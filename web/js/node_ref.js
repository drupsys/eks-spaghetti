import { app } from "../../scripts/app.js";

const REF_OF_NODE_TYPE = "0nedark_RefOfNode";
const POINT_TO_NODE_TYPE = "0nedark_PointToNode";

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
        // Patch graphToPrompt to inject _ref_trigger dependency from RefNode to NodeRef
        const origGraphToPrompt = app.graphToPrompt;
        app.graphToPrompt = async function () {
            const result = await origGraphToPrompt.apply(this, arguments);
            if (!result || !result.output) return result;

            // Build map: ref_name -> refNode prompt ID
            const refNodeMap = {};
            for (const nodeId in result.output) {
                const nodeData = result.output[nodeId];
                if (nodeData.class_type === REF_OF_NODE_TYPE) {
                    const name = nodeData.inputs?.ref_name;
                    if (name) {
                        refNodeMap[name] = nodeId;
                    }
                }
            }

            // For each NodeRef, inject _ref_trigger link to matching RefNode
            for (const nodeId in result.output) {
                const nodeData = result.output[nodeId];
                if (nodeData.class_type !== POINT_TO_NODE_TYPE) continue;

                const refName = nodeData.inputs?.ref_name;
                if (!refName || !refNodeMap[refName]) continue;

                // Inject trigger dependency: [refnode_id, 0] (output slot 0 = trigger)
                nodeData.inputs["_ref_trigger"] = [refNodeMap[refName], 0];
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
