from __future__ import annotations

from typing import Any, Awaitable, Callable


ToolRun = Callable[[dict[str, Any]], Any | Awaitable[Any]]


def define_tool(name: str, description: str, parameters: dict[str, Any], run: ToolRun) -> dict[str, Any]:
    return {"name": name, "description": description, "parameters": parameters, "run": run}


def to_anthropic_tools(tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "name": tool["name"],
            "description": tool["description"],
            "input_schema": tool["parameters"],
        }
        for tool in tools
    ]


def to_openai_tools(tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": tool["name"],
                "description": tool["description"],
                "parameters": tool["parameters"],
            },
        }
        for tool in tools
    ]


async def run_tool(tools: list[dict[str, Any]], name: str, args: dict[str, Any]) -> Any:
    tool = next((item for item in tools if item.get("name") == name), None)
    if tool is None:
        raise ValueError(f"unknown tool: {name}")
    required = tool.get("parameters", {}).get("required", [])
    if isinstance(required, list):
        for key in required:
            if not isinstance(key, str):
                continue
            if key not in args or args[key] is None:
                raise ValueError(f"missing required: {key}")
    result = tool["run"](args)
    if hasattr(result, "__await__"):
        return await result
    return result
