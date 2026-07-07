// Agent task panel: sends a prompt through the tool-calling agent loop
// (agent_run) and displays the final result.

export async function runAgent() {
  const agentPrompt = document.getElementById("agent-prompt");
  const agentOutput = document.getElementById("agent-output");
  const agentBtn = document.getElementById("agent-btn");

  const prompt = agentPrompt.value.trim();
  if (!prompt) return;

  agentBtn.disabled = true;
  agentOutput.textContent = "Running agent — this can take a few seconds if it calls tools...";

  try {
    const result = await window.__TAURI__.core.invoke("agent_run", { prompt });
    agentOutput.textContent = result;
  } catch (err) {
    agentOutput.textContent = "Agent failed: " + err;
  } finally {
    agentBtn.disabled = false;
  }
}

export function initAgentPanelBindings() {
  document.getElementById("agent-btn").addEventListener("click", runAgent);
  document.getElementById("agent-prompt").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      runAgent();
    }
  });
}
