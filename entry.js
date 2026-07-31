// Phase 5 vendor bundle entry — adds autocomplete, lint (diagnostics), and
// hoverTooltip on top of Phase 2's language support. Rebuild the same way
// as before, with the additional packages listed in this phase's notes.

export { EditorView, basicSetup } from "codemirror";
export { Compartment, EditorState } from "@codemirror/state";
export { hoverTooltip } from "@codemirror/view";
export { oneDark } from "@codemirror/theme-one-dark";
export { javascript } from "@codemirror/lang-javascript";
export { python } from "@codemirror/lang-python";
export { rust } from "@codemirror/lang-rust";
export { json } from "@codemirror/lang-json";
export { html } from "@codemirror/lang-html";
export { css } from "@codemirror/lang-css";
export { markdown } from "@codemirror/lang-markdown";
export { defaultHighlightStyle } from "@codemirror/language";
export { highlightCode } from "@lezer/highlight";
export { autocompletion } from "@codemirror/autocomplete";
export { linter, lintGutter, setDiagnostics } from "@codemirror/lint";
export { keymap } from "@codemirror/view";