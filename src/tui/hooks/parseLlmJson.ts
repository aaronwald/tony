export interface ParsedLlmResponse {
  json: unknown;
  explanation: string;
}

export function parseLlmJson(response: string): ParsedLlmResponse | null {
  const fenceRegex = /```json\s*\n([\s\S]*?)```/;
  const match = response.match(fenceRegex);
  if (!match) return null;

  try {
    const json = JSON.parse(match[1].trim());
    const explanation = response
      .replace(fenceRegex, "")
      .trim()
      .replace(/\n{2,}/g, "\n");
    return { json, explanation };
  } catch {
    return null;
  }
}
