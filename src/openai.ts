import { OpenAI } from "openai";
import type { ChatCompletion, ChatCompletionChunk } from "openai/resources/chat/completions";
import type { Stream } from "openai/streaming";

const controller = new AbortController();

process.on("SIGINT", () => controller.abort());

const DEFAULT_OPEN_AI_URL = "https://openrouter.ai/api/v1";
const MAX_RETRIES = 8;
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

export function getOpenAIClient(): OpenAI {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("Missing OPENROUTER_API_KEY in environment.");
  }
  return new OpenAI({
    baseURL: DEFAULT_OPEN_AI_URL,
    apiKey: apiKey,
  });
}

export function createChatCompletion(
  openai: OpenAI,
  params: Parameters<typeof openai.chat.completions.create>[0] & { stream: true }
): Promise<Stream<ChatCompletionChunk>>;
export function createChatCompletion(
  openai: OpenAI,
  params: Omit<Parameters<typeof openai.chat.completions.create>[0], "stream"> & {
    stream?: false;
  }
): Promise<ChatCompletion>;
export async function createChatCompletion(
  openai: OpenAI,
  params: Parameters<typeof openai.chat.completions.create>[0]
): Promise<Stream<ChatCompletionChunk> | ChatCompletion> {
  let attempt = 0;
  while (true) {
    try {
      return await openai.chat.completions.create({
        ...params,
        // @ts-expect-error OpenRouter-specific: compress prompts that exceed context window
        transforms: ["middle-out"],
      }, {
        signal: controller.signal,
      });
    } catch (error) {
      attempt += 1;
      if (attempt > MAX_RETRIES || !shouldRetry(error)) {
        throw error;
      }
      const baseDelay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      const jitter = 0.5 + Math.random();
      const delay = Math.round(baseDelay * jitter);
      console.warn(`Retrying request (attempt ${attempt}) after ${delay}ms...`);
      await sleep(delay);
    }
  }
}
