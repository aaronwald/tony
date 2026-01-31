import type { Instructions, Task } from "../../instructions.js";
import { audit, auditError, auditStep, auditWarn } from "../../audit.js";
import { getOpenAIClient } from "../../openai.js";
import { createChatCompletion } from "../../openai.js";
import type { OpenAI } from "openai";

export interface CommandResult {
  instructions?: Instructions;
  task?: Task;
  explanation: string;
  changedFields: string[];
  error?: string;
}

const TOOL_MODEL = "openai/gpt-4o-mini";

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
 * Inject _index markers into tasks to help the model reference tasks.
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

const VALID_MEMORY_ROLES = new Set(["user", "assistant", "system"]);

function normalizeAgentMemory(
  memory: Record<string, unknown>
): { context: string[]; history: { role: string; content: string }[] } {
  const rawContext = memory.context;
  const context = Array.isArray(rawContext)
    ? rawContext.filter((c) => typeof c === "string")
    : [];

  const rawHistory = memory.history;
  const history = Array.isArray(rawHistory)
    ? rawHistory
        .filter(
          (entry) =>
            !!entry &&
            typeof entry === "object" &&
            typeof (entry as Record<string, unknown>).role === "string" &&
            VALID_MEMORY_ROLES.has((entry as Record<string, unknown>).role as string) &&
            typeof (entry as Record<string, unknown>).content === "string"
        )
        .map((entry) => ({
          role: (entry as Record<string, unknown>).role as string,
          content: (entry as Record<string, unknown>).content as string,
        }))
    : [];

  return { context, history };
}

function normalizeTask(task: Record<string, unknown>): Record<string, unknown> {
  if (task.type !== "agent") {
    return task;
  }
  const memory = isPlainObject(task.memory)
    ? (task.memory as Record<string, unknown>)
    : {};
  return {
    ...task,
    memory: normalizeAgentMemory(memory),
  };
}

function ensureAgentMemory(task: Record<string, unknown>): Record<string, unknown> {
  if (task.type !== "agent") {
    return task;
  }
  if (!isPlainObject(task.memory)) {
    return {
      ...task,
      memory: normalizeAgentMemory({}),
    };
  }
  return {
    ...task,
    memory: normalizeAgentMemory(task.memory as Record<string, unknown>),
  };
}

function assertTaskShape(task: Record<string, unknown>): void {
  if (typeof task.id !== "string" || task.id.trim() === "") {
    throw new Error("Task must include a non-empty id");
  }
  if (task.type !== "agent" && task.type !== "chat") {
    throw new Error(`Task "${task.id}" must have type "agent" or "chat"`);
  }
  if (task.type === "chat") {
    if (typeof task.prompt !== "string" || typeof task.description !== "string") {
      throw new Error(`Task "${task.id}" must include prompt and description for chat tasks`);
    }
  }
}

function applyAddTask(instructions: Instructions, rawTask: Record<string, unknown>): Instructions {
  assertTaskShape(rawTask);
  if (instructions.tasks.some((t) => t.id === rawTask.id)) {
    throw new Error(`Task with id "${rawTask.id}" already exists`);
  }
  const task = normalizeTask(ensureAgentMemory(rawTask)) as Task;
  return {
    ...instructions,
    tasks: [...instructions.tasks, task],
  };
}

function applyUpdateTask(
  instructions: Instructions,
  taskId: string,
  updates: Record<string, unknown>
): Instructions {
  const idx = instructions.tasks.findIndex((t) => t.id === taskId);
  if (idx < 0) {
    throw new Error(`Task with id "${taskId}" not found`);
  }
  const existing = instructions.tasks[idx] as unknown as Record<string, unknown>;
  const { id: _ignoreId, ...safeUpdates } = updates;
  const merged = normalizeTask(
    ensureAgentMemory(
      deepMerge(existing, safeUpdates)
    )
  ) as Task;
  const nextTasks = [...instructions.tasks];
  nextTasks[idx] = merged;
  return { ...instructions, tasks: nextTasks };
}

function applyDeleteTask(instructions: Instructions, taskId: string): Instructions {
  const nextTasks = instructions.tasks.filter((t) => t.id !== taskId);
  if (nextTasks.length === instructions.tasks.length) {
    throw new Error(`Task with id "${taskId}" not found`);
  }
  return { ...instructions, tasks: nextTasks };
}

function applyReorderTask(
  instructions: Instructions,
  fromIndex: number,
  toIndex: number
): Instructions {
  const tasks = [...instructions.tasks];
  if (fromIndex < 0 || fromIndex >= tasks.length) {
    throw new Error("Invalid fromIndex for reorder");
  }
  if (toIndex < 0 || toIndex >= tasks.length) {
    throw new Error("Invalid toIndex for reorder");
  }
  const [moved] = tasks.splice(fromIndex, 1);
  tasks.splice(toIndex, 0, moved);
  return { ...instructions, tasks };
}

type ToolCall = {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
};

type ToolResult = {
  toolCallId: string;
  name: string;
  output: Record<string, unknown>;
};

function parseToolArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error("Invalid tool arguments JSON");
  }
}

function executeToolCalls(
  instructions: Instructions,
  toolCalls: ToolCall[],
  scope: CommandScope,
  currentTaskId?: string
): { instructions: Instructions; results: ToolResult[] } {
  let next = instructions;
  const results: ToolResult[] = [];
  for (const call of toolCalls) {
    const name = call.function?.name;
    if (!name) continue;
    const args = parseToolArguments(call.function?.arguments);
    const callId = call.id ?? "";

    if (scope === "task") {
      if (name !== "update_task" && name !== "get_task" && name !== "check_task_exists") {
        throw new Error("Task scope only supports update_task, get_task, or check_task_exists");
      }
      if (name === "update_task" || name === "get_task" || name === "check_task_exists") {
        const id = args.id as string | undefined;
        if (!id || id !== currentTaskId) {
          throw new Error("Task scope operations must target the current task id");
        }
      }
    }

    switch (name) {
      case "add_task": {
        const task = args.task as Record<string, unknown> | undefined;
        if (task && isPlainObject(task)) {
          next = applyAddTask(next, task);
          results.push({ toolCallId: callId, name, output: { ok: true, id: task.id } });
          break;
        }
        const name = (args.name as string | undefined) ?? (args.id as string | undefined);
        if (!name) {
          throw new Error("add_task requires a task object or name/id");
        }
        const built: Record<string, unknown> = {
          id: name,
          type: "agent",
          memory: { context: [], history: [] },
          input: args.input,
          outcome: args.outcome,
        };
        next = applyAddTask(next, built);
        results.push({ toolCallId: callId, name, output: { ok: true, id: name } });
        break;
      }
      case "update_task": {
        const id = args.id as string | undefined;
        const updates = args.updates as Record<string, unknown> | undefined;
        if (!id || !updates || !isPlainObject(updates)) {
          throw new Error("update_task requires id and updates");
        }
        next = applyUpdateTask(next, id, updates);
        results.push({ toolCallId: callId, name, output: { ok: true, id } });
        break;
      }
      case "delete_task": {
        const id = args.id as string | undefined;
        if (!id) {
          throw new Error("delete_task requires id");
        }
        next = applyDeleteTask(next, id);
        results.push({ toolCallId: callId, name, output: { ok: true, id } });
        break;
      }
      case "reorder_task": {
        const fromIndex = Number(args.fromIndex);
        const toIndex = Number(args.toIndex);
        if (!Number.isFinite(fromIndex) || !Number.isFinite(toIndex)) {
          throw new Error("reorder_task requires fromIndex and toIndex numbers");
        }
        next = applyReorderTask(next, fromIndex, toIndex);
        results.push({ toolCallId: callId, name, output: { ok: true, fromIndex, toIndex } });
        break;
      }
      case "get_task": {
        const id = args.id as string | undefined;
        if (!id) {
          throw new Error("get_task requires id");
        }
        const task = next.tasks.find((t) => t.id === id) ?? null;
        results.push({ toolCallId: callId, name, output: { task } });
        break;
      }
      case "check_task_exists": {
        const id = args.id as string | undefined;
        if (!id) {
          throw new Error("check_task_exists requires id");
        }
        const exists = next.tasks.some((t) => t.id === id);
        results.push({ toolCallId: callId, name, output: { exists } });
        break;
      }
      default:
        throw new Error(`Unsupported tool: ${name}`);
    }
  }
  return { instructions: next, results };
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

Use the provided tools to add, update, delete, or reorder tasks.
Do NOT return JSON edits. Do NOT rewrite the full instructions file.
If no change is needed, reply with a short explanation only.

Note: tools will apply changes and validate the result automatically.`;

export async function executeCommand(
  command: string,
  context: CommandContext,
  scope: CommandScope,
  model?: string
): Promise<CommandResult> {
  try {
    await auditStep("command.start", scope);
    await audit(`command.text: ${command}`);
    const client: OpenAI = getOpenAIClient();
    const resolvedModel = model ?? TOOL_MODEL;

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

    const tools = [
      {
        type: "function",
        function: {
          name: "add_task",
          description: "Add a new task to instructions",
          parameters: {
            type: "object",
            properties: {
              task: { type: "object", description: "Full task object to add" },
              name: { type: "string", description: "Task id/name (when not providing task)" },
              id: { type: "string", description: "Task id (alias for name)" },
              input: { type: "string", description: "Optional agent input" },
              outcome: { type: "string", description: "Optional agent outcome" },
            },
            required: [],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "update_task",
          description: "Update an existing task by id",
          parameters: {
            type: "object",
            properties: {
              id: { type: "string" },
              updates: { type: "object", description: "Partial fields to update" },
            },
            required: ["id", "updates"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "delete_task",
          description: "Delete a task by id",
          parameters: {
            type: "object",
            properties: {
              id: { type: "string" },
            },
            required: ["id"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "reorder_task",
          description: "Reorder tasks by index",
          parameters: {
            type: "object",
            properties: {
              fromIndex: { type: "number" },
              toIndex: { type: "number" },
            },
            required: ["fromIndex", "toIndex"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "get_task",
          description: "Get a task by id",
          parameters: {
            type: "object",
            properties: {
              id: { type: "string" },
            },
            required: ["id"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "check_task_exists",
          description: "Check if a task id exists",
          parameters: {
            type: "object",
            properties: {
              id: { type: "string" },
            },
            required: ["id"],
          },
        },
      },
    ];

    await audit(`command.model: ${resolvedModel}`);

    let completion = await createChatCompletion(client, {
      model: resolvedModel,
      messages,
      tools,
    });

    let responseMessage = completion.choices[0]?.message;
    let toolCalls = (responseMessage as unknown as { tool_calls?: ToolCall[] })?.tool_calls;
    let responseText = responseMessage?.content;
    if (!responseText && (!toolCalls || toolCalls.length === 0)) {
      return {
        explanation: "No response from model",
        changedFields: [],
        error: "Empty response from model",
      };
    }

    let updated = context.instructions;
    const maxToolRounds = 3;
    let rounds = 0;
    while (toolCalls && toolCalls.length > 0 && rounds < maxToolRounds) {
      rounds += 1;
      await auditStep("command.tools", `${toolCalls.length}`);
      for (const call of toolCalls) {
        const name = call.function?.name ?? "unknown";
        await audit(`command.tool: ${name} -> ${call.function?.arguments ?? ""}`);
      }

      const { instructions: nextInstructions, results } = executeToolCalls(
        updated,
        toolCalls,
        scope,
        context.currentTask?.id
      );
      updated = nextInstructions;

      const toolMessages: OpenAI.ChatCompletionMessageParam[] = results.map((result) => ({
        role: "tool",
        tool_call_id: result.toolCallId,
        content: JSON.stringify(result.output),
      }));

      const assistantMessage: OpenAI.ChatCompletionMessageParam = {
        role: "assistant",
        content: responseText ?? null,
        tool_calls: toolCalls as unknown as OpenAI.ChatCompletionMessageToolCall[],
      };

      completion = await createChatCompletion(client, {
        model: resolvedModel,
        messages: [...messages, assistantMessage, ...toolMessages],
        tools,
      });

      responseMessage = completion.choices[0]?.message;
      toolCalls = (responseMessage as unknown as { tool_calls?: ToolCall[] })?.tool_calls;
      responseText = responseMessage?.content;
    }

    if (toolCalls && toolCalls.length > 0) {
      await auditWarn("command.tools.max_rounds");
    }

    const changed = diffFieldsDeep(
      context.instructions as unknown as Record<string, unknown>,
      updated as unknown as Record<string, unknown>
    );
    const updatedTask =
      scope === "task" && context.currentTask
        ? updated.tasks.find((t) => t.id === context.currentTask!.id)
        : undefined;
    const hasChanges = changed.length > 0;
    if (!hasChanges) {
      await auditWarn("command.no_changes");
    }
    return {
      instructions: hasChanges ? updated : undefined,
      task: updatedTask,
      explanation: responseText || "Instructions updated",
      changedFields: changed,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    await auditError(`command.failed: ${message}`);
    return {
      explanation: "",
      changedFields: [],
      error: message,
    };
  }
}
