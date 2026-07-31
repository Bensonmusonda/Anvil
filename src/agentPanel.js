// Agent task panel: sends a prompt through the tool-calling agent loop
// (agent_run) and renders the exchange as chat bubbles (prompts right-
// aligned, responses left-aligned). Maintains conversation history
// in-memory for the session — resets on app restart or "New Chat".
//
// Every user/agent bubble gets a hover-revealed action row: copy on both,
// edit on user messages only. Editing a past prompt discards everything
// after it (both in the DOM and in conversationHistory) and resubmits
// from that point — same semantics as ChatGPT's edit.

import { mountModelSelector, getSelectedModel } from "./modelSelector.js";
import { showSettingsDialog } from "./promptDialog.js";

let bindingsMounted = false;
let conversationHistory = []; // [{role: "user"|"assistant", content: string}, ...]

const COPY_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
const EDIT_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>`;
const CHECK_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
const CLOSE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;

function createIconButton(title, svgInner) {
  const btn = document.createElement("button");
  btn.className = "chat-action-btn";
  btn.title = title;
  btn.innerHTML = svgInner;
  return btn;
}

function buildViewActions(row, role, turnStart) {
  const actions = document.createElement("div");
  actions.className = "chat-actions";

  const copyBtn = createIconButton("Copy", COPY_ICON);
  copyBtn.addEventListener("click", () => {
    const bubble = row.querySelector(".chat-bubble");
    navigator.clipboard.writeText(bubble.textContent).catch((err) => {
      console.error("Copy failed:", err);
    });
    copyBtn.innerHTML = CHECK_ICON;
    setTimeout(() => (copyBtn.innerHTML = COPY_ICON), 1000);
  });
  actions.appendChild(copyBtn);

  if (role === "user") {
    const editBtn = createIconButton("Edit", EDIT_ICON);
    editBtn.addEventListener("click", () => enterEditMode(row, turnStart));
    actions.appendChild(editBtn);
  }

  return actions;
}

function enterEditMode(row, turnStart) {
  const bubble = row.querySelector(".chat-bubble");
  const actions = row.querySelector(".chat-actions");
  const originalText = bubble.textContent;

  const textarea = document.createElement("textarea");
  textarea.className = "chat-edit-textarea";
  textarea.value = originalText;
  bubble.replaceWith(textarea);
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);

  const editActions = document.createElement("div");
  editActions.className = "chat-actions chat-actions--editing";
  const saveBtn = createIconButton("Save & resend", CHECK_ICON);
  const cancelBtn = createIconButton("Cancel", CLOSE_ICON);
  editActions.appendChild(saveBtn);
  editActions.appendChild(cancelBtn);
  actions.replaceWith(editActions);

  cancelBtn.addEventListener("click", () => {
    textarea.replaceWith(bubble);
    editActions.replaceWith(buildViewActions(row, "user", turnStart));
  });

  saveBtn.addEventListener("click", () => {
    const editedText = textarea.value.trim();
    if (!editedText) return;
    truncateFrom(row);
    conversationHistory.length = turnStart;
    sendPrompt(editedText);
  });

  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      saveBtn.click();
    } else if (e.key === "Escape") {
      cancelBtn.click();
    }
  });
}

// Removes `row` and every message after it in the DOM. Used by edit
// (the edited row gets a fresh replacement appended right after).
function truncateFrom(row) {
  let node = row;
  while (node) {
    const next = node.nextElementSibling;
    node.remove();
    node = next;
  }
}

function appendMessage(role, text, { turnStart } = {}) {
  const agentOutput = document.getElementById("agent-output");
  const row = document.createElement("div");
  row.className = `chat-message chat-message--${role}`;
  if (turnStart !== undefined) row.dataset.turnStart = String(turnStart);

  const bubble = document.createElement("div");
  bubble.className = "chat-bubble";
  bubble.textContent = text;
  row.appendChild(bubble);

  if (role === "user" || role === "agent") {
    row.appendChild(buildViewActions(row, role, turnStart));
  }

  agentOutput.appendChild(row);
  agentOutput.scrollTop = agentOutput.scrollHeight;
  return { row, bubble };
}

function clearConversation() {
  conversationHistory = [];
  document.getElementById("agent-output").replaceChildren();
}

async function sendPrompt(promptText) {
  const agentBtn = document.getElementById("agent-btn");
  agentBtn.disabled = true;

  const turnStart = conversationHistory.length;
  appendMessage("user", promptText, { turnStart });
  const pending = appendMessage("pending", "Running agent — this can take a few seconds if it calls tools...");
  const historyForThisTurn = [...conversationHistory];

  try {
    const modelOverride = getSelectedModel();
    const result = await window.__TAURI__.core.invoke("agent_run", {
      prompt: promptText,
      provider: modelOverride?.provider ?? null,
      model: modelOverride?.model ?? null,
      history: historyForThisTurn,
    });
    pending.row.remove();
    appendMessage("agent", result);
    conversationHistory.push({ role: "user", content: promptText });
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

export async function runAgent() {
  const agentPrompt = document.getElementById("agent-prompt");
  const prompt = agentPrompt.value.trim();
  if (!prompt) return;
  agentPrompt.value = "";
  await sendPrompt(prompt);
}

export function initAgentPanelBindings() {
  document.getElementById("agent-btn").addEventListener("click", runAgent);
  document.getElementById("agent-prompt").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      runAgent();
    }
  });

  if (bindingsMounted) return;
  bindingsMounted = true;

  const footer = document.getElementById("agent-prompt-box-footer");
  const sendBtn = document.getElementById("agent-btn");
  const selectorHost = document.createElement("div");
  footer.insertBefore(selectorHost, sendBtn);
  mountModelSelector(selectorHost);

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