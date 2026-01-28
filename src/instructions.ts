import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { MemoryConfig, MemoryEntry } from "./memory.js";

export interface ChatTask {
  id: string;
  type: "chat";
  prompt: string;
  description: string;
  memory?: MemoryConfig;
  outcome?: string;
  model?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type MessageRole = MemoryEntry["role"];

export type AgentMemory = MemoryConfig;

export interface AgentTask {
  id: string;
  type: "agent";
  tool: ToolDefinition;
  memory: AgentMemory;
  input?: string;
  outcome?: string;
  model?: string;
}

export type Task = ChatTask | AgentTask;

export interface Instructions {
  defaultModel?: string;
  tasks: Task[];
}

function isToolDefinition(value: unknown): value is ToolDefinition {
  if (!value || typeof value !== "object") {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.name === "string" &&
    obj.name.trim() !== "" &&
    typeof obj.description === "string" &&
    typeof obj.parameters === "object" &&
    obj.parameters !== null
  );
}

const VALID_ROLES: MessageRole[] = ["user", "assistant", "system"];

function isValidRole(role: unknown): role is MessageRole {
  return typeof role === "string" && VALID_ROLES.includes(role as MessageRole);
}

function isAgentMemory(value: unknown): value is AgentMemory {
  if (!value || typeof value !== "object") {
    return false;
  }
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.context)) {
    return false;
  }
  if (!obj.context.every((c) => typeof c === "string")) {
    return false;
  }
  if (!Array.isArray(obj.history)) {
    return false;
  }
  for (const entry of obj.history) {
    if (!entry || typeof entry !== "object") {
      return false;
    }
    const e = entry as Record<string, unknown>;
    if (!isValidRole(e.role) || typeof e.content !== "string") {
      return false;
    }
  }
  return true;
}

function isChatTask(value: unknown): value is ChatTask {
  if (!value || typeof value !== "object") {
    return false;
  }
  const task = value as Record<string, unknown>;
  return (
    typeof task.id === "string" &&
    task.type === "chat" &&
    typeof task.prompt === "string" &&
    typeof task.description === "string" &&
    (task.memory === undefined || isAgentMemory(task.memory)) &&
    (task.outcome === undefined || typeof task.outcome === "string") &&
    (task.model === undefined || typeof task.model === "string")
  );
}

function isAgentTask(value: unknown): value is AgentTask {
  if (!value || typeof value !== "object") {
    return false;
  }
  const task = value as Record<string, unknown>;
  return (
    typeof task.id === "string" &&
    task.type === "agent" &&
    isToolDefinition(task.tool) &&
    isAgentMemory(task.memory) &&
    (task.input === undefined || typeof task.input === "string") &&
    (task.outcome === undefined || typeof task.outcome === "string") &&
    (task.model === undefined || typeof task.model === "string")
  );
}

function isTask(value: unknown): value is Task {
  return isChatTask(value) || isAgentTask(value);
}

function describeTaskError(value: unknown, index: number): string {
  if (!value || typeof value !== "object") {
    return `tasks[${index}] must be an object`;
  }
  const task = value as Record<string, unknown>;

  if (typeof task.id !== "string") {
    return `tasks[${index}].id must be a string`;
  }

  if (task.type !== "chat" && task.type !== "agent") {
    return `tasks[${index}].type must be "chat" or "agent", got "${task.type}"`;
  }

  if (task.type === "chat") {
    if (typeof task.prompt !== "string") {
      return `tasks[${index}].prompt must be a string`;
    }
    if (typeof task.description !== "string") {
      return `tasks[${index}].description must be a string`;
    }
    if (task.memory !== undefined && !isAgentMemory(task.memory)) {
      return `tasks[${index}].memory must have context array and history array`;
    }
    if (task.outcome !== undefined && typeof task.outcome !== "string") {
      return `tasks[${index}].outcome must be a string`;
    }
  }

  if (task.type === "agent") {
    if (!isToolDefinition(task.tool)) {
      return `tasks[${index}].tool must have name, description, and parameters`;
    }
    if (!isAgentMemory(task.memory)) {
      return `tasks[${index}].memory must have context array and history array`;
    }
    if (task.input !== undefined && typeof task.input !== "string") {
      return `tasks[${index}].input must be a string`;
    }
    if (task.outcome !== undefined && typeof task.outcome !== "string") {
      return `tasks[${index}].outcome must be a string`;
    }
  }

  return `tasks[${index}] has an unknown validation error`;
}

function parseInstructions(raw: string, sourcePath: string): Instructions {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    throw new Error(`Failed to parse ${sourcePath}: ${message}`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid instructions format in ${sourcePath}`);
  }

  const obj = parsed as Record<string, unknown>;
  const tasks = obj.tasks;

  if (!Array.isArray(tasks)) {
    throw new Error(`Missing or invalid tasks array in ${sourcePath}`);
  }

  for (let i = 0; i < tasks.length; i++) {
    if (!isTask(tasks[i])) {
      throw new Error(`${describeTaskError(tasks[i], i)} in ${sourcePath}`);
    }
  }

  const defaultModel =
    typeof obj.defaultModel === "string" ? obj.defaultModel : undefined;

  return { defaultModel, tasks: tasks as Task[] };
}

export async function loadInstructions(
  pathOverride?: string
): Promise<Instructions> {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = dirname(currentFile);
  const instructionsPath = pathOverride
    ? resolve(process.cwd(), pathOverride)
    : resolve(currentDir, "..", "instructions.json");
  const instructionsRaw = await readFile(instructionsPath, "utf-8");

  return parseInstructions(instructionsRaw, instructionsPath);
}
