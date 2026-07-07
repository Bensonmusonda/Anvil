// Sidebar file tree: lazy-loaded directory browsing, workspace opening,
// and the native folder picker.

import { appState, showStatus } from "./state.js";
import { maybeStartLsp } from "./lspClient.js";
import { openFile } from "./fileOps.js";

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

export async function openWorkspace(path) {
  appState.currentWorkspacePath = path;
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

export function initFileTreeBindings() {
  document.getElementById("open-btn").addEventListener("click", () => {
    const path = document.getElementById("workspace-path").value.trim();
    if (path) openWorkspace(path);
  });

  document.getElementById("workspace-path").addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("open-btn").click();
  });

  document.getElementById("browse-folder-btn").addEventListener("click", openFolderDialog);
  document.getElementById("open-folder-btn").addEventListener("click", () => {
    document.querySelectorAll(".dropdown-content").forEach((dc) => dc.classList.remove("show"));
    document.querySelectorAll(".dropdown-btn").forEach((db) => db.classList.remove("active"));
    openFolderDialog();
  });
}
