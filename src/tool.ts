import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { MCPServerConfig, ToolDefinition } from "./instructions.js";
import { callMcpTool, listMcpTools as listMcpToolsInternal } from "./mcp.js";
import { audit, auditStep, auditWarn } from "./audit.js";

export interface ToolCall {
  id: string;
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolExecutionContext {
  tools: ToolDefinition[];
  mcpServers?: MCPServerConfig[];
}

export interface McpToolInfo {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
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

function validateToolArgs(
  tool: ToolDefinition,
  args: Record<string, unknown>
): boolean {
  // TODO: Validate args against tool.parameters JSON schema.
  // For now, assume args are valid.
  void tool;
  void args;
  return true;
}

function resolveToolDefinition(
  name: string,
  context: ToolExecutionContext
): ToolDefinition | undefined {
  return context.tools.find((tool) => tool.name === name);
}

function resolveMcpServer(
  serverName: string,
  context: ToolExecutionContext
): MCPServerConfig | undefined {
  return context.mcpServers?.find((server) => server.name === serverName);
}

export async function listMcpTools(
  server: MCPServerConfig
): Promise<McpToolInfo[]> {
  const response = await listMcpToolsInternal(server);
  return response.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  }));
}

async function executeMcpTool(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  context: ToolExecutionContext
): Promise<string> {
  if (!tool.mcpServer) {
    return JSON.stringify({ error: `Tool ${tool.name} missing mcpServer` });
  }

  const server = resolveMcpServer(tool.mcpServer, context);
  if (!server) {
    return JSON.stringify({ error: `MCP server ${tool.mcpServer} not configured` });
  }

  const result = await callMcpTool(server, tool.name, args);
  return JSON.stringify(result);
}

export async function executeTool(
  toolCall: ToolCall,
  context: ToolExecutionContext
): Promise<string> {
  const { name, arguments: argsJson } = toolCall.function;
  let args: Record<string, unknown>;

  await auditStep("tool.call", name);
  await audit(`tool.args.raw: ${name} -> ${argsJson}`);

  try {
    args = JSON.parse(argsJson) as Record<string, unknown>;
  } catch {
    return JSON.stringify({ error: `Invalid JSON arguments for tool ${name}` });
  }

  const toolDefinition = resolveToolDefinition(name, context);
  if (!toolDefinition) {
    await auditWarn(`tool.unknown: ${name}`);
    return JSON.stringify({ error: `Unknown tool name: ${name}` });
  }

  if (!validateToolArgs(toolDefinition, args)) {
    await auditWarn(`tool.args.invalid: ${name}`);
    return JSON.stringify({ error: `Invalid arguments for tool ${name}` });
  }

  // console.log(`  📞 Tool call: ${name}(${JSON.stringify(args)})`);

  // Tool implementations
  if (toolDefinition.mcpServer) {
    await auditStep("tool.dispatch.mcp", `${toolDefinition.mcpServer}.${name}`);
    return executeMcpTool(toolDefinition, args, context);
  }

  switch (name) {
    case "fetchFoo": {
      const id = args.id as string | undefined;
      // Stub implementation - returns mock data
      const response = JSON.stringify({
        success: true,
        data: {
          id: id ?? "default",
          name: "Foo Item",
          value: 42,
          timestamp: new Date().toISOString(),
        },
      });
      await audit(`tool.response: ${name} -> ${response}`);
      return response;
    }
    default:
      // Should never reach here - resolveToolDefinition already validates
      await auditWarn(`tool.unhandled: ${name}`);
      return JSON.stringify({ error: `Unhandled tool: ${name}` });
  }
}
