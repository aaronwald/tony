import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { MCPServerConfig } from "./instructions.js";
import { audit, auditError, auditStep, auditWarn } from "./audit.js";

const clientCache = new Map<string, Client>();
const transportCache = new Map<string, StdioClientTransport>();

function getServerKey(server: MCPServerConfig): string {
	return server.name;
}

async function connectStdioServer(server: MCPServerConfig): Promise<Client> {
	if (!server.command) {
		throw new Error(`MCP server ${server.name} missing command`);
	}

	await auditStep("mcp.connect", server.name);
	const transport = new StdioClientTransport({
		command: server.command,
		args: server.args,
		env: server.env,
	});
	const client = new Client({ name: "tony", version: "0.1.0" });
	await client.connect(transport);
	transportCache.set(server.name, transport);
	await audit(`mcp.connected: ${server.name}`);
	return client;
}

async function getClient(server: MCPServerConfig): Promise<Client> {
	const key = getServerKey(server);
	const cached = clientCache.get(key);
	if (cached) {
		return cached;
	}

	if (server.url) {
		throw new Error(`MCP server ${server.name} uses url transport, not implemented yet`);
	}

	const client = await connectStdioServer(server);
	clientCache.set(key, client);
	return client;
}

export async function listMcpTools(server: MCPServerConfig) {
	await auditStep("mcp.listTools", server.name);
	const client = await getClient(server);
	const result = await client.listTools();
	await audit(`mcp.tools.count: ${server.name} -> ${result.tools.length}`);
	return result;
}

export async function callMcpTool(
	server: MCPServerConfig,
	toolName: string,
	args: Record<string, unknown>
) {
	await auditStep("mcp.call", `${server.name}.${toolName}`);
	await audit(`mcp.args: ${server.name}.${toolName} -> ${JSON.stringify(args)}`);
	const client = await getClient(server);
	const result = await client.callTool({ name: toolName, arguments: args });
	await audit(`mcp.result: ${server.name}.${toolName} -> ${JSON.stringify(result)}`);
	return result;
}

export async function shutdownMcpClients(): Promise<void> {
	for (const [name, client] of clientCache.entries()) {
		try {
			await auditStep("mcp.disconnect", name);
			await client.close();
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			await auditWarn(`mcp.disconnect.failed: ${name} -> ${message}`);
		}
	}

	for (const [name, transport] of transportCache.entries()) {
		try {
			await transport.close();
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			await auditWarn(`mcp.transport.close.failed: ${name} -> ${message}`);
		}
	}

	clientCache.clear();
	transportCache.clear();
	await audit("mcp.shutdown.complete");
}
