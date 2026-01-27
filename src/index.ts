import { OpenAI } from "openai";
import { loadInstructions } from "./instructions.js";

const apiKey = process.env.OPENROUTER_API_KEY;

if (!apiKey) {
  throw new Error("Missing OPENROUTER_API_KEY in environment.");
}

const openai = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: apiKey
});

async function route(content: string) {
  const completion = await openai.chat.completions.create({
    // model: 'openai/gpt-5.2',
    model: 'liquid/lfm-2.5-1.2b-thinking:free',
    messages: [
      {
        role: 'user',
        content: content,
      },
    ],
  });

  console.log(completion.choices[0].message);
}


try {
  const instructions = await loadInstructions();
  for (const task of instructions.tasks) {
    console.log(`Routing for task: ${task.id}`);
    await route(task.description);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`Failed to parse instructions.json: ${message}`);
  process.exitCode = 1;
  throw error;
}

// main(instructions.tasks.map(task => task.description).join("\n"));
