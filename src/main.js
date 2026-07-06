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

// --- UI Dropdown Logic ---
document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll('.dropdown-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const dropdown = btn.nextElementSibling;
      const isShowing = dropdown.classList.contains('show');
      
      document.querySelectorAll('.dropdown-content').forEach(dc => dc.classList.remove('show'));
      document.querySelectorAll('.dropdown-btn').forEach(db => db.classList.remove('active'));
      
      if (!isShowing) {
        dropdown.classList.add('show');
        btn.classList.add('active');
      }
    });
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.dropdown')) {
      document.querySelectorAll('.dropdown-content').forEach(dc => dc.classList.remove('show'));
      document.querySelectorAll('.dropdown-btn').forEach(db => db.classList.remove('active'));
    }
  });

  // --- Window Controls ---
  document.getElementById('win-minimize')?.addEventListener('click', () => {
    window.__TAURI__.core.invoke('win_minimize');
  });
  document.getElementById('win-maximize')?.addEventListener('click', () => {
    window.__TAURI__.core.invoke('win_toggle_maximize');
  });
  document.getElementById('win-close')?.addEventListener('click', () => {
    window.__TAURI__.core.invoke('win_close');
  });

  // --- Window Drag: start dragging on mousedown on the drag region ---
  // Use JS startDragging so that gaps between interactive elements are draggable
  document.querySelector('.top-bar')?.addEventListener('mousedown', (e) => {
    // Only drag on left button, not on interactive elements
    if (e.button !== 0) return;
    const tag = e.target.tagName.toLowerCase();
    const interactive = ['button', 'input', 'textarea', 'select', 'a'];
    if (interactive.includes(tag)) return;
    if (e.target.closest('.window-controls, .dropdown, .top-bar-menu')) return;
    window.__TAURI__.window.getCurrentWindow().startDragging();
  });

  // --- Sidebar collapse: clicking active tab collapses the sidebar ---
  const sidebar = document.getElementById('sidebar');
  document.querySelectorAll('.activity-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const isActive = tab.classList.contains('active');
      if (isActive) {
        // collapse
        sidebar.style.display = sidebar.style.display === 'none' ? 'flex' : 'none';
      } else {
        sidebar.style.display = 'flex';
      }
    });
  });
});

import {
  EditorView,
  basicSetup,
  javascript,
  rust,
  markdown,
  html,
  css,
  json,
  Compartment,
  autocompletion,
  linter,
  lintGutter,
  setDiagnostics,
  hoverTooltip,
  keymap,
} from "./vendor/codemirror.bundle.js";

import { Terminal } from "./vendor/xterm.js";
import { FitAddon } from "./vendor/xterm-addon-fit.js";

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

let currentWorkspacePath = null;
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

const LSP_KIND_MAP = {
  1: "text", 2: "method", 3: "function", 4: "constructor", 5: "field",
  6: "variable", 7: "class", 8: "interface", 9: "module", 10: "property",
  13: "enum", 14: "keyword", 21: "constant", 22: "type", 25: "type",
};

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

function toggleAiPopup(view) {
  const aiPopup = document.getElementById("ai-popup");
  const aiPrompt = document.getElementById("ai-prompt");
  if (aiPopup.style.display === "none" || !aiPopup.style.display) {
    aiPopup.style.transform = "none";
    const coords = view.coordsAtPos(view.state.selection.main.head);
    if (coords) {
      aiPopup.style.left = `${coords.left}px`;
      aiPopup.style.top = `${coords.bottom + 5}px`;
    } else {
      aiPopup.style.left = "50%";
      aiPopup.style.top = "50%";
      aiPopup.style.transform = "translate(-50%, -50%)";
    }
    aiPopup.style.display = "block";
    aiPrompt.focus();
  } else {
    aiPopup.style.display = "none";
    view.focus();
  }
  return true;
}

const definitionKeymap = keymap.of([{ key: "Alt-d", run: goToDefinition }]);
const aiPopupKeymap = keymap.of([{ key: "Mod-k", run: toggleAiPopup }]);

const dynamicTheme = EditorView.theme({
  "&": {
    color: "var(--text)",
    backgroundColor: "var(--bg)"
  },
  ".cm-content": {
    caretColor: "var(--accent)"
  },
  "&.cm-focused .cm-cursor": {
    borderLeftColor: "var(--accent)"
  },
  "&.cm-focused .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--panel)"
  },
  ".cm-gutters": {
    backgroundColor: "var(--bg)",
    color: "var(--dim)",
    border: "none"
  },
  ".cm-activeLineGutter": {
    backgroundColor: "var(--panel)",
    color: "var(--text)"
  },
  ".cm-activeLine": {
    backgroundColor: "rgba(255, 255, 255, 0.04)"
  }
}, { dark: false });

const editor = new EditorView({
  doc: "// Open a folder on the left, then click a file to edit it.\n",
  extensions: [
    basicSetup,
    dynamicTheme,
    languageCompartment.of([]),
    EditorView.lineWrapping,
    autocompletion({ override: [rustCompletionSource] }),
    lintGutter(),
    rustHover,
    definitionKeymap,
    aiPopupKeymap,
  ],
  parent: document.getElementById("editor")
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
  currentWorkspacePath = path;
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

// Native folder picker (Tauri dialog plugin)
async function openFolderDialog() {
  try {
    const selected = await window.__TAURI__.dialog.open({
      directory: true,
      multiple: false,
      title: "Open Workspace Folder",
    });
    if (selected) {
      document.getElementById("workspace-path").value = selected;
      openWorkspace(selected);
    }
  } catch (err) {
    showStatus("Folder picker failed: " + err, true);
  }
}

document.getElementById("browse-folder-btn").addEventListener("click", openFolderDialog);
document.getElementById("open-folder-btn").addEventListener("click", () => {
  // close dropdown first
  document.querySelectorAll('.dropdown-content').forEach(dc => dc.classList.remove('show'));
  document.querySelectorAll('.dropdown-btn').forEach(db => db.classList.remove('active'));
  openFolderDialog();
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
    document.getElementById("ai-popup").style.display = "none";
    showStatus("Inserted AI response");
  } catch (err) {
    showStatus("AI request failed: " + err, true);
  } finally {
    aiBtn.disabled = false;
    editor.focus();
  }
}

aiBtn.addEventListener("click", askAI);
aiPrompt.addEventListener("keydown", (e) => {
  if (e.key === "Enter") askAI();
  if (e.key === "Escape") {
    document.getElementById("ai-popup").style.display = "none";
    editor.focus();
  }
});

// Hide AI popup if clicking outside
document.addEventListener("click", (e) => {
  const aiPopup = document.getElementById("ai-popup");
  if (aiPopup && aiPopup.style.display === "block") {
    if (!e.target.closest("#ai-popup")) {
      aiPopup.style.display = "none";
    }
  }
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

  // Ctrl+P / Cmd+P for File Palette
  if (e.key === "p" && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
    e.preventDefault();
    openCommandPalette("files");
  }

  // Ctrl+Shift+P / Cmd+Shift+P for Command Palette
  if (e.key === "P" && (e.ctrlKey || e.metaKey) && e.shiftKey) {
    e.preventDefault();
    openCommandPalette("commands");
  }
});

// --- Command Palette ---
const paletteOverlay = document.getElementById("command-palette");
const paletteInput = document.getElementById("palette-input");
const paletteResults = document.getElementById("palette-results");
let paletteItems = [];
let paletteSelectedIndex = 0;
let paletteMode = "files"; // "files" or "commands"

const AVAILABLE_COMMANDS = [
  { id: "git.refresh", title: "Git: Refresh Status" },
  { id: "terminal.toggle", title: "Terminal: Toggle Panel" },
  { id: "editor.save", title: "Editor: Save File" },
  { id: "agent.run", title: "Agent: Run" },
  { id: "theme.dark", title: "Theme: Anvil Dark" },
  { id: "theme.light", title: "Theme: Anvil Light" },
  { id: "theme.hacker", title: "Theme: Hacker" },
];

function openCommandPalette(mode) {
  if (mode === "files" && !currentWorkspacePath) {
    showStatus("Open a workspace first to use the file palette.", true);
    return;
  }
  paletteMode = mode;
  paletteOverlay.style.display = "flex";
  paletteInput.value = "";
  paletteInput.placeholder = mode === "files" ? "Search files..." : "Search commands...";
  paletteResults.innerHTML = "";
  paletteInput.focus();
  updatePaletteResults();
}

function closeCommandPalette() {
  paletteOverlay.style.display = "none";
  editor.focus();
}

paletteOverlay.addEventListener("mousedown", (e) => {
  if (e.target === paletteOverlay) closeCommandPalette();
});

paletteInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    closeCommandPalette();
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    if (paletteSelectedIndex < paletteItems.length - 1) {
      paletteSelectedIndex++;
      renderPaletteSelection();
    }
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (paletteSelectedIndex > 0) {
      paletteSelectedIndex--;
      renderPaletteSelection();
    }
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (paletteItems.length > 0) {
      const selectedItem = paletteItems[paletteSelectedIndex];
      closeCommandPalette();
      
      if (paletteMode === "files") {
        const absPath = currentWorkspacePath + "/" + selectedItem.path;
        loadFile(absPath);
      } else if (paletteMode === "commands") {
        executeCommand(selectedItem.id);
      }
    }
  }
});

function executeCommand(id) {
  switch(id) {
    case "git.refresh":
      if (currentWorkspacePath) refreshGitStatus();
      break;
    case "terminal.toggle":
      terminalToggleBtn.click();
      break;
    case "editor.save":
      saveFile();
      break;
    case "agent.run":
      runAgent();
      break;
    case "theme.dark":
      document.documentElement.setAttribute("data-theme", "dark");
      break;
    case "theme.light":
      document.documentElement.setAttribute("data-theme", "light");
      break;
    case "theme.hacker":
      document.documentElement.setAttribute("data-theme", "hacker");
      break;
  }
}

let paletteTimeout = null;
paletteInput.addEventListener("input", () => {
  clearTimeout(paletteTimeout);
  paletteTimeout = setTimeout(() => {
    updatePaletteResults();
  }, 100);
});

async function updatePaletteResults() {
  const query = paletteInput.value.toLowerCase();
  try {
    if (paletteMode === "files") {
      paletteItems = await window.__TAURI__.core.invoke("fuzzy_files", { query });
    } else {
      paletteItems = AVAILABLE_COMMANDS.filter(cmd => 
        cmd.title.toLowerCase().includes(query) || cmd.id.toLowerCase().includes(query)
      );
    }
    
    paletteSelectedIndex = 0;
    
    paletteResults.innerHTML = "";
    if (paletteItems.length === 0) {
      paletteResults.innerHTML = `<div class='palette-item'><span class='palette-item-path'>No ${paletteMode} found</span></div>`;
      return;
    }
    
    paletteItems.forEach((item, index) => {
      const div = document.createElement("div");
      div.className = "palette-item";
      if (index === paletteSelectedIndex) div.classList.add("selected");
      
      const label = paletteMode === "files" ? item.path : item.title;
      div.innerHTML = `<span class="palette-item-path">${label}</span>`;
      
      div.onmousedown = () => {
        closeCommandPalette();
        if (paletteMode === "files") {
          const absPath = currentWorkspacePath + "/" + item.path;
          loadFile(absPath);
        } else {
          executeCommand(item.id);
        }
      };
      div.onmouseover = () => {
        paletteSelectedIndex = index;
        renderPaletteSelection();
      };
      paletteResults.appendChild(div);
    });
    
    renderPaletteSelection();
  } catch (err) {
    paletteResults.innerHTML = `<div class="palette-item" style="color:var(--error)">Error: ${err}</div>`;
  }
}

function renderPaletteSelection() {
  const children = paletteResults.children;
  for (let i = 0; i < children.length; i++) {
    if (i === paletteSelectedIndex) {
      children[i].classList.add("selected");
      children[i].scrollIntoView({ block: "nearest" });
    } else {
      children[i].classList.remove("selected");
    }
  }
}

// --- Integrated Terminal ---

const terminalPanel = document.getElementById("terminal-panel");
const terminalToggleBtn = document.getElementById("terminal-toggle-btn");
const terminalContainer = document.getElementById("terminal-container");

const term = new Terminal({
  fontFamily: '"JetBrains Mono", "Fira Code", Consolas, monospace',
  fontSize: 13,
  theme: {
    background: 'transparent',
    foreground: '#cccccc',
    cursor: '#f0514e'
  },
  allowTransparency: true
});
const fitAddon = new FitAddon();
term.loadAddon(fitAddon);

let terminalSpawned = false;

terminalToggleBtn.addEventListener("click", async () => {
  if (terminalPanel.style.display === "none") {
    terminalPanel.style.display = "flex";
    if (!term.element) {
      term.open(terminalContainer);
    }
    
    // Defer fit so that the DOM has updated
    requestAnimationFrame(() => {
      fitAddon.fit();
    });

    if (!terminalSpawned && currentWorkspacePath) {
      try {
        await window.__TAURI__.core.invoke("spawn_terminal", { cwd: currentWorkspacePath });
        terminalSpawned = true;
      } catch (err) {
        showStatus("Failed to spawn terminal: " + err, true);
      }
    }
    term.focus();
  } else {
    terminalPanel.style.display = "none";
    editor.focus();
  }
});

term.onData(async (data) => {
  if (terminalSpawned) {
    try {
      await window.__TAURI__.core.invoke("write_terminal", { data });
    } catch (err) {
      console.error("write_terminal error:", err);
    }
  }
});

term.onResize(async ({ cols, rows }) => {
  if (terminalSpawned) {
    try {
      await window.__TAURI__.core.invoke("resize_terminal", { cols, rows });
    } catch (err) {
      console.error("resize_terminal error:", err);
    }
  }
});

window.addEventListener("resize", () => {
  if (terminalPanel.style.display !== "none") {
    fitAddon.fit();
  }
});

window.__TAURI__.event.listen("terminal-data", (event) => {
  term.write(event.payload);
});

window.__TAURI__.event.listen("terminal-exit", () => {
  terminalSpawned = false;
  term.write("\r\n[Terminal exited]\r\n");
});

// --- Sidebar Tabs ---
const tabFiles = document.getElementById("tab-files");
const tabGit = document.getElementById("tab-git");
const panelFiles = document.getElementById("files-panel");
const panelGit = document.getElementById("git-panel");

function switchTab(tabId) {
  [tabFiles, tabGit].forEach(t => t.classList.remove("active"));
  [panelFiles, panelGit].forEach(p => p.style.display = "none");
  
  if (tabId === "files") {
    tabFiles.classList.add("active");
    panelFiles.style.display = "flex";
  } else if (tabId === "git") {
    tabGit.classList.add("active");
    panelGit.style.display = "flex";
    if (currentWorkspacePath) refreshGitStatus();
  }
}

tabFiles.addEventListener("click", () => switchTab("files"));
tabGit.addEventListener("click", () => switchTab("git"));

// --- Agent Pane Toggle ---
const agentToggleBtn = document.getElementById("agent-toggle-btn");
const rightSidebar = document.getElementById("right-sidebar");

agentToggleBtn.addEventListener("click", () => {
  if (rightSidebar.style.display === "none") {
    rightSidebar.style.display = "flex";
  } else {
    rightSidebar.style.display = "none";
  }
});

// --- Git Panel ---
const gitRefreshBtn = document.getElementById("git-refresh-btn");
const gitStatusList = document.getElementById("git-status-list");
const gitCommitMsg = document.getElementById("git-commit-msg");
const gitCommitBtn = document.getElementById("git-commit-action-btn");

gitRefreshBtn.addEventListener("click", () => {
  if (currentWorkspacePath) refreshGitStatus();
});

async function refreshGitStatus() {
  gitStatusList.innerHTML = "Loading...";
  try {
    const statuses = await window.__TAURI__.core.invoke("git_status");
    gitStatusList.innerHTML = "";
    if (statuses.length === 0) {
      gitStatusList.innerHTML = "<div style='padding:10px; color:var(--dim)'>No changes</div>";
      return;
    }
    
    for (const item of statuses) {
      const row = document.createElement("div");
      row.className = "git-file";
      
      const badge = document.createElement("div");
      badge.className = "git-status-badge";
      badge.textContent = item.status;
      row.appendChild(badge);
      
      const pathEl = document.createElement("div");
      pathEl.className = "git-path";
      pathEl.textContent = item.path;
      pathEl.title = item.path;
      row.appendChild(pathEl);
      
      const actions = document.createElement("div");
      actions.className = "git-actions";
      
      const isStaged = item.status[0] !== ' ' && item.status[0] !== '?';
      const isUnstaged = item.status[1] !== ' ';
      
      if (isUnstaged || item.status === '??') {
        const stageBtn = document.createElement("button");
        stageBtn.className = "git-action-btn";
        stageBtn.textContent = "+";
        stageBtn.title = "Stage";
        stageBtn.onclick = async (e) => {
          e.stopPropagation();
          try {
            await window.__TAURI__.core.invoke("git_stage", { path: item.path });
            refreshGitStatus();
          } catch (err) {
            showStatus("Stage failed: " + err, true);
          }
        };
        actions.appendChild(stageBtn);
      }
      
      if (isStaged) {
        const unstageBtn = document.createElement("button");
        unstageBtn.className = "git-action-btn";
        unstageBtn.textContent = "-";
        unstageBtn.title = "Unstage";
        unstageBtn.onclick = async (e) => {
          e.stopPropagation();
          try {
            await window.__TAURI__.core.invoke("git_unstage", { path: item.path });
            refreshGitStatus();
          } catch (err) {
            showStatus("Unstage failed: " + err, true);
          }
        };
        actions.appendChild(unstageBtn);
      }
      
      row.appendChild(actions);
      
      row.onclick = async () => {
        document.querySelectorAll(".git-file.active").forEach((el) => el.classList.remove("active"));
        row.classList.add("active");
        
        try {
          const diff = await window.__TAURI__.core.invoke("git_diff", { path: item.path });
          currentFilePath = item.path; // somewhat hacky: pretending diff is a file for editor
          editor.dispatch({
            changes: { from: 0, to: editor.state.doc.length, insert: diff || "(no diff output / new file)" },
            effects: languageCompartment.reconfigure([]), // No specific language, plain text or diff
          });
          currentFileEl.textContent = "Diff: " + item.path;
        } catch (err) {
          showStatus("Failed to get diff: " + err, true);
        }
      };
      
      gitStatusList.appendChild(row);
    }
  } catch (err) {
    gitStatusList.innerHTML = "<div class='tree-error'>Error: " + err + "</div>";
  }
}

gitCommitBtn.addEventListener("click", async () => {
  const msg = gitCommitMsg.value.trim();
  if (!msg) {
    showStatus("Commit message required", true);
    return;
  }
  if (!currentWorkspacePath) return;
  
  try {
    await window.__TAURI__.core.invoke("git_commit_action", { message: msg });
    gitCommitMsg.value = "";
    showStatus("Committed");
    refreshGitStatus();
  } catch (err) {
    showStatus("Commit failed: " + err, true);
  }
});