import { OpenAI } from "openai";
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionMessageParam,
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
import { Memory, createMemory } from "./memory.js";
import { ToolCall, executeTool, buildToolDefinition, listMcpTools } from "./tool.js";
import { shutdownMcpClients } from "./mcp.js";
import { createChatCompletion, getOpenAIClient } from "./openai.js";
import type { Stream } from "openai/streaming";
import { audit, auditError, auditStep, auditWarn } from "./audit.js";
import { startSpinner } from "./spinner.js";

/*
system (System Prompt): Used to define the persona, tone, rules, and constraints for the AI before the conversation begins, ensuring the model acts according to specific guidelines. It is typically the first message.
user (User Prompt): Represents the questions, requests, or instructions provided by the end-user.
assistant (Model Response): Stores the AI's prior responses within a conversation, allowing for context retention. It can also be pre-filled by the developer to provide "few-shot" examples of how the assistant should respond.
*/

require('@dotenvx/dotenvx').config({ quiet: true })


const DEFAULT_MODEL = "liquid/lfm-2.5-1.2b-thinking:free";
const MAX_AGENT_ITERATIONS = 10;
const MAX_REPEATED_ASSISTANT_MESSAGES = 2;

type AssistantMessage = ChatCompletion["choices"][number]["message"];

type ToolCallAccumulator = {
  id?: string;
  type: "function";
  function: {
    name?: string;
    arguments?: string;
  };
};

function accumulateToolCalls(
  target: ToolCallAccumulator[],
  deltas: Array<{
    index?: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>
): void {
  for (const delta of deltas) {
    const index = delta.index ?? target.length;
    if (!target[index]) {
      target[index] = { type: "function", function: {} };
    }
    if (delta.id) {
      target[index].id = delta.id;
    }
    if (delta.type === "function") {
      target[index].type = "function";
    }
    if (delta.function?.name) {
      target[index].function.name = delta.function.name;
    }
    if (delta.function?.arguments) {
      target[index].function.arguments =
        (target[index].function.arguments ?? "") + delta.function.arguments;
    }
  }
}

async function resolveTaskTools(task: AgentTask): Promise<ToolDefinition[]> {
  await auditStep("resolve.tools", task.id);
  const toolMap = new Map<string, ToolDefinition>();

  if (task.tool) {
    toolMap.set(task.tool.name, task.tool);
  }

  if (task.mcpTools && task.mcpServers) {
    for (const serverName of task.mcpTools) {
      const server = task.mcpServers.find((item) => item.name === serverName);
      if (!server) {
        await auditWarn(`mcp.server.missing: ${task.id} -> ${serverName}`);
        continue;
      }
      const tools = await listMcpTools(server);
      for (const tool of tools) {
        if (toolMap.has(tool.name)) {
          continue;
        }
        toolMap.set(tool.name, {
          name: tool.name,
          description: tool.description ?? "",
          parameters: tool.parameters ?? { type: "object" },
          mcpServer: serverName,
        });
      }
    }
  }

  return Array.from(toolMap.values());
}

async function consumeStream(
  stream: Stream<ChatCompletionChunk>,
  label?: string
): Promise<AssistantMessage> {
  let content = "";
  const toolCalls: ToolCallAccumulator[] = [];

  await auditStep("stream.start");

  if (label) {
    process.stdout.write(label);
  }

  for await (const chunk of stream) {
    const choice = chunk.choices[0];
    const delta = choice?.delta;
    if (!delta) {
      continue;
    }
    if (delta.content) {
      content += delta.content;
      process.stdout.write(delta.content);
    }
    if (delta.tool_calls) {
      accumulateToolCalls(toolCalls, delta.tool_calls as Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>);
    }
  }

  if (label) {
    process.stdout.write("\n");
  }

  if (content.length === 0 && toolCalls.length === 0) {
    await auditWarn("assistant.empty.response");
  }

  return {
    role: "assistant",
    content: content.length > 0 ? content : null,
    refusal: null,
    tool_calls: toolCalls.length > 0 ? (toolCalls as AssistantMessage["tool_calls"]) : undefined,
  };
}

const MAX_STREAM_RETRIES = 2;

async function createAssistantMessage(
  openai: OpenAI,
  params: Parameters<typeof openai.chat.completions.create>[0],
  label?: string
): Promise<AssistantMessage> {
  for (let attempt = 0; attempt <= MAX_STREAM_RETRIES; attempt++) {
    await auditStep("assistant.request");
    const spinner = startSpinner("Waiting for model response...");
    try {
      const stream = await createChatCompletion(openai, { ...params, stream: true });
      spinner.stop();
      return await consumeStream(stream, label);
    } catch (error) {
      spinner.stop();
      const isStreamIteratorBug =
        error instanceof TypeError &&
        error.message === "undefined is not a function" &&
        error.stack?.includes("ReadableStreamAsyncIterator");
      if (isStreamIteratorBug && attempt < MAX_STREAM_RETRIES) {
        await auditWarn(`stream.retry: attempt ${attempt + 1} (Bun ReadableStream bug)`);
        continue;
      }
      throw error;
    }
  }
  throw new Error("Unreachable");
}

async function runChatTask(
  openai: OpenAI,
  task: ChatTask,
  model: string
): Promise<void> {
  await auditStep("chat.task.start", task.id);
  await createAssistantMessage(
    openai,
    {
      model,
      messages: buildChatMessages(task),
      ...buildGenerationParams(task),
    },
    "  🗨️  Assistant: "
  );
}

function buildMessages(memory: Memory): ChatCompletionMessageParam[] {
  const messages: ChatCompletionMessageParam[] = [];

  // Add context as system messages
  for (const ctx of memory.getContext()) {
    messages.push({ role: "system", content: ctx }); // Context becomes the system (first) msg
  }

  // Add conversation history
  for (const entry of memory.getHistory()) {
    messages.push({ role: entry.role, content: entry.content });
  }

  return messages;
}

function buildChatMessages(task: ChatTask): ChatCompletionMessageParam[] {
  const messages: ChatCompletionMessageParam[] = [];

  const memory = task.memory ? createMemory(task.memory) : undefined;

  if (memory) {
    for (const ctx of memory.getContext()) {
      messages.push({ role: "system", content: ctx });
    }
  }
  // Keep the task prompt close to the new user request for clearer intent.
  messages.push({ role: "system", content: task.prompt });

  if (memory) {
    for (const entry of memory.getHistory()) {
      messages.push({ role: entry.role, content: entry.content });
    }
  }

  // Always include the new user request, even if history ends with user.
  // This keeps a simple start→finish workflow without mutating prior history.
  messages.push({ role: "user", content: task.description });

  return messages;
}

function buildGenerationParams(task: ChatTask | AgentTask) {
  return {
    temperature: task.temperature,
    top_p: task.top_p,
    max_tokens: task.max_tokens,
    seed: task.seed,
  };
}


function isLowValueAssistantMessage(content: string | null | undefined): boolean {
  if (!content) {
    return true;
  }
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return true;
  }
  return false;
}

async function runAgentTask(
  openai: OpenAI,
  task: AgentTask,
  model: string
): Promise<Memory> {
  await auditStep("agent.task.start", task.id);

  const memory = createMemory(task.memory);
  const toolDefinitions = await resolveTaskTools(task);
  const tools = toolDefinitions.length > 0 ? toolDefinitions.map(buildToolDefinition) : undefined;
  const messages = buildMessages(memory);
  let lastAssistantContent: string | undefined;
  let repeatedAssistantCount = 0;
  let lastToolSignature: string | undefined;
  let repeatedToolCalls = 0;

  if (!memory.endsWithUserMessage()) {
    if (task.input) {
      // Ensure we always have a user turn to kick off the agent loop.
      memory.appendUser(task.input);
      messages.push({ role: "user", content: task.input });
    } else {
      console.log("  No user message in history, nothing to do.");
      return memory;
    }
  }

  for (let i = 0; i < MAX_AGENT_ITERATIONS; i++) {
    await auditStep("agent.iteration", `${task.id}#${i + 1}`);
    const assistantMessage = await createAssistantMessage(
      openai,
      {
        model,
        messages,
        tools,
        tool_choice: tools ? "auto" : undefined,
        ...buildGenerationParams(task),
      },
      "  🤖 Assistant: "
    );
    messages.push(assistantMessage);
    if (assistantMessage.content) {
      // Keep in-session memory updated without persisting it to disk.
      memory.appendAssistant(assistantMessage.content);
    }

    if (assistantMessage.content === lastAssistantContent) {
      repeatedAssistantCount += 1;
    } else {
      repeatedAssistantCount = 0;
      lastAssistantContent = assistantMessage.content ?? lastAssistantContent;
    }

    if (repeatedAssistantCount >= MAX_REPEATED_ASSISTANT_MESSAGES) {
      await auditWarn(`agent.stop.repeated: ${task.id}`);
      return memory;
    }

    // If no tool calls, we're done - save final response to memory
    // Iterate til no more tools to do
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      if (isLowValueAssistantMessage(assistantMessage.content)) {
        await auditWarn(`agent.stop.lowValue: ${task.id}`);
        return memory;
      }
      await audit(`agent.complete: ${task.id}`);
      return memory;
    }

    if (toolDefinitions.length === 0) {
      await auditWarn(`agent.stop.noTools: ${task.id}`);
      return memory;
    }

    // Execute each tool call (Function)
    for (const toolCall of assistantMessage.tool_calls) {
      // Only handle function-type tool calls
      if (toolCall.type !== "function" || !("function" in toolCall)) {
        continue;
      }
      const toolSignature = `${toolCall.function.name}:${toolCall.function.arguments}`;
      if (toolSignature === lastToolSignature) {
        repeatedToolCalls += 1;
      } else {
        repeatedToolCalls = 0;
        lastToolSignature = toolSignature;
      }

      if (repeatedToolCalls >= 2) {
        await auditWarn(`agent.stop.repeatedTool: ${task.id}`);
        return memory;
      }

      const toolName = toolCall.function.name;
      const spinner = startSpinner(`Running tool: ${toolName}`);
      const result = await executeTool(toolCall as ToolCall, {
        tools: toolDefinitions,
        mcpServers: task.mcpServers,
      });
      spinner.stop();
      try {
        const parsed = JSON.parse(result) as Record<string, unknown>;
        if (parsed.error) {
          console.error(`  ✗ ${toolName}: ${parsed.error}`);
          await auditWarn(`agent.stop.toolError: ${task.id}`);
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: result,
          });
          return memory;
        }
      } catch {
        // not an error, keep going
      }
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result,
      });
      // TODO Should tool calls form new memories?
      // memory.appendToolResult(toolCall.function.name ?? "unknown", result);
    }
  }

  console.log(`  Warning: Reached max iterations (${MAX_AGENT_ITERATIONS})`);
  await auditWarn(`agent.stop.maxIterations: ${task.id}`);
  return memory;
}

async function runTask(
  task: Task,
  defaultModel: string,
  getClient: () => OpenAI
): Promise<void> {
  const model = task.model ?? defaultModel;
  await auditStep("task.start", `${task.id}:${task.type}`);

  switch (task.type) {
    case "chat":
      await runChatTask(getClient(), task, model);
      break;
    case "agent":
      const memory:Memory = await runAgentTask(getClient(), task, model);
      if (memory) {
        await audit(`agent.memory.final: ${task.id}`);
        for (const entry of memory.getHistory()) {
          await audit(`agent.memory.entry: ${task.id} [${entry.role}] ${entry.content}`);
        }
      }
      break;
  }
}

interface RunArgs {
  file?: string;
  model?: string;
  taskId?: string;
  preflight: boolean;
  showHelp: boolean;
  errors: string[];
}

function parseRunArgs(args: string[]): RunArgs {
  let file: string | undefined;
  let model: string | undefined;
  let taskId: string | undefined;
  let preflight = false;
  let showHelp = false;
  const errors: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      showHelp = true;
      continue;
    }
    if (arg === "--preflight") {
      preflight = true;
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

  return { file, model, taskId, preflight, showHelp, errors };
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
  console.log("  --preflight          List MCP tools before running");
  console.log("  -h, --help           Show this help message");
}

async function preflightTasks(tasks: Task[]): Promise<void> {
  const servers = new Map<string, NonNullable<Task["mcpServers"]>[number]>();
  for (const task of tasks) {
    if (!task.mcpServers) {
      continue;
    }
    const filter = task.mcpTools && task.mcpTools.length > 0 ? new Set(task.mcpTools) : undefined;
    for (const server of task.mcpServers) {
      if (filter && !filter.has(server.name)) {
        continue;
      }
      servers.set(server.name, server);
    }
  }

  for (const server of servers.values()) {
    await auditStep("mcp.preflight", server.name);
    const spinner = startSpinner(`Connecting to MCP server: ${server.name}`);
    try {
      const tools = await listMcpTools(server);
      spinner.stop();
      if (tools.length === 0) {
        console.error(`  ⚠ ${server.name}: no tools found`);
        await auditWarn(`mcp.preflight.empty: ${server.name}`);
        continue;
      }
      console.log(`  ✓ ${server.name}: ${tools.length} tools`);
      for (const tool of tools) {
        await audit(`mcp.tool: ${server.name}.${tool.name}`);
      }
    } catch (error) {
      spinner.stop();
      const message = error instanceof Error ? error.message : "Unknown error";
      const stack = error instanceof Error ? error.stack : undefined;
      console.error(`  ✗ ${server.name}: ${message}`);
      await auditError(`mcp.preflight.failed: ${server.name} -> ${message}`);
      if (stack) {
        await auditError(`mcp.preflight.failed.stack: ${stack}`);
      }
    }
  }
}

addCommand(cli, {
  name: "run",
  description: "Run tasks from instructions.json",
  action: async (args) => {
    try {
      const { file, model: modelOverride, taskId, preflight, showHelp, errors } =
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

      if (preflight) {
        await preflightTasks(tasks);
      }

      let cachedClient: OpenAI | undefined;
      const getClient = () => {
        if (!cachedClient) {
          cachedClient = getOpenAIClient();
        }
        return cachedClient;
      };

      try {
        for (const task of tasks) {
          await runTask(task, model, getClient);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        const stack = error instanceof Error ? error.stack : undefined;
        await auditError(`task.failed: ${message}`);
        if (stack) {
          await auditError(`task.failed.stack: ${stack}`);
        }
        console.error(`Task failed: ${message}`);
        if (stack) {
          console.error(stack);
        }
        process.exitCode = 1;
      } finally {
        await shutdownMcpClients();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      const stack = error instanceof Error ? error.stack : undefined;
      await auditError(`run.failed: ${message}`);
      if (stack) {
        await auditError(`run.failed.stack: ${stack}`);
        console.error(stack);
      }
      console.error(`Error: ${message}`);
      process.exitCode = 1;
    }
  },
});

await runCli(cli);
