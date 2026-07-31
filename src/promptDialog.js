// A small themed modal replacement for window.prompt(). Used specifically
// where there's no existing tree row to attach an inline input to — right
// now, just naming a new folder when creating one with no workspace open
// yet. Kept as its own leaf module (no imports) since it's a generic UI
// primitive, not something owned by any single panel.

export function showPromptDialog({ title, placeholder = "", confirmLabel = "OK" }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "overlay";

    const box = document.createElement("div");
    box.className = "prompt-dialog";

    const heading = document.createElement("div");
    heading.className = "prompt-dialog-title";
    heading.textContent = title;

    const input = document.createElement("input");
    input.type = "text";
    input.className = "prompt-dialog-input";
    input.placeholder = placeholder;
    input.autocomplete = "off";

    const actions = document.createElement("div");
    actions.className = "prompt-dialog-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "text-action-btn";
    cancelBtn.textContent = "Cancel";

    const confirmBtn = document.createElement("button");
    confirmBtn.className = "text-action-btn prompt-dialog-confirm";
    confirmBtn.textContent = confirmLabel;

    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    box.appendChild(heading);
    box.appendChild(input);
    box.appendChild(actions);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    input.focus();

    let settled = false;
    function close(value) {
      if (settled) return;
      settled = true;
      overlay.remove();
      resolve(value);
    }

    confirmBtn.addEventListener("click", () => close(input.value.trim() || null));
    cancelBtn.addEventListener("click", () => close(null));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(null);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        close(input.value.trim() || null);
      } else if (e.key === "Escape") {
        e.preventDefault();
        close(null);
      }
    });
  });
}

// Yes/no confirmation modal, same visual family as showPromptDialog but
// without an input — used for delete confirmations. `danger` just tints
// the confirm button red via the existing --error CSS var (no new CSS
// classes needed) for the permanent-delete case, which needs to look
// more alarming than a plain trash-delete confirmation.
export function showConfirmDialog({ title, message, confirmLabel = "Confirm", danger = false }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "overlay";

    const box = document.createElement("div");
    box.className = "prompt-dialog";

    const heading = document.createElement("div");
    heading.className = "prompt-dialog-title";
    heading.textContent = title;

    const body = document.createElement("div");
    body.className = "prompt-dialog-message";
    body.textContent = message;

    const actions = document.createElement("div");
    actions.className = "prompt-dialog-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "text-action-btn";
    cancelBtn.textContent = "Cancel";

    const confirmBtn = document.createElement("button");
    confirmBtn.className = "text-action-btn prompt-dialog-confirm";
    confirmBtn.textContent = confirmLabel;
    if (danger) confirmBtn.style.color = "var(--error)";

    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    box.appendChild(heading);
    box.appendChild(body);
    box.appendChild(actions);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    confirmBtn.focus();

    let settled = false;
    function close(value) {
      if (settled) return;
      settled = true;
      overlay.remove();
      resolve(value);
    }

    confirmBtn.addEventListener("click", () => close(true));
    cancelBtn.addEventListener("click", () => close(false));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(false);
    });
    document.addEventListener("keydown", function handler(e) {
      if (settled) return document.removeEventListener("keydown", handler);
      if (e.key === "Escape") {
        e.preventDefault();
        close(false);
        document.removeEventListener("keydown", handler);
      } else if (e.key === "Enter") {
        e.preventDefault();
        close(true);
        document.removeEventListener("keydown", handler);
      }
    });
  });
}

// Settings modal for custom system prompts (Inline AI / Chat). Same visual
// family as showPromptDialog/showConfirmDialog, extended with two textareas
// instead of one input.
export function showSettingsDialog({ inlinePrompt = "", chatPrompt = "" }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "overlay";

    const box = document.createElement("div");
    box.className = "prompt-dialog settings-dialog";

    const heading = document.createElement("div");
    heading.className = "prompt-dialog-title";
    heading.textContent = "Custom System Prompts";

    const inlineLabel = document.createElement("label");
    inlineLabel.className = "settings-dialog-label";
    inlineLabel.textContent = "Inline AI (Ctrl+K)";
    const inlineArea = document.createElement("textarea");
    inlineArea.className = "settings-dialog-textarea";
    inlineArea.value = inlinePrompt;
    inlineArea.placeholder = "Optional system prompt for inline completions...";

    const chatLabel = document.createElement("label");
    chatLabel.className = "settings-dialog-label";
    chatLabel.textContent = "Chat / Agent (Ctrl+I)";
    const chatArea = document.createElement("textarea");
    chatArea.className = "settings-dialog-textarea";
    chatArea.value = chatPrompt;
    chatArea.placeholder = "Optional system prompt for agent chat...";

    const actions = document.createElement("div");
    actions.className = "prompt-dialog-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "text-action-btn";
    cancelBtn.textContent = "Cancel";

    const saveBtn = document.createElement("button");
    saveBtn.className = "text-action-btn prompt-dialog-confirm";
    saveBtn.textContent = "Save";

    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);

    box.appendChild(heading);
    box.appendChild(inlineLabel);
    box.appendChild(inlineArea);
    box.appendChild(chatLabel);
    box.appendChild(chatArea);
    box.appendChild(actions);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    inlineArea.focus();

    let settled = false;
    function close(value) {
      if (settled) return;
      settled = true;
      overlay.remove();
      resolve(value);
    }

    saveBtn.addEventListener("click", () =>
      close({ inlinePrompt: inlineArea.value, chatPrompt: chatArea.value })
    );
    cancelBtn.addEventListener("click", () => close(null));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(null);
    });
    document.addEventListener("keydown", function handler(e) {
      if (settled) return document.removeEventListener("keydown", handler);
      if (e.key === "Escape") {
        e.preventDefault();
        close(null);
        document.removeEventListener("keydown", handler);
      }
    });
  });
}