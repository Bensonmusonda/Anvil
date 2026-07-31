// Find in Files: full-text content search across the workspace.
// Triggered by Ctrl+Shift+F or the magnifying glass activity-bar icon.
//
// Results are grouped by file and rendered as collapsible file headers with
// match rows underneath. Clicking any match opens the file and jumps the
// CodeMirror editor to the correct line.

import { appState, showStatus } from "./state.js";
import { openOrSwitchToFile } from "./tabs.js";
import { getEditor } from "./editorSetup.js";
import { EditorView } from "./vendor/codemirror.bundle.js";

const MAX_MATCHES = 1_000; // mirrors the Rust cap in search.rs

let searchDebounceTimer = null;
let lastResults = []; // kept so keyboard nav can reference them later

// ─── Public API ────────────────────────────────────────────────────────────

/** Opens the search sidebar panel and focuses the query input. */
export function openSearchPanel() {
  // Delegate to uiChrome to show the sidebar with the search tab active.
  // We fire a custom event so this module does not need to import uiChrome
  // (which would create an import cycle through main.js).
  document.dispatchEvent(new CustomEvent("anvil:show-search-panel"));
  requestAnimationFrame(() => {
    document.getElementById("search-query")?.focus();
  });
}

/** Called once from main.js after DOMContentLoaded. */
export function initSearchPanel() {
  const queryInput   = document.getElementById("search-query");
  const caseBtn      = document.getElementById("search-case-btn");
  const regexBtn     = document.getElementById("search-regex-btn");
  const clearBtn     = document.getElementById("search-clear-btn");
  const resultsEl    = document.getElementById("search-results");

  if (!queryInput) return; // guard against tests without full DOM

  // Debounced search-as-you-type (300 ms, same rhythm as the file palette)
  queryInput.addEventListener("input", () => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => runSearch(), 300);
  });

  queryInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      clearTimeout(searchDebounceTimer);
      runSearch();
    }
    if (e.key === "Escape") {
      queryInput.blur();
    }
  });

  // Toggle buttons — active class drives the visual state via CSS
  caseBtn.addEventListener("click", () => {
    caseBtn.classList.toggle("active");
    runSearch();
  });

  regexBtn.addEventListener("click", () => {
    regexBtn.classList.toggle("active");
    runSearch();
  });

  clearBtn.addEventListener("click", () => {
    queryInput.value = "";
    resultsEl.innerHTML = "";
    lastResults = [];
    setStatusLine("");
    queryInput.focus();
  });
}

// ─── Core search logic ──────────────────────────────────────────────────────

async function runSearch() {
  const queryInput = document.getElementById("search-query");
  const caseBtn    = document.getElementById("search-case-btn");
  const regexBtn   = document.getElementById("search-regex-btn");
  const resultsEl  = document.getElementById("search-results");

  const query         = queryInput.value;
  const caseSensitive = caseBtn.classList.contains("active");
  const useRegex      = regexBtn.classList.contains("active");

  if (!query.trim()) {
    resultsEl.innerHTML = "";
    setStatusLine("");
    return;
  }

  if (!appState.currentWorkspacePath) {
    setStatusLine("Open a workspace first.", true);
    return;
  }

  setStatusLine("Searching…");
  resultsEl.innerHTML = `<div class="search-searching">Searching…</div>`;

  try {
    const matches = await window.__TAURI__.core.invoke("search_in_files", {
      query,
      caseSensitive,
      useRegex,
    });

    lastResults = matches;
    renderResults(matches, query, caseSensitive, useRegex, resultsEl);
  } catch (err) {
    resultsEl.innerHTML = `<div class="search-error">${escapeHtml(String(err))}</div>`;
    setStatusLine("Search error.", true);
  }
}

// ─── Rendering ──────────────────────────────────────────────────────────────

function renderResults(matches, query, caseSensitive, useRegex, container) {
  container.innerHTML = "";

  if (matches.length === 0) {
    container.innerHTML = `<div class="search-empty">No results found.</div>`;
    setStatusLine("No results.");
    return;
  }

  const isCapped = matches.length >= MAX_MATCHES;
  const statusText = isCapped
    ? `Showing first ${MAX_MATCHES.toLocaleString()} matches`
    : `${matches.length.toLocaleString()} match${matches.length === 1 ? "" : "es"}`;
  setStatusLine(statusText);

  // Group by file path
  const byFile = new Map();
  for (const m of matches) {
    if (!byFile.has(m.path)) byFile.set(m.path, []);
    byFile.get(m.path).push(m);
  }

  // Build the regex for highlighting the snippet. Fall back gracefully if the
  // query happens to be an invalid regex (shouldn't happen — backend already
  // validated it — but defensive here).
  let highlightRe = null;
  try {
    const pat = useRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    highlightRe = new RegExp(pat, caseSensitive ? "g" : "gi");
  } catch (_) { /* skip highlight if regex broken */ }

  for (const [filePath, fileMatches] of byFile) {
    const relPath = filePath.startsWith(appState.currentWorkspacePath)
      ? filePath.slice(appState.currentWorkspacePath.length + 1)
      : filePath;

    // File group header
    const header = document.createElement("div");
    header.className = "search-file-header";
    header.innerHTML =
      `<span class="search-file-name">${escapeHtml(relPath)}</span>` +
      `<span class="search-file-count">${fileMatches.length}</span>`;

    // Collapse/expand on click
    let collapsed = false;
    header.addEventListener("click", () => {
      collapsed = !collapsed;
      header.classList.toggle("collapsed", collapsed);
      matchList.style.display = collapsed ? "none" : "";
    });

    const matchList = document.createElement("div");
    matchList.className = "search-match-list";

    for (const match of fileMatches) {
      const row = document.createElement("div");
      row.className = "search-match-row";
      row.tabIndex = 0;

      const lineNum = document.createElement("span");
      lineNum.className = "search-line-num";
      lineNum.textContent = match.line_number;

      const snippet = document.createElement("span");
      snippet.className = "search-snippet";
      snippet.innerHTML = highlightRe
        ? escapeHtml(match.line_content).replace(
            // re-apply on escaped string using escaped query
            new RegExp(
              useRegex
                ? escapeRegexForHighlight(query)
                : escapeHtml(query).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
              caseSensitive ? "g" : "gi"
            ),
            (m) => `<mark class="search-highlight">${m}</mark>`
          )
        : escapeHtml(match.line_content);

      row.appendChild(lineNum);
      row.appendChild(snippet);

      const jumpToMatch = () => jumpToLine(filePath, match.line_number, match.column);
      row.addEventListener("click", jumpToMatch);
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          jumpToMatch();
        }
      });

      matchList.appendChild(row);
    }

    container.appendChild(header);
    container.appendChild(matchList);
  }
}

// ─── Editor jump ────────────────────────────────────────────────────────────

async function jumpToLine(filePath, lineNumber, column) {
  await openOrSwitchToFile(filePath);

  // Give CodeMirror a tick to settle before dispatching the scroll/selection.
  requestAnimationFrame(() => {
    const editor = getEditor();
    if (!editor) return;

    const doc = editor.state.doc;
    if (lineNumber > doc.lines) return;

    const line = doc.line(lineNumber);
    const pos  = Math.min(line.from + column, line.to);

    editor.dispatch({
      selection: { anchor: pos, head: pos },
      effects: EditorView.scrollIntoView(pos, { y: "center" }),
    });
    editor.focus();
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function setStatusLine(text, isError = false) {
  const el = document.getElementById("search-status");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("search-status-error", isError);
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Escape a user regex string for use in a new RegExp() inside the highlighter. */
function escapeRegexForHighlight(pattern) {
  // For regex mode we trust the pattern is valid (backend already validated it)
  // but we need to return it as-is for RegExp construction.
  return pattern;
}
