export interface ToolDefinition<Args extends Record<string, unknown> = Record<string, unknown>> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run: (args: Args) => unknown | Promise<unknown>;
}

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export function defineTool<Args extends Record<string, unknown>>(
  tool: ToolDefinition<Args>,
): ToolDefinition<Args> {
  return tool;
}

export function toAnthropicTools(tools: readonly ToolDefinition[]): AnthropicTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

export function toOpenAITools(tools: readonly ToolDefinition[]): OpenAITool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

export async function runTool(
  tools: readonly ToolDefinition[],
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new Error(`unknown tool: ${name}`);
  const required = Array.isArray(tool.parameters.required) ? tool.parameters.required : [];
  for (const key of required) {
    if (typeof key !== "string") continue;
    if (!Object.prototype.hasOwnProperty.call(args, key) || args[key] === undefined || args[key] === null) {
      throw new Error(`missing required: ${key}`);
    }
  }
  return tool.run(args);
}
