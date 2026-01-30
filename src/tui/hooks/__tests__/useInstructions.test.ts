import { describe, it, expect } from "bun:test";
import {
  createInstructionsState,
  updateTask,
  addTask,
  deleteTask,
  undo,
  type InstructionsState,
} from "../useInstructions.js";
import type { Instructions, AgentTask } from "../../../instructions.js";

const baseInstructions: Instructions = {
  defaultModel: "test-model",
  tasks: [
    {
      id: "task1",
      type: "agent",
      memory: { context: ["ctx"], history: [] },
      input: "do something",
      outcome: "result",
    } as AgentTask,
  ],
};

describe("createInstructionsState", () => {
  it("creates state from instructions with empty undo stack", () => {
    const state = createInstructionsState(baseInstructions, "/tmp/test.json");
    expect(state.instructions).toEqual(baseInstructions);
    expect(state.filePath).toBe("/tmp/test.json");
    expect(state.dirty).toBe(false);
    expect(state.undoStack).toEqual([]);
    expect(state.savedSnapshot).toBe(JSON.stringify(baseInstructions));
  });
});

describe("updateTask", () => {
  it("updates a task field and marks dirty", () => {
    const state = createInstructionsState(baseInstructions, "/tmp/test.json");
    const next = updateTask(state, "task1", { input: "new input" });
    const task = next.instructions.tasks[0] as AgentTask;
    expect(task.input).toBe("new input");
    expect(next.dirty).toBe(true);
    expect(next.undoStack.length).toBe(1);
  });

  it("pushes previous state to undo stack", () => {
    const state = createInstructionsState(baseInstructions, "/tmp/test.json");
    const next = updateTask(state, "task1", { input: "changed" });
    expect(next.undoStack[0]).toEqual(state.instructions);
  });
});

describe("addTask", () => {
  it("adds a task and marks dirty", () => {
    const state = createInstructionsState(baseInstructions, "/tmp/test.json");
    const newTask: AgentTask = {
      id: "task2",
      type: "agent",
      memory: { context: [], history: [] },
    };
    const next = addTask(state, newTask);
    expect(next.instructions.tasks.length).toBe(2);
    expect(next.instructions.tasks[1].id).toBe("task2");
    expect(next.dirty).toBe(true);
  });

  it("rejects duplicate IDs", () => {
    const state = createInstructionsState(baseInstructions, "/tmp/test.json");
    const dupe: AgentTask = {
      id: "task1",
      type: "agent",
      memory: { context: [], history: [] },
    };
    expect(() => addTask(state, dupe)).toThrow("already exists");
  });
});

describe("deleteTask", () => {
  it("removes a task by id and marks dirty", () => {
    const state = createInstructionsState(baseInstructions, "/tmp/test.json");
    const next = deleteTask(state, "task1");
    expect(next.instructions.tasks.length).toBe(0);
    expect(next.dirty).toBe(true);
  });
});

describe("undo", () => {
  it("restores previous state from undo stack", () => {
    const state = createInstructionsState(baseInstructions, "/tmp/test.json");
    const modified = updateTask(state, "task1", { input: "changed" });
    const restored = undo(modified);
    expect(restored.instructions).toEqual(baseInstructions);
    expect(restored.undoStack.length).toBe(0);
  });

  it("clears dirty flag when undo returns to saved snapshot", () => {
    const state = createInstructionsState(baseInstructions, "/tmp/test.json");
    const modified = updateTask(state, "task1", { input: "changed" });
    const restored = undo(modified);
    expect(restored.dirty).toBe(false);
  });

  it("returns same state when undo stack is empty", () => {
    const state = createInstructionsState(baseInstructions, "/tmp/test.json");
    const same = undo(state);
    expect(same).toBe(state);
  });

  it("caps undo stack at 50 entries", () => {
    let state = createInstructionsState(baseInstructions, "/tmp/test.json");
    for (let i = 0; i < 55; i++) {
      state = updateTask(state, "task1", { input: `change-${i}` });
    }
    expect(state.undoStack.length).toBe(50);
  });
});
