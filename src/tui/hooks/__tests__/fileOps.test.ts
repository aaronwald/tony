import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync, writeFileSync, statSync } from "fs";
import {
  saveInstructions,
  loadOrScaffold,
  getFileMtime,
  scaffoldInstructions,
} from "../fileOps.js";
import type { Instructions } from "../../../instructions.js";

const testPath = "/tmp/tony-test-instructions.json";

afterEach(() => {
  try { unlinkSync(testPath); } catch {}
});

describe("scaffoldInstructions", () => {
  it("returns minimal valid instructions", () => {
    const result = scaffoldInstructions();
    expect(result.defaultModel).toBeDefined();
    expect(result.tasks).toEqual([]);
  });
});

describe("saveInstructions", () => {
  it("writes instructions as formatted JSON", () => {
    const instructions: Instructions = { defaultModel: "m", tasks: [] };
    saveInstructions(testPath, instructions);
    const content = Bun.file(testPath).text();
    expect(content).resolves.toContain('"defaultModel"');
  });
});

describe("loadOrScaffold", () => {
  it("loads existing valid file", async () => {
    const data: Instructions = { defaultModel: "m", tasks: [] };
    writeFileSync(testPath, JSON.stringify(data));
    const result = await loadOrScaffold(testPath);
    expect(result.defaultModel).toBe("m");
  });

  it("creates scaffold when file does not exist", async () => {
    const result = await loadOrScaffold(testPath);
    expect(result.tasks).toEqual([]);
    expect(existsSync(testPath)).toBe(true);
  });
});

describe("getFileMtime", () => {
  it("returns mtime for existing file", () => {
    writeFileSync(testPath, "{}");
    const mtime = getFileMtime(testPath);
    expect(typeof mtime).toBe("number");
    expect(mtime).toBeGreaterThan(0);
  });
});
