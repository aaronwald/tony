import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { MCPServerConfig } from "./instructions.js";

const clientCache = new Map<string, Client>();

function getServerKey(server: MCPServerConfig): string {
	return server.name;
}

async function connectStdioServer(server: MCPServerConfig): Promise<Client> {
	if (!server.command) {
		throw new Error(`MCP server ${server.name} missing command`);
	}

	console.log(`🔌 MCP connect: ${server.name}`);
	const transport = new StdioClientTransport({
		command: server.command,
		args: server.args,
		env: server.env,
	});
	const client = new Client({ name: "tony", version: "0.1.0" });
	await client.connect(transport);
	console.log(`✅ MCP connected: ${server.name}`);
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
	console.log(`🔎 MCP list tools: ${server.name}`);
	const client = await getClient(server);
	const result = await client.listTools();
	console.log(`🔎 MCP tools count: ${result.tools.length}`);
	return result;
}

export async function callMcpTool(
	server: MCPServerConfig,
	toolName: string,
	args: Record<string, unknown>
) {
	console.log(`🔧 MCP call: ${server.name}.${toolName}`);
	console.log(`🔧 MCP args: ${JSON.stringify(args)}`);
	const client = await getClient(server);
	const result = await client.callTool({ name: toolName, arguments: args });
	console.log(`🔧 MCP result: ${JSON.stringify(result)}`);
	return result;
}
