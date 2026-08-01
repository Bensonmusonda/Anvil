// "Previous Chats" picker: mirrors commandPalette.js's fuzzy-list/keyboard-
// navigable chrome (reuses the .overlay/.palette-container/.palette-item
// classes from style.css so it looks and feels like the same component) but
// lives as its own module rather than a third command-palette mode — the
// palette's mode-dispatch is tightly coupled to files-vs-commands, and this
// needs its own per-row rename/delete actions that don't fit that shape.

import { showConfirmDialog, showPromptDialog } from "./promptDialog.js";

let pickerSessions = []; // full index list from list_chat_sessions, unfiltered
let filteredSessions = [];
let pickerSelectedIndex = 0;
let onSelectCallback = null;

const RENAME_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>`;
const TRASH_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path></svg>`;

function renderPickerSelection() {
    const results = document.getElementById("chat-picker-results");
    const children = results.children;
    for (let i = 0; i < children.length; i++) {
        if (i === pickerSelectedIndex) {
            children[i].classList.add("selected");
            children[i].scrollIntoView({ block: "nearest" });
        } else {
            children[i].classList.remove("selected");
        }
    }
}

function renderPickerResults() {
    const results = document.getElementById("chat-picker-results");
    pickerSelectedIndex = 0;
    results.innerHTML = "";

    if (filteredSessions.length === 0) {
        results.innerHTML = `<div class="palette-item"><span class="palette-item-path">No saved chats found</span></div>`;
        return;
    }

    filteredSessions.forEach((session, index) => {
        const div = document.createElement("div");
        div.className = "palette-item chat-picker-item";
        if (index === pickerSelectedIndex) div.classList.add("selected");

        const titleEl = document.createElement("span");
        titleEl.className = "palette-item-path chat-picker-item-title";
        titleEl.textContent = session.title;
        div.appendChild(titleEl);

        const actions = document.createElement("div");
        actions.className = "chat-picker-item-actions";

        const renameBtn = document.createElement("button");
        renameBtn.className = "chat-picker-action-btn";
        renameBtn.title = "Rename";
        renameBtn.innerHTML = RENAME_ICON;
        renameBtn.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            handleRename(session);
        });
        actions.appendChild(renameBtn);

        const deleteBtn = document.createElement("button");
        deleteBtn.className = "chat-picker-action-btn";
        deleteBtn.title = "Delete";
        deleteBtn.innerHTML = TRASH_ICON;
        deleteBtn.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            handleDelete(session);
        });
        actions.appendChild(deleteBtn);

        div.appendChild(actions);

        div.onmousedown = (e) => {
            if (e.target.closest(".chat-picker-action-btn")) return;
            closeChatPicker();
            onSelectCallback?.(session);
        };
        div.onmouseover = () => {
            pickerSelectedIndex = index;
            renderPickerSelection();
        };
        results.appendChild(div);
    });

    renderPickerSelection();
}

// NOTE: assumes promptDialog.js's showPromptDialog/showConfirmDialog accept
// a {title, message, defaultValue?} options object and resolve to the
// entered string (or null on cancel) / a boolean respectively — the same
// shape showSettingsDialog's usage elsewhere implies. If promptDialog.js's
// actual signature differs, these two call sites are the only places that
// need adjusting.
async function handleRename(session) {
    const newTitle = await showPromptDialog({
        title: "Rename Chat",
        message: "Enter a new name for this chat.",
        defaultValue: session.title,
    });
    if (!newTitle || !newTitle.trim() || newTitle.trim() === session.title) return;

    try {
        await window.__TAURI__.core.invoke("rename_chat_session", {
            id: session.id,
            title: newTitle.trim(),
        });
        session.title = newTitle.trim();
        renderPickerResults();
    } catch (err) {
        console.error("Failed to rename chat session:", err);
    }
}

async function handleDelete(session) {
    const confirmed = await showConfirmDialog({
        title: "Delete Chat",
        message: `Delete "${session.title}"? This can't be undone.`,
    });
    if (!confirmed) return;

    try {
        await window.__TAURI__.core.invoke("delete_chat_session", { id: session.id });
        pickerSessions = pickerSessions.filter((s) => s.id !== session.id);
        filteredSessions = filteredSessions.filter((s) => s.id !== session.id);
        renderPickerResults();
    } catch (err) {
        console.error("Failed to delete chat session:", err);
    }
}

function filterSessions(query) {
    const q = query.trim().toLowerCase();
    filteredSessions = q
        ? pickerSessions.filter((s) => s.title.toLowerCase().includes(q))
        : pickerSessions.slice();
    renderPickerResults();
}

function closeChatPicker() {
    document.getElementById("chat-picker").style.display = "none";
}

// Opens the picker and loads the session index fresh every time (cheap —
// index.json is small), so a chat saved or renamed since the picker was
// last opened always shows up correctly. `onSelect(entry)` is called with
// the chosen {id, title, updated_at} index entry; the caller is responsible
// for fetching the full session via load_chat_session.
export async function openChatPicker(onSelect) {
    onSelectCallback = onSelect;
    const overlay = document.getElementById("chat-picker");
    const input = document.getElementById("chat-picker-input");

    overlay.style.display = "flex";
    input.value = "";
    input.focus();

    try {
        pickerSessions = await window.__TAURI__.core.invoke("list_chat_sessions");
    } catch (err) {
        pickerSessions = [];
        console.error("Failed to load chat sessions:", err);
    }
    filterSessions("");
}

let bindingsMounted = false;

export function initChatPickerBindings() {
    if (bindingsMounted) return;
    bindingsMounted = true;

    const overlay = document.getElementById("chat-picker");
    const input = document.getElementById("chat-picker-input");

    overlay.addEventListener("mousedown", (e) => {
        if (e.target === overlay) closeChatPicker();
    });

    input.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
            e.preventDefault();
            closeChatPicker();
        } else if (e.key === "ArrowDown") {
            e.preventDefault();
            if (pickerSelectedIndex < filteredSessions.length - 1) {
                pickerSelectedIndex++;
                renderPickerSelection();
            }
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            if (pickerSelectedIndex > 0) {
                pickerSelectedIndex--;
                renderPickerSelection();
            }
        } else if (e.key === "Enter") {
            e.preventDefault();
            if (filteredSessions.length > 0) {
                const session = filteredSessions[pickerSelectedIndex];
                closeChatPicker();
                onSelectCallback?.(session);
            }
        }
    });

    input.addEventListener("input", () => filterSessions(input.value));
}