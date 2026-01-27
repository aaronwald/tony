import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { ToolDefinition } from "./instructions.js";

export interface ToolCall {
  id: string;
  function: {
    name: string;
    arguments: string;
  };
}

export function buildToolDefinition(tool: ToolDefinition): ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

export async function executeTool(toolCall: ToolCall): Promise<string> {
  const { name, arguments: argsJson } = toolCall.function;
  let args: Record<string, unknown>;

  try {
    args = JSON.parse(argsJson) as Record<string, unknown>;
  } catch {
    return JSON.stringify({ error: `Invalid JSON arguments for tool ${name}` });
  }

  // console.log(`  📞 Tool call: ${name}(${JSON.stringify(args)})`);

  // Tool implementations
  switch (name) {
    case "fetchFoo": {
      const id = args.id as string | undefined;
      // Stub implementation - returns mock data
      return JSON.stringify({
        success: true,
        data: {
          id: id ?? "default",
          name: "Foo Item",
          value: 42,
          timestamp: new Date().toISOString(),
        },
      });
    }
    default:
      return JSON.stringify({
        result: `Stub response for ${name}`,
        args,
      });
  }
}
