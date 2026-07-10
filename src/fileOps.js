// File content operations against the editor: open, save, revert, commit,
// plus the external-change watcher. See lspClient.js's top comment for why
// the mutual import with that module (notifyDidOpen/notifyDidClose here,
// openFile there) is safe rather than a bug.

import { appState, showStatus } from "./state.js";
import { getEditor, setEditorContent } from "./editorSetup.js";
import { notifyDidOpen, notifyDidClose } from "./lspClient.js";
import {
  openOrSwitchToFile,
  updateActiveTabSavedDoc,
  closeTabByPath,
  getTabs,
  getEffectiveContent,
  markTabSaved,
  renderTabBar,
} from "./tabs.js";

export async function openFile(path) {
  try {
    const { tab, isNew, content } = await openOrSwitchToFile(path);
    await notifyDidOpen(path, content);
  } catch (err) {
    // Previously this overwrote the editor's content in place with an
    // error message. Under the tab model that would corrupt whatever tab
    // happens to be currently active (its cached EditorState, not just a
    // transient display) if the open that failed wasn't for the active
    // tab — so this is now a status message instead of clobbering a tab's
    // actual document. Intentional change, not an oversight.
    showStatus("Failed to open " + path + ": " + err, true);
  }
}

/// Fixes a real latent bug found during the Phase 6.5 module split: the
/// command palette's "Editor: Save File" action called a `saveFile()` that
/// never existed anywhere in the codebase — it would have thrown
/// ReferenceError if ever triggered. This is now the single source of
/// truth for saving, used by both the Save button and the command palette.
export async function saveFile() {
  if (!appState.currentFilePath) return showStatus("No file open", true);
  const editor = getEditor();
  try {
    appState.suppressNextReload = true;
    const content = editor.state.doc.toString();
    await window.__TAURI__.core.invoke("write_text_file", {
      path: appState.currentFilePath,
      content,
    });
    updateActiveTabSavedDoc(content);
    showStatus("Saved");
  } catch (err) {
    showStatus("Save failed: " + err, true);
  }
}

export async function revertFile() {
  if (!appState.currentFilePath) return showStatus("No file open", true);
  try {
    appState.suppressNextReload = true;
    const content = await window.__TAURI__.core.invoke("revert_file", { path: appState.currentFilePath });
    setEditorContent(content);
    updateActiveTabSavedDoc(content);
    showStatus("Reverted to last snapshot");
  } catch (err) {
    showStatus("Revert failed: " + err, true);
  }
}

export async function commitFile() {
  if (!appState.currentFilePath) return showStatus("No file open", true);
  try {
    await window.__TAURI__.core.invoke("commit_file", { path: appState.currentFilePath });
    showStatus("Committed — snapshot cleared");
  } catch (err) {
    showStatus("Commit failed: " + err, true);
  }
}

export function initFileOpsBindings() {
  document.getElementById("save-btn").addEventListener("click", saveFile);
  document.getElementById("revert-btn").addEventListener("click", revertFile);
  document.getElementById("commit-btn").addEventListener("click", commitFile);
  document.addEventListener("keydown", (e) => {
    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && key === "s" && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      saveFile();
    }
  });

  document.addEventListener("keydown", (e) => {
    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && key === "s" && e.altKey) {
      e.preventDefault();
      saveAllFiles();
    } else if ((e.ctrlKey || e.metaKey) && key === "s" && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      saveFile();
    }
  });

  window.__TAURI__.event.listen("file-changed", async (event) => {
    const changedPath = event.payload;
    const sameFile =
      changedPath === appState.currentFilePath ||
      (appState.currentFilePath && changedPath.split("/").pop() === appState.currentFilePath.split("/").pop());
    if (!sameFile) return;

    if (appState.suppressNextReload) {
      appState.suppressNextReload = false;
      return;
    }

    try {
      const content = await window.__TAURI__.core.invoke("read_text_file", { path: changedPath });
      setEditorContent(content);
      updateActiveTabSavedDoc(content);
      showStatus("Reloaded — changed on disk externally");
    } catch (err) {
      showStatus("File changed but couldn't reload: " + err, true);
    }
  });
}

export async function saveAllFiles() {
  const dirtyTabs = getTabs().filter((t) => t.dirty);
  if (dirtyTabs.length === 0) return showStatus("Nothing to save");

  appState.suppressNextReload = true; // covers the active tab's own write, same guard saveFile() uses
  let failed = 0;
  for (const tab of dirtyTabs) {
    const content = getEffectiveContent(tab);
    try {
      await window.__TAURI__.core.invoke("write_text_file", { path: tab.path, content });
      markTabSaved(tab, content);
    } catch (err) {
      failed++;
      console.error(`Failed to save ${tab.path}:`, err);
    }
  }
  renderTabBar();
  showStatus(
    failed === 0 ? `Saved ${dirtyTabs.length} file(s)` : `Saved ${dirtyTabs.length - failed}, ${failed} failed`,
    failed > 0
  );
}

/// Closing a tab that ISN'T the active one needs no LSP notification at
/// all — per the single-active-document LSP model (locked decision,
/// 2026-07-09), switching away from a tab already triggers an implicit
/// didClose as a side effect of the next tab's didOpen (see
/// lspClient.js's notifyDidOpen). So a background tab's document is
/// already closed server-side by the time its tab gets closed here.
/// Closing the ACTIVE tab is different: if another tab takes its place,
/// that reuses the same "didOpen triggers didClose of whatever was open"
/// mechanism. But if it was the LAST tab, nothing else calls didOpen to
/// trigger that implicit close — so this explicitly sends didClose itself
/// in that one case, otherwise the server would be left thinking a
/// document is still open when Anvil has no tabs left at all.
export async function closeTab(path) {
  const result = closeTabByPath(path);
  if (!result) return;

  if (result.closedWasActive) {
    if (result.nextTab) {
      await notifyDidOpen(result.nextTab.path, result.nextTab.editorState.doc.toString());
    } else {
      await notifyDidClose(path);
    }
  }
}