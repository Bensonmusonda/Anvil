// Single-shot AI: the inline popup (Mod-k, opens near the cursor) that
// inserts a response directly into the editor at the cursor position.

import { keymap } from "./vendor/codemirror.bundle.js";
import { showStatus } from "./state.js";
import { getEditor } from "./editorSetup.js";

export function toggleAiPopup(view) {
  const aiPopup = document.getElementById("ai-popup");
  const aiPrompt = document.getElementById("ai-prompt");
  if (aiPopup.style.display === "none" || !aiPopup.style.display) {
    aiPopup.style.transform = "none";
    const coords = view.coordsAtPos(view.state.selection.main.head);
    if (coords) {
      aiPopup.style.left = `${coords.left}px`;
      aiPopup.style.top = `${coords.bottom + 5}px`;
    } else {
      aiPopup.style.left = "50%";
      aiPopup.style.top = "50%";
      aiPopup.style.transform = "translate(-50%, -50%)";
    }
    aiPopup.style.display = "block";
    aiPrompt.focus();
  } else {
    aiPopup.style.display = "none";
    view.focus();
  }
  return true;
}

export const aiPopupKeymap = keymap.of([{ key: "Mod-k", run: toggleAiPopup }]);

async function askAI() {
  const aiPrompt = document.getElementById("ai-prompt");
  const aiBtn = document.getElementById("ai-btn");
  const editor = getEditor();

  const prompt = aiPrompt.value.trim();
  if (!prompt) return;

  aiBtn.disabled = true;
  showStatus("Asking AI...");

  try {
    const response = await window.__TAURI__.core.invoke("ai_complete", {
      purpose: "chat",
      prompt,
    });
    const cursorPos = editor.state.selection.main.head;
    editor.dispatch({ changes: { from: cursorPos, insert: response } });
    aiPrompt.value = "";
    document.getElementById("ai-popup").style.display = "none";
    showStatus("Inserted AI response");
  } catch (err) {
    showStatus("AI request failed: " + err, true);
  } finally {
    aiBtn.disabled = false;
    editor.focus();
  }
}

export function initAiPanelBindings() {
  const aiPrompt = document.getElementById("ai-prompt");

  document.getElementById("ai-btn").addEventListener("click", askAI);
  aiPrompt.addEventListener("keydown", (e) => {
    if (e.key === "Enter") askAI();
    if (e.key === "Escape") {
      document.getElementById("ai-popup").style.display = "none";
      getEditor().focus();
    }
  });

  document.addEventListener("click", (e) => {
    const aiPopup = document.getElementById("ai-popup");
    if (aiPopup && aiPopup.style.display === "block") {
      if (!e.target.closest("#ai-popup")) {
        aiPopup.style.display = "none";
      }
    }
  });
}
