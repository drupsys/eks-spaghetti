from comfy_execution.graph_utils import ExecutionBlocker

MAX_OUTPUTS = 16

# Shared value store: ref_name -> list of input values (actual Python objects)
_ref_stores = {}


class AnyType(str):
    """A special class that is always equal in not-equal comparisons."""

    def __ne__(self, __value: object) -> bool:
        return False


class FlexibleOptionalInputType(dict):
    """Accepts any dynamically-named inputs from the frontend."""

    def __init__(self, type):
        self.type = type

    def __getitem__(self, key):
        return (self.type,)

    def __contains__(self, key):
        return True


any_type = AnyType("*")


class RefNode:
    """Publisher: accepts inputs from a target node and assigns a persistent reference name."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "ref_name": ("STRING", {"default": ""}),
            },
            "optional": FlexibleOptionalInputType(any_type),
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = (any_type,)
    RETURN_NAMES = ("trigger",)
    OUTPUT_NODE = True
    FUNCTION = "execute"
    CATEGORY = "utils"

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        return True

    def execute(self, ref_name="", unique_id=None, **kwargs):
        # Store actual input values for NodeRef to read
        values = list(kwargs.values())
        if ref_name:
            _ref_stores[ref_name] = values
        # Return ref_name as trigger output (creates dependency for NodeRef via injected link)
        return (ref_name,)


class NodeRef:
    """Consumer: outputs values from a named reference."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "ref_name": ("STRING", {"default": "", "forceInput": False}),
            },
            "optional": FlexibleOptionalInputType(any_type),
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = tuple([any_type] * MAX_OUTPUTS)
    RETURN_NAMES = tuple([f"out_{i}" for i in range(MAX_OUTPUTS)])
    FUNCTION = "execute"
    CATEGORY = "utils"

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        return True

    def execute(self, ref_name="", unique_id=None, **kwargs):
        if not ref_name:
            return tuple([ExecutionBlocker(None)] * MAX_OUTPUTS)

        # Read values directly from RefNode's store (same Python objects)
        values = _ref_stores.get(ref_name, [])
        if not values:
            return tuple([ExecutionBlocker(None)] * MAX_OUTPUTS)

        result = []
        for i in range(MAX_OUTPUTS):
            if i < len(values):
                result.append(values[i])
            else:
                result.append(ExecutionBlocker(None))
        return tuple(result)


class SubgraphRef:
    """Reference a Group Node by name — acts as an independent function call."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "ref_name": ("STRING", {"default": ""}),
            },
            "optional": FlexibleOptionalInputType(any_type),
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = tuple([any_type] * MAX_OUTPUTS)
    RETURN_NAMES = tuple([f"out_{i}" for i in range(MAX_OUTPUTS)])
    FUNCTION = "execute"
    CATEGORY = "utils"

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        return True

    def execute(self, ref_name="", unique_id=None, **kwargs):
        # Should not be called — graphToPrompt rewrites class_type to the group node UUID
        return tuple([ExecutionBlocker(None)] * MAX_OUTPUTS)


NODE_CLASS_MAPPINGS = {
    "0nedark_RefOfNode": RefNode,
    "0nedark_PointToNode": NodeRef,
    "0nedark_SubgraphRef": SubgraphRef,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "0nedark_RefOfNode": "&Node",
    "0nedark_PointToNode": "*Node",
    "0nedark_SubgraphRef": "Copy -> Subgraph",
}

WEB_DIRECTORY = "./web/js"
