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

function diffFields(
  oldObj: Record<string, unknown>,
  newObj: Record<string, unknown>
): string[] {
  const keys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)]);
  const changed: string[] = [];
  for (const key of keys) {
    if (JSON.stringify(oldObj[key]) !== JSON.stringify(newObj[key])) {
      changed.push(key);
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
      const updatedTask = parsed.json as Task;
      const changed = diffFields(
        context.currentTask as unknown as Record<string, unknown>,
        updatedTask as unknown as Record<string, unknown>
      );
      return {
        task: updatedTask,
        explanation: parsed.explanation || "Task updated",
        changedFields: changed,
      };
    } else {
      // Global scope: parse the full instructions
      const raw = JSON.stringify(parsed.json);
      const updatedInstructions = parseInstructions(raw, "command-mode");
      const changed = diffFields(
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
