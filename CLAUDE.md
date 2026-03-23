# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a **ComfyUI custom node pack** (`0nedark-eks-spaghetti`) published to the Comfy Registry under publisher `onedark`. It provides two nodes that enable "spaghetti-free" workflows by letting users create named references to pass data between distant nodes without visible noodle connections.

## Architecture

The pack consists of two complementary nodes:

- **RefNode (`&Node`)** — Publisher. Accepts arbitrary inputs from any node and stores their values under a user-defined `ref_name` in a global Python dict (`_ref_stores`).
- **NodeRef (`*Node`)** — Consumer. Reads values from a named reference and exposes them as outputs (up to `MAX_OUTPUTS=16`).

Execution ordering is enforced by patching `app.graphToPrompt` in the frontend JS to inject a hidden `_ref_trigger` link from RefNode to NodeRef, ensuring RefNode always executes first.

**Key files:**
- `__init__.py` — Python backend: node classes, `NODE_CLASS_MAPPINGS`, shared value store
- `web/js/node_ref.js` — Frontend extension: dynamic input/output management, ref registry, combo widget, goto navigation, prompt patching

The `AnyType("*")` class and `FlexibleOptionalInputType` dict enable accepting/outputting any ComfyUI data type.

## Development

No build step. The pack is loaded directly by ComfyUI from its `custom_nodes` directory.

**Lint:** `ruff check .` (ruff cache present in `.ruff_cache/`)

**Testing:** No test suite exists. Test manually by loading the nodes in ComfyUI.

**Install/Update:** Pull the latest published version from the registry:
```
source /mnt/comfy/comfy-env/bin/activate
comfy node registry-install 0nedark-eks-spaghetti
```

**Publishing:** Uses `comfy-cli` to publish to the Comfy Registry (see `[tool.comfy]` in `pyproject.toml`). Activate the environment first:
```
source /mnt/comfy/comfy-env/bin/activate
comfy node publish --token "$COMFY_REGISTRY_TOKEN"
```
