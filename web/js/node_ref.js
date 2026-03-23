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

// ─── Sync helpers ───

function updateNodeRefOutputName(refNode, slotIndex, newName) {
    const refNameW = refNode.widgets?.find(w => w.name === "ref_name");
    const rName = refNameW?.value;
    console.log("[updateNodeRefOutputName] rName:", rName, "slotIndex:", slotIndex, "newName:", newName);
    if (!rName) return;

    // Find the output index: count connected inputs before this slot
    let outputIdx = 0;
    for (let i = 0; i < slotIndex; i++) {
        if (refNode.inputs[i]?.link != null) outputIdx++;
    }
    console.log("[updateNodeRefOutputName] outputIdx:", outputIdx);

    const allNodes = collectAllNodes(getRootGraph());
    let found = 0;
    for (const { node } of allNodes) {
        if (node.type !== POINT_TO_NODE_TYPE) continue;
        const nrWidget = node.widgets?.find(w => w.name === "ref_name");
        console.log("[updateNodeRefOutputName] checking NodeRef, ref_name widget value:", nrWidget?.value, "match:", nrWidget?.value === rName);
        if (nrWidget?.value !== rName) continue;
        found++;
        console.log("[updateNodeRefOutputName] NodeRef outputs:", JSON.stringify(node.outputs?.map(o => o.name)));
        if (node.outputs?.[outputIdx]) {
            node.outputs[outputIdx].name = newName;
            node.size = node.computeSize();
            node.setDirtyCanvas(true, true);
            console.log("[updateNodeRefOutputName] Updated output", outputIdx, "to", newName);
        } else {
            console.log("[updateNodeRefOutputName] No output at index", outputIdx);
        }
    }
    console.log("[updateNodeRefOutputName] Total NodeRef matches:", found);
}

// ─── Ref Node extension (publisher) ───

app.registerExtension({
    name: "0nedark.RefNode",

    async beforeRegisterNodeDef(nodeType, nodeData, _app) {
        if (nodeData.name !== REF_OF_NODE_TYPE) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            if (onNodeCreated) onNodeCreated.apply(this, arguments);

            if (this.inputs) {
                while (this.inputs.length > 0) {
                    this.removeInput(0);
                }
            }
            this.addInput("...", "*");

            // Hide the trigger output (used internally for execution ordering)
            if (this.outputs) {
                while (this.outputs.length > 0) {
                    this.removeOutput(0);
                }
            }

            this.title = "Ref ->";

            if (!this.properties) this.properties = {};
            if (!this.properties._customInputNames) this.properties._customInputNames = {};

            const self = this;

            const nameWidget = this.widgets?.find(w => w.name === "ref_name");
            if (nameWidget) {
                const origCallback = nameWidget.callback;
                nameWidget.callback = function (value) {
                    if (origCallback) origCallback.call(this, value);
                    self.title = value ? `Ref -> ${value}` : "Ref ->";
                    self.size = self.computeSize();
                    self.setDirtyCanvas(true, true);
                };
                if (nameWidget.value) {
                    this.title = `Ref -> ${nameWidget.value}`;
                }
            }
        };

        const onConnectionsChange = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onConnectionsChange = function (type, slotIndex, isConnected, linkInfo, ioSlot) {
            if (onConnectionsChange) onConnectionsChange.apply(this, arguments);

            if (type !== 1) return;
            if (!this.inputs) return;

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
                            this.inputs[slotIndex].name = sourceNode.outputs[link.origin_slot].name;
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

            // Remove all unconnected inputs, then re-add one empty slot at the end
            for (let i = this.inputs.length - 1; i >= 0; i--) {
                if (this.inputs[i].link == null) {
                    this.removeInput(i);
                }
            }

            // Ensure at least one empty input slot exists for new connections
            const lastInput = this.inputs[this.inputs.length - 1];
            if (!this.inputs.length || (lastInput && lastInput.link != null)) {
                this.addInput("...", "*");
            }

            // Rename connected inputs from their source output names (respecting custom names)
            for (let i = 0; i < this.inputs.length; i++) {
                if (this.inputs[i].link != null) {
                    if (this.properties._customInputNames?.[String(i)]) {
                        this.inputs[i].name = this.properties._customInputNames[String(i)];
                    } else {
                        const link = this.graph?.links[this.inputs[i].link];
                        if (link) {
                            const srcNode = this.graph?.getNodeById(link.origin_id);
                            if (srcNode?.outputs?.[link.origin_slot]) {
                                this.inputs[i].name = srcNode.outputs[link.origin_slot].name;
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
            // Restore custom input names from properties
            if (this.properties._customInputNames) {
                for (const [idx, name] of Object.entries(this.properties._customInputNames)) {
                    const i = parseInt(idx);
                    if (this.inputs[i] && this.inputs[i].link != null) {
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
        node.title = refName ? `${refName} -> Ref` : "-> Ref";
        node.size = node.computeSize();
        node.setDirtyCanvas(true, true);
    }
}

app.registerExtension({
    name: "0nedark.NodeRef",

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
                refNameWidget.type = "hidden";
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

            // Goto button — navigates to the correct subgraph and centers on the Ref Node
            this.addWidget("button", "Goto", null, async function () {
                const refNameW = self.widgets?.find(w => w.name === "ref_name");
                const name = refNameW?.value;
                if (!name || name === "None" || name === "") return;

                const registry = getRefRegistry();
                const refInfo = registry[name];
                if (!refInfo || !refInfo.refNode) return;

                const refNode = refInfo.refNode;
                const targetGraph = refInfo.graph;
                const canvas = app.canvas;
                if (!canvas) return;

                const currentGraph = canvas.getCurrentGraph?.() ?? canvas.graph;
                if (targetGraph && targetGraph !== currentGraph) {
                    // Find the subgraph node that owns the target graph
                    // (the node you'd double-click to enter it)
                    const fromNode = targetGraph._subgraph_node || null;
                    canvas.openSubgraph(targetGraph, fromNode);
                    // Wait for graph switch to settle
                    await new Promise(r => setTimeout(r, 16));
                }

                canvas.centerOnNode(refNode);
                canvas.selectNode(refNode, false);
                canvas.setDirty(true, true);
            });

            this.title = "-> Ref";
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
                this.title = `${refName} -> Ref`;

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
