// Anvil Editor — Phase 6.5: frontend modularization
//
// This file is now just the composition root: it gathers the extensions
// every other module contributes, constructs the editor once (breaking
// the circular-dependency risk described in editorSetup.js's top comment),
// and wires up every panel's event listeners. No editor logic, no LSP
// logic, no panel logic lives here anymore — see the individual modules.

import { autocompletion, lintGutter } from "./vendor/codemirror.bundle.js";
import { createEditor } from "./editorSetup.js";
import { rustCompletionSource, rustHover, definitionKeymap, initLspEditorBindings } from "./lspClient.js";
import { aiPopupKeymap, initAiPanelBindings } from "./aiPanel.js";
import { initFileOpsBindings } from "./fileOps.js";
import { initFileTreeBindings } from "./fileTree.js";
import { initTerminalBindings } from "./terminalPanel.js";
import { initGitPanelBindings } from "./gitPanel.js";
import { initAgentPanelBindings } from "./agentPanel.js";
import { initCommandPaletteBindings } from "./commandPalette.js";
import { initUiChrome } from "./uiChrome.js";

const editor = createEditor([
  autocompletion({ override: [rustCompletionSource] }),
  lintGutter(),
  rustHover,
  definitionKeymap,
  aiPopupKeymap,
]);

initLspEditorBindings(editor);
initFileOpsBindings();
initFileTreeBindings();
initTerminalBindings();
initGitPanelBindings();
initAgentPanelBindings();
initAiPanelBindings();
initCommandPaletteBindings();
initUiChrome();
