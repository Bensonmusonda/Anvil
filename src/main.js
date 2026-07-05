// Anvil Editor — Phase 2 frontend
//
// Adds: a file tree (lazy-loaded via list_dir), opening files into the editor
// (read_text_file), and per-file syntax highlighting via a CodeMirror
// Compartment (swaps language support without recreating the EditorView).
//
// Requires an updated vendor bundle — see vendor-build/entry.js and the
// rebuild command in this phase's notes. The bundle must export:
// EditorView, basicSetup, Compartment, oneDark, and the language() functions
// used in LANGUAGE_BY_EXT below.

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

const editor = new EditorView({
  doc: "// Open a folder on the left, then click a file to edit it.\n",
  extensions: [basicSetup, languageCompartment.of([]), oneDark],
  parent: document.getElementById("editor"),
});

async function openFile(path) {
  try {
    const content = await window.__TAURI__.core.invoke("read_text_file", { path });
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: content },
      effects: languageCompartment.reconfigure(languageForPath(path)),
    });
    currentFileEl.textContent = path;
  } catch (err) {
    currentFileEl.textContent = "error opening file";
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: `// Failed to open ${path}\n// ${err}` },
    });
  }
}

function iconFor(entry) {
  return entry.is_dir ? "\u25B8" : "\u2022"; // ▸ for dirs, • for files
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

  // Directory: lazy-load children on first click, toggle visibility after.
  let childrenEl = null;
  let loaded = false;
  let expanded = false;

  row.addEventListener("click", async () => {
    expanded = !expanded;
    caret.textContent = expanded ? "\u25BE" : "\u25B8"; // ▾ / ▸

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