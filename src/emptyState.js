// Toggles the "no file open" overlay in the main editor area. Kept as its
// own tiny module (rather than folded into fileTree.js or fileOps.js) so
// both of those can call it without introducing a new circular import
// between them — the only intentional circular import in the codebase is
// the documented one between lspClient.js and fileOps.js.

import { appState } from "./state.js";

export function updateEmptyState() {
  const el = document.getElementById("empty-state");
  if (!el) return;
  const show = !appState.currentFilePath;
  el.style.display = show ? "flex" : "none";
}