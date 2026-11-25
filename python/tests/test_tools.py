import asyncio

from p2a_sdk import define_tool, run_tool, to_anthropic_tools, to_openai_tools

PARAMETERS = {
    "type": "object",
    "properties": {"order_id": {"type": "string"}},
    "required": ["order_id"],
}


def _lookup(args):
    return args["order_id"]


def test_converters_match_the_documented_shapes():
    tool = define_tool("lookup_order", "Look up an order", PARAMETERS, _lookup)
    assert to_anthropic_tools([tool]) == [
        {"name": "lookup_order", "description": "Look up an order", "input_schema": PARAMETERS}
    ]
    assert to_openai_tools([tool]) == [
        {
            "type": "function",
            "function": {
                "name": "lookup_order",
                "description": "Look up an order",
                "parameters": PARAMETERS,
            },
        }
    ]


def test_run_tool_checks_required_keys():
    tool = define_tool("lookup_order", "Look up an order", PARAMETERS, _lookup)

    async def run():
        assert await run_tool([tool], "lookup_order", {"order_id": "123"}) == "123"
        try:
            await run_tool([tool], "lookup_order", {})
        except ValueError as err:
            assert str(err) == "missing required: order_id"
        else:
            raise AssertionError("expected missing required")
        try:
            await run_tool([tool], "other", {"order_id": "123"})
        except ValueError as err:
            assert str(err) == "unknown tool: other"
        else:
            raise AssertionError("expected unknown tool")

    asyncio.run(run())
