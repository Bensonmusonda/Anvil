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
