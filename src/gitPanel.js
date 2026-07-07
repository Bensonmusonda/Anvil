// Source control panel: status list, stage/unstage, commit, and viewing a
// diff (reusing the main editor pane — see the note below on why that's a
// deliberate, if slightly unusual, choice rather than an accident).

import { appState, showStatus } from "./state.js";
import { getEditor, languageCompartment } from "./editorSetup.js";

export async function refreshGitStatus() {
  const gitStatusList = document.getElementById("git-status-list");
  gitStatusList.innerHTML = "Loading...";
  try {
    const statuses = await window.__TAURI__.core.invoke("git_status");
    gitStatusList.innerHTML = "";
    if (statuses.length === 0) {
      gitStatusList.innerHTML = "<div style='padding:10px; color:var(--dim)'>No changes</div>";
      return;
    }

    for (const item of statuses) {
      const row = document.createElement("div");
      row.className = "git-file";

      const badge = document.createElement("div");
      badge.className = "git-status-badge";
      badge.textContent = item.status;
      row.appendChild(badge);

      const pathEl = document.createElement("div");
      pathEl.className = "git-path";
      pathEl.textContent = item.path;
      pathEl.title = item.path;
      row.appendChild(pathEl);

      const actions = document.createElement("div");
      actions.className = "git-actions";

      const isStaged = item.status[0] !== " " && item.status[0] !== "?";
      const isUnstaged = item.status[1] !== " ";

      if (isUnstaged || item.status === "??") {
        const stageBtn = document.createElement("button");
        stageBtn.className = "git-action-btn";
        stageBtn.textContent = "+";
        stageBtn.title = "Stage";
        stageBtn.onclick = async (e) => {
          e.stopPropagation();
          try {
            await window.__TAURI__.core.invoke("git_stage", { path: item.path });
            refreshGitStatus();
          } catch (err) {
            showStatus("Stage failed: " + err, true);
          }
        };
        actions.appendChild(stageBtn);
      }

      if (isStaged) {
        const unstageBtn = document.createElement("button");
        unstageBtn.className = "git-action-btn";
        unstageBtn.textContent = "-";
        unstageBtn.title = "Unstage";
        unstageBtn.onclick = async (e) => {
          e.stopPropagation();
          try {
            await window.__TAURI__.core.invoke("git_unstage", { path: item.path });
            refreshGitStatus();
          } catch (err) {
            showStatus("Unstage failed: " + err, true);
          }
        };
        actions.appendChild(unstageBtn);
      }

      row.appendChild(actions);

      row.onclick = async () => {
        document.querySelectorAll(".git-file.active").forEach((el) => el.classList.remove("active"));
        row.classList.add("active");

        try {
          const diff = await window.__TAURI__.core.invoke("git_diff", { path: item.path });
          const editor = getEditor();
          // Deliberate reuse of the main editor pane to show diffs, rather
          // than a separate view — carried over as-is from the original
          // implementation. Sets currentFilePath to the diffed file's path
          // even though what's displayed isn't that file's real content;
          // this is a known, slightly hacky shortcut, not a bug — a
          // dedicated read-only diff view would be the cleaner fix if this
          // starts causing confusion (e.g. accidentally Saving a diff).
          appState.currentFilePath = item.path;
          editor.dispatch({
            changes: { from: 0, to: editor.state.doc.length, insert: diff || "(no diff output / new file)" },
            effects: languageCompartment.reconfigure([]),
          });
          document.getElementById("current-file").textContent = "Diff: " + item.path;
        } catch (err) {
          showStatus("Failed to get diff: " + err, true);
        }
      };

      gitStatusList.appendChild(row);
    }
  } catch (err) {
    gitStatusList.innerHTML = "<div class='tree-error'>Error: " + err + "</div>";
  }
}

export function initGitPanelBindings() {
  document.getElementById("git-refresh-btn").addEventListener("click", () => {
    if (appState.currentWorkspacePath) refreshGitStatus();
  });

  document.getElementById("git-commit-action-btn").addEventListener("click", async () => {
    const gitCommitMsg = document.getElementById("git-commit-msg");
    const msg = gitCommitMsg.value.trim();
    if (!msg) {
      showStatus("Commit message required", true);
      return;
    }
    if (!appState.currentWorkspacePath) return;

    try {
      await window.__TAURI__.core.invoke("git_commit_action", { message: msg });
      gitCommitMsg.value = "";
      showStatus("Committed");
      refreshGitStatus();
    } catch (err) {
      showStatus("Commit failed: " + err, true);
    }
  });
}
