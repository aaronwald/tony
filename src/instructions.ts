import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export type Instructions = {
	tasks: Array<{
		id: string;
		description: string;
		steps: string[];
	}>;
};

export async function loadInstructions(): Promise<Instructions> {
	const currentFile = fileURLToPath(import.meta.url);
	const currentDir = dirname(currentFile);
	const instructionsPath = resolve(currentDir, "..", "instructions.json");
	const instructionsRaw = await readFile(instructionsPath, "utf-8");

	return JSON.parse(instructionsRaw) as Instructions;
}
