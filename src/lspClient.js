// LSP integration: position conversion, the CodeMirror extensions that
// call into language servers (completion/hover/go-to-def), and the
// didOpen/didChange/didClose notification lifecycle.
//
// Language registry: at workspace-open time, maybeStartLsp() builds a
// JS-side registry from the language_servers config delivered by the
// backend (via the get_language_servers command). All the old isRustFile()
// guards are replaced by getLanguageForPath() so every language server
// added to config.json works without touching this file.
//
// Note on the import from fileOps.js: this creates a circular import
// (fileOps.js imports notifyDidOpen/notifyDidClose from here; here imports
// openFile from fileOps.js for goToDefinition's cross-file jump). This is
// SAFE because every binding crossing the cycle is a function declaration
// (hoisted, available immediately) and none of them are called at either
// module's own top level — only from inside event handlers, well after
// both modules have finished loading. Don't "fix" this into something more
// convoluted; it's a known-safe pattern, not an oversight.

import { hoverTooltip, keymap, setDiagnostics } from "./vendor/codemirror.bundle.js";
import { appState, showStatus } from "./state.js";
import { getEditor } from "./editorSetup.js";
import { openFile } from "./fileOps.js";

// ---------------------------------------------------------------------------
// Language Registry
// ---------------------------------------------------------------------------

/**
 * An entry in the language registry, derived from config.language_servers.
 * @typedef {{ serverName: string, languageId: string, fileExtensions: string[], projectMarkers: string[] }} LangEntry
 */

/** @type {LangEntry[]} */
let languageRegistry = [];

/** Active server name (the key from config.language_servers). */
let activeLspServerName = null;

/**
 * Returns the registry entry for the given file path, or null if no
 * configured language server handles files with that extension.
 *
 * @param {string|null|undefined} path
 * @returns {LangEntry|null}
 */
export function getLanguageForPath(path) {
  if (!path) return null;
  // Normalise: lowercase the full path so extension checks are
  // case-insensitive on case-insensitive filesystems.
  const lower = path.toLowerCase();
  for (const entry of languageRegistry) {
    if (entry.fileExtensions.some((ext) => lower.endsWith(ext))) return entry;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Compatibility shims — kept so the rest of the codebase still compiles
// without changes during the transition.
// ---------------------------------------------------------------------------

/** @deprecated Use getLanguageForPath(path) !== null instead. */
export function isRustFile(path) {
  const entry = getLanguageForPath(path);
  return entry?.languageId === "rust";
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export function pathToUri(path) {
  return "file://" + path;
}

export function uriToPath(uri) {
  return uri.startsWith("file://") ? uri.slice("file://".length) : uri;
}

// LSP uses {line, character}, both 0-indexed; CodeMirror uses a flat
// character offset into the document.
export function offsetToLspPos(doc, offset) {
  const line = doc.lineAt(offset);
  return { line: line.number - 1, character: offset - line.from };
}

export function lspPosToOffset(doc, pos) {
  const line = doc.line(pos.line + 1);
  return line.from + pos.character;
}
// ---------------------------------------------------------------------------
// LSP lifecycle state
// ---------------------------------------------------------------------------

/** Set of server names (from config.language_servers) currently running. */
let startedServers = new Set();
/** Per-server currently open document path: Map<serverName, path> */
let openPaths = new Map();
/** Per-server document version counter: Map<serverName, number> */
let docVersions = new Map();

const LSP_KIND_MAP = {
  1: "text", 2: "method", 3: "function", 4: "constructor", 5: "field",
  6: "variable", 7: "class", 8: "interface", 9: "module", 10: "property",
  13: "enum", 14: "keyword", 21: "constant", 22: "type", 25: "type",
};

// ---------------------------------------------------------------------------
// LSP feature handlers (language-agnostic; guarded by getLanguageForPath)
// ---------------------------------------------------------------------------

export async function lspCompletionSource(context) {
  const lang = getLanguageForPath(appState.currentFilePath);
  if (!lang || !startedServers.has(lang.serverName)) return null;

  const pos = offsetToLspPos(context.state.doc, context.pos);
  let result;
  try {
    result = await window.__TAURI__.core.invoke("lsp_request", {
      serverName: lang.serverName,
      method: "textDocument/completion",
      params: {
        textDocument: { uri: pathToUri(appState.currentFilePath) },
        position: pos,
      },
    });
  } catch (err) {
    return null; // don't break typing over an LSP hiccup
  }

  const items = Array.isArray(result) ? result : result?.items || [];
  if (items.length === 0) return null;

  // Preserve server's own relevance ordering (sortText).
  const sorted = [...items].sort((a, b) => {
    const sa = a.sortText || a.label, sb = b.sortText || b.label;
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });

  const word = context.matchBefore(/\w*/);
  return {
    from: word ? word.from : context.pos,
    validFor: /^\w*$/,
    options: sorted.slice(0, 50).map((item, i) => {
      // Clean up text to apply — jdtls includes return types in label (e.g. "foo() : void"),
      // while insertText or textEdit holds the raw method insertion.
      let insertStr = item.insertText || (item.textEdit ? item.textEdit.newText : item.label);
      if (insertStr.includes(" : ")) {
        insertStr = insertStr.split(" : ")[0];
      }
      return {
        label: item.label,
        apply: insertStr,
        detail: item.detail || undefined,
        type: LSP_KIND_MAP[item.kind] || "text",
        boost: -i,
      };
    }),
  };
}

// Backward-compat alias used by editorSetup.js / main.js.
export const rustCompletionSource = lspCompletionSource;

export const lspHover = hoverTooltip(async (view, pos) => {
  const lang = getLanguageForPath(appState.currentFilePath);
  if (!lang || !startedServers.has(lang.serverName)) return null;

  const lspPos = offsetToLspPos(view.state.doc, pos);
  let result;
  try {
    result = await window.__TAURI__.core.invoke("lsp_request", {
      serverName: lang.serverName,
      method: "textDocument/hover",
      params: {
        textDocument: { uri: pathToUri(appState.currentFilePath) },
        position: lspPos,
      },
    });
  } catch (err) {
    return null;
  }

  if (!result || !result.contents) return null;

  let text;
  const c = result.contents;
  if (typeof c === "string") text = c;
  else if (c.value) text = c.value;
  else if (Array.isArray(c)) text = c.map((x) => (typeof x === "string" ? x : x.value)).join("\n\n");
  if (!text) return null;

  return {
    pos,
    end: pos,
    create() {
      const dom = document.createElement("div");
      dom.className = "cm-lsp-hover";
      dom.textContent = text;
      return { dom };
    },
  };
});

// Backward-compat alias.
export const rustHover = lspHover;

export async function goToDefinition(view) {
  const lang = getLanguageForPath(appState.currentFilePath);
  if (!lang || !startedServers.has(lang.serverName)) return false;

  const pos = offsetToLspPos(view.state.doc, view.state.selection.main.head);
  let result;
  try {
    result = await window.__TAURI__.core.invoke("lsp_request", {
      serverName: lang.serverName,
      method: "textDocument/definition",
      params: {
        textDocument: { uri: pathToUri(appState.currentFilePath) },
        position: pos,
      },
    });
  } catch (err) {
    showStatus("Go-to-definition failed: " + err, true);
    return true;
  }

  const location = Array.isArray(result) ? result[0] : result;
  // Support both LSP Location ({ uri, range }) and LocationLink ({ targetUri, targetSelectionRange/targetRange })
  const targetUri = location?.uri || location?.targetUri;
  if (!location || !targetUri) {
    showStatus("No definition found");
    return true;
  }

  if (!targetUri.startsWith("file://")) {
    showStatus(`Definition is in non-file source (${targetUri.split(":")[0]}://)`);
    return true;
  }

  const targetPath = uriToPath(targetUri);
  const range = location.range || location.targetSelectionRange || location.targetRange;
  const targetLine = range?.start?.line ?? 0;
  const targetChar = range?.start?.character ?? 0;

  if (targetPath === appState.currentFilePath) {
    const offset = lspPosToOffset(view.state.doc, { line: targetLine, character: targetChar });
    view.dispatch({ selection: { anchor: offset }, scrollIntoView: true });
  } else {
    await openFile(targetPath);
    const editor = getEditor();
    const offset = lspPosToOffset(editor.state.doc, { line: targetLine, character: targetChar });
    editor.dispatch({ selection: { anchor: offset }, scrollIntoView: true });
  }
  return true;
}

export const definitionKeymap = keymap.of([{ key: "Alt-d", run: goToDefinition }]);

// ---------------------------------------------------------------------------
// Workspace open — auto-detect which language server(s) to start
// ---------------------------------------------------------------------------

/**
 * Called by fileTree.js when a workspace is opened. Fetches the language
 * server registry from the backend, finds ALL servers whose project_markers
 * appear in the workspace root entries, and starts them concurrently.
 *
 * @param {string} workspaceRoot
 * @param {{ name: string, is_dir: boolean }[]} entries  top-level workspace entries
 */
export async function maybeStartLsp(workspaceRoot, entries) {
  let serversFromConfig;
  try {
    serversFromConfig = await window.__TAURI__.core.invoke("get_language_servers");
  } catch (err) {
    console.warn("get_language_servers unavailable, using built-in Rust fallback:", err);
    serversFromConfig = {
      rust: {
        command: "rust-analyzer",
        args: [],
        language_id: "rust",
        file_extensions: [".rs"],
        project_markers: ["Cargo.toml"],
      },
    };
  }

  // Build the local registry from the response.
  languageRegistry = Object.entries(serversFromConfig).map(([name, cfg]) => ({
    serverName: name,
    languageId: cfg.language_id,
    fileExtensions: cfg.file_extensions || [],
    projectMarkers: cfg.project_markers || [],
  }));

  // Find all servers whose project markers appear at the workspace root or in a sub-folder.
  const entryNames = new Set(entries.map((e) => e.name));
  const matches = [];

  for (const entry of languageRegistry) {
    for (const marker of entry.projectMarkers) {
      if (entryNames.has(marker)) {
        matches.push({ serverName: entry.serverName, root: workspaceRoot });
        break;
      } else if (marker.includes("/")) {
        const parts = marker.split("/");
        const subFolder = parts[0];
        if (entryNames.has(subFolder)) {
          matches.push({ serverName: entry.serverName, root: `${workspaceRoot}/${subFolder}` });
          break;
        }
      }
    }
  }

  if (matches.length === 0) return;

  const startedNames = [];
  for (const match of matches) {
    try {
      await window.__TAURI__.core.invoke("start_lsp", {
        workspaceRoot: match.root,
        serverName: match.serverName,
      });
      startedServers.add(match.serverName);
      startedNames.push(match.serverName);
    } catch (err) {
      showStatus(`${match.serverName} language server failed to start: ${err}`, true);
    }
  }

  if (startedNames.length > 0) {
    showStatus(`${startedNames.join(", ")} language server(s) started`);
  }
}

// ---------------------------------------------------------------------------
// Document lifecycle notifications
// ---------------------------------------------------------------------------

export async function notifyDidClose(path) {
  const lang = getLanguageForPath(path);
  if (!lang || !startedServers.has(lang.serverName)) return;
  try {
    await window.__TAURI__.core.invoke("lsp_notify", {
      serverName: lang.serverName,
      method: "textDocument/didClose",
      params: { textDocument: { uri: pathToUri(path) } },
    });
    if (openPaths.get(lang.serverName) === path) {
      openPaths.delete(lang.serverName);
    }
  } catch (err) {
    console.error("didClose failed:", err);
  }
}

export async function notifyDidOpen(path, content) {
  const lang = getLanguageForPath(path);
  if (!lang || !startedServers.has(lang.serverName)) return;

  const prevPath = openPaths.get(lang.serverName);
  if (prevPath === path) return;

  if (prevPath && prevPath !== path) {
    await notifyDidClose(prevPath);
  }

  docVersions.set(lang.serverName, 1);
  try {
    await window.__TAURI__.core.invoke("lsp_notify", {
      serverName: lang.serverName,
      method: "textDocument/didOpen",
      params: {
        textDocument: {
          uri: pathToUri(path),
          languageId: lang.languageId,
          version: 1,
          text: content,
        },
      },
    });
    openPaths.set(lang.serverName, path);
  } catch (err) {
    console.error("didOpen failed:", err);
  }
}

let didChangeTimer = null;
function notifyDidChangeDebounced() {
  const lang = getLanguageForPath(appState.currentFilePath);
  if (!lang || !startedServers.has(lang.serverName)) return;
  clearTimeout(didChangeTimer);
  didChangeTimer = setTimeout(async () => {
    const v = (docVersions.get(lang.serverName) || 1) + 1;
    docVersions.set(lang.serverName, v);
    const editor = getEditor();
    try {
      await window.__TAURI__.core.invoke("lsp_notify", {
        serverName: lang.serverName,
        method: "textDocument/didChange",
        params: {
          textDocument: { uri: pathToUri(appState.currentFilePath), version: v },
          contentChanges: [{ text: editor.state.doc.toString() }],
        },
      });
    } catch (err) {
      console.error("didChange failed:", err);
    }
  }, 300);
}

// ---------------------------------------------------------------------------
// Editor bindings (called once from main.js after createEditor())
// ---------------------------------------------------------------------------

/// Wires up everything that needs the live editor instance. Call this
/// exactly once from main.js, right after createEditor() returns.
export function initLspEditorBindings(editor) {
  editor.contentDOM.addEventListener("keyup", notifyDidChangeDebounced);

  // Diagnostics are pushed by the language server, not pulled.
  window.__TAURI__.event.listen("lsp-notification", (event) => {
    const msg = event.payload;
    if (msg.server && !startedServers.has(msg.server)) return;
    if (msg.method !== "textDocument/publishDiagnostics") {
      console.log("[lsp]", msg.server || "", msg.method, msg.params);
      return;
    }

    const uri = msg.params?.uri;
    if (!uri || uriToPath(uri) !== appState.currentFilePath) return;

    const diagnostics = (msg.params.diagnostics || [])
      .map((d) => {
        try {
          return {
            from: lspPosToOffset(editor.state.doc, d.range.start),
            to: lspPosToOffset(editor.state.doc, d.range.end),
            severity: d.severity === 1 ? "error" : d.severity === 2 ? "warning" : "info",
            message: d.message,
          };
        } catch (e) {
          return null; // range outside current doc bounds — stale notification
        }
      })
      .filter(Boolean);

    editor.dispatch(setDiagnostics(editor.state, diagnostics));
  });
}
