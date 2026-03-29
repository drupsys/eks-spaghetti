import { app } from "../../scripts/app.js";

const REF_OF_NODE_TYPE = "0nedark_RefOfNode";
const POINT_TO_NODE_TYPE = "0nedark_PointToNode";
const SUBGRAPH_REF_TYPE = "0nedark_SubgraphRef";
const PORTAL_IN_TYPE = "0nedark_PortalIn";
const PORTAL_OUT_TYPE = "0nedark_PortalOut";
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function getNodeClassType(node) {
    return node.comfyClass || node.type;
}

function isGroupNode(node) {
    const classType = getNodeClassType(node);
    if (UUID_REGEX.test(classType)) return true;
    // Fallback: check for proxyWidgets property (group node indicator)
    if (node.properties && "proxyWidgets" in node.properties) return true;
    return false;
}

// ─── Graph traversal helpers ───

function getRootGraph() {
    let graph = app.graph;
    if (!graph) return null;
    while (graph._subgraph_node && graph._subgraph_node.graph) {
        graph = graph._subgraph_node.graph;
    }
    return graph;
}

function collectAllNodes(graph) {
    const results = [];
    if (!graph || !graph._nodes) return results;
    for (const node of graph._nodes) {
        results.push({ node, graph });
        if (node.subgraph) {
            results.push(...collectAllNodes(node.subgraph));
        }
    }
    return results;
}

function collectAllNodesWithPath(graph, path = []) {
    const results = [];
    if (!graph || !graph._nodes) return results;
    for (const node of graph._nodes) {
        results.push({ node, graph, path: [...path] });
        if (node.subgraph) {
            results.push(...collectAllNodesWithPath(node.subgraph, [...path, node.title || node.type]));
        }
    }
    return results;
}

// ─── Reference registry ───

function getRefRegistry() {
    const registry = {};
    const root = getRootGraph();
    if (!root) return registry;

    const allNodes = collectAllNodes(root);

    for (const { node, graph } of allNodes) {
        if (node.type !== REF_OF_NODE_TYPE) continue;

        const nameWidget = node.widgets?.find(w => w.name === "ref_name");
        const refName = nameWidget?.value || "";
        if (!refName) continue;

        const inputs = [];
        if (node.inputs) {
            for (let i = 0; i < node.inputs.length; i++) {
                const input = node.inputs[i];
                if (input.link != null) {
                    const link = graph.links[input.link];
                    if (link) {
                        inputs.push({
                            name: input.label || input.name || `in_${i}`,
                            type: link.type || input.type || "*",
                        });
                    }
                }
            }
        }

        registry[refName] = { refNode: node, graph, inputs };
    }

    return registry;
}

function getRefNameList() {
    const registry = getRefRegistry();
    return ["None", ...Object.keys(registry).sort()];
}

// ─── Output helpers ───

function clearOutputs(node) {
    if (!node.outputs) return;
    while (node.outputs.length > 0) {
        node.removeOutput(0);
    }
}

// ─── Searchable dropdown ───

function showSearchableMenu(items, x, y, onSelect) {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;z-index:9999;";

    const panel = document.createElement("div");
    panel.style.cssText = `position:fixed;left:${x}px;top:${y}px;background:#1e1e1e;border:1px solid #555;border-radius:6px;padding:6px;min-width:250px;max-height:320px;display:flex;flex-direction:column;z-index:10000;font-family:sans-serif;font-size:13px;color:#ccc;box-shadow:0 4px 12px rgba(0,0,0,0.5);`;

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Search...";
    input.style.cssText = "background:#2a2a2a;border:1px solid #555;border-radius:4px;padding:5px 8px;color:#eee;outline:none;margin-bottom:4px;font-size:13px;";

    const list = document.createElement("div");
    list.style.cssText = "overflow-y:auto;flex:1;";

    function render(filter) {
        list.innerHTML = "";
        const filtered = filter ? items.filter(it => it.label.toLowerCase().includes(filter.toLowerCase())) : items;
        for (const item of filtered) {
            const row = document.createElement("div");
            row.textContent = item.label;
            row.style.cssText = "padding:5px 8px;cursor:pointer;border-radius:3px;white-space:nowrap;";
            row.addEventListener("mouseenter", () => row.style.background = "#333");
            row.addEventListener("mouseleave", () => row.style.background = "none");
            row.addEventListener("click", () => { cleanup(); onSelect(item); });
            list.appendChild(row);
        }
    }

    input.addEventListener("input", () => render(input.value));
    input.addEventListener("keydown", (e) => { if (e.key === "Escape") cleanup(); });

    function cleanup() { overlay.remove(); panel.remove(); }
    overlay.addEventListener("click", cleanup);

    panel.appendChild(input);
    panel.appendChild(list);
    document.body.appendChild(overlay);
    document.body.appendChild(panel);
    input.focus();
    render("");
}

// ─── Name helpers ───

function uniqueInputName(node, baseName, slotIndex) {
    let name = baseName;
    let counter = 1;
    while (node.inputs.some((inp, i) => i !== slotIndex && inp.link != null && inp.name === name)) {
        name = `${baseName}_${counter++}`;
    }
    return name;
}

// ─── Sync helpers ───

function updateNodeRefOutputName(refNode, slotIndex, newName) {
    const refNameW = refNode.widgets?.find(w => w.name === "ref_name");
    const rName = refNameW?.value;
    if (!rName) return;

    let outputIdx = 0;
    for (let i = 0; i < slotIndex; i++) {
        if (refNode.inputs[i]?.link != null) outputIdx++;
    }

    const allNodes = collectAllNodes(getRootGraph());
    for (const { node } of allNodes) {
        if (node.type !== POINT_TO_NODE_TYPE) continue;
        const nrWidget = node.widgets?.find(w => w.name === "ref_name");
        if (nrWidget?.value !== rName) continue;
        if (node.outputs?.[outputIdx]) {
            node.outputs[outputIdx].name = newName;
            node.size = node.computeSize();
            node.setDirtyCanvas(true, true);
        }
    }
}

// ─── Ref Node extension (publisher) ───

app.registerExtension({
    name: "0nedark.RefNode",

    commands: [{
        id: "0nedark.goto-consumers",
        label: "Goto",
        icon: "pi pi-arrow-right",
        function: async () => {
            const selected = Object.values(app.canvas.selected_nodes || {});
            const node = selected.find(n => n.type === REF_OF_NODE_TYPE);
            if (!node) return;
            const nameW = node.widgets?.find(w => w.name === "ref_name");
            const rName = nameW?.value;
            if (!rName) return;

            const allNodes = collectAllNodesWithPath(getRootGraph());
            const consumers = [];
            for (const { node: n, graph, path } of allNodes) {
                if (n.type !== POINT_TO_NODE_TYPE) continue;
                const nrWidget = n.widgets?.find(w => w.name === "ref_name");
                if (nrWidget?.value !== rName) continue;
                const nodeLabel = n.title || n.type;
                const parts = [...path, nodeLabel];
                consumers.push({ node: n, graph, label: parts.join(" / ") });
            }

            if (consumers.length === 0) return;

            const navigateTo = async (c) => {
                const canvas = app.canvas;
                if (!canvas) return;
                const currentGraph = canvas.getCurrentGraph?.() ?? canvas.graph;
                if (c.graph && c.graph !== currentGraph) {
                    const fromNode = c.graph._subgraph_node || null;
                    canvas.openSubgraph(c.graph, fromNode);
                    await new Promise(r => setTimeout(r, 16));
                }
                canvas.centerOnNode(c.node);
                canvas.selectNode(c.node, false);
                canvas.setDirty(true, true);
            };

            if (consumers.length === 1) {
                await navigateTo(consumers[0]);
                return;
            }

            const rect = app.canvas.canvas.getBoundingClientRect();
            const x = app.canvas.last_mouse[0] + rect.left;
            const y = app.canvas.last_mouse[1] + rect.top;
            showSearchableMenu(consumers, x, y, navigateTo);
        }
    }],

    getSelectionToolboxCommands(selectedItem) {
        if (selectedItem?.type === REF_OF_NODE_TYPE) return ["0nedark.goto-consumers"];
        return [];
    },

    async beforeRegisterNodeDef(nodeType, nodeData, _app) {
        if (nodeData.name !== REF_OF_NODE_TYPE) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            if (onNodeCreated) onNodeCreated.apply(this, arguments);

            // Wipe default inputs/outputs from INPUT_TYPES
            if (this.inputs) {
                while (this.inputs.length > 0) this.removeInput(0);
            }
            if (this.outputs) {
                while (this.outputs.length > 0) this.removeOutput(0);
            }

            // For new nodes (no configure call), add "..." placeholder after a tick
            const self_init = this;
            setTimeout(() => {
                if (!self_init.inputs?.length) {
                    self_init.addInput("...", "*");
                    self_init.size = self_init.computeSize();
                }
            }, 0);

            this.title = "Ref -> ?";

            if (!this.properties) this.properties = {};
            if (!this.properties._customInputNames) this.properties._customInputNames = {};

            const self = this;

            const nameWidget = this.widgets?.find(w => w.name === "ref_name");
            if (nameWidget) {
                const origCallback = nameWidget.callback;
                nameWidget.callback = function (value) {
                    if (origCallback) origCallback.call(this, value);
                    self.title = value ? `Ref -> ${value}` : "Ref -> ?";
                    self.size = self.computeSize();
                    self.setDirtyCanvas(true, true);
                };
                if (nameWidget.value) {
                    this.title = `Ref -> ${nameWidget.value}`;
                }
            }

        };

        const origConfigure = nodeType.prototype.configure;
        nodeType.prototype.configure = function (info) {
            this._isRestoring = true;
            if (origConfigure) origConfigure.apply(this, arguments);
            this._isRestoring = false;
        };

        const onConnectionsChange = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onConnectionsChange = function (type, slotIndex, isConnected, linkInfo, ioSlot) {
            if (onConnectionsChange) onConnectionsChange.apply(this, arguments);

            if (type !== 1) return;
            if (!this.inputs) return;
            if (this._isRestoring) return;

            if (isConnected && linkInfo && this.inputs[slotIndex]) {
                const link = this.graph?.links[linkInfo.id || linkInfo];
                if (link) {
                    if (link.type) {
                        this.inputs[slotIndex].type = link.type;
                    }
                    // Inherit the output name from the source node (unless custom-named)
                    if (!this.properties._customInputNames?.[String(slotIndex)]) {
                        const sourceNode = this.graph?.getNodeById(link.origin_id);
                        if (sourceNode && sourceNode.outputs && sourceNode.outputs[link.origin_slot]) {
                            const baseName = sourceNode.outputs[link.origin_slot].name;
                            this.inputs[slotIndex].name = uniqueInputName(this, baseName, slotIndex);
                        }
                    }
                }
            }

            // Reset disconnected input type back to wildcard
            if (!isConnected && this.inputs[slotIndex]) {
                this.inputs[slotIndex].type = "*";
            }

            // Remap custom input names before removing disconnected slots
            if (this.properties._customInputNames) {
                const oldCustom = this.properties._customInputNames;
                const newCustom = {};
                let newIdx = 0;
                for (let i = 0; i < this.inputs.length; i++) {
                    if (this.inputs[i].link != null) {
                        if (oldCustom[String(i)]) {
                            newCustom[String(newIdx)] = oldCustom[String(i)];
                        }
                        newIdx++;
                    }
                }
                this.properties._customInputNames = newCustom;
            }

            // Remove only empty placeholder inputs (not real inputs awaiting reconnection)
            for (let i = this.inputs.length - 1; i >= 0; i--) {
                if (this.inputs[i].link == null && this.inputs[i].name === "..." && !this.inputs[i].label) {
                    this.removeInput(i);
                }
            }

            // Ensure at least one empty input slot exists for new connections
            const lastInput = this.inputs[this.inputs.length - 1];
            if (!this.inputs.length || (lastInput && lastInput.link != null)) {
                this.addInput("...", "*");
            }

            // Rename connected inputs from their source output names (respecting custom names and labels)
            for (let i = 0; i < this.inputs.length; i++) {
                if (this.inputs[i].link != null) {
                    if (this.inputs[i].label) {
                        // LiteGraph built-in rename — keep it
                    } else if (this.properties._customInputNames?.[String(i)]) {
                        this.inputs[i].name = this.properties._customInputNames[String(i)];
                    } else {
                        const link = this.graph?.links[this.inputs[i].link];
                        if (link) {
                            const srcNode = this.graph?.getNodeById(link.origin_id);
                            if (srcNode?.outputs?.[link.origin_slot]) {
                                const baseName = srcNode.outputs[link.origin_slot].name;
                                this.inputs[i].name = uniqueInputName(this, baseName, i);
                            }
                        }
                    }
                }
            }

            this.size = this.computeSize();
            this.setDirtyCanvas(true, true);
        };

        const origGetExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
        nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
            if (origGetExtraMenuOptions) origGetExtraMenuOptions.apply(this, arguments);

            const self = this;
            const slot = this._lastInputSlotOver;

            if (slot != null && this.inputs[slot] && this.inputs[slot].link != null) {
                options.push(null); // separator
                options.push({
                    content: "Rename Input",
                    callback: () => {
                        const currentName = self.inputs[slot].name;
                        const newName = prompt("Enter new name for this input:", currentName);
                        if (!newName || !newName.trim()) return;
                        const trimmed = newName.trim();
                        if (trimmed === "..." || trimmed === "ref_name") return;
                        // Check for duplicate names
                        for (let i = 0; i < self.inputs.length; i++) {
                            if (i !== slot && self.inputs[i].name === trimmed) return;
                        }
                        if (!self.properties._customInputNames) self.properties._customInputNames = {};
                        self.properties._customInputNames[String(slot)] = trimmed;
                        self.inputs[slot].name = trimmed;
                        self.setDirtyCanvas(true, true);
                        updateNodeRefOutputName(self, slot, trimmed);
                    }
                });

                if (this.properties._customInputNames?.[String(slot)]) {
                    options.push({
                        content: "Reset Input Name",
                        callback: () => {
                            delete self.properties._customInputNames[String(slot)];
                            let restoredName = self.inputs[slot].name;
                            const link = self.graph?.links[self.inputs[slot].link];
                            if (link) {
                                const srcNode = self.graph?.getNodeById(link.origin_id);
                                if (srcNode?.outputs?.[link.origin_slot]) {
                                    restoredName = srcNode.outputs[link.origin_slot].name;
                                    self.inputs[slot].name = restoredName;
                                }
                            }
                            self.setDirtyCanvas(true, true);
                            updateNodeRefOutputName(self, slot, restoredName);
                        }
                    });
                }
            }
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            if (onConfigure) onConfigure.apply(this, arguments);
            const nameWidget = this.widgets?.find(w => w.name === "ref_name");
            if (nameWidget?.value) {
                this.title = `Ref -> ${nameWidget.value}`;
            }

            // Ensure trailing "..." placeholder exists
            const lastInput = this.inputs?.[this.inputs.length - 1];
            if (!this.inputs?.length || (lastInput && lastInput.link != null)) {
                this.addInput("...", "*");
            }

            // Remove trigger output if present (restored by LiteGraph serialization)
            if (this.outputs) {
                while (this.outputs.length > 0) this.removeOutput(0);
            }

            // Restore input labels from serialized data
            if (info.inputs) {
                for (let i = 0; i < info.inputs.length; i++) {
                    if (this.inputs[i] && info.inputs[i].label) {
                        this.inputs[i].label = info.inputs[i].label;
                    }
                }
            }

            // Restore custom input names from properties
            if (this.properties._customInputNames) {
                for (const [idx, name] of Object.entries(this.properties._customInputNames)) {
                    const i = parseInt(idx);
                    if (this.inputs[i]) {
                        this.inputs[i].name = name;
                    }
                }
            }
        };
    },
});

// ─── Subgraph registry ───

function getSubgraphRegistry() {
    const registry = {};
    const root = getRootGraph();
    if (!root) return registry;

    const allNodes = collectAllNodes(root);

    for (const { node, graph } of allNodes) {
        if (!isGroupNode(node)) continue;

        const classType = getNodeClassType(node);
        const name = node.title || classType;
        if (!name) continue;

        if (registry[name]) {
            if (registry[name].classType !== classType) {
                registry[name].ambiguous = true;
            }
            continue;
        }

        // Read ALL inputs/outputs from the subgraph definition (-10/-20 nodes)
        // because the new ComfyUI frontend hides optional unconnected inputs from node.inputs
        const inputs = [];
        const outputs = [];
        const sg = node.subgraph;

        if (sg?._nodes) {
            const inputNode = sg._nodes.find(n => n.id === -10);
            if (inputNode?.outputs) {
                for (const out of inputNode.outputs) {
                    inputs.push({
                        name: out.name,
                        type: out.type || "*",
                        label: out.label || out.name,
                    });
                }
            }
            const outputNode = sg._nodes.find(n => n.id === -20);
            if (outputNode?.inputs) {
                for (const inp of outputNode.inputs) {
                    outputs.push({
                        name: inp.name,
                        type: inp.type || "*",
                        label: inp.label || inp.name,
                    });
                }
            }
        }

        // Fallback to node.inputs/outputs if subgraph not available
        if (inputs.length === 0 && node.inputs) {
            for (const inp of node.inputs) {
                inputs.push({ name: inp.name, type: inp.type || "*", label: inp.label || inp.name });
            }
        }
        if (outputs.length === 0 && node.outputs) {
            for (const out of node.outputs) {
                outputs.push({ name: out.name, type: out.type || "*", label: out.label || out.name });
            }
        }

        registry[name] = { classType, node, graph, inputs, outputs, ambiguous: false };
    }

    return registry;
}

function getSubgraphNameList() {
    const registry = getSubgraphRegistry();
    return ["None", ...Object.keys(registry).filter(n => !registry[n].ambiguous).sort()];
}

// ─── Generic slot sync helper ───

function syncSlots(node, kind, desired) {
    const slots = node[kind] || [];
    const addFn = kind === "inputs" ? "addInput" : "addOutput";
    const removeFn = kind === "inputs" ? "removeInput" : "removeOutput";

    let changed = false;
    const minLen = Math.min(slots.length, desired.length);

    for (let i = 0; i < minLen; i++) {
        const d = desired[i];
        const displayName = d.label || d.name;
        if (slots[i].name !== d.name || slots[i].type !== d.type) {
            slots[i].name = d.name;
            slots[i].type = d.type;
            changed = true;
        }
        if ((slots[i].label || "") !== (d.label || "")) {
            slots[i].label = d.label || null;
            changed = true;
        }
    }

    for (let i = slots.length - 1; i >= desired.length; i--) {
        node[removeFn](i);
        changed = true;
    }

    for (let i = (node[kind]?.length || 0); i < desired.length; i++) {
        const d = desired[i];
        node[addFn](d.name, d.type);
        if (d.label) {
            node[kind][node[kind].length - 1].label = d.label;
        }
        changed = true;
    }

    return changed;
}

// ─── Subgraph IO sync ───

function syncSubgraphIO(node) {
    const refNameWidget = node.widgets?.find(w => w.name === "ref_name");
    const refName = refNameWidget?.value;

    if (!refName || refName === "None" || refName === "") {
        const hadSlots = (node.inputs?.length || 0) + (node.outputs?.length || 0) > 0;
        if (hadSlots) {
            if (node.inputs) while (node.inputs.length > 0) node.removeInput(0);
            clearOutputs(node);
            node.properties._subgraph_inputs = null;
            node.properties._subgraph_outputs = null;
            node.title = "Copy -> ?";
            node.size = node.computeSize();
            node.setDirtyCanvas(true, true);
        }
        return;
    }

    const registry = getSubgraphRegistry();
    const info = registry[refName];

    // If not found or ambiguous, keep last known state
    if (!info || info.ambiguous) return;

    const desiredInputs = info.inputs;
    const desiredOutputs = info.outputs;

    // Check if already in sync
    const inputsMatch = (node.inputs?.length || 0) === desiredInputs.length &&
        desiredInputs.every((d, i) => node.inputs[i].name === d.name && node.inputs[i].type === d.type);
    const outputsMatch = (node.outputs?.length || 0) === desiredOutputs.length &&
        desiredOutputs.every((d, i) => node.outputs[i].name === d.name && node.outputs[i].type === d.type);

    if (inputsMatch && outputsMatch) {
        // Ensure properties are stored
        if (!node.properties._subgraph_uuid || node.properties._subgraph_uuid !== info.uuid) {
            node.properties._subgraph_uuid = info.classType;
            node.properties._subgraph_inputs = desiredInputs;
            node.properties._subgraph_outputs = desiredOutputs;
        }
        return;
    }

    const inputsChanged = syncSlots(node, "inputs", desiredInputs);
    const outputsChanged = syncSlots(node, "outputs", desiredOutputs);

    if (inputsChanged || outputsChanged) {
        node.properties._subgraph_uuid = info.classType;
        node.properties._subgraph_inputs = desiredInputs;
        node.properties._subgraph_outputs = desiredOutputs;
        node.title = `Copy -> ${refName}`;
        node.size = node.computeSize();
        node.setDirtyCanvas(true, true);
    }
}

// ─── Node Ref extension (consumer) ───

/**
 * Sync Node Ref's outputs to match the current state of the referenced Ref Node.
 * Incremental: preserves existing outputs and their connections when possible.
 */
function syncOutputsToRef(node) {
    const refNameWidget = node.widgets?.find(w => w.name === "ref_name");
    const refName = refNameWidget?.value;
    if (!refName || refName === "None" || refName === "") {
        if (node.outputs && node.outputs.length > 0) {
            clearOutputs(node);
            node.properties._ref_outputs = null;
            node.title = `? -> Ref (#${node.id})`;
            node.size = node.computeSize();
            node.setDirtyCanvas(true, true);
        }
        return;
    }

    const registry = getRefRegistry();
    const refInfo = registry[refName];

    // If ref name not found in registry, don't touch outputs — ref node may not be loaded yet
    if (!refInfo) return;

    // Build the expected output list
    const desired = refInfo.inputs.map(inp => ({ name: inp.name, type: inp.type }));
    // Check if actual outputs already match exactly
    const numOutputs = node.outputs?.length || 0;
    if (
        numOutputs === desired.length &&
        desired.every((d, i) => node.outputs[i].name === d.name && node.outputs[i].type === d.type)
    ) {
        // Ensure _ref_outputs is in sync
        if (!node.properties._ref_outputs || node.properties._ref_outputs.length !== desired.length) {
            node.properties._ref_outputs = desired.map((d, i) => ({
                name: d.name, type: d.type, origIndex: i
            }));
        }
        return; // No change needed
    }

    // Incremental update: keep matching prefix, fix changed slots, add/remove rest
    let changed = false;

    // Update existing outputs that changed type/name
    const minLen = Math.min(node.outputs?.length || 0, desired.length);
    for (let i = 0; i < minLen; i++) {
        if (node.outputs[i].name !== desired[i].name || node.outputs[i].type !== desired[i].type) {
            node.outputs[i].name = desired[i].name;
            node.outputs[i].type = desired[i].type;
            changed = true;
        }
    }

    // Remove excess outputs from the end
    if (node.outputs && node.outputs.length > desired.length) {
        for (let i = node.outputs.length - 1; i >= desired.length; i--) {
            node.removeOutput(i);
        }
        changed = true;
    }

    // Add missing outputs at the end
    for (let i = (node.outputs?.length || 0); i < desired.length; i++) {
        node.addOutput(desired[i].name, desired[i].type);
        changed = true;
    }

    if (changed) {
        node.properties._ref_outputs = desired.map((d, i) => ({
            name: d.name, type: d.type, origIndex: i
        }));
        node.title = `${refName} -> Ref (#${node.id})`;
        node.size = node.computeSize();
        node.setDirtyCanvas(true, true);
    }
}

app.registerExtension({
    name: "0nedark.NodeRef",

    commands: [{
        id: "0nedark.goto-producer",
        label: "Goto",
        icon: "pi pi-arrow-left",
        function: async () => {
            const selected = Object.values(app.canvas.selected_nodes || {});
            const node = selected.find(n => n.type === POINT_TO_NODE_TYPE);
            if (!node) return;
            const refNameW = node.widgets?.find(w => w.name === "ref_name");
            const name = refNameW?.value;
            if (!name || name === "None" || name === "") return;

            const registry = getRefRegistry();
            const refInfo = registry[name];
            if (!refInfo || !refInfo.refNode) return;

            const canvas = app.canvas;
            if (!canvas) return;

            const currentGraph = canvas.getCurrentGraph?.() ?? canvas.graph;
            if (refInfo.graph && refInfo.graph !== currentGraph) {
                const fromNode = refInfo.graph._subgraph_node || null;
                canvas.openSubgraph(refInfo.graph, fromNode);
                await new Promise(r => setTimeout(r, 16));
            }

            canvas.centerOnNode(refInfo.refNode);
            canvas.selectNode(refInfo.refNode, false);
            canvas.setDirty(true, true);
        }
    }],

    getSelectionToolboxCommands(selectedItem) {
        if (selectedItem?.type === POINT_TO_NODE_TYPE) return ["0nedark.goto-producer"];
        return [];
    },

    async setup() {
        const origGraphToPrompt = app.graphToPrompt;
        app.graphToPrompt = async function () {
            const rootGraph = getRootGraph();
            const subgraphReg = rootGraph ? getSubgraphRegistry() : {};
            const dummies = [];

            if (rootGraph) {
                const referencedGroups = new Set();
                for (const { node } of collectAllNodes(rootGraph)) {
                    if (node.type !== SUBGRAPH_REF_TYPE) continue;
                    const w = node.widgets?.find(w => w.name === "ref_name");
                    if (w?.value && w.value !== "None" && subgraphReg[w.value]) {
                        referencedGroups.add(w.value);
                    }
                }
                for (const refName of referencedGroups) {
                    const info = subgraphReg[refName];
                    if (!info.node.inputs) continue;
                    for (let i = 0; i < info.node.inputs.length; i++) {
                        if (info.node.inputs[i].link != null) continue;
                        const dummy = LiteGraph.createNode("PrimitiveInt");
                        if (!dummy) continue;
                        dummy.pos = [info.node.pos[0] - 300, info.node.pos[1]];
                        info.graph.add(dummy);
                        dummy.connect(0, info.node, i);
                        dummies.push({ graph: info.graph, dummy, node: info.node, slot: i });
                    }
                }
            }

            const result = await origGraphToPrompt.apply(this, arguments);

            // ─── Phase 2b: Remove dummies ───
            for (const { graph, dummy, node, slot } of dummies) {
                node.disconnectInput(slot);
                graph.remove(dummy);
            }

            if (!result || !result.output) return result;

            // Note: dummy PrimitiveInt entries stay in the prompt — they're harmless.
            // Removing them would leave dangling refs in the original group's expansion.

            // RefNode/NodeRef _ref_trigger injection
            const refNodeMap = {};
            for (const nodeId in result.output) {
                if (result.output[nodeId].class_type === REF_OF_NODE_TYPE) {
                    const name = result.output[nodeId].inputs?.ref_name;
                    if (name) refNodeMap[name] = nodeId;
                }
            }
            for (const nodeId in result.output) {
                if (result.output[nodeId].class_type !== POINT_TO_NODE_TYPE) continue;
                const refName = result.output[nodeId].inputs?.ref_name;
                if (refName && refNodeMap[refName]) {
                    result.output[nodeId].inputs["_ref_trigger"] = [refNodeMap[refName], 0];
                }
            }

            // Portal scoped _ref_trigger injection
            for (const nodeId in result.output) {
                const nd = result.output[nodeId];
                if (nd.class_type !== PORTAL_OUT_TYPE) continue;
                const refName = nd.inputs?.ref_name;
                if (!refName) continue;
                const parts = nodeId.split(":");
                const scope = parts.length > 1 ? parts.slice(0, -1).join(":") : "";
                let found = false;
                for (const otherId in result.output) {
                    const other = result.output[otherId];
                    if (other.class_type !== PORTAL_IN_TYPE) continue;
                    if (other.inputs?.ref_name !== refName) continue;
                    const oParts = otherId.split(":");
                    const oScope = oParts.length > 1 ? oParts.slice(0, -1).join(":") : "";
                    if (oScope === scope) {
                        nd.inputs["_ref_trigger"] = [otherId, 0];
                        found = true;
                        break;
                    }
                }
                console.log(`[Portal] ${nodeId} (scope="${scope}", ref="${refName}"): trigger ${found ? "injected" : "NOT FOUND"}`);
            }

            // SubgraphRef expansion
            function findExpandedPrefix(originalId) {
                for (const pId in result.output) {
                    if (pId.startsWith(originalId + ":")) return originalId;
                    const idx = pId.indexOf(":" + originalId + ":");
                    if (idx >= 0) return pId.substring(0, idx + 1 + originalId.length);
                }
                return null;
            }

            function tryExpandRef(refNodeId, refNodeData) {
                const refName = refNodeData.inputs?.ref_name;
                if (!refName || refName === "None") { delete result.output[refNodeId]; return true; }
                const info = subgraphReg[refName];
                if (!info) return false;
                if (info.ambiguous) throw new Error(`[&Subgraph] Ambiguous: "${refName}".`);

                const expandedPrefix = findExpandedPrefix(String(info.node.id));
                if (!expandedPrefix) return false;

                const expandedNodes = {};
                for (const pId in result.output) {
                    if (pId.startsWith(expandedPrefix + ":")) expandedNodes[pId] = result.output[pId];
                }

                const sg = info.node.subgraph;
                if (!sg?.links) return false;

                // Input mapping from -10
                const inputMap = {};
                for (const lId in sg.links) {
                    const l = sg.links[lId];
                    if (!l || l.origin_id !== -10) continue;
                    const n = sg._nodes?.find(n => n.id === l.target_id);
                    if (!n) continue;
                    const name = n.inputs?.[l.target_slot]?.name;
                    if (name == null) continue;
                    if (!inputMap[l.origin_slot]) inputMap[l.origin_slot] = [];
                    inputMap[l.origin_slot].push({ nodeId: String(l.target_id), name });
                }

                // Output mapping to -20
                const outputMap = {};
                for (const lId in sg.links) {
                    const l = sg.links[lId];
                    if (!l || l.target_id !== -20) continue;
                    outputMap[l.target_slot] = { nodeId: String(l.origin_id), slot: l.origin_slot };
                }

                // &Subgraph's inputs by slot (use registry inputs which include all slots)
                const refInputs = {};
                for (let i = 0; i < info.inputs.length; i++) {
                    const val = refNodeData.inputs[info.inputs[i].name];
                    if (val !== undefined) refInputs[i] = val;
                }
                // Clone with new prefix
                const newPrefix = refNodeId;
                for (const [oldId, oldData] of Object.entries(expandedNodes)) {
                    const suffix = oldId.substring(expandedPrefix.length);
                    const cloned = JSON.parse(JSON.stringify(oldData));
                    for (const key in cloned.inputs) {
                        const val = cloned.inputs[key];
                        if (!Array.isArray(val)) continue;
                        const src = String(val[0]);
                        if (src.startsWith(expandedPrefix + ":")) {
                            cloned.inputs[key] = [newPrefix + src.substring(expandedPrefix.length), val[1]];
                        }
                    }
                    result.output[newPrefix + suffix] = cloned;
                }

                // Follow reroute chains for optimized-away nodes
                function resolveTarget(targetId) {
                    const resolved = [];
                    for (const lId in sg.links) {
                        const l = sg.links[lId];
                        if (!l || String(l.origin_id) !== targetId) continue;
                        const destCloneId = newPrefix + ":" + String(l.target_id);
                        if (result.output[destCloneId]) {
                            const dn = sg._nodes?.find(n => n.id === l.target_id);
                            const dn_name = dn?.inputs?.[l.target_slot]?.name;
                            if (dn_name != null) resolved.push({ nodeId: String(l.target_id), name: dn_name });
                        } else {
                            resolved.push(...resolveTarget(String(l.target_id)));
                        }
                    }
                    return resolved;
                }

                // Override external inputs (resolve through optimized-away reroutes)
                for (const [slot, targets] of Object.entries(inputMap)) {
                    const val = refInputs[parseInt(slot)];
                    if (val === undefined) continue;
                    for (const { nodeId, name } of targets) {
                        const id = newPrefix + ":" + nodeId;
                        if (result.output[id]) {
                            result.output[id].inputs[name] = val;
                        } else {
                            for (const r of resolveTarget(nodeId)) {
                                const rId = newPrefix + ":" + r.nodeId;
                                if (result.output[rId]) result.output[rId].inputs[r.name] = val;
                            }
                        }
                    }
                }

                // Remap output references
                for (const pId in result.output) {
                    if (pId === refNodeId) continue;
                    const nd = result.output[pId];
                    if (!nd?.inputs) continue;
                    for (const key in nd.inputs) {
                        const val = nd.inputs[key];
                        if (!Array.isArray(val) || String(val[0]) !== refNodeId) continue;
                        const m = outputMap[val[1]];
                        if (m) nd.inputs[key] = [newPrefix + ":" + m.nodeId, m.slot];
                    }
                }

                delete result.output[refNodeId];
                return true;
            }

            // Iterative: defer refs inside another ref's expansion source
            for (let pass = 0; pass < 10; pass++) {
                const refs = [];
                for (const nId in result.output) {
                    if (result.output[nId].class_type === SUBGRAPH_REF_TYPE) refs.push(nId);
                }
                if (refs.length === 0) break;

                const refPrefixes = {};
                for (const nId of refs) {
                    const rn = result.output[nId].inputs?.ref_name;
                    const inf = rn ? subgraphReg[rn] : null;
                    if (inf) { const p = findExpandedPrefix(String(inf.node.id)); if (p) refPrefixes[nId] = p; }
                }

                let any = false;
                for (const nId of refs) {
                    if (!result.output[nId]) continue;
                    let inside = false;
                    for (const [oId, p] of Object.entries(refPrefixes)) {
                        if (oId !== nId && nId.startsWith(p + ":")) { inside = true; break; }
                    }
                    if (inside) continue;
                    if (tryExpandRef(nId, result.output[nId])) any = true;
                }
                if (!any) {
                    for (const nId of refs) { if (result.output[nId]) delete result.output[nId]; }
                    break;
                }
            }

            // DEBUG: dump portal entries
            for (const nId in result.output) {
                const nd = result.output[nId];
                if (nd.class_type === PORTAL_IN_TYPE || nd.class_type === PORTAL_OUT_TYPE) {
                    console.log(`[Portal prompt] ${nId}: class=${nd.class_type}, inputs=${JSON.stringify(nd.inputs)}`);
                }
            }

            // Portal passthrough resolution (runs AFTER SubgraphRef expansion)
            // Replace downstream refs to PortalIn outputs with direct refs to input sources
            for (const portalId in result.output) {
                const portalNd = result.output[portalId];
                if (portalNd.class_type !== PORTAL_IN_TYPE) continue;

                // Build output-slot → input-source map (prompt key order, skip non-link entries)
                const sources = [];
                for (const [key, val] of Object.entries(portalNd.inputs)) {
                    if (key === "ref_name" || key === "_ref_trigger") continue;
                    if (Array.isArray(val)) sources.push(val);
                }

                // Replace downstream references
                for (const nId in result.output) {
                    if (nId === portalId) continue;
                    const nd = result.output[nId];
                    if (!nd.inputs) continue;
                    for (const key in nd.inputs) {
                        const val = nd.inputs[key];
                        if (!Array.isArray(val) || String(val[0]) !== portalId) continue;
                        if (key === "_ref_trigger") continue;
                        const slot = val[1];
                        if (slot < sources.length) {
                            nd.inputs[key] = sources[slot];
                        }
                    }
                }
            }

            return result;
        };
    },

    async beforeRegisterNodeDef(nodeType, nodeData, _app) {
        if (nodeData.name !== POINT_TO_NODE_TYPE) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            if (onNodeCreated) onNodeCreated.apply(this, arguments);

            clearOutputs(this);

            if (!this.properties) this.properties = {};
            if (!this.properties._ref_outputs) this.properties._ref_outputs = null;

            const self = this;

            // Hide the backend's STRING widget and add a real combo dropdown
            const refNameWidget = this.widgets?.find(w => w.name === "ref_name");
            if (refNameWidget) {
                refNameWidget.computeSize = () => [0, -4];
            }

            // Add a proper combo widget for ref name selection
            this.refNameCombo = this.addWidget(
                "combo",
                "select_ref",
                refNameWidget?.value || "None",
                function (value) {
                    if (refNameWidget) {
                        refNameWidget.value = value === "None" ? "" : value;
                    }
                    syncOutputsToRef(self);
                },
                {
                    values: () => getRefNameList(),
                }
            );
            this.refNameCombo.serializeValue = () => undefined;

            this.title = `? -> Ref (#${this.id})`;
        };

        // Auto-refresh outputs when the referenced Ref Node's connections change
        const onDrawForeground = nodeType.prototype.onDrawForeground;
        nodeType.prototype.onDrawForeground = function (ctx) {
            if (onDrawForeground) onDrawForeground.apply(this, arguments);
            syncOutputsToRef(this);
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            if (onConfigure) onConfigure.apply(this, arguments);

            const refNameWidget = this.widgets?.find(w => w.name === "ref_name");
            const refName = refNameWidget?.value;

            if (refName && refName !== "None" && refName !== "") {
                this.title = `${refName} -> Ref (#${this.id})`;

                if (this.refNameCombo) {
                    this.refNameCombo.value = refName;
                }

                // Defer sync to after graph is fully loaded
                const self = this;
                setTimeout(() => syncOutputsToRef(self), 200);
            }
        };
    },
});

// ─── Portal registry (same-level only) ───

function getPortalRegistry() {
    const registry = {};
    // Use the canvas's current graph (follows subgraph navigation)
    const graph = app.canvas?.graph || app.graph;
    if (!graph?._nodes) return registry;

    for (const node of graph._nodes) {
        if (node.type !== PORTAL_IN_TYPE) continue;

        const nameWidget = node.widgets?.find(w => w.name === "ref_name");
        const refName = nameWidget?.value || "";
        if (!refName) continue;

        const inputs = [];
        if (node.inputs) {
            for (let i = 0; i < node.inputs.length; i++) {
                const input = node.inputs[i];
                if (input.link != null) {
                    const link = graph.links[input.link];
                    if (link) {
                        inputs.push({
                            name: input.label || input.name || `in_${i}`,
                            type: link.type || input.type || "*",
                        });
                    }
                }
            }
        }

        registry[refName] = { portalNode: node, inputs };
    }

    return registry;
}

function getPortalNameList() {
    const registry = getPortalRegistry();
    return ["None", ...Object.keys(registry).sort()];
}

// ─── Portal output sync ───

function syncOutputsToPortal(node) {
    const refNameWidget = node.widgets?.find(w => w.name === "ref_name");
    const refName = refNameWidget?.value;
    if (!refName || refName === "None" || refName === "") {
        if (node.outputs && node.outputs.length > 0) {
            clearOutputs(node);
            node.title = `? -> Portal (#${node.id})`;
            node.size = node.computeSize();
            node.setDirtyCanvas(true, true);
        }
        return;
    }

    const registry = getPortalRegistry();
    const info = registry[refName];
    if (!info) return;

    const desired = info.inputs.map(inp => ({ name: inp.name, type: inp.type }));
    const numOutputs = node.outputs?.length || 0;
    if (
        numOutputs === desired.length &&
        desired.every((d, i) => node.outputs[i].name === d.name && node.outputs[i].type === d.type)
    ) {
        return;
    }

    let changed = false;
    const minLen = Math.min(node.outputs?.length || 0, desired.length);
    for (let i = 0; i < minLen; i++) {
        if (node.outputs[i].name !== desired[i].name || node.outputs[i].type !== desired[i].type) {
            node.outputs[i].name = desired[i].name;
            node.outputs[i].type = desired[i].type;
            changed = true;
        }
    }
    if (node.outputs && node.outputs.length > desired.length) {
        for (let i = node.outputs.length - 1; i >= desired.length; i--) node.removeOutput(i);
        changed = true;
    }
    for (let i = (node.outputs?.length || 0); i < desired.length; i++) {
        node.addOutput(desired[i].name, desired[i].type);
        changed = true;
    }

    if (changed) {
        node.title = `${refName} -> Portal (#${node.id})`;
        node.size = node.computeSize();
        node.setDirtyCanvas(true, true);
    }
}

// ─── Portal In output sync (passthrough) ───

function syncPortalInOutputs(node) {
    const desired = [];
    if (node.inputs) {
        for (const inp of node.inputs) {
            if (inp.link != null && inp.name !== "...") {
                desired.push({ name: inp.label || inp.name, type: inp.type || "*" });
            }
        }
    }

    const numOutputs = node.outputs?.length || 0;
    if (
        numOutputs === desired.length &&
        desired.every((d, i) => node.outputs[i].name === d.name && node.outputs[i].type === d.type)
    ) {
        return;
    }

    let changed = false;
    const minLen = Math.min(node.outputs?.length || 0, desired.length);
    for (let i = 0; i < minLen; i++) {
        if (node.outputs[i].name !== desired[i].name || node.outputs[i].type !== desired[i].type) {
            node.outputs[i].name = desired[i].name;
            node.outputs[i].type = desired[i].type;
            changed = true;
        }
    }
    if (node.outputs && node.outputs.length > desired.length) {
        for (let i = node.outputs.length - 1; i >= desired.length; i--) node.removeOutput(i);
        changed = true;
    }
    for (let i = (node.outputs?.length || 0); i < desired.length; i++) {
        node.addOutput(desired[i].name, desired[i].type);
        changed = true;
    }

    if (changed) {
        node.size = node.computeSize();
        node.setDirtyCanvas(true, true);
    }
}

// ─── Portal In extension (publisher) ───

app.registerExtension({
    name: "0nedark.PortalIn",

    async beforeRegisterNodeDef(nodeType, nodeData, _app) {
        if (nodeData.name !== PORTAL_IN_TYPE) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            if (onNodeCreated) onNodeCreated.apply(this, arguments);

            if (this.inputs) while (this.inputs.length > 0) this.removeInput(0);
            if (this.outputs) while (this.outputs.length > 0) this.removeOutput(0);

            const self_init = this;
            setTimeout(() => {
                if (!self_init.inputs?.length) {
                    self_init.addInput("...", "*");
                    self_init.size = self_init.computeSize();
                }
            }, 0);

            this.title = "Portal -> ?";

            if (!this.properties) this.properties = {};
            if (!this.properties._customInputNames) this.properties._customInputNames = {};

            const self = this;
            const nameWidget = this.widgets?.find(w => w.name === "ref_name");
            if (nameWidget) {
                const origCallback = nameWidget.callback;
                nameWidget.callback = function (value) {
                    if (origCallback) origCallback.call(this, value);
                    self.title = value ? `Portal -> ${value}` : "Portal -> ?";
                    self.size = self.computeSize();
                    self.setDirtyCanvas(true, true);
                };
                if (nameWidget.value) this.title = `Portal -> ${nameWidget.value}`;
            }
        };

        const origConfigure = nodeType.prototype.configure;
        nodeType.prototype.configure = function (info) {
            this._isRestoring = true;
            if (origConfigure) origConfigure.apply(this, arguments);
            this._isRestoring = false;
        };

        const onConnectionsChange = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onConnectionsChange = function (type, slotIndex, isConnected, linkInfo, ioSlot) {
            if (onConnectionsChange) onConnectionsChange.apply(this, arguments);
            if (type !== 1 || !this.inputs || this._isRestoring) return;

            if (isConnected && linkInfo && this.inputs[slotIndex]) {
                const link = this.graph?.links[linkInfo.id || linkInfo];
                if (link) {
                    if (link.type) this.inputs[slotIndex].type = link.type;
                    if (!this.properties._customInputNames?.[String(slotIndex)]) {
                        const sourceNode = this.graph?.getNodeById(link.origin_id);
                        if (sourceNode?.outputs?.[link.origin_slot]) {
                            const baseName = sourceNode.outputs[link.origin_slot].name;
                            this.inputs[slotIndex].name = uniqueInputName(this, baseName, slotIndex);
                        } else {
                            // Source not found (e.g., subgraph input node -10) — use fallback name
                            this.inputs[slotIndex].name = `in_${slotIndex}`;
                        }
                    }
                }
            }

            if (!isConnected && this.inputs[slotIndex]) this.inputs[slotIndex].type = "*";

            if (this.properties._customInputNames) {
                const oldCustom = this.properties._customInputNames;
                const newCustom = {};
                let newIdx = 0;
                for (let i = 0; i < this.inputs.length; i++) {
                    if (this.inputs[i].link != null) {
                        if (oldCustom[String(i)]) newCustom[String(newIdx)] = oldCustom[String(i)];
                        newIdx++;
                    }
                }
                this.properties._customInputNames = newCustom;
            }

            for (let i = this.inputs.length - 1; i >= 0; i--) {
                if (this.inputs[i].link == null && this.inputs[i].name === "..." && !this.inputs[i].label) {
                    this.removeInput(i);
                }
            }

            const lastInput = this.inputs[this.inputs.length - 1];
            if (!this.inputs.length || (lastInput && lastInput.link != null)) {
                this.addInput("...", "*");
            }

            for (let i = 0; i < this.inputs.length; i++) {
                if (this.inputs[i].link != null) {
                    if (this.inputs[i].label) { /* keep */ }
                    else if (this.properties._customInputNames?.[String(i)]) {
                        this.inputs[i].name = this.properties._customInputNames[String(i)];
                    } else {
                        const link = this.graph?.links[this.inputs[i].link];
                        if (link) {
                            const srcNode = this.graph?.getNodeById(link.origin_id);
                            if (srcNode?.outputs?.[link.origin_slot]) {
                                this.inputs[i].name = uniqueInputName(this, srcNode.outputs[link.origin_slot].name, i);
                            } else if (this.inputs[i].name === "...") {
                                this.inputs[i].name = `in_${i}`;
                            }
                        }
                    }
                }
            }

            this.size = this.computeSize();
            this.setDirtyCanvas(true, true);
            syncPortalInOutputs(this);
        };

        const onDrawForeground = nodeType.prototype.onDrawForeground;
        nodeType.prototype.onDrawForeground = function (ctx) {
            if (onDrawForeground) onDrawForeground.apply(this, arguments);
            syncPortalInOutputs(this);
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            if (onConfigure) onConfigure.apply(this, arguments);
            const nameWidget = this.widgets?.find(w => w.name === "ref_name");
            if (nameWidget?.value) this.title = `Portal -> ${nameWidget.value}`;

            const lastInput = this.inputs?.[this.inputs.length - 1];
            if (!this.inputs?.length || (lastInput && lastInput.link != null)) {
                this.addInput("...", "*");
            }

            if (this.outputs) {
                for (let i = this.outputs.length - 1; i >= 0; i--) {
                    if (this.outputs[i].name === "trigger") this.removeOutput(i);
                }
            }

            if (info.inputs) {
                for (let i = 0; i < info.inputs.length; i++) {
                    if (this.inputs[i] && info.inputs[i].label) this.inputs[i].label = info.inputs[i].label;
                }
            }

            if (this.properties._customInputNames) {
                for (const [idx, name] of Object.entries(this.properties._customInputNames)) {
                    const i = parseInt(idx);
                    if (this.inputs[i]) this.inputs[i].name = name;
                }
            }
        };
    },
});

// ─── Portal Out extension (consumer) ───

app.registerExtension({
    name: "0nedark.PortalOut",

    async beforeRegisterNodeDef(nodeType, nodeData, _app) {
        if (nodeData.name !== PORTAL_OUT_TYPE) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            if (onNodeCreated) onNodeCreated.apply(this, arguments);

            clearOutputs(this);

            if (!this.properties) this.properties = {};

            const self = this;

            const refNameWidget = this.widgets?.find(w => w.name === "ref_name");
            if (refNameWidget) refNameWidget.computeSize = () => [0, -4];

            this.portalCombo = this.addWidget(
                "combo",
                "select_portal",
                refNameWidget?.value || "None",
                function (value) {
                    if (refNameWidget) refNameWidget.value = value === "None" ? "" : value;
                    syncOutputsToPortal(self);
                },
                { values: () => getPortalNameList() }
            );
            this.portalCombo.serializeValue = () => undefined;

            this.title = `? -> Portal (#${this.id})`;
        };

        const onDrawForeground = nodeType.prototype.onDrawForeground;
        nodeType.prototype.onDrawForeground = function (ctx) {
            if (onDrawForeground) onDrawForeground.apply(this, arguments);
            syncOutputsToPortal(this);
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            if (onConfigure) onConfigure.apply(this, arguments);

            const refNameWidget = this.widgets?.find(w => w.name === "ref_name");
            const refName = refNameWidget?.value;

            if (refName && refName !== "None" && refName !== "") {
                this.title = `${refName} -> Portal (#${this.id})`;
                if (this.portalCombo) this.portalCombo.value = refName;
                const self = this;
                setTimeout(() => syncOutputsToPortal(self), 200);
            }
        };
    },
});

// ─── Subgraph Ref extension ───

app.registerExtension({
    name: "0nedark.SubgraphRef",

    commands: [{
        id: "0nedark.goto-subgraph",
        label: "Goto",
        icon: "pi pi-arrow-left",
        function: async () => {
            const selected = Object.values(app.canvas.selected_nodes || {});
            const node = selected.find(n => n.type === SUBGRAPH_REF_TYPE);
            if (!node) return;
            const refNameW = node.widgets?.find(w => w.name === "ref_name");
            const name = refNameW?.value;
            if (!name || name === "None" || name === "") return;

            const registry = getSubgraphRegistry();
            const info = registry[name];
            if (!info || !info.node) return;

            const canvas = app.canvas;
            if (!canvas) return;

            const currentGraph = canvas.getCurrentGraph?.() ?? canvas.graph;
            if (info.graph && info.graph !== currentGraph) {
                const fromNode = info.graph._subgraph_node || null;
                canvas.openSubgraph(info.graph, fromNode);
                await new Promise(r => setTimeout(r, 16));
            }

            canvas.centerOnNode(info.node);
            canvas.selectNode(info.node, false);
            canvas.setDirty(true, true);
        }
    }],

    getSelectionToolboxCommands(selectedItem) {
        if (selectedItem?.type === SUBGRAPH_REF_TYPE) return ["0nedark.goto-subgraph"];
        return [];
    },

    async beforeRegisterNodeDef(nodeType, nodeData, _app) {
        if (nodeData.name !== SUBGRAPH_REF_TYPE) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            if (onNodeCreated) onNodeCreated.apply(this, arguments);

            // Wipe default inputs/outputs
            if (this.inputs) while (this.inputs.length > 0) this.removeInput(0);
            if (this.outputs) while (this.outputs.length > 0) this.removeOutput(0);

            if (!this.properties) this.properties = {};
            this.properties._subgraph_inputs = null;
            this.properties._subgraph_outputs = null;
            this.properties._subgraph_uuid = null;

            this.title = "&Subgraph";

            const self = this;

            // Hide the backend's STRING widget and add a combo dropdown
            const refNameWidget = this.widgets?.find(w => w.name === "ref_name");
            if (refNameWidget) {
                refNameWidget.computeSize = () => [0, -4];
            }

            this.subgraphCombo = this.addWidget(
                "combo",
                "select_subgraph",
                refNameWidget?.value || "None",
                function (value) {
                    if (refNameWidget) {
                        refNameWidget.value = value === "None" ? "" : value;
                    }
                    syncSubgraphIO(self);
                },
                { values: () => getSubgraphNameList() }
            );
            this.subgraphCombo.serializeValue = () => undefined;
        };

        const onDrawForeground = nodeType.prototype.onDrawForeground;
        nodeType.prototype.onDrawForeground = function (ctx) {
            if (onDrawForeground) onDrawForeground.apply(this, arguments);
            syncSubgraphIO(this);
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            if (onConfigure) onConfigure.apply(this, arguments);

            const refNameWidget = this.widgets?.find(w => w.name === "ref_name");
            const refName = refNameWidget?.value;

            if (refName && refName !== "None" && refName !== "") {
                this.title = `&${refName}`;

                if (this.subgraphCombo) {
                    this.subgraphCombo.value = refName;
                }

                // Restore from properties if available
                if (this.properties._subgraph_inputs) {
                    syncSlots(this, "inputs", this.properties._subgraph_inputs);
                }
                if (this.properties._subgraph_outputs) {
                    syncSlots(this, "outputs", this.properties._subgraph_outputs);
                }

                // Defer full sync to after graph is loaded
                const self = this;
                setTimeout(() => syncSubgraphIO(self), 200);
            }
        };
    },
});
