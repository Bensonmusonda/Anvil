// File content operations against the editor: open, save, revert, commit,
// plus the external-change watcher. See lspClient.js's top comment for why
// the mutual import with that module (notifyDidOpen/notifyDidClose here,
// openFile there) is safe rather than a bug.

import { appState, showStatus } from "./state.js";
import { getEditor, setEditorContent, languageCompartment, languageForPath } from "./editorSetup.js";
import { notifyDidOpen } from "./lspClient.js";
import { updateEmptyState } from "./emptyState.js";

export async function openFile(path) {
  const editor = getEditor();
  try {
    const content = await window.__TAURI__.core.invoke("read_text_file", { path });
    appState.currentFilePath = path;
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: content },
      effects: languageCompartment.reconfigure(languageForPath(path)),
    });
    document.getElementById("current-file").textContent = path;
    updateEmptyState();
    await notifyDidOpen(path, content);
  } catch (err) {
    document.getElementById("current-file").textContent = "error opening file";
    setEditorContent(`// Failed to open ${path}\n// ${err}`);
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
    await window.__TAURI__.core.invoke("write_text_file", {
      path: appState.currentFilePath,
      content: editor.state.doc.toString(),
    });
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
      showStatus("Reloaded — changed on disk externally");
    } catch (err) {
      showStatus("File changed but couldn't reload: " + err, true);
    }
  });
}