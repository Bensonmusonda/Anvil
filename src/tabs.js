// Tab data model + switching mechanics (Phase 8). Owns the mapping from
// "which files are open" to cached CM6 EditorStates, and swaps between
// them in the single shared EditorView rather than recreating the editor
// per tab (view.setState() is the built-in CM6 mechanism for this).
//
// Scroll position is handled separately from EditorState on purpose: CM6
// doesn't consider scroll position part of editor state at all (it's a
// DOM property of the view's own scroll container), so unlike cursor
// position and undo history — which come along for free with the cached
// EditorState — scroll has to be captured on switch-away and restored on
// switch-to, manually, here.
//
// No tab-bar UI yet (that's the next step) — but switching/reuse/caching
// all work today via any existing "open this file" call site (tree click,
// command palette, go-to-definition), since they all route through
// fileOps.js's openFile(), which now delegates here.

import { appState } from "./state.js";
import { getEditor, buildEditorState } from "./editorSetup.js";
import { updateEmptyState } from "./emptyState.js";
import { openFile, closeTab } from "./fileOps.js";
import { EditorView } from "./vendor/codemirror.bundle.js";

let tabs = [];
let activeTabId = null;
let nextTabId = 1;

function titleForPath(path) {
    return path.split(/[\\/]/).pop();
}

function renderTabBar() {
    ensureBarDndBound();
    const bar = document.getElementById("tab-bar");
    bar.innerHTML = "";
    for (const tab of tabs) {
        const item = document.createElement("div");
        item.className = "tab-bar-item" + (tab.id === activeTabId ? " active" : "");
        item.draggable = true;

        const label = document.createElement("span");
        label.className = "tab-bar-item-label";
        label.textContent = tab.title;
        label.title = tab.path;

        if (tab.dirty) {
            const dot = document.createElement("span");
            dot.className = "tab-bar-item-dirty-dot";
            item.appendChild(dot);
        }

        const closeBtn = document.createElement("span");
        closeBtn.className = "tab-bar-item-close";
        closeBtn.innerHTML =
            '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
        closeBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            closeTab(tab.path);
        });

        item.appendChild(label);
        item.appendChild(closeBtn);
        item.addEventListener("click", () => {
            if (tab.id !== activeTabId) openFile(tab.path);
        });

        item.addEventListener("dragstart", (e) => {
            e.dataTransfer.setData("text/plain", String(tab.id));
            e.dataTransfer.effectAllowed = "move";
            item.classList.add("dragging");
        });
        item.addEventListener("dragend", () => item.classList.remove("dragging"));
        item.addEventListener("dragover", (e) => {
            e.preventDefault(); // required for drop to fire at all
            e.dataTransfer.dropEffect = "move";
        });
        item.addEventListener("drop", (e) => {
            e.preventDefault();
            e.stopPropagation(); // don't also trigger the bar's own drop handler below
            const draggedId = Number(e.dataTransfer.getData("text/plain"));
            if (draggedId === tab.id) return;
            moveTab(draggedId, tab.id);
        });

        bar.appendChild(item);
    }
}

let barDndBound = false;
function ensureBarDndBound() {
    if (barDndBound) return;
    barDndBound = true;
    const bar = document.getElementById("tab-bar");
    bar.addEventListener("dragover", (e) => e.preventDefault());
    bar.addEventListener("drop", (e) => {
        // Only fires for drops on empty space to the right of all tabs — a
        // drop on an actual tab is caught by that tab's own listener above,
        // which stops propagation before it reaches here.
        e.preventDefault();
        const draggedId = Number(e.dataTransfer.getData("text/plain"));
        const fromIdx = tabs.findIndex((t) => t.id === draggedId);
        if (fromIdx === -1) return;
        const [moved] = tabs.splice(fromIdx, 1);
        tabs.push(moved);
        renderTabBar();
    });
}

/// Moves the dragged tab to sit immediately before the drop target.
function moveTab(draggedId, targetId) {
    const fromIdx = tabs.findIndex((t) => t.id === draggedId);
    if (fromIdx === -1) return;
    const [moved] = tabs.splice(fromIdx, 1);
    const toIdx = tabs.findIndex((t) => t.id === targetId); // recomputed after removal, since removing fromIdx shifts everything after it
    tabs.splice(toIdx === -1 ? tabs.length : toIdx, 0, moved);
    renderTabBar();
}

export function getTabs() {
    return tabs;
}

export function getActiveTab() {
    return tabs.find((t) => t.id === activeTabId) || null;
}

function findTabByPath(path) {
    return tabs.find((t) => t.kind === "file" && t.path === path) || null;
}

function captureScroll(tab) {
    if (!tab) return;
    tab.scrollTop = getEditor().scrollDOM.scrollTop;
}

function restoreScroll(tab) {
    const editor = getEditor();
    // Deferred a frame: the view needs to finish laying out the just-swapped
    // state before setting scrollTop has any effect.
    requestAnimationFrame(() => {
        editor.scrollDOM.scrollTop = tab.scrollTop || 0;
    });
}

function activateTab(newTab) {
    const editor = getEditor();
    const previous = getActiveTab();
    if (previous) {
        previous.editorState = editor.state; // persist latest doc/selection/undo-history before swapping away
        captureScroll(previous);
    }

    editor.setState(newTab.editorState);
    activeTabId = newTab.id;
    appState.currentFilePath = newTab.path;

    document.getElementById("current-file").textContent = newTab.path;
    updateEmptyState();
    restoreScroll(newTab);
    editor.focus(); // see the focus note below
    renderTabBar();
}

/// Central "open this file" entry point for the whole app. Returns
/// { tab, isNew, content } so fileOps.js's openFile() can decide whether
/// an LSP didOpen notification is needed — reusing an already-open tab is
/// just a view swap, not new content to notify the server about.
export async function openOrSwitchToFile(path) {
    const existing = findTabByPath(path);
    if (existing) {
        activateTab(existing);
        return { tab: existing, isNew: false, content: existing.editorState.doc.toString() };
    }

    const content = await window.__TAURI__.core.invoke("read_text_file", { path });
    const tab = {
        id: nextTabId++,
        kind: "file",
        path,
        title: titleForPath(path),
        editorState: buildEditorState(content, path),
        savedDoc: content, // dirty-check baseline; kept in sync by fileOps.js on save/revert/external-reload
        dirty: false,
        scrollTop: 0,
    };
    tabs.push(tab);
    activateTab(tab);
    renderTabBar();
    return { tab, isNew: true, content };
}

function handleActiveDocChanged() {
    const tab = getActiveTab();
    if (!tab) return;
    const isDirty = getEditor().state.doc.toString() !== tab.savedDoc;
    if (tab.dirty !== isDirty) {
        tab.dirty = isDirty; // only re-render when the flag actually flips, not on every keystroke once already dirty
        renderTabBar();
    }
}

export const docChangeListener = EditorView.updateListener.of((update) => {
    if (update.docChanged) handleActiveDocChanged();
});


/// Called by fileOps.js after a successful save/revert/external-reload, so
/// the dirty-check baseline (used by Phase 8's not-yet-built unsaved
/// indicator) doesn't go stale the moment this lands.
export function updateActiveTabSavedDoc(content) {
    const tab = getActiveTab();
    if (!tab) return;
    tab.savedDoc = content;
    tab.dirty = false;
    renderTabBar();
}

/// Removes a tab by path. If it was the active tab, activates whichever
/// tab is now to its left (or the new first tab, if index 0 was closed),
/// or clears the editor entirely if it was the last tab open. Returns
/// enough info for fileOps.js's closeTab() to decide what LSP notification
/// (if any) is needed — see that function's comment for why.
export function closeTabByPath(path) {
    const idx = tabs.findIndex((t) => t.path === path);
    if (idx === -1) return null;

    const wasActive = tabs[idx].id === activeTabId;
    tabs.splice(idx, 1);



    let nextTab = null;
    if (wasActive) {
        if (tabs.length > 0) {
            nextTab = tabs[Math.max(0, idx - 1)];
            activateTab(nextTab); // also calls renderTabBar()
        } else {
            activeTabId = null;
            appState.currentFilePath = null;
            document.getElementById("current-file").textContent = "no file open";
            updateEmptyState();
            renderTabBar();
        }
    } else {
        renderTabBar();
    }
    return { closedWasActive: wasActive, nextTab };
}

export function getEffectiveContent(tab) {
    return tab.id === activeTabId ? getEditor().state.doc.toString() : tab.editorState.doc.toString();
}

export function markTabSaved(tab, content) {
    tab.savedDoc = content;
    tab.dirty = false;
}

export { renderTabBar };