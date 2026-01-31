import { OpenAI } from "openai";
import { randomUUID } from "node:crypto";
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
import { Memory, MemoryConfig, createMemory } from "./memory.js";
import { ToolCall, executeTool, buildToolDefinition, listMcpTools } from "./tool.js";
import { shutdownMcpClients } from "./mcp.js";
import { createChatCompletion, getOpenAIClient } from "./openai.js";
import type { Stream } from "openai/streaming";
import {
  audit,
  auditError,
  auditStep,
  auditWarn,
  getAuditContext,
  popAuditContext,
  pushAuditContext,
} from "./audit.js";
import { startSpinner } from "./spinner.js";
import { appendStats } from "./stats.js";
import { render } from "ink";
import React from "react";
import { App } from "./tui/app.js";
import { loadOrScaffold, getFileMtime, saveInstructions } from "./tui/hooks/fileOps.js";
import { executeCommand } from "./tui/hooks/useCommandMode.js";

/*
system (System Prompt): Used to define the persona, tone, rules, and constraints for the AI before the conversation begins, ensuring the model acts according to specific guidelines. It is typically the first message.
user (User Prompt): Represents the questions, requests, or instructions provided by the end-user.
assistant (Model Response): Stores the AI's prior responses within a conversation, allowing for context retention. It can also be pre-filled by the developer to provide "few-shot" examples of how the assistant should respond.
*/

require('@dotenvx/dotenvx').config({ quiet: true })


const DEFAULT_MODEL = "liquid/lfm-2.5-1.2b-thinking:free";
const MAX_AGENT_ITERATIONS = 10;
const MAX_REPEATED_ASSISTANT_MESSAGES = 2;
const MAX_TASK_CHAIN_DEPTH = 3;
let isShuttingDown = false;

type TaskExecutionContext = {
  tasksById: Map<string, Task>;
  defaultModel: string;
  getClient: () => OpenAI;
  depth: number;
  taskChain: Set<string>;
};

type AssistantMessage = ChatCompletion["choices"][number]["message"];

type StreamUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number;
  total_cost?: number;
};

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
): Promise<{ message: AssistantMessage; usage?: StreamUsage; model?: string }> {
  let content = "";
  let actualModel: string | undefined;
  let usage: StreamUsage | undefined;
  const toolCalls: ToolCallAccumulator[] = [];

  await auditStep("stream.start");

  if (label) {
    process.stdout.write(label);
  }

  for await (const chunk of stream) {
    if (!actualModel && chunk.model) {
      actualModel = chunk.model;
      await audit(`stream.model: ${actualModel}`);
    }
    if ((chunk as { usage?: StreamUsage }).usage) {
      usage = (chunk as { usage?: StreamUsage }).usage;
    }
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
    message: {
      role: "assistant",
      content: content.length > 0 ? content : null,
      refusal: null,
      tool_calls: toolCalls.length > 0 ? (toolCalls as AssistantMessage["tool_calls"]) : undefined,
    },
    usage,
    model: actualModel,
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
      const stream = await createChatCompletion(openai, {
        ...params,
        stream: true,
        stream_options: { include_usage: true },
      });
      spinner.stop();
      const { message, usage, model } = await consumeStream(stream, label);
      const context = getAuditContext();
      const resolvedModel = model ?? (typeof params.model === "string" ? params.model : "unknown");
      const cost = usage?.total_cost ?? usage?.cost;
      try {
        await appendStats({
          timestamp: new Date().toISOString(),
          model: resolvedModel,
          promptTokens: usage?.prompt_tokens,
          completionTokens: usage?.completion_tokens,
          totalTokens: usage?.total_tokens,
          cost,
          context,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        await auditWarn(`stats.write.failed: ${message}`);
      }
      return message;
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

function mergeMemoryConfigs(
  base: MemoryConfig | undefined,
  inherited: Memory
): MemoryConfig {
  const inheritedConfig = inherited.toConfig();
  if (!base) {
    return inheritedConfig;
  }
  return {
    context: [...base.context, ...inheritedConfig.context],
    history: [...base.history, ...inheritedConfig.history],
  };
}

function applyInheritedMemory(task: Task, inherited: Memory): Task {
  return {
    ...task,
    memory: mergeMemoryConfigs(task.memory, inherited),
  };
}

function buildInvokeTaskTool(): ToolDefinition {
  return {
    name: "invoke_task",
    description:
      "Run another task by id and pass the current task memory into it.",
    parameters: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "The id of the task to invoke.",
        },
        input: {
          type: "string",
          description:
            "Optional input override (agent: input, chat: description).",
        },
      },
      required: ["taskId"],
    },
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

async function invokeTaskFromAgent(
  toolCall: ToolCall,
  memory: Memory,
  context: TaskExecutionContext
): Promise<string> {
  const { arguments: argsJson } = toolCall.function;
  let args: Record<string, unknown>;

  await auditStep("tool.invoke_task");
  await audit(`tool.invoke_task.args.raw: ${argsJson}`);

  try {
    args = JSON.parse(argsJson) as Record<string, unknown>;
  } catch {
    return JSON.stringify({ error: "Invalid JSON arguments for tool invoke_task" });
  }

  const taskId =
    typeof args.taskId === "string"
      ? args.taskId
      : typeof args.id === "string"
        ? args.id
        : undefined;
  if (!taskId) {
    return JSON.stringify({ error: "invoke_task requires taskId" });
  }

  if (context.depth >= MAX_TASK_CHAIN_DEPTH) {
    return JSON.stringify({
      error: `Max task chain depth (${MAX_TASK_CHAIN_DEPTH}) reached`,
    });
  }

  if (context.taskChain.has(taskId)) {
    await auditWarn(`tool.invoke_task.cycle: ${taskId} (chain: ${[...context.taskChain].join(" -> ")} -> ${taskId})`);
    return JSON.stringify({
      error: `Cycle detected: task "${taskId}" is already in the call chain`,
    });
  }

  const nextTask = context.tasksById.get(taskId);
  if (!nextTask) {
    return JSON.stringify({ error: `Task not found: ${taskId}` });
  }

  const inputOverride = typeof args.input === "string" ? args.input : undefined;
  let taskToRun = nextTask;
  if (inputOverride) {
    if (nextTask.type === "agent") {
      taskToRun = { ...nextTask, input: inputOverride };
    } else {
      taskToRun = { ...nextTask, description: inputOverride };
    }
  }

  const nextChain = new Set(context.taskChain);
  nextChain.add(taskId);

  const nextContext: TaskExecutionContext = {
    ...context,
    depth: context.depth + 1,
    taskChain: nextChain,
  };

  try {
    const nextMemory = await runTask(taskToRun, nextContext, memory);
    const lastEntry = nextMemory?.getLastEntry();

    return JSON.stringify({
      ok: true,
      taskId,
      lastMessage: lastEntry?.content ?? null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    await auditError(`tool.invoke_task.failed: ${taskId} -> ${message}`);
    return JSON.stringify({ error: `invoke_task failed: ${message}` });
  }
}

async function runAgentTask(
  openai: OpenAI,
  task: AgentTask,
  model: string,
  context: TaskExecutionContext
): Promise<Memory> {
  await auditStep("agent.task.start", task.id);

  const memory = createMemory(task.memory);
  const externalToolDefinitions = await resolveTaskTools(task);
  const invokeTaskTool = buildInvokeTaskTool();
  const toolDefinitions = externalToolDefinitions.some((tool) => tool.name === invokeTaskTool.name)
    ? externalToolDefinitions
    : [...externalToolDefinitions, invokeTaskTool];
  const tools = toolDefinitions.length > 0 ? toolDefinitions.map(buildToolDefinition) : undefined;
  const messages = buildMessages(memory);
  if (task.outcome && task.outcome.trim().length > 0) {
    messages.push({ role: "system", content: `Desired outcome: ${task.outcome}` });
  }
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
      if (toolCall.function.name === "invoke_task") {
        const result = await invokeTaskFromAgent(
          toolCall as ToolCall,
          memory,
          context
        );
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: result,
        });
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
        tools: externalToolDefinitions,
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
  context: TaskExecutionContext,
  inheritedMemory?: Memory
): Promise<Memory | undefined> {
  const model = task.model ?? context.defaultModel;
  const hasTools = task.type === "agent" && (task.mcpTools?.length || task.tool);
  const resolvedModel = hasTools ? TOOL_MODEL : model;
  if (resolvedModel !== model) {
    await auditWarn(`task.model.override: ${model} -> ${resolvedModel}`);
  }
  console.log(`  Model: ${resolvedModel}`);
  const taskRunId = randomUUID();
  await pushAuditContext({ taskId: task.id, taskRunId });

  try {
    await auditStep("task.start", `${task.id}:${task.type}:${resolvedModel}`);

    const resolvedTask = inheritedMemory
      ? applyInheritedMemory(task, inheritedMemory)
      : task;

    // Add current task to the chain so invoke_task can detect cycles
    const activeContext: TaskExecutionContext = {
      ...context,
      taskChain: new Set([...context.taskChain, task.id]),
    };

    switch (resolvedTask.type) {
      case "chat":
        await runChatTask(activeContext.getClient(), resolvedTask, resolvedModel);
        return undefined;
      case "agent":
        const memory:Memory = await runAgentTask(
          activeContext.getClient(),
          resolvedTask,
          resolvedModel,
          activeContext
        );
        if (memory) {
          await audit(`agent.memory.final: ${resolvedTask.id}`);
          for (const entry of memory.getHistory()) {
            await audit(
              `agent.memory.entry: ${resolvedTask.id} [${entry.role}] ${entry.content}`
            );
          }
        }
        return memory;
    }
  } finally {
    await popAuditContext();
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

function registerSignalHandlers(): void {
  const handler = async (signal: NodeJS.Signals) => {
    if (isShuttingDown) {
      return;
    }
    isShuttingDown = true;
    try {
      await auditWarn(`signal.received: ${signal}`);
      await shutdownMcpClients();
    } finally {
      process.exitCode = signal === "SIGINT" ? 130 : 1;
      process.exit();
    }
  };

  process.once("SIGINT", handler);
  process.once("SIGTERM", handler);
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
      registerSignalHandlers();
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

      const runId = randomUUID();
      await pushAuditContext({ runId });

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
      const tasksById = new Map(instructions.tasks.map((task) => [task.id, task]));
      const taskContext: TaskExecutionContext = {
        tasksById,
        defaultModel: model,
        getClient,
        depth: 0,
        taskChain: new Set(),
      };

      try {
        for (const task of tasks) {
          await runTask(task, taskContext);
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
        await popAuditContext();
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

addCommand(cli, {
  name: "churn",
  description: "Interactive TUI for editing instructions",
  action: async (args: string[]) => {
    let filePath = "instructions.json";
    let initialCommand: string | undefined;
    for (let i = 0; i < args.length; i++) {
      if ((args[i] === "-f" || args[i] === "--file") && args[i + 1]) {
        filePath = args[i + 1];
        i++;
      } else if ((args[i] === "-c" || args[i] === "--command") && args[i + 1]) {
        initialCommand = args[i + 1];
        i++;
      }
    }
    const { resolve } = await import("path");
    const resolved = resolve(process.cwd(), filePath);
    const instructions = await loadOrScaffold(resolved);

    if (initialCommand) {
      const result = await executeCommand(
        initialCommand,
        { instructions },
        "global"
      );
      if (result.error) {
        console.error(`Error: ${result.error}`);
        if (result.explanation) console.error(result.explanation);
        process.exitCode = 1;
        return;
      }
      console.log(result.explanation);
      if (result.changedFields.length > 0) {
        console.log(`Changed: ${result.changedFields.join(", ")}`);
      }
      if (result.instructions) {
        saveInstructions(resolved, result.instructions);
        console.log(`Saved ${resolved}`);
      }
      return;
    }

    const mtime = getFileMtime(resolved);
    const { waitUntilExit } = render(
      React.createElement(App, {
        initialInstructions: instructions,
        filePath: resolved,
        initialMtime: mtime,
      })
    );
    await waitUntilExit();
  },
});

await runCli(cli);
