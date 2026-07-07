// Shared app state and the status-bar helper. Deliberately zero
// dependencies on any other module — everything else depends on this,
// this depends on nothing, so it's the bottom of the graph.

export const appState = {
  currentWorkspacePath: null,
  currentFilePath: null,
  suppressNextReload: false,
};

const statusEl = document.getElementById("status-msg");

export function showStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
  setTimeout(() => {
    if (statusEl.textContent === message) statusEl.textContent = "";
  }, 3000);
}
