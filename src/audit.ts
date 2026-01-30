import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";

const logPath = resolve(process.cwd(), "audit.log");

function formatEntry(level: string, message: string) {
	const timestamp = new Date().toISOString();
	return `[${timestamp}] [${level}] ${message}\n`;
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
