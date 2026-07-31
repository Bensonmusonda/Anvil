// Owns the CodeMirror EditorView instance, the editor theme, and per-file
// language selection. Deliberately does NOT import anything from
// lspClient.js/fileOps.js/aiPanel.js — construction is deferred into
// createEditor(extensions), called once from main.js after every module
// that contributes an extension has already loaded. This sidesteps a real
// circular-dependency risk: the editor needs LSP/AI extensions to
// construct itself, but LSP/AI code needs the constructed editor to
// dispatch changes. main.js is the one place that breaks the cycle by
// controlling construction order explicitly.

import {
  EditorView,
  EditorState,
  basicSetup,
  Compartment,
  javascript,
  python,
  rust,
  json,
  html,
  css,
  markdown,
} from "./vendor/codemirror.bundle.js";


const LANGUAGE_FACTORIES = {
  javascript: () => javascript(),
  javascriptJsx: () => javascript({ jsx: true }),
  typescript: () => javascript({ typescript: true }),
  typescriptTsx: () => javascript({ typescript: true, jsx: true }),
  python: () => python(),
  rust: () => rust(),
  json: () => json(),
  html: () => html(),
  css: () => css(),
  markdown: () => markdown(),
};

const LANGUAGE_BY_EXT = {
  js: LANGUAGE_FACTORIES.javascript,
  jsx: LANGUAGE_FACTORIES.javascriptJsx,
  ts: LANGUAGE_FACTORIES.typescript,
  tsx: LANGUAGE_FACTORIES.typescriptTsx,
  py: LANGUAGE_FACTORIES.python,
  rs: LANGUAGE_FACTORIES.rust,
  json: LANGUAGE_FACTORIES.json,
  html: LANGUAGE_FACTORIES.html,
  css: LANGUAGE_FACTORIES.css,
  md: LANGUAGE_FACTORIES.markdown,
};

// Aliases for fenced-code-block language tags (```js, ```python, etc.) —
// LLM output and file extensions don't use the same vocabulary. To add a
// new language everywhere it matters: one entry in LANGUAGE_FACTORIES,
// referenced from this map and/or LANGUAGE_BY_EXT above as needed.
const LANGUAGE_BY_FENCE_NAME = {
  js: LANGUAGE_FACTORIES.javascript,
  javascript: LANGUAGE_FACTORIES.javascript,
  jsx: LANGUAGE_FACTORIES.javascriptJsx,
  ts: LANGUAGE_FACTORIES.typescript,
  typescript: LANGUAGE_FACTORIES.typescript,
  tsx: LANGUAGE_FACTORIES.typescriptTsx,
  py: LANGUAGE_FACTORIES.python,
  python: LANGUAGE_FACTORIES.python,
  rs: LANGUAGE_FACTORIES.rust,
  rust: LANGUAGE_FACTORIES.rust,
  json: LANGUAGE_FACTORIES.json,
  html: LANGUAGE_FACTORIES.html,
  css: LANGUAGE_FACTORIES.css,
  md: LANGUAGE_FACTORIES.markdown,
  markdown: LANGUAGE_FACTORIES.markdown,
};

export function languageForPath(path) {
  const ext = path.split(".").pop().toLowerCase();
  const factory = LANGUAGE_BY_EXT[ext];
  return factory ? factory() : [];
}

// Raw Lezer parser for a fenced-code-block language tag, or null if
// unsupported — callers should fall back to plain unhighlighted text
// rather than throwing. Used by codeHighlight.js for static highlighting
// outside an editor instance.
export function parserForFenceName(name) {
  const factory = LANGUAGE_BY_FENCE_NAME[(name || "").toLowerCase()];
  return factory ? factory().language.parser : null;
}

export const languageCompartment = new Compartment();

const dynamicTheme = EditorView.theme({
  "&": {
    color: "var(--text)",
    backgroundColor: "var(--bg)",
  },
  ".cm-content": {
    caretColor: "var(--accent)",
  },
  "&.cm-focused .cm-cursor": {
    borderLeftColor: "var(--accent)",
  },
  "&.cm-focused .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--panel)",
  },
  ".cm-gutters": {
    backgroundColor: "var(--bg)",
    color: "var(--dim)",
    border: "none",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "var(--panel)",
    color: "var(--text)",
  },
  ".cm-activeLine": {
    backgroundColor: "rgba(255, 255, 255, 0.04)",
  },
}, { dark: false });

let _editor = null;
let sharedExtensions = [];

/// Builds a fresh EditorState for one tab's content. Shares the same base
/// setup (theme, line wrapping, language-per-extension) and the same
/// LSP/AI/keymap extensions every tab was constructed with, so every tab
/// behaves identically — only the document, language, and (via the
/// caller) selection/undo-history differ per tab. `path` is null for the
/// placeholder state shown before any file is open.
export function buildEditorState(content, path) {
  return EditorState.create({
    doc: content,
    extensions: [
      basicSetup,
      dynamicTheme,
      languageCompartment.of(path ? languageForPath(path) : []),
      EditorView.lineWrapping,
      ...sharedExtensions,
    ],
  });
}

export function buildDiffEditorState(diffContent) {
  return EditorState.create({
    doc: diffContent || "(no diff output)",
    extensions: [
      basicSetup,
      dynamicTheme,
      EditorView.lineWrapping,
      EditorState.readOnly.of(true),
    ],
  });
}

/// Constructs the EditorView exactly once. `extensions` is whatever the
/// caller (main.js) gathered from other modules (autocompletion, hover,
/// keymaps, etc.) — stashed in sharedExtensions so buildEditorState() can
/// reuse the identical list for every subsequently-created tab.
export function createEditor(extensions) {
  sharedExtensions = extensions;
  _editor = new EditorView({
    state: buildEditorState("// Open a folder on the left, then click a file to edit it.\n", null),
    parent: document.getElementById("editor"),
  });
  return _editor;
}

/// Other modules call this inside their own functions (never at their own
/// top level) to get the live editor instance — see the module comment
/// above for why this indirection exists.
export function getEditor() {
  return _editor;
}

export function setEditorContent(content) {
  _editor.dispatch({
    changes: { from: 0, to: _editor.state.doc.length, insert: content },
  });
}
