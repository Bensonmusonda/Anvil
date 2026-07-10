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

  // Closes whichever dropdown is open the moment an item inside it is
  // actually clicked — delegated to the container so every current and
  // future .dropdown-item gets this for free, instead of each button's
  // own handler needing to remember to do it.
  document.querySelectorAll(".dropdown-content").forEach((dc) => {
    dc.addEventListener("click", (e) => {
      if (e.target.closest(".dropdown-item")) {
        document.querySelectorAll(".dropdown-content").forEach((d) => d.classList.remove("show"));
        document.querySelectorAll(".dropdown-btn").forEach((db) => db.classList.remove("active"));
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
  const agentCloseBtn = document.getElementById("agent-close-btn");
  const rightSidebar = document.getElementById("right-sidebar");

  agentToggleBtn.addEventListener("click", () => {
    rightSidebar.style.display = rightSidebar.style.display === "none" ? "flex" : "none";
  });

  agentCloseBtn.addEventListener("click", () => {
    rightSidebar.style.display = "none"; // unconditional close, unlike the toggle button
  });
}

export function initUiChrome() {
  document.addEventListener("DOMContentLoaded", () => {
    initDropdowns();
    initWindowControls();
  });
  initSidebarTabs();
  initAgentPaneToggle();
  initPaneResize();
  loadPaneWidths();
}

const MIN_PANE_WIDTH = 180;
const MAX_PANE_WIDTH = 500;
const MAX_RIGHT_PANE_WIDTH = 750;

function makeResizable(resizer, pane, getDelta, maxWidth = MAX_PANE_WIDTH) {
  let dragging = false;
  let startX = 0;
  let startWidth = 0;

  resizer.addEventListener("mousedown", (e) => {
    dragging = true;
    startX = e.clientX;
    startWidth = pane.getBoundingClientRect().width;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none"; // prevents selecting editor text while dragging across it
    e.preventDefault();
  });

  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const delta = e.clientX - startX;
    const newWidth = Math.min(maxWidth, Math.max(MIN_PANE_WIDTH, startWidth + getDelta(delta)));
    pane.style.width = newWidth + "px";
  });

  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    persistPaneWidths(); // fires once, on release — not per pixel during the drag
  });
}

function persistPaneWidths() {
  const left = Math.round(document.getElementById("sidebar").getBoundingClientRect().width);
  const right = Math.round(document.getElementById("right-sidebar").getBoundingClientRect().width);
  window.__TAURI__.core.invoke("save_pane_widths", { left, right }).catch((err) => {
    console.error("Failed to save pane widths:", err);
  });
}

async function loadPaneWidths() {
  try {
    const widths = await window.__TAURI__.core.invoke("get_pane_widths");
    document.getElementById("sidebar").style.width = widths.left + "px";
    document.getElementById("right-sidebar").style.width = widths.right + "px";
  } catch (err) {
    console.error("Failed to load pane widths:", err);
  }
}

function initPaneResize() {
  makeResizable(document.getElementById("sidebar-resizer"), document.getElementById("sidebar"), (delta) => delta);
  makeResizable(document.getElementById("right-sidebar-resizer"), document.getElementById("right-sidebar"), (delta) => -delta, MAX_RIGHT_PANE_WIDTH);
}