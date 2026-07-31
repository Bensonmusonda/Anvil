// Shared model-selection state for the inline (Mod-k) popup and the agent
// chat panel. Single module-level source of truth, synced via a
// dispatched event — same pattern tabs.js/fileTree.js use for dirty-dots —
// rather than a direct import cycle between aiPanel.js and agentPanel.js.
// Mounting this into a future top-bar selector later is just another
// mountModelSelector(container) call; no rewiring needed here.

let cachedModels = null; // { known_pairs, providers }
let selected = { provider: null, model: null };

export function getSelectedModel() {
    return selected.provider && selected.model ? { ...selected } : null;
}

function setSelected(provider, model) {
    selected = { provider, model };
    document.dispatchEvent(new CustomEvent("anvil:model-changed", { detail: { ...selected } }));
}

async function loadModels() {
    if (cachedModels) return cachedModels;
    cachedModels = await window.__TAURI__.core.invoke("get_available_models");
    return cachedModels;
}

// Renders a self-contained selector into `container`: a <select> of known
// (provider, model) pairs plus a "Custom…" option that reveals a provider
// <select> + free-text model <input>.
export async function mountModelSelector(container) {
    const models = await loadModels();

    const wrap = document.createElement("div");
    wrap.className = "model-selector";

    const knownSelect = document.createElement("select");
    knownSelect.className = "model-selector-known";

    models.known_pairs.forEach((opt) => {
        const el = document.createElement("option");
        el.value = `${opt.provider}::${opt.model}`;
        el.textContent = opt.label;
        knownSelect.appendChild(el);
    });

    const customOpt = document.createElement("option");
    customOpt.value = "__custom__";
    customOpt.textContent = "Custom…";
    knownSelect.appendChild(customOpt);

    const customRow = document.createElement("div");
    customRow.className = "model-selector-custom";
    customRow.style.display = "none";

    const providerSelect = document.createElement("select");
    models.providers.forEach((name) => {
        const el = document.createElement("option");
        el.value = name;
        el.textContent = name;
        providerSelect.appendChild(el);
    });

    const modelInput = document.createElement("input");
    modelInput.type = "text";
    modelInput.placeholder = "model name";

    customRow.appendChild(providerSelect);
    customRow.appendChild(modelInput);

    function applyKnown() {
        const [provider, model] = knownSelect.value.split("::");
        setSelected(provider, model);
    }

    function applyCustom() {
        if (providerSelect.value && modelInput.value.trim()) {
            setSelected(providerSelect.value, modelInput.value.trim());
        }
    }

    knownSelect.addEventListener("change", () => {
        if (knownSelect.value === "__custom__") {
            customRow.style.display = "flex";
            applyCustom();
        } else {
            customRow.style.display = "none";
            applyKnown();
        }
    });
    providerSelect.addEventListener("change", applyCustom);
    modelInput.addEventListener("input", applyCustom);

    wrap.appendChild(knownSelect);
    wrap.appendChild(customRow);
    container.appendChild(wrap);

    if (models.known_pairs.length > 0) {
        knownSelect.value = `${models.known_pairs[0].provider}::${models.known_pairs[0].model}`;
        applyKnown();
    } else if (models.providers.length > 0) {
        knownSelect.value = "__custom__";
        customRow.style.display = "flex";
        providerSelect.value = models.providers[0];
    }
}