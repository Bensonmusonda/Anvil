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
import { openChatPicker, initChatPickerBindings } from "./chatPicker.js";
import MarkdownIt from "./vendor/markdown-it.bundle.js";
import { highlightCodeBlock } from "./codeHighlight.js";

let bindingsMounted = false;
let conversationHistory = []; // [{role: "user"|"assistant", content: string}, ...]
// Parallel to conversationHistory (same index = same turn). Holds each
// assistant turn's joined reasoning text across all tool-call rounds, or
// undefined for user turns / turns with no reasoning. Never sent back to
// agent_run's `history` array — only used to rebuild collapsed thinking
// blocks when a persisted session is reloaded.
let reasoningHistory = [];
// null until the first turn of a session is persisted (see
// persistCurrentSession), which mints the id/title. Set instead by
// loadSessionIntoPanel when a saved session is picked from Previous Chats.
let currentSessionId = null;
let currentSessionTitle = null;
let activeRequestId = null;
const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

const COPY_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
const EDIT_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>`;
const CHECK_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
const CLOSE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
const SEND_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg>`;
const STOP_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2"></rect></svg>`;
const TYPING_INDICATOR_HTML = `<div class="chat-typing-indicator"><span></span><span></span><span></span></div>`;

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
    navigator.clipboard.writeText(bubble.dataset.raw ?? bubble.textContent).catch((err) => {
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
    reasoningHistory.length = turnStart;
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
  if (!agentOutput.querySelector(".chat-message")) {
    agentOutput.textContent = ""; // clear the "(no agent task run yet)" placeholder
  }

  const row = document.createElement("div");
  row.className = `chat-message chat-message--${role}`;
  if (turnStart !== undefined) row.dataset.turnStart = String(turnStart);

  const bubble = document.createElement("div");
  bubble.dataset.raw = text; // copy button always copies this, not rendered HTML

  if (role === "agent") {
    bubble.className = "chat-bubble chat-bubble--markdown";
    bubble.innerHTML = md.render(text);
    highlightRenderedCode(bubble);
    addCodeCopyButtons(bubble);
  } else {
    bubble.className = "chat-bubble chat-bubble--plain";
    bubble.textContent = text;
  }

  row.appendChild(bubble);

  if (role === "user" || role === "agent") {
    row.appendChild(buildViewActions(row, role, turnStart));
  }

  agentOutput.appendChild(row);
  agentOutput.scrollTop = agentOutput.scrollHeight;
  return { row, bubble };
}

// Upserts the current in-memory conversation to disk. Mints a session id +
// an LLM-generated title on the first call for a given session (i.e. the
// first successful turn); every call after that just resaves under the
// existing id/title. Safe to call redundantly — e.g. "New Chat" calls this
// defensively even though the common case already has nothing new to save,
// since every successful turn already triggers it.
async function persistCurrentSession() {
  if (conversationHistory.length === 0) return;
  try {
    if (!currentSessionId) {
      currentSessionId = crypto.randomUUID();
      const firstUser = conversationHistory.find((m) => m.role === "user")?.content ?? "";
      const firstAssistant = conversationHistory.find((m) => m.role === "assistant")?.content ?? "";
      currentSessionTitle = await window.__TAURI__.core.invoke("generate_chat_title", {
        userMessage: firstUser,
        assistantMessage: firstAssistant,
      });
    }

    const messages = conversationHistory.map((m, i) => ({
      role: m.role,
      content: m.content,
      reasoning: reasoningHistory[i] || undefined,
    }));

    await window.__TAURI__.core.invoke("save_chat_session", {
      id: currentSessionId,
      title: currentSessionTitle,
      messages,
    });
  } catch (err) {
    // A failed autosave shouldn't surface as an "agent failed" error to the
    // user mid-conversation — worst case they lose this one turn's
    // persistence and it gets retried on the next successful turn.
    console.error("Failed to persist chat session:", err);
  }
}

async function clearConversation() {
  // Requirement: starting a new chat must not silently drop whatever was
  // active. In practice every successful turn already autosaves, so this is
  // usually a no-op resave — but it's the one place that still needs to
  // catch a session that was never given an id (e.g. its very first
  // autosave failed) before we wipe conversationHistory out from under it.
  await persistCurrentSession();

  conversationHistory = [];
  reasoningHistory = [];
  currentSessionId = null;
  currentSessionTitle = null;
  document.getElementById("agent-output").replaceChildren();
}

// Rebuilds the panel from a saved session: fetches its full messages,
// replaces conversationHistory/reasoningHistory, and re-renders DOM bubbles
// from scratch. Assistant turns with stored reasoning get a collapsed
// thinking block rebuilt ahead of the answer, matching the shape a live
// turn ends up in — just born collapsed instead of collapsing.
async function loadSessionIntoPanel(entry) {
  await persistCurrentSession(); // don't lose the session being switched away from

  let session;
  try {
    session = await window.__TAURI__.core.invoke("load_chat_session", { id: entry.id });
  } catch (err) {
    console.error("Failed to load chat session:", err);
    return;
  }

  currentSessionId = session.id;
  currentSessionTitle = session.title;
  conversationHistory = session.messages.map((m) => ({ role: m.role, content: m.content }));
  reasoningHistory = session.messages.map((m) => m.reasoning);

  const agentOutput = document.getElementById("agent-output");
  agentOutput.replaceChildren();

  session.messages.forEach((m, i) => {
    if (m.role === "user") {
      appendMessage("user", m.content, { turnStart: i });
      return;
    }

    const { row, bubble } = appendMessage("agent", m.content, { turnStart: i });
    if (m.reasoning) {
      bubble.innerHTML = '<div class="thinking-stack"></div><div class="answer-content"></div>';
      const thinkingStackEl = bubble.querySelector(".thinking-stack");
      const answerContentEl = bubble.querySelector(".answer-content");

      const details = document.createElement("details");
      details.className = "thinking-block";
      details.open = false;
      const summary = document.createElement("summary");
      summary.textContent = "Thoughts";
      const content = document.createElement("div");
      content.className = "thinking-content";
      content.textContent = m.reasoning;
      details.appendChild(summary);
      details.appendChild(content);
      thinkingStackEl.appendChild(details);

      answerContentEl.innerHTML = md.render(m.content);
      highlightRenderedCode(bubble);
      addCodeCopyButtons(bubble);
      // No need to touch the .chat-actions row buildViewActions already
      // appended — its copy button looks up ".chat-bubble" at click time,
      // not at creation time, so it's unaffected by bubble.innerHTML being
      // replaced just now.
    }
  });

  agentOutput.scrollTop = agentOutput.scrollHeight;
}

function isNearBottom(el, threshold = 60) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
}

async function sendPrompt(promptText) {
  const turnStart = conversationHistory.length;
  appendMessage("user", promptText, { turnStart });

  const agentOutput = document.getElementById("agent-output");
  const row = document.createElement("div");
  row.className = "chat-message chat-message--agent";
  const bubble = document.createElement("div");
  bubble.className = "chat-bubble chat-bubble--markdown";
  bubble.innerHTML = TYPING_INDICATOR_HTML;
  row.appendChild(bubble);
  agentOutput.appendChild(row);
  agentOutput.scrollTop = agentOutput.scrollHeight;

  const requestId = crypto.randomUUID();
  activeRequestId = requestId;
  setSendButtonMode("stop");

  let streamedText = "";
  let renderScheduled = false;
  let reasoningRenderScheduled = false;
  let finished = false;

  // Built lazily on the first round-start or first content token, whichever
  // arrives first — until then the bubble is still showing the typing dots.
  let thinkingStackEl = null;
  let answerContentEl = null;
  let currentThinkingDetails = null;
  let currentReasoningText = "";
  let capturedReasoningForTurn = "";

  function ensureBubbleStructure() {
    if (thinkingStackEl) return;
    bubble.innerHTML = '<div class="thinking-stack"></div><div class="answer-content"></div>';
    thinkingStackEl = bubble.querySelector(".thinking-stack");
    answerContentEl = bubble.querySelector(".answer-content");
  }

  function collapseCurrentThinking() {
    if (!currentThinkingDetails || !currentThinkingDetails.open) return;
    currentThinkingDetails.open = false;
    const summary = currentThinkingDetails.querySelector("summary");
    if (summary) summary.textContent = "Thoughts";
    // Fires exactly once per round's thinking block (guarded by the early
    // return above), so this naturally joins every round's reasoning for
    // the turn in order, without double-counting a round whose collapse
    // was triggered by both a new round starting and the content-token
    // handler racing it.
    if (currentReasoningText) {
      capturedReasoningForTurn += (capturedReasoningForTurn ? "\n\n" : "") + currentReasoningText;
    }
  }

  function scheduleRender() {
    if (renderScheduled || finished) return;
    renderScheduled = true;
    requestAnimationFrame(() => {
      renderScheduled = false;
      if (finished) return;
      const stick = isNearBottom(agentOutput);
      answerContentEl.innerHTML = md.render(streamedText) + '<span class="chat-stream-cursor"></span>';
      if (stick) agentOutput.scrollTop = agentOutput.scrollHeight;
    });
  }

  function scheduleReasoningRender() {
    if (reasoningRenderScheduled || finished) return;
    reasoningRenderScheduled = true;
    requestAnimationFrame(() => {
      reasoningRenderScheduled = false;
      if (finished || !currentThinkingDetails) return;
      const content = currentThinkingDetails.querySelector(".thinking-content");
      if (content) content.textContent = currentReasoningText;
      if (currentThinkingDetails.open) agentOutput.scrollTop = agentOutput.scrollHeight;
    });
  }

  const unlistenRoundStart = await window.__TAURI__.event.listen("agent-round-start", (event) => {
    if (event.payload.requestId !== requestId) return;
    ensureBubbleStructure();
    collapseCurrentThinking();

    const details = document.createElement("details");
    details.className = "thinking-block";
    details.open = true;
    const summary = document.createElement("summary");
    summary.textContent = "Thinking...";
    const content = document.createElement("div");
    content.className = "thinking-content";
    details.appendChild(summary);
    details.appendChild(content);
    thinkingStackEl.appendChild(details);

    currentThinkingDetails = details;
    currentReasoningText = "";
    agentOutput.scrollTop = agentOutput.scrollHeight;
  });

  const unlistenReasoning = await window.__TAURI__.event.listen("agent-reasoning-token", (event) => {
    if (event.payload.requestId !== requestId) return;
    ensureBubbleStructure();
    if (!currentThinkingDetails) return;
    currentReasoningText += event.payload.token;
    scheduleReasoningRender();
  });

  const unlistenToken = await window.__TAURI__.event.listen("agent-token", (event) => {
    if (event.payload.requestId !== requestId) return;
    ensureBubbleStructure();
    collapseCurrentThinking(); // the real answer starting is exactly the collapse trigger
    streamedText += event.payload.token;
    scheduleRender();
  });

  const historyForThisTurn = [...conversationHistory];

  try {
    const modelOverride = getSelectedModel();
    const result = await window.__TAURI__.core.invoke("agent_run", {
      prompt: promptText,
      provider: modelOverride?.provider ?? null,
      model: modelOverride?.model ?? null,
      history: historyForThisTurn,
      requestId,
    });
    finished = true;

    ensureBubbleStructure();
    collapseCurrentThinking();
    bubble.dataset.raw = result;
    answerContentEl.innerHTML = md.render(result);
    highlightRenderedCode(bubble);
    addCodeCopyButtons(bubble);
    row.appendChild(buildViewActions(row, "agent", turnStart));

    conversationHistory.push({ role: "user", content: promptText });
    conversationHistory.push({ role: "assistant", content: result });
    reasoningHistory.push(undefined);
    reasoningHistory.push(capturedReasoningForTurn || undefined);

    await persistCurrentSession();
  } catch (err) {
    finished = true;
    row.className = "chat-message chat-message--error";
    bubble.className = "chat-bubble chat-bubble--plain";
    bubble.textContent = "Agent failed: " + err;
  } finally {
    unlistenRoundStart();
    unlistenReasoning();
    unlistenToken();
    activeRequestId = null;
    setSendButtonMode("send");
    if (isNearBottom(agentOutput)) {
      agentOutput.scrollTop = agentOutput.scrollHeight;
    }
  }
}

async function stopAgent() {
  if (!activeRequestId) return;
  try {
    await window.__TAURI__.core.invoke("stop_agent", { requestId: activeRequestId });
  } catch (err) {
    console.error("Failed to stop agent:", err);
  }
}

function setSendButtonMode(mode) {
  const agentBtn = document.getElementById("agent-btn");
  agentBtn.dataset.mode = mode;
  agentBtn.innerHTML = mode === "stop" ? STOP_ICON : SEND_ICON;
  agentBtn.title = mode === "stop" ? "Stop generating" : "Run Agent";
}

export async function runAgent() {
  if (activeRequestId) return;
  const agentPrompt = document.getElementById("agent-prompt");
  const prompt = agentPrompt.value.trim();
  if (!prompt) return;
  agentPrompt.value = "";
  await sendPrompt(prompt);
}

export function initAgentPanelBindings() {
  document.getElementById("agent-btn").addEventListener("click", () => {
    const agentBtn = document.getElementById("agent-btn");
    if (agentBtn.dataset.mode === "stop") {
      stopAgent();
    } else {
      runAgent();
    }
  });
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

  const previousChatsBtn = document.createElement("button");
  previousChatsBtn.className = "agent-header-icon-btn";
  previousChatsBtn.title = "Previous Chats";
  previousChatsBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v5h5"></path><path d="M3.05 13a9 9 0 1 0 .5-4.5"></path><polyline points="12 7 12 12 15 14"></polyline></svg>`;
  previousChatsBtn.addEventListener("click", () => openChatPicker(loadSessionIntoPanel));
  headerControls.appendChild(previousChatsBtn);
  initChatPickerBindings();

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

function addCodeCopyButtons(bubble) {
  bubble.querySelectorAll("pre").forEach((pre) => {
    const wrapper = document.createElement("div");
    wrapper.className = "code-block-wrapper";
    pre.replaceWith(wrapper);
    wrapper.appendChild(pre);

    const btn = document.createElement("button");
    btn.className = "code-copy-btn";
    btn.title = "Copy code";
    btn.innerHTML = COPY_ICON;
    btn.addEventListener("click", () => {
      const code = pre.querySelector("code");
      navigator.clipboard.writeText(code ? code.textContent : pre.textContent).catch((err) => {
        console.error("Copy failed:", err);
      });
      btn.innerHTML = CHECK_ICON;
      setTimeout(() => (btn.innerHTML = COPY_ICON), 1000);
    });
    wrapper.appendChild(btn);
  });
}

function highlightRenderedCode(bubble) {
  bubble.querySelectorAll("pre code").forEach((codeEl) => {
    const langClass = [...codeEl.classList].find((c) => c.startsWith("language-"));
    const lang = langClass ? langClass.slice("language-".length) : "";
    const highlighted = highlightCodeBlock(codeEl.textContent, lang);
    if (highlighted !== null) {
      codeEl.innerHTML = highlighted;
    }
  });
}

function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    bubble.innerHTML = md.render(streamedText) + '<span class="chat-stream-cursor"></span>';
    agentOutput.scrollTop = agentOutput.scrollHeight;
  });
}