import { describe, it, expect } from "bun:test";
import { parseLlmJson } from "../parseLlmJson.js";

describe("parseLlmJson", () => {
  it("extracts JSON from a json code fence", () => {
    const input = 'Here is the result:\n```json\n{"id": "task1"}\n```\nDone.';
    const result = parseLlmJson(input);
    expect(result).toEqual({ json: { id: "task1" }, explanation: "Here is the result:\nDone." });
  });

  it("handles code fence with no language tag as non-match", () => {
    const input = '```\n{"id": "task1"}\n```';
    const result = parseLlmJson(input);
    expect(result).toBeNull();
  });

  it("returns null when no code fence is found", () => {
    const input = "No JSON here, just text.";
    const result = parseLlmJson(input);
    expect(result).toBeNull();
  });

  it("returns null when code fence contains invalid JSON", () => {
    const input = '```json\n{invalid json}\n```';
    const result = parseLlmJson(input);
    expect(result).toBeNull();
  });

  it("extracts explanation text outside the fence", () => {
    const input = 'Changed the model.\n```json\n{"defaultModel": "gpt-4o"}\n```\nLet me know.';
    const result = parseLlmJson(input);
    expect(result?.explanation).toBe("Changed the model.\nLet me know.");
  });

  it("uses the first json code fence if multiple exist", () => {
    const input = '```json\n{"a": 1}\n```\ntext\n```json\n{"b": 2}\n```';
    const result = parseLlmJson(input);
    expect(result?.json).toEqual({ a: 1 });
  });
});
