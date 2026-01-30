import type { Instructions, Task } from "../../instructions.js";
import { getOpenAIClient } from "../../openai.js";
import { createChatCompletion } from "../../openai.js";
import { parseLlmJson } from "./parseLlmJson.js";
import type { OpenAI } from "openai";

export interface CommandResult {
  instructions?: Instructions;
  task?: Task;
  explanation: string;
  changedFields: string[];
  error?: string;
}

type CommandScope = "global" | "task";

interface CommandContext {
  instructions: Instructions;
  currentTask?: Task;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    const baseVal = base[key];
    const overVal = override[key];
    if (isPlainObject(baseVal) && isPlainObject(overVal)) {
      result[key] = deepMerge(baseVal, overVal);
    } else {
      result[key] = overVal;
    }
  }
  return result;
}

/**
 * Inject _index markers into tasks for reliable matching.
 * Strips them from the result after merging.
 */
function injectTaskIndices(instructions: Instructions): Record<string, unknown> {
  const obj = JSON.parse(JSON.stringify(instructions));
  if (Array.isArray(obj.tasks)) {
    obj.tasks.forEach((t: Record<string, unknown>, i: number) => {
      t._index = i;
    });
  }
  return obj;
}

function stripTaskIndices(task: Record<string, unknown>): Record<string, unknown> {
  const { _index, ...rest } = task;
  return rest;
}

/**
 * Merge LLM-returned instructions onto existing instructions.
 * Matches tasks by _index first, then by id, preserving tasks
 * the LLM didn't mention and appending genuinely new ones.
 */
function mergeInstructions(
  base: Instructions,
  llmResult: Record<string, unknown>
): Instructions {
  // Merge top-level non-tasks fields (exclude tasks from deepMerge)
  const { tasks: _llmTasks, ...llmNonTasks } = llmResult;
  const merged = deepMerge(
    base as unknown as Record<string, unknown>,
    llmNonTasks
  ) as unknown as Instructions;

  // If LLM didn't return tasks, keep originals
  if (!Array.isArray(_llmTasks)) {
    merged.tasks = base.tasks;
    return merged;
  }

  const baseTasks = base.tasks;
  const matchedBaseIndices = new Set<number>();
  const resultTasks: Record<string, unknown>[] = [...baseTasks.map(
    (t) => t as unknown as Record<string, unknown>
  )];

  for (const llmTask of _llmTasks) {
    if (!isPlainObject(llmTask)) continue;
    const lt = llmTask as Record<string, unknown>;

    // Try _index match first
    let baseIdx = -1;
    if (typeof lt._index === "number" && lt._index >= 0 && lt._index < baseTasks.length) {
      baseIdx = lt._index;
    }

    // Fall back to id match
    if (baseIdx < 0 && typeof lt.id === "string") {
      baseIdx = baseTasks.findIndex((t) => t.id === lt.id);
    }

    if (baseIdx >= 0) {
      // Merge onto existing task
      resultTasks[baseIdx] = stripTaskIndices(
        deepMerge(
          baseTasks[baseIdx] as unknown as Record<string, unknown>,
          lt
        )
      );
      matchedBaseIndices.add(baseIdx);
    } else if (typeof lt.id === "string") {
      // Genuinely new task
      resultTasks.push(stripTaskIndices(lt));
    }
  }

  merged.tasks = resultTasks as unknown as Task[];
  return merged;
}

function diffFieldsDeep(
  oldObj: Record<string, unknown>,
  newObj: Record<string, unknown>,
  prefix = ""
): string[] {
  const keys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)]);
  const changed: string[] = [];
  for (const key of keys) {
    const path = prefix ? `${prefix}.${key}` : key;
    const oldVal = oldObj[key];
    const newVal = newObj[key];

    if (isPlainObject(oldVal) && isPlainObject(newVal)) {
      changed.push(...diffFieldsDeep(oldVal, newVal, path));
      continue;
    }
    if (Array.isArray(oldVal) || Array.isArray(newVal)) {
      if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
        changed.push(path);
      }
      continue;
    }
    if (oldVal !== newVal) {
      changed.push(path);
    }
  }
  return changed;
}

const SYSTEM_PROMPT = `You are an assistant that edits an instructions.json file for a task runner called "tony".

## Schema

The top-level object has:
- "defaultModel": (string, optional) Default LLM model for all tasks (e.g. "openai/gpt-4o-mini")
- "tasks": array of task objects

### Task types

**Agent task** (type: "agent") — autonomous agent with memory:
- "id": (string, required) Unique task identifier
- "type": "agent"
- "memory": (object, required) { "context": string[], "history": [{"role": "user"|"assistant"|"system", "content": string}] }
- "input": (string, optional) User input/instructions for the agent
- "outcome": (string, optional) Desired outcome description

**Chat task** (type: "chat") — simple prompt/response:
- "id": (string, required) Unique task identifier
- "type": "chat"
- "prompt": (string, required) System prompt
- "description": (string, required) User message

### Shared optional fields (both types):
- "model": (string) Override model for this task
- "mcpServers": (array) MCP server configs: [{"name": string, "url"?: string, "command"?: string, "args"?: string[], "env"?: object}]
- "mcpTools": (string[]) MCP server names to use
- "temperature": (number, 0-2)
- "max_tokens": (number, 1-128000)
- "seed": (integer)

## Response format

1. A brief explanation of what you changed
2. A JSON code block with ONLY the fields you are changing

RULES:
- Only include fields you are modifying. Unchanged fields will be preserved automatically.
- For task scope: return a task object with "id", "type", "_index", and only the changed fields.
- For global scope: return an instructions object with only the changed parts. Each task in the "tasks" array MUST include its "_index" field unchanged for matching.
- NEVER use "..." or ellipsis. Omit unchanged fields entirely.
- The JSON must be valid. No comments, no trailing commas.
- Always preserve the "_index" field on tasks exactly as given.

Always wrap JSON in a \`\`\`json code fence.

## Example

User command: "change the temperature to 0.9 and max_tokens to 1000"

Good response:
I updated the temperature to 0.9 and max_tokens to 1000.

\`\`\`json
{
  "_index": 0,
  "id": "my-task",
  "type": "agent",
  "temperature": 0.9,
  "max_tokens": 1000
}
\`\`\`

Note: only the changed fields are included. All other fields are preserved automatically.`;

export async function executeCommand(
  command: string,
  context: CommandContext,
  scope: CommandScope,
  model?: string
): Promise<CommandResult> {
  try {
    const client: OpenAI = getOpenAIClient();
    const resolvedModel = model ?? context.instructions.defaultModel ?? "openai/gpt-4o-mini";

    const indexedInstructions = injectTaskIndices(context.instructions);

    let userContent: string;
    if (scope === "task" && context.currentTask) {
      const taskIdx = context.instructions.tasks.findIndex(
        (t) => t.id === context.currentTask!.id
      );
      const indexedTask = { ...context.currentTask, _index: taskIdx >= 0 ? taskIdx : 0 };
      userContent = `Full instructions file (for reference):\n\`\`\`json\n${JSON.stringify(indexedInstructions, null, 2)}\n\`\`\`\n\nEdit ONLY this task (id: "${context.currentTask.id}"):\n\`\`\`json\n${JSON.stringify(indexedTask, null, 2)}\n\`\`\`\n\nReturn the updated task object only. Preserve the "_index" field unchanged. Command: ${command}`;
    } else {
      userContent = `Current instructions:\n\`\`\`json\n${JSON.stringify(indexedInstructions, null, 2)}\n\`\`\`\n\nCommand: ${command}`;
    }

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ];

    const completion = await createChatCompletion(client, {
      model: resolvedModel,
      messages,
    });

    const responseText = completion.choices[0]?.message?.content;
    if (!responseText) {
      return {
        explanation: "No response from model",
        changedFields: [],
        error: "Empty response from model",
      };
    }

    const parsed = parseLlmJson(responseText);
    if (!parsed) {
      return {
        explanation: responseText,
        changedFields: [],
        error: "Could not parse JSON from model response",
      };
    }

    if (scope === "task" && context.currentTask) {
      const llmTask = parsed.json as Record<string, unknown>;
      // Deep-merge LLM response onto existing task, strip _index marker.
      // Validation deferred to save time.
      const mergedTask = stripTaskIndices(
        deepMerge(
          context.currentTask as unknown as Record<string, unknown>,
          llmTask
        )
      ) as unknown as Task;
      const changed = diffFieldsDeep(
        context.currentTask as unknown as Record<string, unknown>,
        mergedTask as unknown as Record<string, unknown>
      );
      return {
        task: mergedTask,
        explanation: parsed.explanation || "Task updated",
        changedFields: changed,
      };
    } else {
      // Global scope: merge LLM response onto existing instructions.
      // Tasks are matched by id so unmentioned tasks are preserved.
      const llmInstructions = parsed.json as Record<string, unknown>;
      const mergedInstructions = mergeInstructions(
        context.instructions,
        llmInstructions
      );
      const changed = diffFieldsDeep(
        context.instructions as unknown as Record<string, unknown>,
        mergedInstructions as unknown as Record<string, unknown>
      );
      return {
        instructions: mergedInstructions,
        explanation: parsed.explanation || "Instructions updated",
        changedFields: changed,
      };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return {
      explanation: "",
      changedFields: [],
      error: message,
    };
  }
}
