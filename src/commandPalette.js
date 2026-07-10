// Command palette: Ctrl/Cmd+P for fuzzy file search, Ctrl/Cmd+Shift+P for
// commands. Depends on fileOps/terminalPanel/gitPanel/agentPanel for the
// actions it can trigger — this is intentionally the most "connected"
// module, since a command palette's whole job is dispatching into
// everything else.

import { appState, showStatus } from "./state.js";
import { openFile, saveFile, saveAllFiles } from "./fileOps.js";
import { toggleTerminal } from "./terminalPanel.js";
import { refreshGitStatus } from "./gitPanel.js";
import { runAgent } from "./agentPanel.js";
import { getEditor } from "./editorSetup.js";

let paletteItems = [];
let paletteSelectedIndex = 0;
let paletteMode = "files"; // "files" or "commands"
let paletteTimeout = null;

const AVAILABLE_COMMANDS = [
  { id: "git.refresh", title: "Git: Refresh Status" },
  { id: "terminal.toggle", title: "Terminal: Toggle Panel" },
  { id: "editor.save", title: "Editor: Save File" },
  { id: "editor.saveAll", title: "Editor: Save All Files" },
  { id: "agent.run", title: "Agent: Run" },
  { id: "theme.dark", title: "Theme: Anvil Dark" },
  { id: "theme.light", title: "Theme: Anvil Light" },
  { id: "theme.hacker", title: "Theme: Hacker" },
];

function executeCommand(id) {
  switch (id) {
    case "git.refresh":
      if (appState.currentWorkspacePath) refreshGitStatus();
      break;
    case "terminal.toggle":
      toggleTerminal();
      break;
    case "editor.save":
      // Fixed during the Phase 6.5 split: this called a non-existent
      // saveFile() before — see fileOps.js's comment on that bug.
      saveFile();
      break;
    case "editor.saveAll":
      saveAllFiles();
      break;
    case "agent.run":
      runAgent();
      break;
    case "theme.dark":
      document.documentElement.setAttribute("data-theme", "dark");
      break;
    case "theme.light":
      document.documentElement.setAttribute("data-theme", "light");
      break;
    case "theme.hacker":
      document.documentElement.setAttribute("data-theme", "hacker");
      break;
  }
}

function renderPaletteSelection() {
  const paletteResults = document.getElementById("palette-results");
  const children = paletteResults.children;
  for (let i = 0; i < children.length; i++) {
    if (i === paletteSelectedIndex) {
      children[i].classList.add("selected");
      children[i].scrollIntoView({ block: "nearest" });
    } else {
      children[i].classList.remove("selected");
    }
  }
}

async function updatePaletteResults() {
  const paletteInput = document.getElementById("palette-input");
  const paletteResults = document.getElementById("palette-results");
  const query = paletteInput.value.toLowerCase();

  try {
    if (paletteMode === "files") {
      paletteItems = await window.__TAURI__.core.invoke("fuzzy_files", { query });
    } else {
      paletteItems = AVAILABLE_COMMANDS.filter(
        (cmd) => cmd.title.toLowerCase().includes(query) || cmd.id.toLowerCase().includes(query)
      );
    }

    paletteSelectedIndex = 0;
    paletteResults.innerHTML = "";
    if (paletteItems.length === 0) {
      paletteResults.innerHTML = `<div class='palette-item'><span class='palette-item-path'>No ${paletteMode} found</span></div>`;
      return;
    }

    paletteItems.forEach((item, index) => {
      const div = document.createElement("div");
      div.className = "palette-item";
      if (index === paletteSelectedIndex) div.classList.add("selected");

      const label = paletteMode === "files" ? item.path : item.title;
      div.innerHTML = `<span class="palette-item-path">${label}</span>`;

      div.onmousedown = () => {
        closeCommandPalette();
        if (paletteMode === "files") {
          const absPath = appState.currentWorkspacePath + "/" + item.path;
          openFile(absPath);
        } else {
          executeCommand(item.id);
        }
      };
      div.onmouseover = () => {
        paletteSelectedIndex = index;
        renderPaletteSelection();
      };
      paletteResults.appendChild(div);
    });

    renderPaletteSelection();
  } catch (err) {
    paletteResults.innerHTML = `<div class="palette-item" style="color:var(--error)">Error: ${err}</div>`;
  }
}

function openCommandPalette(mode) {
  const paletteOverlay = document.getElementById("command-palette");
  const paletteInput = document.getElementById("palette-input");
  const paletteResults = document.getElementById("palette-results");

  if (mode === "files" && !appState.currentWorkspacePath) {
    showStatus("Open a workspace first to use the file palette.", true);
    return;
  }
  paletteMode = mode;
  paletteOverlay.style.display = "flex";
  paletteInput.value = "";
  paletteInput.placeholder = mode === "files" ? "Search files..." : "Search commands...";
  paletteResults.innerHTML = "";
  paletteInput.focus();
  updatePaletteResults();
}

function closeCommandPalette() {
  document.getElementById("command-palette").style.display = "none";
  getEditor().focus();
}

export function initCommandPaletteBindings() {
  const paletteOverlay = document.getElementById("command-palette");
  const paletteInput = document.getElementById("palette-input");

  paletteOverlay.addEventListener("mousedown", (e) => {
    if (e.target === paletteOverlay) closeCommandPalette();
  });

  paletteInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeCommandPalette();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (paletteSelectedIndex < paletteItems.length - 1) {
        paletteSelectedIndex++;
        renderPaletteSelection();
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (paletteSelectedIndex > 0) {
        paletteSelectedIndex--;
        renderPaletteSelection();
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (paletteItems.length > 0) {
        const selectedItem = paletteItems[paletteSelectedIndex];
        closeCommandPalette();

        if (paletteMode === "files") {
          const absPath = appState.currentWorkspacePath + "/" + selectedItem.path;
          // Fixed during the Phase 6.5 split: this called a non-existent
          // loadFile() before — would have thrown ReferenceError the first
          // time anyone opened a file via the command palette.
          openFile(absPath);
        } else if (paletteMode === "commands") {
          executeCommand(selectedItem.id);
        }
      }
    }
  });

  paletteInput.addEventListener("input", () => {
    clearTimeout(paletteTimeout);
    paletteTimeout = setTimeout(() => {
      updatePaletteResults();
    }, 100);
  });

  // Global shortcuts to open the palette in each mode.
  document.addEventListener("keydown", (e) => {
    if (e.key === "p" && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
      e.preventDefault();
      openCommandPalette("files");
    }
    if (e.key === "P" && (e.ctrlKey || e.metaKey) && e.shiftKey) {
      e.preventDefault();
      openCommandPalette("commands");
    }
  });
}
