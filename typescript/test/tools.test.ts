import { describe, expect, it } from "vitest";

import { defineTool, runTool, toAnthropicTools, toOpenAITools } from "../src/tools.ts";

const parameters = {
  type: "object",
  properties: { order_id: { type: "string" } },
  required: ["order_id"],
};

describe("tools", () => {
  const lookup = defineTool({
    name: "lookup_order",
    description: "Look up an order",
    parameters,
    run: (args) => args.order_id,
  });

  it("converts tools to the Anthropic and OpenAI shapes", () => {
    expect(toAnthropicTools([lookup])).toEqual([
      { name: "lookup_order", description: "Look up an order", input_schema: parameters },
    ]);
    expect(toOpenAITools([lookup])).toEqual([
      {
        type: "function",
        function: { name: "lookup_order", description: "Look up an order", parameters },
      },
    ]);
  });

  it("runs a tool when required keys are present and refuses a missing key", async () => {
    await expect(runTool([lookup], "lookup_order", { order_id: "123" })).resolves.toBe("123");
    await expect(runTool([lookup], "lookup_order", {})).rejects.toThrow("missing required: order_id");
    await expect(runTool([lookup], "other", { order_id: "123" })).rejects.toThrow("unknown tool: other");
  });
});
