// LSP integration: position conversion, the CodeMirror extensions that
// call into rust-analyzer (completion/hover/go-to-def), and the
// didOpen/didChange/didClose notification lifecycle.
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

export function isRustFile(path) {
  return path && path.endsWith(".rs");
}

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

let lspStarted = false;
let docVersion = 0;
let lspOpenPath = null;

const LSP_KIND_MAP = {
  1: "text", 2: "method", 3: "function", 4: "constructor", 5: "field",
  6: "variable", 7: "class", 8: "interface", 9: "module", 10: "property",
  13: "enum", 14: "keyword", 21: "constant", 22: "type", 25: "type",
};

export async function rustCompletionSource(context) {
  if (!lspStarted || !isRustFile(appState.currentFilePath)) return null;

  const pos = offsetToLspPos(context.state.doc, context.pos);
  let result;
  try {
    result = await window.__TAURI__.core.invoke("lsp_request", {
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

  // Preserve rust-analyzer's own relevance ordering (sortText) instead of
  // letting CM6's independent fuzzy scoring scramble it.
  const sorted = [...items].sort((a, b) => {
    const sa = a.sortText || a.label, sb = b.sortText || b.label;
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });

  const word = context.matchBefore(/\w*/);
  return {
    from: word ? word.from : context.pos,
    options: sorted.slice(0, 50).map((item, i) => ({
      label: item.label,
      detail: item.detail || undefined,
      type: LSP_KIND_MAP[item.kind] || "text",
      boost: -i, // keep server ordering ahead of CM6's own re-scoring
    })),
  };
}

export const rustHover = hoverTooltip(async (view, pos) => {
  if (!lspStarted || !isRustFile(appState.currentFilePath)) return null;

  const lspPos = offsetToLspPos(view.state.doc, pos);
  let result;
  try {
    result = await window.__TAURI__.core.invoke("lsp_request", {
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

export async function goToDefinition(view) {
  if (!lspStarted || !isRustFile(appState.currentFilePath)) return false;

  const pos = offsetToLspPos(view.state.doc, view.state.selection.main.head);
  let result;
  try {
    result = await window.__TAURI__.core.invoke("lsp_request", {
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
  if (!location || !location.uri) {
    showStatus("No definition found");
    return true;
  }

  const targetPath = uriToPath(location.uri);
  const targetLine = location.range?.start?.line ?? 0;
  const targetChar = location.range?.start?.character ?? 0;

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

export async function maybeStartLsp(workspaceRoot, entries) {
  const hasCargoToml = entries.some((e) => !e.is_dir && e.name === "Cargo.toml");
  if (!hasCargoToml) return;

  try {
    await window.__TAURI__.core.invoke("start_lsp", { workspaceRoot: workspaceRoot });
    lspStarted = true;
    showStatus("rust-analyzer started");
  } catch (err) {
    lspStarted = false;
    showStatus("rust-analyzer failed to start: " + err, true);
  }
}

export async function notifyDidClose(path) {
  if (!lspStarted || !isRustFile(path)) return;
  try {
    await window.__TAURI__.core.invoke("lsp_notify", {
      method: "textDocument/didClose",
      params: { textDocument: { uri: pathToUri(path) } },
    });
  } catch (err) {
    console.error("didClose failed:", err);
  }
}

export async function notifyDidOpen(path, content) {
  if (!lspStarted || !isRustFile(path)) return;

  // Already open as far as the server knows — re-sending didOpen for the
  // same URI without a didClose in between is a protocol violation.
  if (lspOpenPath === path) return;

  if (lspOpenPath && lspOpenPath !== path) {
    await notifyDidClose(lspOpenPath);
  }

  docVersion = 1;
  try {
    await window.__TAURI__.core.invoke("lsp_notify", {
      method: "textDocument/didOpen",
      params: {
        textDocument: {
          uri: pathToUri(path),
          languageId: "rust",
          version: docVersion,
          text: content,
        },
      },
    });
    lspOpenPath = path;
  } catch (err) {
    console.error("didOpen failed:", err);
  }
}

let didChangeTimer = null;
function notifyDidChangeDebounced() {
  if (!lspStarted || !isRustFile(appState.currentFilePath)) return;
  clearTimeout(didChangeTimer);
  didChangeTimer = setTimeout(async () => {
    docVersion += 1;
    const editor = getEditor();
    try {
      await window.__TAURI__.core.invoke("lsp_notify", {
        method: "textDocument/didChange",
        params: {
          textDocument: { uri: pathToUri(appState.currentFilePath), version: docVersion },
          // Omitting `range` means "replace the whole document" — valid
          // regardless of negotiated sync mode, simpler than incremental diffs.
          contentChanges: [{ text: editor.state.doc.toString() }],
        },
      });
    } catch (err) {
      console.error("didChange failed:", err);
    }
  }, 300);
}

/// Wires up everything that needs the live editor instance. Call this
/// exactly once from main.js, right after createEditor() returns.
export function initLspEditorBindings(editor) {
  editor.contentDOM.addEventListener("keyup", notifyDidChangeDebounced);

  // Diagnostics are pushed by rust-analyzer, not pulled.
  window.__TAURI__.event.listen("lsp-notification", (event) => {
    const msg = event.payload;
    if (msg.method !== "textDocument/publishDiagnostics") {
      console.log("[lsp]", msg.method, msg.params);
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
