export interface ParsedLlmResponse {
  json: unknown;
  explanation: string;
}

/**
 * Sanitize common LLM JSON quirks before parsing:
 * - { ...} or { ... } → {}
 * - [...] → []
 * - Trailing commas before } or ]
 */
function sanitizeLlmJson(raw: string): string {
  return raw
    .replace(/\{\s*\.{3}\s*\}/g, "{}")
    .replace(/\[\s*\.{3}\s*\]/g, "[]")
    .replace(/,\s*([}\]])/g, "$1");
}

export function parseLlmJson(response: string): ParsedLlmResponse | null {
  const fenceRegex = /```json\s*\n([\s\S]*?)```/;
  const match = response.match(fenceRegex);
  if (!match) return null;

  const explanation = response
    .replace(fenceRegex, "")
    .trim()
    .replace(/\n{2,}/g, "\n");

  // Try raw first, then sanitized
  const raw = match[1].trim();
  try {
    return { json: JSON.parse(raw), explanation };
  } catch {
    // fall through to sanitized attempt
  }

  try {
    return { json: JSON.parse(sanitizeLlmJson(raw)), explanation };
  } catch {
    return null;
  }
}
