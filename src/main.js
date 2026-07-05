// Anvil Editor — Phase 3 frontend
//
// Adds: filesystem watcher event handling (auto-reload on external
// changes), Save/Revert/Commit wired to the snapshot model in history.rs,
// and an AI prompt bar that inserts completions at the cursor.

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

const languageCompartment = new Compartment();
const currentFileEl = document.getElementById("current-file");
const statusEl = document.getElementById("status-msg");

let currentFilePath = null;
// Tracks whether the last write to disk for the current file came from us
// (Save/Revert), so the watcher-triggered reload doesn't fight in-progress
// edits when the change genuinely came from outside the editor.
let suppressNextReload = false;

const editor = new EditorView({
  doc: "// Open a folder on the left, then click a file to edit it.\n",
  extensions: [basicSetup, languageCompartment.of([]), oneDark],
  parent: document.getElementById("editor"),
});

function showStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
  setTimeout(() => {
    if (statusEl.textContent === message) statusEl.textContent = "";
  }, 3000);
}

function setEditorContent(content) {
  editor.dispatch({
    changes: { from: 0, to: editor.state.doc.length, insert: content },
  });
}

async function openFile(path) {
  try {
    const content = await window.__TAURI__.core.invoke("read_text_file", { path });
    currentFilePath = path;
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: content },
      effects: languageCompartment.reconfigure(languageForPath(path)),
    });
    currentFileEl.textContent = path;
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

// --- Filesystem watcher: View Invalidation (spec §5 step 3) ---

window.__TAURI__.event.listen("file-changed", async (event) => {
  const changedPath = event.payload;
  if (changedPath !== currentFilePath) return;

  if (suppressNextReload) {
    suppressNextReload = false;
    return;
  }

  try {
    const content = await window.__TAURI__.core.invoke("read_text_file", { path: changedPath });
    setEditorContent(content);
    showStatus("Reloaded — changed on disk externally");
  } catch (err) {
    // File may have been deleted/moved — not fatal, just surface it.
    showStatus("File changed but couldn't reload: " + err, true);
  }
});

// --- AI generation reaching the editor ---

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
    editor.dispatch({
      changes: { from: cursorPos, insert: response },
    });
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
