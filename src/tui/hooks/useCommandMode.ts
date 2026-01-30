import type { Instructions, Task } from "../../instructions.js";
import { parseInstructions } from "../../instructions.js";
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

The instructions.json schema:
{
  "defaultModel": "<optional string - the default LLM model>",
  "tasks": [
    {
      "id": "<string - unique task identifier>",
      "type": "agent" | "chat",

      // For agent tasks:
      "memory": { "context": ["<system prompt strings>"], "history": [{"role": "user"|"assistant"|"system", "content": "<string>"}] },
      "input": "<optional string - user input>",
      "outcome": "<optional string - desired outcome>",

      // For chat tasks:
      "prompt": "<string - system prompt>",
      "description": "<string - user message>",

      // Shared optional fields:
      "model": "<optional string - override model>",
      "mcpServers": [{"name": "<string>", "url": "<optional>", "command": "<optional>", "args": ["<optional>"], "env": {"<optional>"}}],
      "mcpTools": ["<optional server names to use>"],
      "temperature": "<optional number 0-2>",
      "max_tokens": "<optional number 1-128000>",
      "seed": "<optional integer>"
    }
  ]
}

When the user asks you to modify the instructions, respond with:
1. A brief explanation of what you changed
2. A JSON code block with the updated structure

If the scope is "global", return the full instructions object in the JSON block.
If the scope is "task", return just the single updated task object in the JSON block.

Always wrap JSON in a \`\`\`json code fence.`;

export async function executeCommand(
  command: string,
  context: CommandContext,
  scope: CommandScope,
  model?: string
): Promise<CommandResult> {
  try {
    const client: OpenAI = getOpenAIClient();
    const resolvedModel = model ?? context.instructions.defaultModel ?? "openai/gpt-4o-mini";

    let userContent: string;
    if (scope === "task" && context.currentTask) {
      userContent = `Current task:\n\`\`\`json\n${JSON.stringify(context.currentTask, null, 2)}\n\`\`\`\n\nCommand: ${command}`;
    } else {
      userContent = `Current instructions:\n\`\`\`json\n${JSON.stringify(context.instructions, null, 2)}\n\`\`\`\n\nCommand: ${command}`;
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
      // Deep-merge LLM response onto existing task so omitted fields
      // (like memory.context/history) are preserved from the original.
      const mergedTask = deepMerge(
        context.currentTask as unknown as Record<string, unknown>,
        llmTask
      ) as unknown as Task;
      parseInstructions(
        JSON.stringify({ tasks: [mergedTask] }),
        "command-mode"
      );
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
      // Global scope: parse the full instructions
      const raw = JSON.stringify(parsed.json);
      const updatedInstructions = parseInstructions(raw, "command-mode");
      const changed = diffFieldsDeep(
        context.instructions as unknown as Record<string, unknown>,
        updatedInstructions as unknown as Record<string, unknown>
      );
      return {
        instructions: updatedInstructions,
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
