import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { MCPServerConfig } from "./instructions.js";
import { audit, auditError, auditStep, auditWarn } from "./audit.js";

const clientCache = new Map<string, Client>();
const transportCache = new Map<string, StdioClientTransport>();

// Timeout defaults in milliseconds
const MCP_CONNECT_TIMEOUT = 30_000; // 30 seconds for connection
const MCP_TOOL_CALL_TIMEOUT = 60_000; // 60 seconds for tool calls

function withTimeout<T>(promise: Promise<T>, ms: number, operation: string): Promise<T> {
	let timeoutId: ReturnType<typeof setTimeout>;
	const timeoutPromise = new Promise<T>((_, reject) => {
		timeoutId = setTimeout(() => reject(new Error(`${operation} timed out after ${ms}ms`)), ms);
	});
	return Promise.race([promise, timeoutPromise]).finally(() => {
		clearTimeout(timeoutId);
	});
}

function getServerKey(server: MCPServerConfig): string {
	return server.name;
}

async function connectStdioServer(server: MCPServerConfig): Promise<Client> {
	if (!server.command) {
		throw new Error(`MCP server ${server.name} missing command`);
	}

	await auditStep("mcp.connect", server.name);
	const mergedEnv: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) {
			mergedEnv[key] = value;
		}
	}
	if (server.env) {
		Object.assign(mergedEnv, server.env);
	}
	const transport = new StdioClientTransport({
		command: server.command,
		args: server.args,
		env: mergedEnv,
	});
	const client = new Client({ name: "tony", version: "0.1.0" });
	await withTimeout(
		client.connect(transport),
		MCP_CONNECT_TIMEOUT,
		`MCP connection to ${server.name}`
	);
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
	const result = await withTimeout(
		client.listTools(),
		MCP_TOOL_CALL_TIMEOUT,
		`MCP listTools for ${server.name}`
	);
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
	try {
		const client = await getClient(server);
		const result = await withTimeout(
			client.callTool({ name: toolName, arguments: args }),
			MCP_TOOL_CALL_TIMEOUT,
			`MCP tool call ${server.name}.${toolName}`
		);
		await audit(`mcp.result: ${server.name}.${toolName} -> ${JSON.stringify(result)}`);
		return result;
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown error";
		await auditError(`mcp.call.failed: ${server.name}.${toolName} -> ${message}`);
		return { error: `MCP tool call failed: ${message}` };
	}
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
