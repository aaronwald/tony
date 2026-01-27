import { OpenAI } from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import {
  loadInstructions,
  Instructions,
  Task,
  ChatTask,
  AgentTask,
  ToolDefinition,
} from "./instructions.js";
import { createCLI, addCommand, runCli } from "./cli.js";

const controller = new AbortController();

process.on("SIGINT", () => controller.abort());

const DEFAULT_MODEL = "liquid/lfm-2.5-1.2b-thinking:free";
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorStatus(error: unknown): number | undefined {
  const err = error as { status?: number; statusCode?: number } | undefined;
  return err?.status ?? err?.statusCode;
}

function shouldRetry(error: unknown): boolean {
  const status = getErrorStatus(error);
  return status === 429 || (typeof status === "number" && status >= 500);
}

async function createChatCompletion(
  openai: OpenAI,
  params: Parameters<typeof openai.chat.completions.create>[0]
): Promise<Awaited<ReturnType<typeof openai.chat.completions.create>>> {
  let attempt = 0;
  while (true) {
    try {
      return await openai.chat.completions.create(params, {
        signal: controller.signal,
      });
    } catch (error) {
      attempt += 1;
      if (attempt > MAX_RETRIES || !shouldRetry(error)) {
        throw error;
      }
      const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      console.warn(`Retrying request (attempt ${attempt}) after ${delay}ms...`);
      await sleep(delay);
    }
  }
}

function getOpenAIClient(): OpenAI {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("Missing OPENROUTER_API_KEY in environment.");
  }
  return new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: apiKey,
  });
}

async function runChatTask(
  openai: OpenAI,
  task: ChatTask,
  model: string
): Promise<void> {
  console.log(`💬 Running chat task: ${task.id}`);
  const completion = await createChatCompletion(openai, {
    model,
    messages: [
      { role: "system", content: task.prompt },
      { role: "user", content: task.description },
    ],
  });
  console.log(completion.choices[0].message);
}

function buildToolDefinition(tool: ToolDefinition): ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function buildMessages(task: AgentTask): ChatCompletionMessageParam[] {
  const messages: ChatCompletionMessageParam[] = [];

  // Add context as system messages
  for (const ctx of task.memory.context) {
    messages.push({ role: "system", content: ctx });
  }

  // Add conversation history
  for (const entry of task.memory.history) {
    if (entry.role === "user" || entry.role === "assistant" || entry.role === "system") {
      messages.push({ role: entry.role, content: entry.content });
    }
  }

  return messages;
}

interface ToolCall {
  id: string;
  function: {
    name: string;
    arguments: string;
  };
}

async function executeTool(toolCall: ToolCall): Promise<string> {
  const { name, arguments: argsJson } = toolCall.function;
  let args: Record<string, unknown>;

  try {
    args = JSON.parse(argsJson) as Record<string, unknown>;
  } catch {
    return JSON.stringify({ error: `Invalid JSON arguments for tool ${name}` });
  }

  // TODO: Implement actual tool execution based on tool name
  // For now, return a stub response
  console.log(`  📞 Tool call: ${name}(${JSON.stringify(args)})`);
  return JSON.stringify({
    result: `Stub response for ${name}`,
    args,
  });
}

const MAX_AGENT_ITERATIONS = 10;

async function runAgentTask(
  openai: OpenAI,
  task: AgentTask,
  model: string
): Promise<void> {
  console.log(`🤖 Running agent task: ${task.id}`);

  const tools = [buildToolDefinition(task.tool)];
  const messages = buildMessages(task);

  if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
    console.log("  No user message in history, nothing to do.");
    return;
  }

  for (let i = 0; i < MAX_AGENT_ITERATIONS; i++) {
    const completion = await createChatCompletion(openai, {
      model,
      messages,
      tools,
      tool_choice: "auto",
    });

    const choice = completion.choices[0];
    if (!choice) {
      console.error("  No response from model");
      return;
    }

    const assistantMessage = choice.message;
    messages.push(assistantMessage);

    // If no tool calls, we're done
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      console.log(`  Assistant: ${assistantMessage.content}`);
      return;
    }

    // Execute each tool call
    for (const toolCall of assistantMessage.tool_calls) {
      // Only handle function-type tool calls
      if (toolCall.type !== "function" || !("function" in toolCall)) {
        continue;
      }
      const result = await executeTool(toolCall as ToolCall);
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result,
      });
    }
  }

  console.log(`  Warning: Reached max iterations (${MAX_AGENT_ITERATIONS})`);
}

async function runTask(
  task: Task,
  defaultModel: string,
  getClient: () => OpenAI
): Promise<void> {
  const model = task.model ?? defaultModel;

  switch (task.type) {
    case "chat":
      await runChatTask(getClient(), task, model);
      break;
    case "agent":
      await runAgentTask(getClient(), task, model);
      break;
  }
}

interface RunArgs {
  file?: string;
  model?: string;
  taskId?: string;
  showHelp: boolean;
  errors: string[];
}

function parseRunArgs(args: string[]): RunArgs {
  let file: string | undefined;
  let model: string | undefined;
  let taskId: string | undefined;
  let showHelp = false;
  const errors: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      showHelp = true;
      continue;
    }
    if (arg === "--file" || arg === "-f") {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) {
        errors.push("--file requires a path value");
        continue;
      }
      file = value;
      i += 1;
      continue;
    }
    if (arg === "--model" || arg === "-m") {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) {
        errors.push("--model requires a model value");
        continue;
      }
      model = value;
      i += 1;
      continue;
    }
    if (arg === "--task" || arg === "-t") {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) {
        errors.push("--task requires a task id value");
        continue;
      }
      taskId = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      errors.push(`Unknown option: ${arg}`);
    }
  }

  return { file, model, taskId, showHelp, errors };
}

function filterTasks(
  instructions: Instructions,
  taskId?: string
): { tasks: Task[]; model: string } {
  const model = instructions.defaultModel ?? DEFAULT_MODEL;

  if (!taskId) {
    return { tasks: instructions.tasks, model };
  }

  const task = instructions.tasks.find((t) => t.id === taskId);
  if (!task) {
    const availableIds = instructions.tasks.map((t) => t.id).join(", ");
    throw new Error(
      `Task "${taskId}" not found. Available tasks: ${availableIds}`
    );
  }

  return { tasks: [task], model };
}

// main entry point
const cli = createCLI("tony", "0.1.0");

function printRunHelp(): void {
  console.log("Usage:");
  console.log("  tony run [options]\n");
  console.log("Options:");
  console.log("  -f, --file <path>    Path to instructions JSON");
  console.log("  -m, --model <model>  Override model for all tasks");
  console.log("  -t, --task <id>      Run a single task by id");
  console.log("  -h, --help           Show this help message");
}

addCommand(cli, {
  name: "run",
  description: "Run tasks from instructions.json",
  action: async (args) => {
    try {
      const { file, model: modelOverride, taskId, showHelp, errors } =
        parseRunArgs(args);
      if (showHelp) {
        printRunHelp();
        return;
      }
      if (errors.length > 0) {
        for (const error of errors) {
          console.error(`Error: ${error}`);
        }
        printRunHelp();
        process.exitCode = 1;
        return;
      }
      const instructions = await loadInstructions(file);

      if (instructions.tasks.length === 0) {
        console.log("No tasks found in instructions.");
        return;
      }

      const { tasks, model: defaultModel } = filterTasks(instructions, taskId);
      const model = modelOverride ?? defaultModel;

      let cachedClient: OpenAI | undefined;
      const getClient = () => {
        if (!cachedClient) {
          cachedClient = getOpenAIClient();
        }
        return cachedClient;
      };

      for (const task of tasks) {
        try {
          await runTask(task, model, getClient);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          console.error(`Task "${task.id}" (${task.type}) failed: ${message}`);
          process.exitCode = 1;
          return;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(`Error: ${message}`);
      process.exitCode = 1;
    }
  },
});

await runCli(cli);
