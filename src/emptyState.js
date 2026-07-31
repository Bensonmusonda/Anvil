// Toggles the "no file open" overlay in the main editor area. Kept as its
// own tiny module (rather than folded into fileTree.js or fileOps.js) so
// both of those can call it without introducing a new circular import
// between them — the only intentional circular import in the codebase is
// the documented one between lspClient.js and fileOps.js.

// Toggles the "no file open" overlay in the main editor area. Kept as its
// own tiny module (rather than folded into fileTree.js or fileOps.js) so
// both of those can call it without introducing a new circular import
// between them — the only intentional circular import in the codebase is
// the documented one between lspClient.js and fileOps.js.
//
// hasActiveTab is set by tabs.js each time the active tab changes, so this
// module doesn't need to import tabs.js (which would create a cycle).

let hasActiveTab = false;

export function setHasActiveTab(value) {
  hasActiveTab = value;
}

export function updateEmptyState() {
  const el = document.getElementById("empty-state");
  if (!el) return;
  el.style.display = hasActiveTab ? "none" : "flex";
}