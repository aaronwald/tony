import { OpenAI } from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import {
  loadInstructions,
  Instructions,
  Task,
  ChatTask,
  AgentTask,
} from "./instructions.js";
import { createCLI, addCommand, runCli } from "./cli.js";
import { Memory, createMemory } from "./memory.js";
import { ToolCall, executeTool, buildToolDefinition } from "./tool.js";
import { assert } from "node:console";
import { createChatCompletion, getOpenAIClient } from "./openai.js";

/*
system (System Prompt): Used to define the persona, tone, rules, and constraints for the AI before the conversation begins, ensuring the model acts according to specific guidelines. It is typically the first message.
user (User Prompt): Represents the questions, requests, or instructions provided by the end-user.
assistant (Model Response): Stores the AI's prior responses within a conversation, allowing for context retention. It can also be pre-filled by the developer to provide "few-shot" examples of how the assistant should respond.
*/

const DEFAULT_MODEL = "liquid/lfm-2.5-1.2b-thinking:free";
const MAX_AGENT_ITERATIONS = 10;
const MAX_REPEATED_ASSISTANT_MESSAGES = 2;

async function runChatTask(
  openai: OpenAI,
  task: ChatTask,
  model: string
): Promise<void> {
  console.log(`💬 Running chat task: ${task.id}`);
  const completion = await createChatCompletion(openai, {
    model,
    messages: buildChatMessages(task),
  });

  for (const choice of completion.choices) {
    console.log(`  🗨️  Assistant: ${choice.message.content}`);
  }
  // console.log(completion.choices[0].message);

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
  console.log(`🤖 Running agent task: ${task.id}`);

  const memory = createMemory(task.memory);
  const tools = [buildToolDefinition(task.tool)];
  const messages = buildMessages(memory);
  let lastAssistantContent: string | undefined;
  let repeatedAssistantCount = 0;

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
    const completion = await createChatCompletion(openai, {
      model,
      messages,
      tools,
      tool_choice: "auto",
    });

    assert(completion.choices.length === 1, "No choices returned from model");
    const choice = completion.choices[0];
    if (!choice) {
      console.error("  No response from model");
      return memory;
    }

    const assistantMessage = choice.message;
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
      console.log("  Stopping: repeated assistant responses detected.");
      return memory;
    }

    // If no tool calls, we're done - save final response to memory
    // Iterate til no more tools to do
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      if (isLowValueAssistantMessage(assistantMessage.content)) {
        console.log("  Stopping: low-value assistant response detected.");
        return memory;
      }
      console.log(`  Assistant: ${assistantMessage.content}`);
      return memory;
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
  return memory;
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
      const memory:Memory = await runAgentTask(getClient(), task, model);
      if (memory) {
        console.log("  Final agent memory:");
        for (const entry of memory.getHistory()) {
          console.log(`    [${entry.role}] ${entry.content}`);
        }
      }
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
