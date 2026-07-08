// Window chrome: custom titlebar dropdowns, minimize/maximize/close,
// window dragging, and the two tab-switching mechanisms (Explorer/Git in
// the left sidebar, Agent pane show/hide on the right).

import { appState } from "./state.js";
import { refreshGitStatus } from "./gitPanel.js";

function initDropdowns() {
  document.querySelectorAll(".dropdown-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const dropdown = btn.nextElementSibling;
      const isShowing = dropdown.classList.contains("show");

      document.querySelectorAll(".dropdown-content").forEach((dc) => dc.classList.remove("show"));
      document.querySelectorAll(".dropdown-btn").forEach((db) => db.classList.remove("active"));

      if (!isShowing) {
        dropdown.classList.add("show");
        btn.classList.add("active");
      }
    });
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".dropdown")) {
      document.querySelectorAll(".dropdown-content").forEach((dc) => dc.classList.remove("show"));
      document.querySelectorAll(".dropdown-btn").forEach((db) => db.classList.remove("active"));
    }
  });
}

function initWindowControls() {
  document.getElementById("win-minimize")?.addEventListener("click", () => {
    window.__TAURI__.core.invoke("win_minimize");
  });
  document.getElementById("win-maximize")?.addEventListener("click", () => {
    window.__TAURI__.core.invoke("win_toggle_maximize");
  });
  document.getElementById("win-close")?.addEventListener("click", () => {
    window.__TAURI__.core.invoke("win_close");
  });

  document.querySelector(".top-bar")?.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    const tag = e.target.tagName.toLowerCase();
    const interactive = ["button", "input", "textarea", "select", "a"];
    if (interactive.includes(tag)) return;
    if (e.target.closest(".window-controls, .dropdown, .top-bar-menu")) return;
    window.__TAURI__.window.getCurrentWindow().startDragging();
  });
}

function switchSidebarTab(tabId) {
  const tabFiles = document.getElementById("tab-files");
  const tabGit = document.getElementById("tab-git");
  const panelFiles = document.getElementById("files-panel");
  const panelGit = document.getElementById("git-panel");

  [tabFiles, tabGit].forEach((t) => t.classList.remove("active"));
  [panelFiles, panelGit].forEach((p) => (p.style.display = "none"));

  if (tabId === "files") {
    tabFiles.classList.add("active");
    panelFiles.style.display = "flex";
  } else if (tabId === "git") {
    tabGit.classList.add("active");
    panelGit.style.display = "flex";
    if (appState.currentWorkspacePath) refreshGitStatus();
  }
}

// One handler per tab button, replacing the previous split between a
// separate collapse-toggle listener and this switch listener. The two
// used to race on the same click: switchSidebarTab (whichever listener
// ran first) added .active to the clicked tab, so the other listener
// would then see it as "already active" and immediately close the
// sidebar it had just opened/switched. Reading isActive/isOpen once,
// before any mutation, removes the race entirely.
function initSidebarTabs() {
  const sidebar = document.getElementById("sidebar");

  function handleTabClick(tabId, tabEl) {
    const isActive = tabEl.classList.contains("active");
    const isOpen = sidebar.style.display !== "none";

    if (isActive && isOpen) {
      sidebar.style.display = "none";
      return;
    }

    sidebar.style.display = "flex";
    switchSidebarTab(tabId);
  }

  const tabFiles = document.getElementById("tab-files");
  const tabGit = document.getElementById("tab-git");
  tabFiles.addEventListener("click", () => handleTabClick("files", tabFiles));
  tabGit.addEventListener("click", () => handleTabClick("git", tabGit));
}

// Lets other modules (fileTree.js, before showing an inline create input)
// make sure the Explorer pane is actually open and visible, rather than
// silently building UI inside a hidden panel.
export function showExplorerPanel() {
  document.getElementById("sidebar").style.display = "flex";
  switchSidebarTab("files");
}

function initAgentPaneToggle() {
  const agentToggleBtn = document.getElementById("agent-toggle-btn");
  const rightSidebar = document.getElementById("right-sidebar");

  agentToggleBtn.addEventListener("click", () => {
    rightSidebar.style.display = rightSidebar.style.display === "none" ? "flex" : "none";
  });
}

export function initUiChrome() {
  document.addEventListener("DOMContentLoaded", () => {
    initDropdowns();
    initWindowControls();
  });
  // These don't need DOMContentLoaded since main.js itself only runs after
  // the module script is parsed, which is already deferred until the DOM
  // is ready (standard behavior for type="module" scripts).
  initSidebarTabs();
  initAgentPaneToggle();
}