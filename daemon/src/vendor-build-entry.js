// Phase 2 vendor bundle entry — expands language support beyond just
// JavaScript, and exports Compartment so main.js can swap languages
// per-file without recreating the editor. Rebuild instructions in this
// phase's README/notes.

export { EditorView, basicSetup } from "codemirror";
export { Compartment } from "@codemirror/state";
export { oneDark } from "@codemirror/theme-one-dark";
export { javascript } from "@codemirror/lang-javascript";
export { python } from "@codemirror/lang-python";
export { rust } from "@codemirror/lang-rust";
export { json } from "@codemirror/lang-json";
export { html } from "@codemirror/lang-html";
export { css } from "@codemirror/lang-css";
export { markdown } from "@codemirror/lang-markdown";