import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";

const logPath = resolve(process.cwd(), "audit.log");

export type AuditContext = {
	runId?: string;
	taskId?: string;
	taskRunId?: string;
};

const contextStack: AuditContext[] = [];

function currentContext(): AuditContext | undefined {
	return contextStack.length > 0 ? contextStack[contextStack.length - 1] : undefined;
}

export function getAuditContext(): AuditContext | undefined {
	return currentContext();
}

function formatContext(context?: AuditContext): string {
	if (!context) {
		return "";
	}
	const parts: string[] = [];
	if (context.runId) {
		parts.push(`run=${context.runId}`);
	}
	if (context.taskId) {
		parts.push(`task=${context.taskId}`);
	}
	if (context.taskRunId) {
		parts.push(`taskRun=${context.taskRunId}`);
	}
	return parts.length > 0 ? ` [${parts.join(" ")}]` : "";
}

function formatEntry(level: string, message: string) {
	const timestamp = new Date().toISOString();
	const context = formatContext(currentContext());
	return `[${timestamp}] [${level}]${context} ${message}\n`;
}

export async function pushAuditContext(context: AuditContext): Promise<void> {
	contextStack.push(context);
}

export async function popAuditContext(): Promise<void> {
	if (contextStack.length === 0) {
		await appendFile(logPath, formatEntry("WARN", "popAuditContext called on empty stack"));
		return;
	}
	contextStack.pop();
}

export async function audit(message: string): Promise<void> {
	await appendFile(logPath, formatEntry("INFO", message));
}

export async function auditWarn(message: string): Promise<void> {
	await appendFile(logPath, formatEntry("WARN", message));
}

export async function auditError(message: string): Promise<void> {
	await appendFile(logPath, formatEntry("ERROR", message));
}

export async function auditStep(step: string, details?: string): Promise<void> {
	const message = details ? `${step} :: ${details}` : step;
	await appendFile(logPath, formatEntry("STEP", message));
}
