// Static syntax highlighting for fenced code blocks in the agent chat
// pane. Reuses the exact same `defaultHighlightStyle` instance the live
// editor uses (via basicSetup in editorSetup.js) through CM6's official
// highlightCode() API for highlighting outside an EditorView — so both
// surfaces render identical token colors from one shared source, with no
// separate theme to maintain here.

import { highlightCode, defaultHighlightStyle } from "./vendor/codemirror.bundle.js";
import { parserForFenceName } from "./editorSetup.js";

function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
}

// Returns highlighted HTML (span-wrapped tokens) for `code` in `lang`, or
// null if `lang` has no registered parser yet — caller falls back to
// plain escaped text in that case.
export function highlightCodeBlock(code, lang) {
    const parser = parserForFenceName(lang);
    if (!parser) return null;

    let tree;
    try {
        tree = parser.parse(code);
    } catch {
        return null; // malformed snippet — fall back rather than break the bubble
    }

    let html = "";
    highlightCode(
        code,
        tree,
        defaultHighlightStyle,
        (text, className) => {
            html += className ? `<span class="${className}">${escapeHtml(text)}</span>` : escapeHtml(text);
        },
        () => { html += "\n"; },
        2
    );
    return html;
}