// Agent task panel: sends a prompt through the tool-calling agent loop
// (agent_run) and renders the exchange as chat bubbles (prompts right-
// aligned, responses left-aligned). Maintains conversation history
// in-memory for the session — resets on app restart or "New Chat".

import { mountModelSelector, getSelectedModel } from "./modelSelector.js";
import { showSettingsDialog } from "./promptDialog.js";

let bindingsMounted = false;
let conversationHistory = []; // [{role: "user"|"assistant", content: string}, ...]

function appendMessage(role, text) {
  const agentOutput = document.getElementById("agent-output");
  const row = document.createElement("div");
  row.className = `chat-message chat-message--${role}`;
  const bubble = document.createElement("div");
  bubble.className = "chat-bubble";
  bubble.textContent = text;
  row.appendChild(bubble);
  agentOutput.appendChild(row);
  agentOutput.scrollTop = agentOutput.scrollHeight;
  return { row, bubble };
}

function clearConversation() {
  conversationHistory = [];
  document.getElementById("agent-output").replaceChildren();
}

export async function runAgent() {
  const agentPrompt = document.getElementById("agent-prompt");
  const agentBtn = document.getElementById("agent-btn");

  const prompt = agentPrompt.value.trim();
  if (!prompt) return;

  agentBtn.disabled = true;
  appendMessage("user", prompt);
  agentPrompt.value = "";

  const pending = appendMessage("pending", "Running agent — this can take a few seconds if it calls tools...");
  const historyForThisTurn = [...conversationHistory];

  try {
    const modelOverride = getSelectedModel();
    const result = await window.__TAURI__.core.invoke("agent_run", {
      prompt,
      provider: modelOverride?.provider ?? null,
      model: modelOverride?.model ?? null,
      history: historyForThisTurn,
    });
    pending.row.className = "chat-message chat-message--agent";
    pending.bubble.textContent = result;
    conversationHistory.push({ role: "user", content: prompt });
    conversationHistory.push({ role: "assistant", content: result });
  } catch (err) {
    pending.row.className = "chat-message chat-message--error";
    pending.bubble.textContent = "Agent failed: " + err;
  } finally {
    agentBtn.disabled = false;
    const agentOutput = document.getElementById("agent-output");
    agentOutput.scrollTop = agentOutput.scrollHeight;
  }
}

export function initAgentPanelBindings() {
  document.getElementById("agent-btn").addEventListener("click", runAgent);
  document.getElementById("agent-prompt").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      runAgent();
    }
    // Shift+Enter falls through to the textarea's default behavior — a newline.
  });
  if (bindingsMounted) return;
  bindingsMounted = true;

  // Model dropdown, mounted directly in the prompt box footer, before
  // the send button.
  const footer = document.getElementById("agent-prompt-box-footer");
  const sendBtn = document.getElementById("agent-btn");
  const selectorHost = document.createElement("div");
  footer.insertBefore(selectorHost, sendBtn);
  mountModelSelector(selectorHost);

  // New Chat + settings, mounted in the header, before the close button.
  const headerControls = document.getElementById("agent-header-controls");

  const newChatBtn = document.createElement("button");
  newChatBtn.className = "agent-header-icon-btn";
  newChatBtn.title = "New Chat";
  newChatBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>`;
  newChatBtn.addEventListener("click", clearConversation);
  headerControls.appendChild(newChatBtn);

  const settingsBtn = document.createElement("button");
  settingsBtn.className = "agent-header-icon-btn";
  settingsBtn.title = "Custom system prompts";
  settingsBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`;
  settingsBtn.addEventListener("click", async () => {
    const current = await window.__TAURI__.core.invoke("get_custom_prompts");
    const result = await showSettingsDialog({
      inlinePrompt: current.inline,
      chatPrompt: current.chat,
    });
    if (result) {
      await window.__TAURI__.core.invoke("save_custom_prompts", {
        inline: result.inlinePrompt,
        chat: result.chatPrompt,
      });
    }
  });
  headerControls.appendChild(settingsBtn);
}