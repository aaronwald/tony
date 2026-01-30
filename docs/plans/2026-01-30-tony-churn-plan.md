# Tony Churn Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build `tony churn`, an interactive TUI subcommand for CRUD editing of `instructions.json` with an LLM-powered command mode.

**Architecture:** Ink (React for CLI) app with two modes — Form Mode for structured navigation/editing, Command Mode for natural language edits via the existing OpenRouter integration. State managed in React hooks with undo stack and dirty tracking. Launched via `tony churn` subcommand.

**Tech Stack:** TypeScript, Ink, React, ink-text-input, Bun, existing OpenRouter/openai.ts integration.

**Worktree:** `/Users/aaronwald/repos/tony/.worktrees/churn` (branch: `feature/churn`)

**Design Doc:** `docs/plans/2026-01-30-tony-churn-design.md`

---

## Task 1: Install Dependencies and Configure JSX

**Files:**

- Modify: `package.json`
- Modify: `tsconfig.json`

**Step 1: Install ink, react, and ink-text-input**

Run:

```bash
bun add ink react ink-text-input
bun add -d @types/react
```

**Step 2: Update tsconfig.json for JSX support**

Add `"jsx": "react-jsx"` and `"jsxImportSource": "react"` to `compilerOptions` in `tsconfig.json`.

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "types": ["node"],
    "jsx": "react-jsx",
    "jsxImportSource": "react"
  },
  "include": ["src/**/*"]
}
```

**Step 3: Verify build still works**

Run: `npx tsc --noEmit`

Expected: No errors.

**Step 4: Commit**

```bash
git add package.json tsconfig.json bun.lock
git commit -m "feat: add ink, react, and JSX support for TUI"
```

---

## Task 2: Create useInstructions Hook

This hook manages loading, mutating, saving, undo, and dirty tracking for `instructions.json`.

**Files:**

- Create: `src/tui/hooks/useInstructions.ts`
- Create: `src/tui/hooks/__tests__/useInstructions.test.ts`

**Step 1: Write the failing tests**

Create `src/tui/hooks/__tests__/useInstructions.test.ts`:

```typescript
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
```

**Step 2: Run tests to verify they fail**

Run: `bun test src/tui/hooks/__tests__/useInstructions.test.ts`

Expected: FAIL — modules not found.

**Step 3: Implement useInstructions**

Create `src/tui/hooks/useInstructions.ts`:

```typescript
import type { Instructions, Task } from "../../instructions.js";

const MAX_UNDO = 50;

export interface InstructionsState {
  instructions: Instructions;
  filePath: string;
  dirty: boolean;
  undoStack: Instructions[];
  savedSnapshot: string;
}

export function createInstructionsState(
  instructions: Instructions,
  filePath: string
): InstructionsState {
  return {
    instructions,
    filePath,
    dirty: false,
    undoStack: [],
    savedSnapshot: JSON.stringify(instructions),
  };
}

function pushUndo(state: InstructionsState, next: Instructions): InstructionsState {
  const undoStack = [state.instructions, ...state.undoStack].slice(0, MAX_UNDO);
  const snapshot = JSON.stringify(next);
  return {
    ...state,
    instructions: next,
    undoStack,
    dirty: snapshot !== state.savedSnapshot,
  };
}

export function updateTask(
  state: InstructionsState,
  taskId: string,
  updates: Partial<Task>
): InstructionsState {
  const next: Instructions = {
    ...state.instructions,
    tasks: state.instructions.tasks.map((t) =>
      t.id === taskId ? { ...t, ...updates } : t
    ),
  };
  return pushUndo(state, next);
}

export function addTask(state: InstructionsState, task: Task): InstructionsState {
  if (state.instructions.tasks.some((t) => t.id === task.id)) {
    throw new Error(`Task with id "${task.id}" already exists`);
  }
  const next: Instructions = {
    ...state.instructions,
    tasks: [...state.instructions.tasks, task],
  };
  return pushUndo(state, next);
}

export function deleteTask(state: InstructionsState, taskId: string): InstructionsState {
  const next: Instructions = {
    ...state.instructions,
    tasks: state.instructions.tasks.filter((t) => t.id !== taskId),
  };
  return pushUndo(state, next);
}

export function undo(state: InstructionsState): InstructionsState {
  if (state.undoStack.length === 0) return state;
  const [prev, ...rest] = state.undoStack;
  const snapshot = JSON.stringify(prev);
  return {
    ...state,
    instructions: prev,
    undoStack: rest,
    dirty: snapshot !== state.savedSnapshot,
  };
}

export function replaceInstructions(
  state: InstructionsState,
  next: Instructions
): InstructionsState {
  return pushUndo(state, next);
}

export function markSaved(state: InstructionsState): InstructionsState {
  return {
    ...state,
    dirty: false,
    savedSnapshot: JSON.stringify(state.instructions),
  };
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test src/tui/hooks/__tests__/useInstructions.test.ts`

Expected: All tests PASS.

**Step 5: Commit**

```bash
git add src/tui/hooks/useInstructions.ts src/tui/hooks/__tests__/useInstructions.test.ts
git commit -m "feat: add useInstructions state management with undo stack"
```

---

## Task 3: Create LLM Code-Fence Parser

Parses LLM responses to extract JSON from ` ```json ` code fences.

**Files:**

- Create: `src/tui/hooks/parseLlmJson.ts`
- Create: `src/tui/hooks/__tests__/parseLlmJson.test.ts`

**Step 1: Write the failing tests**

Create `src/tui/hooks/__tests__/parseLlmJson.test.ts`:

```typescript
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
```

**Step 2: Run tests to verify they fail**

Run: `bun test src/tui/hooks/__tests__/parseLlmJson.test.ts`

Expected: FAIL — module not found.

**Step 3: Implement parseLlmJson**

Create `src/tui/hooks/parseLlmJson.ts`:

```typescript
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
      .replace(/\n{3,}/g, "\n");
    return { json, explanation };
  } catch {
    return null;
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test src/tui/hooks/__tests__/parseLlmJson.test.ts`

Expected: All tests PASS.

**Step 5: Commit**

```bash
git add src/tui/hooks/parseLlmJson.ts src/tui/hooks/__tests__/parseLlmJson.test.ts
git commit -m "feat: add strict JSON code-fence parser for LLM responses"
```

---

## Task 4: Create File I/O Utilities (Save + Scaffold + mtime)

**Files:**

- Create: `src/tui/hooks/fileOps.ts`
- Create: `src/tui/hooks/__tests__/fileOps.test.ts`

**Step 1: Write the failing tests**

Create `src/tui/hooks/__tests__/fileOps.test.ts`:

```typescript
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
```

**Step 2: Run tests to verify they fail**

Run: `bun test src/tui/hooks/__tests__/fileOps.test.ts`

Expected: FAIL — module not found.

**Step 3: Implement fileOps**

Create `src/tui/hooks/fileOps.ts`:

```typescript
import { existsSync, writeFileSync, statSync } from "fs";
import { readFile } from "fs/promises";
import { parseInstructions, type Instructions } from "../../instructions.js";

export function scaffoldInstructions(): Instructions {
  return {
    defaultModel: "openai/gpt-4o-mini",
    tasks: [],
  };
}

export function saveInstructions(filePath: string, instructions: Instructions): void {
  writeFileSync(filePath, JSON.stringify(instructions, null, 2) + "\n");
}

export async function loadOrScaffold(filePath: string): Promise<Instructions> {
  if (!existsSync(filePath)) {
    const scaffold = scaffoldInstructions();
    saveInstructions(filePath, scaffold);
    return scaffold;
  }
  const content = await readFile(filePath, "utf-8");
  return parseInstructions(content);
}

export function getFileMtime(filePath: string): number {
  return statSync(filePath).mtimeMs;
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test src/tui/hooks/__tests__/fileOps.test.ts`

Expected: All tests PASS.

**Step 5: Commit**

```bash
git add src/tui/hooks/fileOps.ts src/tui/hooks/__tests__/fileOps.test.ts
git commit -m "feat: add file I/O utilities for save, scaffold, and mtime"
```

---

## Task 5: Create TaskList Component

The main screen showing all tasks with navigation.

**Files:**

- Create: `src/tui/components/TaskList.tsx`

**Step 1: Implement TaskList**

Create `src/tui/components/TaskList.tsx`:

```tsx
import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { Instructions, Task } from "../../instructions.js";

interface TaskListProps {
  instructions: Instructions;
  dirty: boolean;
  onSelectTask: (taskId: string) => void;
  onNewTask: () => void;
  onDeleteTask: (taskId: string) => void;
  onCommandMode: () => void;
  onSave: () => void;
  onQuit: () => void;
}

export function TaskList({
  instructions,
  dirty,
  onSelectTask,
  onNewTask,
  onDeleteTask,
  onCommandMode,
  onSave,
  onQuit,
}: TaskListProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const tasks = instructions.tasks;

  useInput((input, key) => {
    if (confirmDelete) {
      if (input === "y") {
        const task = tasks[selectedIndex];
        if (task) onDeleteTask(task.id);
        setConfirmDelete(false);
      } else {
        setConfirmDelete(false);
      }
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1));
    } else if (key.downArrow) {
      setSelectedIndex((i) => Math.min(tasks.length - 1, i + 1));
    } else if (key.return) {
      const task = tasks[selectedIndex];
      if (task) onSelectTask(task.id);
    } else if (input === "n") {
      onNewTask();
    } else if (input === "d") {
      if (tasks.length > 0) setConfirmDelete(true);
    } else if (input === ":") {
      onCommandMode();
    } else if (input === "q") {
      onQuit();
    }
  });

  // Ctrl+S handled via raw input
  useInput((_input, key) => {
    if (key.ctrl && _input === "s") {
      onSave();
    }
  });

  const truncate = (s: string | undefined, max: number) =>
    s && s.length > max ? s.slice(0, max) + "..." : s || "";

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>Tony Churn</Text>
        <Text> — </Text>
        <Text dimColor>{instructions.tasks.length} tasks</Text>
        {dirty && <Text color="yellow"> [unsaved]</Text>}
      </Box>

      {tasks.length === 0 ? (
        <Text dimColor>No tasks. Press n to create one.</Text>
      ) : (
        tasks.map((task, i) => {
          const selected = i === selectedIndex;
          const prefix = selected ? ">" : " ";
          const inputPreview = "input" in task ? truncate(task.input, 50) : "";
          return (
            <Box key={task.id}>
              <Text
                color={selected ? "cyan" : undefined}
                bold={selected}
              >
                {prefix} {task.id}
              </Text>
              <Text dimColor> [{task.type}]</Text>
              <Text dimColor> {task.model || instructions.defaultModel || ""}</Text>
              {inputPreview && <Text dimColor> {inputPreview}</Text>}
            </Box>
          );
        })
      )}

      {confirmDelete && (
        <Box marginTop={1}>
          <Text color="red">
            Delete task "{tasks[selectedIndex]?.id}"? (y/n)
          </Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>
          ↑↓ navigate  Enter select  n new  d delete  : command  Ctrl+S save  q quit
        </Text>
      </Box>
    </Box>
  );
}
```

**Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`

Expected: No errors.

**Step 3: Commit**

```bash
git add src/tui/components/TaskList.tsx
git commit -m "feat: add TaskList component with navigation and keybindings"
```

---

## Task 6: Create TaskDetail Component

Shows a single task's fields for editing.

**Files:**

- Create: `src/tui/components/TaskDetail.tsx`

**Step 1: Implement TaskDetail**

Create `src/tui/components/TaskDetail.tsx`:

```tsx
import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import type { Task, AgentTask, ChatTask } from "../../instructions.js";

interface TaskDetailProps {
  task: Task;
  defaultModel?: string;
  changedFields?: Set<string>;
  onUpdate: (updates: Partial<Task>) => void;
  onBack: () => void;
  onCommandMode: () => void;
}

type FieldDef = {
  key: string;
  label: string;
  getValue: (task: Task) => string;
  type: "string" | "multiline" | "select" | "number" | "list";
};

const FIELDS: FieldDef[] = [
  { key: "id", label: "ID", getValue: (t) => t.id, type: "string" },
  { key: "type", label: "Type", getValue: (t) => t.type, type: "select" },
  { key: "model", label: "Model", getValue: (t) => t.model || "", type: "string" },
  {
    key: "input",
    label: "Input",
    getValue: (t) => ("input" in t ? (t as AgentTask).input || "" : (t as ChatTask).prompt || ""),
    type: "multiline",
  },
  { key: "outcome", label: "Outcome", getValue: (t) => t.outcome || "", type: "multiline" },
  {
    key: "memory.context",
    label: "Context",
    getValue: (t) =>
      "memory" in t && t.memory?.context
        ? `[${t.memory.context.length} items]`
        : "[]",
    type: "list",
  },
  {
    key: "mcpServers",
    label: "MCP Servers",
    getValue: (t) =>
      t.mcpServers ? `[${t.mcpServers.map((s) => s.name).join(", ")}]` : "[]",
    type: "list",
  },
  {
    key: "mcpTools",
    label: "MCP Tools",
    getValue: (t) => (t.mcpTools ? `[${t.mcpTools.join(", ")}]` : "[]"),
    type: "list",
  },
  {
    key: "temperature",
    label: "Temperature",
    getValue: (t) => (t.temperature != null ? String(t.temperature) : ""),
    type: "number",
  },
  {
    key: "max_tokens",
    label: "Max Tokens",
    getValue: (t) => (t.max_tokens != null ? String(t.max_tokens) : ""),
    type: "number",
  },
  {
    key: "seed",
    label: "Seed",
    getValue: (t) => (t.seed != null ? String(t.seed) : ""),
    type: "number",
  },
];

const NUMERIC_BOUNDS: Record<string, { min: number; max: number }> = {
  temperature: { min: 0, max: 2 },
  max_tokens: { min: 1, max: 128000 },
};

export function TaskDetail({
  task,
  defaultModel,
  changedFields,
  onUpdate,
  onBack,
  onCommandMode,
}: TaskDetailProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  useInput((input, key) => {
    if (editing) return;

    if (key.escape) {
      onBack();
    } else if (key.upArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1));
      setError(null);
    } else if (key.downArrow) {
      setSelectedIndex((i) => Math.min(FIELDS.length - 1, i + 1));
      setError(null);
    } else if (key.return) {
      const field = FIELDS[selectedIndex];
      if (field.type === "select") {
        const newType = task.type === "agent" ? "chat" : "agent";
        onUpdate({ type: newType } as Partial<Task>);
      } else if (field.type === "list") {
        // List editing handled in a future sub-component
      } else {
        setEditing(true);
        setEditValue(field.getValue(task));
      }
    } else if (input === ":") {
      onCommandMode();
    }
  });

  const handleSubmit = (value: string) => {
    const field = FIELDS[selectedIndex];
    setEditing(false);

    if (field.type === "number" && value !== "") {
      const num = Number(value);
      if (isNaN(num)) {
        setError(`"${field.label}" must be a number`);
        return;
      }
      const bounds = NUMERIC_BOUNDS[field.key];
      if (bounds && (num < bounds.min || num > bounds.max)) {
        setError(`"${field.label}" must be between ${bounds.min} and ${bounds.max}`);
        return;
      }
    }

    setError(null);

    if (field.type === "number") {
      onUpdate({ [field.key]: value === "" ? undefined : Number(value) } as Partial<Task>);
    } else {
      onUpdate({ [field.key]: value } as Partial<Task>);
    }
  };

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>Task: {task.id}</Text>
        <Text dimColor> ({task.model || defaultModel || "default model"})</Text>
      </Box>

      {FIELDS.map((field, i) => {
        const selected = i === selectedIndex;
        const prefix = selected ? ">" : " ";
        const isChanged = changedFields?.has(field.key);
        const value = field.getValue(task);

        if (editing && selected) {
          return (
            <Box key={field.key}>
              <Text color="cyan">{prefix} {field.label}: </Text>
              <TextInput
                value={editValue}
                onChange={setEditValue}
                onSubmit={handleSubmit}
              />
            </Box>
          );
        }

        return (
          <Box key={field.key}>
            <Text
              color={isChanged ? "yellow" : selected ? "cyan" : undefined}
              bold={selected}
            >
              {prefix} {field.label}:
            </Text>
            <Text
              color={isChanged ? "yellow" : undefined}
            >
              {" "}{value.length > 60 ? value.slice(0, 60) + "..." : value || "(empty)"}
            </Text>
          </Box>
        );
      })}

      {error && (
        <Box marginTop={1}>
          <Text color="red">{error}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>
          ↑↓ navigate  Enter edit  Escape back  : command
        </Text>
      </Box>
    </Box>
  );
}
```

**Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`

Expected: No errors.

**Step 3: Commit**

```bash
git add src/tui/components/TaskDetail.tsx
git commit -m "feat: add TaskDetail component with field editing and validation"
```

---

## Task 7: Create CommandInput Component

The `:` command mode UI that sends natural language to the LLM.

**Files:**

- Create: `src/tui/components/CommandInput.tsx`

**Step 1: Implement CommandInput**

Create `src/tui/components/CommandInput.tsx`:

```tsx
import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";

interface CommandInputProps {
  onSubmit: (command: string) => void;
  onCancel: () => void;
  loading: boolean;
  response: string | null;
  error: string | null;
  changedFields: string[];
}

export function CommandInput({
  onSubmit,
  onCancel,
  loading,
  response,
  error,
  changedFields,
}: CommandInputProps) {
  const [value, setValue] = useState("");

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
    }
  });

  const handleSubmit = (v: string) => {
    if (v.trim() === "") return;
    onSubmit(v.trim());
    setValue("");
  };

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="cyan" bold>:</Text>
        {loading ? (
          <Text dimColor> Processing...</Text>
        ) : (
          <TextInput
            value={value}
            onChange={setValue}
            onSubmit={handleSubmit}
            placeholder="Type a command..."
          />
        )}
      </Box>

      {response && (
        <Box marginTop={1} flexDirection="column">
          <Text>{response}</Text>
        </Box>
      )}

      {changedFields.length > 0 && (
        <Box marginTop={1}>
          <Text color="yellow">Changed: {changedFields.join(", ")}</Text>
        </Box>
      )}

      {error && (
        <Box marginTop={1}>
          <Text color="red">{error}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>Escape to dismiss</Text>
      </Box>
    </Box>
  );
}
```

**Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`

Expected: No errors.

**Step 3: Commit**

```bash
git add src/tui/components/CommandInput.tsx
git commit -m "feat: add CommandInput component for LLM command mode"
```

---

## Task 8: Create useCommandMode Hook

Wires command mode to the existing `createAssistantMessage` for LLM calls.

**Files:**

- Create: `src/tui/hooks/useCommandMode.ts`

**Step 1: Implement useCommandMode**

Create `src/tui/hooks/useCommandMode.ts`:

```typescript
import type { Instructions, Task } from "../../instructions.js";
import { getOpenAIClient, createChatCompletion } from "../../openai.js";
import { parseLlmJson } from "./parseLlmJson.js";
import { parseInstructions } from "../../instructions.js";

export interface CommandResult {
  instructions?: Instructions;
  task?: Task;
  explanation: string;
  changedFields: string[];
  error?: string;
}

const SYSTEM_PROMPT = `You are an assistant that edits instructions.json files for the Tony task orchestration framework.

When the user asks you to modify the instructions, return the complete modified JSON inside a \`\`\`json code fence. Include a brief explanation of what you changed outside the fence.

The instructions schema:
- defaultModel: string (optional) - default LLM model
- tasks: array of task objects, each with:
  - id: string (required, unique)
  - type: "agent" | "chat" (required)
  - model: string (optional, overrides defaultModel)
  - For agent tasks: memory (required, {context: string[], history: array}), input (string), outcome (string)
  - For chat tasks: prompt (string), description (string)
  - Optional: mcpServers (array of {name, command, args, env}), mcpTools (string[]), temperature (0-2), max_tokens (1-128000), seed (integer)

Return ONLY the modified JSON in a json code fence. Do not omit any fields from the original.`;

function diffFields(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const changed: string[] = [];
  for (const key of keys) {
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
      changed.push(key);
    }
  }
  return changed;
}

export async function executeCommand(
  command: string,
  context: Instructions | Task,
  scope: "global" | "task",
  model?: string
): Promise<CommandResult> {
  const client = getOpenAIClient();
  const contextJson = JSON.stringify(context, null, 2);

  const scopeNote =
    scope === "global"
      ? "The user wants to modify the full instructions file."
      : "The user wants to modify this specific task.";

  const response = await createChatCompletion(client, {
    model: model || "openai/gpt-4o-mini",
    messages: [
      { role: "system", content: SYSTEM_PROMPT + "\n\n" + scopeNote },
      {
        role: "user",
        content: `Current JSON:\n\`\`\`json\n${contextJson}\n\`\`\`\n\nCommand: ${command}`,
      },
    ],
    stream: false,
  });

  const content = response.choices[0]?.message?.content || "";
  const parsed = parseLlmJson(content);

  if (!parsed) {
    return {
      explanation: "",
      changedFields: [],
      error: "Could not parse LLM response. No valid JSON code fence found.",
    };
  }

  try {
    if (scope === "global") {
      const instructions = parseInstructions(JSON.stringify(parsed.json));
      const changedFields = diffFields(
        context as Record<string, unknown>,
        instructions as unknown as Record<string, unknown>
      );
      return { instructions, explanation: parsed.explanation, changedFields };
    } else {
      const task = parsed.json as Task;
      const changedFields = diffFields(
        context as Record<string, unknown>,
        task as unknown as Record<string, unknown>
      );
      return { task, explanation: parsed.explanation, changedFields };
    }
  } catch (e) {
    return {
      explanation: parsed.explanation,
      changedFields: [],
      error: `LLM returned invalid instructions: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
```

**Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`

Expected: No errors.

**Step 3: Commit**

```bash
git add src/tui/hooks/useCommandMode.ts
git commit -m "feat: add useCommandMode hook for LLM-powered editing"
```

---

## Task 9: Create Root App Component

Ties all components together with mode switching.

**Files:**

- Create: `src/tui/app.tsx`

**Step 1: Implement App**

Create `src/tui/app.tsx`:

```tsx
import React, { useState, useCallback } from "react";
import { Box, Text, useApp } from "ink";
import { TaskList } from "./components/TaskList.js";
import { TaskDetail } from "./components/TaskDetail.js";
import { CommandInput } from "./components/CommandInput.js";
import {
  createInstructionsState,
  updateTask,
  addTask,
  deleteTask,
  undo,
  replaceInstructions,
  markSaved,
  type InstructionsState,
} from "./hooks/useInstructions.js";
import { executeCommand } from "./hooks/useCommandMode.js";
import {
  saveInstructions,
  getFileMtime,
} from "./hooks/fileOps.js";
import { parseInstructions } from "../instructions.js";
import type { Instructions, AgentTask, Task } from "../instructions.js";

type View = "list" | "detail" | "command" | "newTask";

interface AppProps {
  initialInstructions: Instructions;
  filePath: string;
  initialMtime: number;
}

export function App({ initialInstructions, filePath, initialMtime }: AppProps) {
  const { exit } = useApp();
  const [state, setState] = useState<InstructionsState>(() =>
    createInstructionsState(initialInstructions, filePath)
  );
  const [view, setView] = useState<View>("list");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [lastMtime, setLastMtime] = useState(initialMtime);
  const [message, setMessage] = useState<string | null>(null);
  const [commandLoading, setCommandLoading] = useState(false);
  const [commandResponse, setCommandResponse] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [changedFields, setChangedFields] = useState<Set<string>>(new Set());

  const selectedTask = selectedTaskId
    ? state.instructions.tasks.find((t) => t.id === selectedTaskId) || null
    : null;

  const handleSave = useCallback(() => {
    try {
      const currentMtime = getFileMtime(filePath);
      if (currentMtime > lastMtime) {
        setMessage("File changed externally. Save again to overwrite, or restart to reload.");
        setLastMtime(currentMtime);
        return;
      }
    } catch {}

    try {
      saveInstructions(filePath, state.instructions);
      setState(markSaved(state));
      setLastMtime(getFileMtime(filePath));
      setMessage("Saved.");
      setTimeout(() => setMessage(null), 2000);
    } catch (e) {
      setMessage(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [state, filePath, lastMtime]);

  const handleUndo = useCallback(() => {
    setState((s) => undo(s));
  }, []);

  const handleSelectTask = useCallback((taskId: string) => {
    setSelectedTaskId(taskId);
    setChangedFields(new Set());
    setView("detail");
  }, []);

  const handleNewTask = useCallback(() => {
    const id = `task${String(state.instructions.tasks.length + 1).padStart(3, "0")}`;
    const newTask: AgentTask = {
      id,
      type: "agent",
      memory: { context: [], history: [] },
    };
    try {
      setState((s) => addTask(s, newTask));
      setSelectedTaskId(id);
      setView("detail");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  }, [state]);

  const handleDeleteTask = useCallback((taskId: string) => {
    setState((s) => deleteTask(s, taskId));
    setSelectedTaskId(null);
  }, []);

  const handleUpdateTask = useCallback(
    (updates: Partial<Task>) => {
      if (!selectedTaskId) return;
      setState((s) => updateTask(s, selectedTaskId, updates));
    },
    [selectedTaskId]
  );

  const handleCommandSubmit = useCallback(
    async (command: string) => {
      if (command === "w") {
        handleSave();
        setView(selectedTaskId ? "detail" : "list");
        return;
      }
      if (command === "u") {
        handleUndo();
        setView(selectedTaskId ? "detail" : "list");
        return;
      }

      setCommandLoading(true);
      setCommandResponse(null);
      setCommandError(null);

      const scope = selectedTask ? "task" : "global";
      const context = selectedTask || state.instructions;

      try {
        const result = await executeCommand(
          command,
          context,
          scope as "global" | "task",
          state.instructions.defaultModel
        );

        if (result.error) {
          setCommandError(result.error);
        } else if (scope === "global" && result.instructions) {
          setState((s) => replaceInstructions(s, result.instructions!));
          setChangedFields(new Set(result.changedFields));
          setCommandResponse(result.explanation);
        } else if (scope === "task" && result.task && selectedTaskId) {
          setState((s) => updateTask(s, selectedTaskId, result.task!));
          setChangedFields(new Set(result.changedFields));
          setCommandResponse(result.explanation);
        }
      } catch (e) {
        setCommandError(e instanceof Error ? e.message : String(e));
      } finally {
        setCommandLoading(false);
      }
    },
    [state, selectedTask, selectedTaskId, handleSave, handleUndo]
  );

  const handleCommandCancel = useCallback(() => {
    setView(selectedTaskId && selectedTask ? "detail" : "list");
    setCommandResponse(null);
    setCommandError(null);
  }, [selectedTaskId, selectedTask]);

  const handleQuit = useCallback(() => {
    if (state.dirty) {
      setMessage("Unsaved changes. Save first (Ctrl+S) or press q again.");
      // A real implementation would track double-q, keeping simple for now
    }
    exit();
  }, [state.dirty, exit]);

  return (
    <Box flexDirection="column" padding={1}>
      {message && (
        <Box marginBottom={1}>
          <Text color="green">{message}</Text>
        </Box>
      )}

      {view === "list" && (
        <TaskList
          instructions={state.instructions}
          dirty={state.dirty}
          onSelectTask={handleSelectTask}
          onNewTask={handleNewTask}
          onDeleteTask={handleDeleteTask}
          onCommandMode={() => setView("command")}
          onSave={handleSave}
          onQuit={handleQuit}
        />
      )}

      {view === "detail" && selectedTask && (
        <TaskDetail
          task={selectedTask}
          defaultModel={state.instructions.defaultModel}
          changedFields={changedFields}
          onUpdate={handleUpdateTask}
          onBack={() => {
            setView("list");
            setChangedFields(new Set());
          }}
          onCommandMode={() => setView("command")}
        />
      )}

      {view === "command" && (
        <CommandInput
          onSubmit={handleCommandSubmit}
          onCancel={handleCommandCancel}
          loading={commandLoading}
          response={commandResponse}
          error={commandError}
          changedFields={Array.from(changedFields)}
        />
      )}
    </Box>
  );
}
```

**Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`

Expected: No errors.

**Step 3: Commit**

```bash
git add src/tui/app.tsx
git commit -m "feat: add root App component with mode switching and state management"
```

---

## Task 10: Register `churn` Subcommand

Wire the TUI into the existing CLI.

**Files:**

- Modify: `src/index.ts` (add churn command near line 904)

**Step 1: Add churn command to index.ts**

After the existing `addCommand(cli, { name: "run", ... })` block (around line 904), add the churn command:

```typescript
// Add these imports at the top of index.ts
import { render } from "ink";
import React from "react";
import { App } from "./tui/app.js";
import { loadOrScaffold, getFileMtime } from "./tui/hooks/fileOps.js";
```

Then register the command before `runCli(cli)`:

```typescript
addCommand(cli, {
  name: "churn",
  description: "Interactive TUI for editing instructions",
  action: async (args: string[]) => {
    let filePath = "instructions.json";
    for (let i = 0; i < args.length; i++) {
      if ((args[i] === "-f" || args[i] === "--file") && args[i + 1]) {
        filePath = args[i + 1];
        i++;
      }
    }

    const resolved = require("path").resolve(filePath);
    const instructions = await loadOrScaffold(resolved);
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
```

**Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`

Expected: No errors.

**Step 3: Verify build works**

Run: `bun build src/index.ts --outdir dist --target bun`

Expected: Build succeeds.

**Step 4: Smoke test**

Run: `bun run dist/index.js churn`

Expected: TUI launches showing the task list from `instructions.json`. Press `q` to quit.

**Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: register tony churn subcommand"
```

---

## Task 11: Add NewTask Prompt Component

When pressing `n` in the task list, prompt for task ID and type before creating.

**Files:**

- Create: `src/tui/components/NewTaskPrompt.tsx`
- Modify: `src/tui/app.tsx` (wire in the prompt)

**Step 1: Implement NewTaskPrompt**

Create `src/tui/components/NewTaskPrompt.tsx`:

```tsx
import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";

interface NewTaskPromptProps {
  existingIds: string[];
  onConfirm: (id: string, type: "agent" | "chat") => void;
  onCancel: () => void;
}

export function NewTaskPrompt({ existingIds, onConfirm, onCancel }: NewTaskPromptProps) {
  const [step, setStep] = useState<"id" | "type">("id");
  const [id, setId] = useState("");
  const [error, setError] = useState<string | null>(null);

  useInput((_input, key) => {
    if (key.escape) onCancel();
  });

  const handleIdSubmit = (value: string) => {
    const trimmed = value.trim();
    if (trimmed === "") {
      setError("ID cannot be empty");
      return;
    }
    if (existingIds.includes(trimmed)) {
      setError(`Task "${trimmed}" already exists`);
      return;
    }
    setId(trimmed);
    setError(null);
    setStep("type");
  };

  if (step === "id") {
    return (
      <Box flexDirection="column">
        <Text bold>New Task</Text>
        <Box>
          <Text>Task ID: </Text>
          <TextInput value={id} onChange={setId} onSubmit={handleIdSubmit} />
        </Box>
        {error && <Text color="red">{error}</Text>}
        <Text dimColor>Escape to cancel</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold>New Task: {id}</Text>
      <Text>Select type:</Text>
      <TypeSelector onSelect={(type) => onConfirm(id, type)} />
      <Text dimColor>Escape to cancel</Text>
    </Box>
  );
}

function TypeSelector({ onSelect }: { onSelect: (type: "agent" | "chat") => void }) {
  const [selected, setSelected] = useState(0);
  const options: Array<"agent" | "chat"> = ["agent", "chat"];

  useInput((input, key) => {
    if (key.upArrow || key.downArrow) {
      setSelected((s) => (s === 0 ? 1 : 0));
    } else if (key.return) {
      onSelect(options[selected]);
    }
  });

  return (
    <Box flexDirection="column">
      {options.map((opt, i) => (
        <Text key={opt} color={i === selected ? "cyan" : undefined} bold={i === selected}>
          {i === selected ? "> " : "  "}{opt}
        </Text>
      ))}
    </Box>
  );
}
```

**Step 2: Update App to use NewTaskPrompt**

In `src/tui/app.tsx`, add the `newTask` view state and import the `NewTaskPrompt` component. Update `handleNewTask` to switch to the `newTask` view instead of auto-generating. Add the `NewTaskPrompt` render in the return JSX when `view === "newTask"`.

**Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`

Expected: No errors.

**Step 4: Commit**

```bash
git add src/tui/components/NewTaskPrompt.tsx src/tui/app.tsx
git commit -m "feat: add NewTaskPrompt for guided task creation"
```

---

## Task 12: Add SubList Component for List Fields

Handles editing `memory.context`, `mcpTools`, and `mcpServers` arrays.

**Files:**

- Create: `src/tui/components/SubList.tsx`
- Modify: `src/tui/components/TaskDetail.tsx` (wire SubList into list fields)

**Step 1: Implement SubList**

Create `src/tui/components/SubList.tsx`:

```tsx
import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";

interface SubListProps {
  label: string;
  items: string[];
  onChange: (items: string[]) => void;
  onBack: () => void;
}

export function SubList({ label, items, onChange, onBack }: SubListProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [adding, setAdding] = useState(false);
  const [newValue, setNewValue] = useState("");

  useInput((input, key) => {
    if (adding) return;

    if (key.escape) {
      onBack();
    } else if (key.upArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1));
    } else if (key.downArrow) {
      setSelectedIndex((i) => Math.min(items.length - 1, i + 1));
    } else if (input === "a") {
      setAdding(true);
      setNewValue("");
    } else if (input === "d" && items.length > 0) {
      const next = [...items];
      next.splice(selectedIndex, 1);
      onChange(next);
      setSelectedIndex(Math.min(selectedIndex, next.length - 1));
    } else if (input === "j" && selectedIndex < items.length - 1) {
      const next = [...items];
      [next[selectedIndex], next[selectedIndex + 1]] = [next[selectedIndex + 1], next[selectedIndex]];
      onChange(next);
      setSelectedIndex(selectedIndex + 1);
    } else if (input === "k" && selectedIndex > 0) {
      const next = [...items];
      [next[selectedIndex], next[selectedIndex - 1]] = [next[selectedIndex - 1], next[selectedIndex]];
      onChange(next);
      setSelectedIndex(selectedIndex - 1);
    }
  });

  const handleAddSubmit = (value: string) => {
    if (value.trim()) {
      onChange([...items, value.trim()]);
    }
    setAdding(false);
  };

  return (
    <Box flexDirection="column">
      <Text bold>{label}</Text>

      {items.length === 0 && !adding && (
        <Text dimColor>Empty. Press a to add.</Text>
      )}

      {items.map((item, i) => {
        const selected = i === selectedIndex;
        return (
          <Box key={i}>
            <Text color={selected ? "cyan" : undefined} bold={selected}>
              {selected ? "> " : "  "}{item}
            </Text>
          </Box>
        );
      })}

      {adding && (
        <Box>
          <Text color="green">+ </Text>
          <TextInput
            value={newValue}
            onChange={setNewValue}
            onSubmit={handleAddSubmit}
          />
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>
          a add  d delete  j/k reorder  Escape back
        </Text>
      </Box>
    </Box>
  );
}
```

**Step 2: Wire SubList into TaskDetail for list fields**

In `src/tui/components/TaskDetail.tsx`, add state for `editingList` and render `SubList` when a list field is selected and Enter is pressed. The SubList's `onChange` calls `onUpdate` with the modified array.

**Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`

Expected: No errors.

**Step 4: Commit**

```bash
git add src/tui/components/SubList.tsx src/tui/components/TaskDetail.tsx
git commit -m "feat: add SubList component for list field editing"
```

---

## Task 13: Run Full Test Suite and Integration Smoke Test

**Step 1: Run all unit tests**

Run: `bun test`

Expected: All tests pass.

**Step 2: Build**

Run: `bun build src/index.ts --outdir dist --target bun`

Expected: Build succeeds.

**Step 3: Integration smoke test**

Run: `bun run dist/index.js churn`

Test manually:

- Task list displays with existing tasks
- Arrow keys navigate
- Enter drills into task detail
- Escape returns to list
- `n` opens new task prompt
- `d` shows delete confirmation
- `:` opens command mode
- `:w` saves
- `q` quits

**Step 4: Fix any issues found**

Address any type errors, runtime errors, or UX issues.

**Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix: address integration test issues"
```

---

## Task 14: Final Build Verification

**Step 1: Type check**

Run: `npx tsc --noEmit`

Expected: No errors.

**Step 2: Run all tests**

Run: `bun test`

Expected: All pass.

**Step 3: Full build**

Run: `bun build src/index.ts --outdir dist --target bun`

Expected: Build succeeds.

**Step 4: Compile standalone binary**

Run: `bun build src/index.ts --compile --outfile tony`

Expected: Binary created.

**Step 5: Test binary**

Run: `./tony churn`

Expected: TUI launches correctly.

**Step 6: Commit**

```bash
git add -A
git commit -m "chore: final build verification for tony churn"
```
