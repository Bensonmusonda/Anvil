// Anvil Editor — Phase 5 frontend
//
// Adds LSP integration for Rust files: autocomplete, hover, go-to-definition
// (F12), and live diagnostics — all via rust-analyzer, relayed through the
// start_lsp/lsp_request/lsp_notify commands in lsp.rs.
//
// ⚠️ One genuine unknown carried over from scoping: Tauri v2 auto-converts
// multi-word Rust command parameter names to camelCase for the frontend
// (workspace_root -> workspaceRoot). Every command before this phase only
// had single-word params, so this is the first real test of that behavior.
// If start_lsp fails with an argument-related error, that's the first
// thing to check — the param name below may need to go back to snake_case.

import {
  EditorView,
  basicSetup,
  Compartment,
  oneDark,
  javascript,
  python,
  rust,
  json,
  html,
  css,
  markdown,
  autocompletion,
  linter,
  lintGutter,
  setDiagnostics,
  hoverTooltip,
  keymap,
} from "./vendor/codemirror.bundle.js";

const LANGUAGE_BY_EXT = {
  js: () => javascript(),
  jsx: () => javascript({ jsx: true }),
  ts: () => javascript({ typescript: true }),
  tsx: () => javascript({ typescript: true, jsx: true }),
  py: () => python(),
  rs: () => rust(),
  json: () => json(),
  html: () => html(),
  css: () => css(),
  md: () => markdown(),
};

function languageForPath(path) {
  const ext = path.split(".").pop().toLowerCase();
  const factory = LANGUAGE_BY_EXT[ext];
  return factory ? factory() : [];
}

function isRustFile(path) {
  return path && path.endsWith(".rs");
}

function pathToUri(path) {
  return "file://" + path;
}

function uriToPath(uri) {
  return uri.startsWith("file://") ? uri.slice("file://".length) : uri;
}

// --- LSP position helpers: LSP uses {line, character}, both 0-indexed;
// CodeMirror uses a flat character offset into the document. ---

function offsetToLspPos(doc, offset) {
  const line = doc.lineAt(offset);
  return { line: line.number - 1, character: offset - line.from };
}

function lspPosToOffset(doc, pos) {
  const line = doc.line(pos.line + 1);
  return line.from + pos.character;
}

const languageCompartment = new Compartment();
const currentFileEl = document.getElementById("current-file");
const statusEl = document.getElementById("status-msg");

let currentFilePath = null;
let suppressNextReload = false;
let lspStarted = false;
let docVersion = 0;
let lspOpenPath = null;

function showStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
  setTimeout(() => {
    if (statusEl.textContent === message) statusEl.textContent = "";
  }, 3000);
}

// --- LSP-backed CodeMirror extensions ---

async function rustCompletionSource(context) {
  if (!lspStarted || !isRustFile(currentFilePath)) return null;

  const pos = offsetToLspPos(context.state.doc, context.pos);
  let result;
  try {
    result = await window.__TAURI__.core.invoke("lsp_request", {
      method: "textDocument/completion",
      params: {
        textDocument: { uri: pathToUri(currentFilePath) },
        position: pos,
      },
    });
  } catch (err) {
    return null; // don't break typing over an LSP hiccup
  }

  const items = Array.isArray(result) ? result : result?.items || [];
  if (items.length === 0) return null;

  const word = context.matchBefore(/\w*/);
  return {
    from: word ? word.from : context.pos,
    options: items.slice(0, 50).map((item) => ({
      label: item.label,
      detail: item.detail || undefined,
      type: "text",
    })),
  };
}

const rustHover = hoverTooltip(async (view, pos) => {
  if (!lspStarted || !isRustFile(currentFilePath)) return null;

  const lspPos = offsetToLspPos(view.state.doc, pos);
  let result;
  try {
    result = await window.__TAURI__.core.invoke("lsp_request", {
      method: "textDocument/hover",
      params: {
        textDocument: { uri: pathToUri(currentFilePath) },
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

async function goToDefinition(view) {
  if (!lspStarted || !isRustFile(currentFilePath)) return false;

  const pos = offsetToLspPos(view.state.doc, view.state.selection.main.head);
  let result;
  try {
    result = await window.__TAURI__.core.invoke("lsp_request", {
      method: "textDocument/definition",
      params: {
        textDocument: { uri: pathToUri(currentFilePath) },
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

  if (targetPath === currentFilePath) {
    const offset = lspPosToOffset(view.state.doc, { line: targetLine, character: targetChar });
    view.dispatch({ selection: { anchor: offset }, scrollIntoView: true });
  } else {
    await openFile(targetPath);
    const offset = lspPosToOffset(editor.state.doc, { line: targetLine, character: targetChar });
    editor.dispatch({ selection: { anchor: offset }, scrollIntoView: true });
  }
  return true;
}

const definitionKeymap = keymap.of([{ key: "Alt-d", run: goToDefinition }]);

const editor = new EditorView({
  doc: "// Open a folder on the left, then click a file to edit it.\n",
  extensions: [
    basicSetup,
    languageCompartment.of([]),
    oneDark,
    autocompletion({ override: [rustCompletionSource] }),
    lintGutter(),
    rustHover,
    definitionKeymap,
  ],
  parent: document.getElementById("editor"),
});

function setEditorContent(content) {
  editor.dispatch({
    changes: { from: 0, to: editor.state.doc.length, insert: content },
  });
}

// --- LSP diagnostics: pushed by rust-analyzer, not pulled ---

window.__TAURI__.event.listen("lsp-notification", (event) => {
  const msg = event.payload;
  if (msg.method !== "textDocument/publishDiagnostics") {
    console.log("[lsp]", msg.method, msg.params);
    return;
  }

  const uri = msg.params?.uri;
  if (!uri || uriToPath(uri) !== currentFilePath) return;

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

async function maybeStartLsp(workspaceRoot, entries) {
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

async function notifyDidClose(path) {
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

async function notifyDidOpen(path, content) {
  if (!lspStarted || !isRustFile(path)) return;

  // Already open as far as the server knows — re-sending didOpen for the
  // same URI without a didClose in between is a protocol violation (this
  // was the actual bug: "duplicate DidOpenTextDocument").
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
  if (!lspStarted || !isRustFile(currentFilePath)) return;
  clearTimeout(didChangeTimer);
  didChangeTimer = setTimeout(async () => {
    docVersion += 1;
    try {
      await window.__TAURI__.core.invoke("lsp_notify", {
        method: "textDocument/didChange",
        params: {
          textDocument: { uri: pathToUri(currentFilePath), version: docVersion },
          // Omitting `range` means "replace the whole document" — valid
          // regardless of negotiated sync mode, and much simpler than
          // computing incremental diffs for this phase.
          contentChanges: [{ text: editor.state.doc.toString() }],
        },
      });
    } catch (err) {
      console.error("didChange failed:", err);
    }
  }, 300);
}

editor.contentDOM.addEventListener("keyup", notifyDidChangeDebounced);

async function openFile(path) {
  try {
    const content = await window.__TAURI__.core.invoke("read_text_file", { path });
    currentFilePath = path;
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: content },
      effects: languageCompartment.reconfigure(languageForPath(path)),
    });
    currentFileEl.textContent = path;
    await notifyDidOpen(path, content);
  } catch (err) {
    currentFileEl.textContent = "error opening file";
    setEditorContent(`// Failed to open ${path}\n// ${err}`);
  }
}

function iconFor(entry) {
  return entry.is_dir ? "\u25B8" : "\u2022";
}

async function buildTreeNode(entry, container) {
  const row = document.createElement("div");
  row.className = "tree-row";

  const caret = document.createElement("span");
  caret.className = "tree-caret";
  caret.textContent = entry.is_dir ? iconFor(entry) : " ";
  row.appendChild(caret);

  const label = document.createElement("span");
  label.textContent = entry.name;
  row.appendChild(label);

  container.appendChild(row);

  if (!entry.is_dir) {
    row.addEventListener("click", () => {
      document.querySelectorAll(".tree-row.active").forEach((el) => el.classList.remove("active"));
      row.classList.add("active");
      openFile(entry.path);
    });
    return;
  }

  let childrenEl = null;
  let loaded = false;
  let expanded = false;

  row.addEventListener("click", async () => {
    expanded = !expanded;
    caret.textContent = expanded ? "\u25BE" : "\u25B8";

    if (!loaded) {
      loaded = true;
      childrenEl = document.createElement("div");
      childrenEl.className = "tree-children";
      row.insertAdjacentElement("afterend", childrenEl);
      try {
        const children = await window.__TAURI__.core.invoke("list_dir", { path: entry.path });
        for (const child of children) {
          await buildTreeNode(child, childrenEl);
        }
      } catch (err) {
        const errEl = document.createElement("div");
        errEl.className = "tree-error";
        errEl.textContent = "Error: " + err;
        childrenEl.appendChild(errEl);
      }
    }
    childrenEl.style.display = expanded ? "block" : "none";
  });
}

async function openWorkspace(path) {
  const treeEl = document.getElementById("tree");
  treeEl.innerHTML = "";
  try {
    const entries = await window.__TAURI__.core.invoke("list_dir", { path });
    for (const entry of entries) {
      await buildTreeNode(entry, treeEl);
    }
    await window.__TAURI__.core.invoke("start_watching", { path });
    await maybeStartLsp(path, entries);
  } catch (err) {
    const errEl = document.createElement("div");
    errEl.className = "tree-error";
    errEl.textContent = "Error: " + err;
    treeEl.appendChild(errEl);
  }
}

document.getElementById("open-btn").addEventListener("click", () => {
  const path = document.getElementById("workspace-path").value.trim();
  if (path) openWorkspace(path);
});

document.getElementById("workspace-path").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("open-btn").click();
});

// --- Save / Revert / Commit ---

document.getElementById("save-btn").addEventListener("click", async () => {
  if (!currentFilePath) return showStatus("No file open", true);
  try {
    suppressNextReload = true;
    await window.__TAURI__.core.invoke("write_text_file", {
      path: currentFilePath,
      content: editor.state.doc.toString(),
    });
    showStatus("Saved");
  } catch (err) {
    showStatus("Save failed: " + err, true);
  }
});

document.getElementById("revert-btn").addEventListener("click", async () => {
  if (!currentFilePath) return showStatus("No file open", true);
  try {
    suppressNextReload = true;
    const content = await window.__TAURI__.core.invoke("revert_file", { path: currentFilePath });
    setEditorContent(content);
    showStatus("Reverted to last snapshot");
  } catch (err) {
    showStatus("Revert failed: " + err, true);
  }
});

document.getElementById("commit-btn").addEventListener("click", async () => {
  if (!currentFilePath) return showStatus("No file open", true);
  try {
    await window.__TAURI__.core.invoke("commit_file", { path: currentFilePath });
    showStatus("Committed — snapshot cleared");
  } catch (err) {
    showStatus("Commit failed: " + err, true);
  }
});

// --- Filesystem watcher ---

window.__TAURI__.event.listen("file-changed", async (event) => {
  const changedPath = event.payload;
  const sameFile =
    changedPath === currentFilePath ||
    (currentFilePath && changedPath.split("/").pop() === currentFilePath.split("/").pop());
  if (!sameFile) return;

  if (suppressNextReload) {
    suppressNextReload = false;
    return;
  }

  try {
    const content = await window.__TAURI__.core.invoke("read_text_file", { path: changedPath });
    setEditorContent(content);
    showStatus("Reloaded — changed on disk externally");
  } catch (err) {
    showStatus("File changed but couldn't reload: " + err, true);
  }
});

// --- Single-shot AI ---

const aiBtn = document.getElementById("ai-btn");
const aiPrompt = document.getElementById("ai-prompt");

async function askAI() {
  const prompt = aiPrompt.value.trim();
  if (!prompt) return;

  aiBtn.disabled = true;
  showStatus("Asking AI...");

  try {
    const response = await window.__TAURI__.core.invoke("ai_complete", {
      purpose: "chat",
      prompt,
    });
    const cursorPos = editor.state.selection.main.head;
    editor.dispatch({ changes: { from: cursorPos, insert: response } });
    aiPrompt.value = "";
    showStatus("Inserted AI response");
  } catch (err) {
    showStatus("AI request failed: " + err, true);
  } finally {
    aiBtn.disabled = false;
  }
}

aiBtn.addEventListener("click", askAI);
aiPrompt.addEventListener("keydown", (e) => {
  if (e.key === "Enter") askAI();
});

// --- Agent task ---

const agentBtn = document.getElementById("agent-btn");
const agentPrompt = document.getElementById("agent-prompt");
const agentOutput = document.getElementById("agent-output");

async function runAgent() {
  const prompt = agentPrompt.value.trim();
  if (!prompt) return;

  agentBtn.disabled = true;
  agentOutput.textContent = "Running agent — this can take a few seconds if it calls tools...";

  try {
    const result = await window.__TAURI__.core.invoke("agent_run", { prompt });
    agentOutput.textContent = result;
  } catch (err) {
    agentOutput.textContent = "Agent failed: " + err;
  } finally {
    agentBtn.disabled = false;
  }
}

agentBtn.addEventListener("click", runAgent);
agentPrompt.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    runAgent();
  }
});
