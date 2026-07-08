// Sidebar file tree: lazy-loaded directory browsing, workspace opening,
// the native folder picker, and (Phase 7) inline file/folder creation via
// a right-click context menu, the File dropdown, or the empty-state panel.

import { appState, showStatus } from "./state.js";
import { maybeStartLsp } from "./lspClient.js";
import { openFile } from "./fileOps.js";
import { updateEmptyState } from "./emptyState.js";
import { showExplorerPanel } from "./uiChrome.js";
import { showPromptDialog } from "./promptDialog.js";

// Folder paths the user currently has expanded, preserved across
// refreshTree() so creating a file doesn't collapse the whole tree.
const expandedPaths = new Set();

// Maps a directory path -> the DOM element holding its rendered children.
// Populated as folders are loaded; cleared and rebuilt on every refresh.
const containerForPath = new Map();

// Maps a directory path -> an async function that expands+loads it if not
// already loaded. Lets context-menu/toolbar actions target a folder that
// isn't currently open in the tree.
const expandTriggers = new Map();

// The single "active" row in the tree (file or folder) — set by clicking
// a row. A folder's target is itself; a file's target is its parent dir.
// Drives where "New File"/"New Folder" land regardless of entry point
// (dropdown, empty-state panel, or right-click context menu on this row).
let activeSelection = null; // { path, isDir, parentPath }

// The single pending inline create input, if any. Guarded so that clicking
// "New File" repeatedly (e.g. while the Explorer panel is hidden behind
// the Git tab, where the input silently fails to focus and would never
// otherwise get cancelled) can't leave multiple stray input rows behind —
// starting a new one always cancels whichever one is still open first.
let activeInlineEdit = null; // { row, cancel }

function getCreateTargetDir() {
  if (!activeSelection) return appState.currentWorkspacePath;
  return activeSelection.isDir ? activeSelection.path : activeSelection.parentPath;
}

function setActiveRow(row, entry, parentPath) {
  document.querySelectorAll(".tree-row.active").forEach((el) => el.classList.remove("active"));
  row.classList.add("active");
  activeSelection = { path: entry.path, isDir: entry.is_dir, parentPath };
}

function iconFor(entry) {
  return entry.is_dir ? "\u25B8" : "\u2022";
}

async function buildTreeNode(entry, container, parentPath) {
  const row = document.createElement("div");
  row.className = "tree-row";
  row.dataset.path = entry.path;
  if (activeSelection && activeSelection.path === entry.path) {
    row.classList.add("active");
  }

  const caret = document.createElement("span");
  caret.className = "tree-caret";
  caret.textContent = entry.is_dir ? iconFor(entry) : " ";
  row.appendChild(caret);

  const label = document.createElement("span");
  label.textContent = entry.name;
  row.appendChild(label);

  container.appendChild(row);

  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const targetDir = entry.is_dir ? entry.path : parentPath;
    showTreeContextMenu(e.pageX, e.pageY, targetDir);
  });

  if (!entry.is_dir) {
    row.addEventListener("click", () => {
      setActiveRow(row, entry, parentPath);
      openFile(entry.path);
    });
    return;
  }

  let childrenEl = null;
  let loaded = false;
  let expanded = expandedPaths.has(entry.path);
  caret.textContent = expanded ? "\u25BE" : "\u25B8";

  async function loadChildren() {
    loaded = true;
    childrenEl = document.createElement("div");
    childrenEl.className = "tree-children";
    row.insertAdjacentElement("afterend", childrenEl);
    containerForPath.set(entry.path, childrenEl);
    try {
      const children = await window.__TAURI__.core.invoke("list_dir", { path: entry.path });
      for (const child of children) {
        await buildTreeNode(child, childrenEl, entry.path);
      }
    } catch (err) {
      const errEl = document.createElement("div");
      errEl.className = "tree-error";
      errEl.textContent = "Error: " + err;
      childrenEl.appendChild(errEl);
    }
  }

  // Lets a context-menu/toolbar action force this folder open even if the
  // user never clicked it, so "New File" inside a collapsed folder works.
  expandTriggers.set(entry.path, async () => {
    if (!loaded) await loadChildren();
    if (!expanded) {
      expanded = true;
      expandedPaths.add(entry.path);
      caret.textContent = "\u25BE";
      childrenEl.style.display = "block";
    }
  });

  // Expand/collapse is caret-only — clicking the row itself just selects
  // it as the active create-target, it no longer toggles.
  caret.addEventListener("click", async (e) => {
    e.stopPropagation();
    expanded = !expanded;
    caret.textContent = expanded ? "\u25BE" : "\u25B8";
    if (expanded) {
      expandedPaths.add(entry.path);
    } else {
      expandedPaths.delete(entry.path);
    }
    if (!loaded) {
      await loadChildren();
    }
    childrenEl.style.display = expanded ? "block" : "none";
  });

  row.addEventListener("click", () => {
    setActiveRow(row, entry, parentPath);
  });

  // Restore expand state (e.g. after refreshTree() following a create).
  if (expanded) {
    await loadChildren();
    childrenEl.style.display = "block";
  }
}

async function buildRootTree(path) {
  const treeEl = document.getElementById("tree");
  treeEl.innerHTML = "";
  containerForPath.clear();
  expandTriggers.clear();
  containerForPath.set(path, treeEl);

  const entries = await window.__TAURI__.core.invoke("list_dir", { path });
  for (const entry of entries) {
    await buildTreeNode(entry, treeEl, path);
  }
  return entries;
}

// --- Phase 7: recent workspaces (rendered into the empty-state panel) ---

async function renderRecents() {
  const listEl = document.getElementById("empty-recent-list");
  if (!listEl) return;

  let recents = [];
  try {
    recents = await window.__TAURI__.core.invoke("get_recent_workspaces");
  } catch (err) {
    // Non-fatal — recents are a convenience, not core functionality.
    recents = [];
  }

  listEl.innerHTML = "";

  if (recents.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-recent-none";
    empty.textContent = "No recent workspaces";
    listEl.appendChild(empty);
    return;
  }

  for (const path of recents) {
    const item = document.createElement("button");
    item.className = "empty-option empty-recent-item";
    item.title = path;

    const name = document.createElement("span");
    name.className = "empty-recent-name";
    name.textContent = path.split(/[\\/]/).filter(Boolean).pop() || path;

    const full = document.createElement("span");
    full.className = "empty-recent-path";
    full.textContent = path;

    item.appendChild(name);
    item.appendChild(full);
    item.addEventListener("click", () => openWorkspace(path));
    listEl.appendChild(item);
  }
}

export async function openWorkspace(path) {
  appState.currentWorkspacePath = path;
  appState.currentFilePath = null;
  document.getElementById("workspace-path").value = path;
  document.getElementById("workspace-name").textContent = path.split(/[\\/]/).filter(Boolean).pop() || path;
  document.getElementById("current-file").textContent = "no file open";
  expandedPaths.clear();
  activeSelection = null;
  const treeEl = document.getElementById("tree");
  try {
    const entries = await buildRootTree(path);
    await window.__TAURI__.core.invoke("start_watching", { path });
    await maybeStartLsp(path, entries);
    try {
      await window.__TAURI__.core.invoke("add_recent_workspace", { path });
    } catch (err) {
      // Non-fatal — recent-workspaces tracking shouldn't block opening.
      console.warn("Failed to record recent workspace:", err);
    }
    await renderRecents();
    updateEmptyState();
  } catch (err) {
    treeEl.innerHTML = "";
    const errEl = document.createElement("div");
    errEl.className = "tree-error";
    errEl.textContent = "Error: " + err;
    treeEl.appendChild(errEl);
  }
}

// Rebuilds the tree in place from the same workspace root, preserving
// expandedPaths and activeSelection. Used after a file/folder is created —
// unlike openWorkspace(), it doesn't re-arm the watcher or LSP since the
// workspace itself hasn't changed.
export async function refreshTree() {
  if (!appState.currentWorkspacePath) return;
  try {
    await buildRootTree(appState.currentWorkspacePath);
  } catch (err) {
    showStatus("Failed to refresh tree: " + err, true);
  }
}

// --- Phase 7: inline file/folder creation ---

function createInlineInputRow(container, parentDir, isFile) {
  // Only one inline create row can be open at a time. This is what stops
  // repeated "New File" clicks (e.g. while the Explorer panel is hidden
  // and the new input can't actually receive focus, so blur never fires
  // to clean it up) from leaving multiple stray rows behind.
  if (activeInlineEdit) {
    activeInlineEdit.cancel();
  }

  const row = document.createElement("div");
  row.className = "tree-row tree-input-row";

  const caret = document.createElement("span");
  caret.className = "tree-caret";
  caret.textContent = " ";
  row.appendChild(caret);

  const input = document.createElement("input");
  input.type = "text";
  input.className = "tree-inline-input";
  input.placeholder = isFile ? "file name" : "folder name";
  row.appendChild(input);

  container.insertBefore(row, container.firstChild);
  input.focus();

  let settled = false;

  function clearActiveIfSelf() {
    if (activeInlineEdit && activeInlineEdit.row === row) {
      activeInlineEdit = null;
    }
  }

  async function commit() {
    if (settled) return;
    const name = input.value.trim();
    if (!name) {
      cancel();
      return;
    }
    settled = true;
    clearActiveIfSelf();
    try {
      if (isFile) {
        const createdPath = await window.__TAURI__.core.invoke("create_file", { parentDir, name });
        showStatus("File created");
        // Pre-select the new file so refreshTree() re-highlights it, then
        // open it in the editor — same rebuild-then-restore pattern used
        // for expandedPaths.
        activeSelection = { path: createdPath, isDir: false, parentPath: parentDir };
        await refreshTree();
        await openFile(createdPath);
      } else {
        await window.__TAURI__.core.invoke("create_folder", { parentDir, name });
        showStatus("Folder created");
        await refreshTree();
      }
    } catch (err) {
      showStatus((isFile ? "Create file failed: " : "Create folder failed: ") + err, true);
      row.remove();
    }
  }

  function cancel() {
    if (settled) return;
    settled = true;
    clearActiveIfSelf();
    row.remove();
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  });

  input.addEventListener("blur", () => {
    if (!settled) cancel();
  });

  activeInlineEdit = { row, cancel };
}

async function beginInlineCreate(parentDir, isFile) {
  if (!parentDir) {
    showStatus("Open a workspace first", true);
    return;
  }

  showExplorerPanel();

  let container = containerForPath.get(parentDir);
  if (!container) {
    const trigger = expandTriggers.get(parentDir);
    if (trigger) {
      await trigger();
      container = containerForPath.get(parentDir);
    }
  }
  if (!container) {
    showStatus("Could not locate target folder", true);
    return;
  }

  createInlineInputRow(container, parentDir, isFile);
}

let activeContextMenu = null;

function closeTreeContextMenu() {
  if (activeContextMenu) {
    activeContextMenu.remove();
    activeContextMenu = null;
    document.removeEventListener("click", closeTreeContextMenu);
  }
}

function showTreeContextMenu(x, y, targetDir) {
  closeTreeContextMenu();

  const menu = document.createElement("div");
  menu.className = "context-menu";
  menu.style.left = x + "px";
  menu.style.top = y + "px";

  const newFileItem = document.createElement("div");
  newFileItem.className = "context-menu-item";
  newFileItem.textContent = "New File";
  newFileItem.addEventListener("click", () => {
    closeTreeContextMenu();
    beginInlineCreate(targetDir, true);
  });

  const newFolderItem = document.createElement("div");
  newFolderItem.className = "context-menu-item";
  newFolderItem.textContent = "New Folder";
  newFolderItem.addEventListener("click", () => {
    closeTreeContextMenu();
    beginInlineCreate(targetDir, false);
  });

  menu.appendChild(newFileItem);
  menu.appendChild(newFolderItem);
  document.body.appendChild(menu);
  activeContextMenu = menu;

  // Deferred so the click that opened the menu doesn't immediately close it.
  setTimeout(() => document.addEventListener("click", closeTreeContextMenu), 0);
}

async function openFolderDialog() {
  try {
    const selected = await window.__TAURI__.dialog.open({
      directory: true,
      multiple: false,
      title: "Open Workspace Folder",
    });
    if (selected) {
      openWorkspace(selected);
    }
  } catch (err) {
    showStatus("Folder picker failed: " + err, true);
  }
}

async function openFileDialog() {
  try {
    const selected = await window.__TAURI__.dialog.open({
      directory: false,
      multiple: false,
      title: "Open File",
    });
    if (selected) {
      await openFile(selected);
    }
  } catch (err) {
    showStatus("File picker failed: " + err, true);
  }
}

function splitParentAndName(fullPath) {
  const idx = Math.max(fullPath.lastIndexOf("/"), fullPath.lastIndexOf("\\"));
  return {
    parentDir: fullPath.substring(0, idx),
    name: fullPath.substring(idx + 1),
  };
}

// Creating without an open workspace can't use the inline tree-row flow —
// there's no tree to attach the input to. Use the native "save" dialog
// instead, which lets the user pick location and name in one step.
async function createFileWithoutWorkspace() {
  let savePath;
  try {
    savePath = await window.__TAURI__.dialog.save({ title: "New File" });
  } catch (err) {
    showStatus("File picker failed: " + err, true);
    return;
  }
  if (!savePath) return;

  const { parentDir, name } = splitParentAndName(savePath);
  try {
    const createdPath = await window.__TAURI__.core.invoke("create_file", { parentDir, name });
    // Save/Revert/Commit all require a workspace_root to snapshot against
    // — with none open yet, open the file's own directory as the
    // workspace so Save works immediately rather than erroring. This only
    // runs from createFileWithoutWorkspace(), which triggerNewFile() only
    // calls when appState.currentWorkspacePath is falsy.
    await openWorkspace(parentDir);
    activeSelection = { path: createdPath, isDir: false, parentPath: parentDir };
    await refreshTree();
    await openFile(createdPath);
    showStatus("File created — opened as workspace");
  } catch (err) {
    showStatus("Create file failed: " + err, true);
  }
}

// No native "save folder" dialog exists, so this is two steps: pick the
// parent location, then name the folder.
async function createFolderWithoutWorkspace() {
  let parentDir;
  try {
    parentDir = await window.__TAURI__.dialog.open({
      directory: true,
      multiple: false,
      title: "Choose where to create the new folder",
    });
  } catch (err) {
    showStatus("Folder picker failed: " + err, true);
    return;
  }
  if (!parentDir) return;

  const name = await showPromptDialog({ title: "New folder name", placeholder: "folder name" });
  if (!name) return;

  try {
    const createdPath = await window.__TAURI__.core.invoke("create_folder", {
      parentDir,
      name,
    });
    // Per your suggestion — open the newly created folder as the
    // workspace. This only runs from createFolderWithoutWorkspace(),
    // which triggerNewFolder() only calls when appState.currentWorkspacePath
    // is falsy — so this never fires while a workspace is already open.
    await openWorkspace(createdPath);
    showStatus("Folder created — opened as workspace");
  } catch (err) {
    showStatus("Create folder failed: " + err, true);
  }
}

async function triggerNewFile() {
  if (appState.currentWorkspacePath) {
    await beginInlineCreate(getCreateTargetDir(), true);
  } else {
    await createFileWithoutWorkspace();
  }
}

async function triggerNewFolder() {
  if (appState.currentWorkspacePath) {
    await beginInlineCreate(getCreateTargetDir(), false);
  } else {
    await createFolderWithoutWorkspace();
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

  document.getElementById("open-file-btn").addEventListener("click", () => {
    document.querySelectorAll(".dropdown-content").forEach((dc) => dc.classList.remove("show"));
    document.querySelectorAll(".dropdown-btn").forEach((db) => db.classList.remove("active"));
    openFileDialog();
  });

  document.getElementById("browse-folder-btn").addEventListener("click", openFolderDialog);
  document.getElementById("open-folder-btn").addEventListener("click", () => {
    document.querySelectorAll(".dropdown-content").forEach((dc) => dc.classList.remove("show"));
    document.querySelectorAll(".dropdown-btn").forEach((db) => db.classList.remove("active"));
    openFolderDialog();
  });

  // File dropdown's New File / New Folder — target whatever's active in
  // the tree (a selected folder, a selected file's parent, or workspace
  // root), or fall back to the no-workspace flow if nothing's open yet.
  document.getElementById("new-file-btn").addEventListener("click", triggerNewFile);
  document.getElementById("new-folder-btn").addEventListener("click", triggerNewFolder);

  // Empty-state panel: Open Folder / Open File reuse the same dialogs as
  // the toolbar/dropdown; New File / New Folder use the same triggers.
  document.getElementById("empty-open-folder-btn").addEventListener("click", openFolderDialog);
  document.getElementById("empty-open-file-btn").addEventListener("click", openFileDialog);
  document.getElementById("empty-new-file-btn").addEventListener("click", triggerNewFile);
  document.getElementById("empty-new-folder-btn").addEventListener("click", triggerNewFolder);

  // Right-click on empty tree background (not on a row) creates at root.
  document.getElementById("tree").addEventListener("contextmenu", (e) => {
    if (e.target.closest(".tree-row")) return;
    e.preventDefault();
    showTreeContextMenu(e.pageX, e.pageY, appState.currentWorkspacePath);
  });

  // Initial paint: nothing is open yet, so the empty-state panel (with its
  // recents list) should be visible from app launch.
  renderRecents();
  updateEmptyState();
}