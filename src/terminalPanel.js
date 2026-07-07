// Integrated terminal: xterm.js frontend, wired to the portable-pty backed
// spawn_terminal/write_terminal/resize_terminal commands.

import { Terminal } from "./vendor/xterm.js";
import { FitAddon } from "./vendor/xterm-addon-fit.js";
import { appState, showStatus } from "./state.js";
import { getEditor } from "./editorSetup.js";

const term = new Terminal({
  fontFamily: '"JetBrains Mono", "Fira Code", Consolas, monospace',
  fontSize: 13,
  theme: {
    background: "transparent",
    foreground: "#cccccc",
    cursor: "#f0514e",
  },
  allowTransparency: true,
});
const fitAddon = new FitAddon();
term.loadAddon(fitAddon);

let terminalSpawned = false;

export function initTerminalBindings() {
  const terminalPanel = document.getElementById("terminal-panel");
  const terminalToggleBtn = document.getElementById("terminal-toggle-btn");
  const terminalContainer = document.getElementById("terminal-container");

  terminalToggleBtn.addEventListener("click", async () => {
    if (terminalPanel.style.display === "none") {
      terminalPanel.style.display = "flex";
      if (!term.element) {
        term.open(terminalContainer);
      }

      requestAnimationFrame(() => {
        fitAddon.fit();
      });

      if (!terminalSpawned && appState.currentWorkspacePath) {
        try {
          await window.__TAURI__.core.invoke("spawn_terminal", { cwd: appState.currentWorkspacePath });
          terminalSpawned = true;
        } catch (err) {
          showStatus("Failed to spawn terminal: " + err, true);
        }
      }
      term.focus();
    } else {
      terminalPanel.style.display = "none";
      getEditor().focus();
    }
  });

  term.onData(async (data) => {
    if (terminalSpawned) {
      try {
        await window.__TAURI__.core.invoke("write_terminal", { data });
      } catch (err) {
        console.error("write_terminal error:", err);
      }
    }
  });

  term.onResize(async ({ cols, rows }) => {
    if (terminalSpawned) {
      try {
        await window.__TAURI__.core.invoke("resize_terminal", { cols, rows });
      } catch (err) {
        console.error("resize_terminal error:", err);
      }
    }
  });

  window.addEventListener("resize", () => {
    if (terminalPanel.style.display !== "none") {
      fitAddon.fit();
    }
  });

  window.__TAURI__.event.listen("terminal-data", (event) => {
    term.write(event.payload);
  });

  window.__TAURI__.event.listen("terminal-exit", () => {
    terminalSpawned = false;
    term.write("\r\n[Terminal exited]\r\n");
  });
}

export function toggleTerminal() {
  document.getElementById("terminal-toggle-btn").click();
}
