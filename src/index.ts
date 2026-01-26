import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

type Instructions = {
	tasks: Array<{
		id: string;
		description: string;
		steps: string[];
	}>;
};

const currentFile = fileURLToPath(import.meta.url);
const currentDir = dirname(currentFile);
const instructionsPath = resolve(currentDir, "..", "instructions.json");

const instructionsRaw = await readFile(instructionsPath, "utf-8");

let instructions: Instructions;

try {
	instructions = JSON.parse(instructionsRaw) as Instructions;
  console.log(instructions);
} catch (error) {
	const message = error instanceof Error ? error.message : "Unknown error";
	console.error(`Failed to parse instructions.json: ${message}`);
	process.exitCode = 1;
	throw error;
}
