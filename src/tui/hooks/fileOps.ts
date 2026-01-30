import { existsSync, writeFileSync, statSync } from "fs";
import { readFile } from "fs/promises";
import { parseInstructions, type Instructions } from "../../instructions.js";

export function scaffoldInstructions(): Instructions {
  return {
    defaultModel: "openai/gpt-4o-mini",
    tasks: [],
  };
}

export function saveInstructions(filePath: string, instructions: Instructions): void {
  const validated = parseInstructions(JSON.stringify(instructions), filePath);
  writeFileSync(filePath, JSON.stringify(validated, null, 2) + "\n");
}

export async function loadOrScaffold(filePath: string): Promise<Instructions> {
  if (!existsSync(filePath)) {
    const scaffold = scaffoldInstructions();
    saveInstructions(filePath, scaffold);
    return scaffold;
  }
  const content = await readFile(filePath, "utf-8");
  return parseInstructions(content, filePath);
}

export function getFileMtime(filePath: string): number {
  return statSync(filePath).mtimeMs;
}
