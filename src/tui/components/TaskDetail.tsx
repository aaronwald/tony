import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import type { Task } from "../../instructions.js";

export interface TaskDetailProps {
  task: Task;
  defaultModel?: string;
  changedFields?: Set<string>;
  onUpdate: (updates: Partial<Task>) => void;
  onBack: () => void;
  onCommandMode: () => void;
}

interface FieldDef {
  key: string;
  label: string;
  getValue: (task: Task) => string;
  setValue: (value: string) => Partial<Task> | null;
  isToggle?: boolean;
}

function getMemoryContext(task: Task): string {
  if (task.type === "agent") {
    return task.memory.context.join("; ");
  }
  const memory = (task as { memory?: { context?: string[] } }).memory;
  return memory?.context?.join("; ") ?? "";
}

function getMcpServers(task: Task): string {
  if (!task.mcpServers) return "";
  return task.mcpServers.map((s) => s.name).join(", ");
}

function getMcpTools(task: Task): string {
  if (!task.mcpTools) return "";
  return task.mcpTools.join(", ");
}

const FIELDS: FieldDef[] = [
  {
    key: "id",
    label: "ID",
    getValue: (t) => t.id,
    setValue: (v) => (v.trim() ? { id: v.trim() } : null),
  },
  {
    key: "type",
    label: "Type",
    getValue: (t) => t.type,
    setValue: (_v) => null, // handled by toggle
    isToggle: true,
  },
  {
    key: "model",
    label: "Model",
    getValue: (t) => t.model ?? "",
    setValue: (v) => ({ model: v.trim() || undefined }),
  },
  {
    key: "input",
    label: "Input",
    getValue: (t) =>
      t.type === "agent" ? t.input ?? "" : (t as { prompt?: string }).prompt ?? "",
    setValue: (v) => ({ input: v } as Partial<Task>),
  },
  {
    key: "outcome",
    label: "Outcome",
    getValue: (t) => {
      if (t.type === "agent") return t.outcome ?? "";
      return (t as { outcome?: string }).outcome ?? "";
    },
    setValue: (v) => ({ outcome: v || undefined } as Partial<Task>),
  },
  {
    key: "memory.context",
    label: "Memory Context",
    getValue: (t) => getMemoryContext(t),
    setValue: (v) => {
      const ctx = v
        .split(";")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      return { memory: { context: ctx, history: [] } } as Partial<Task>;
    },
  },
  {
    key: "mcpServers",
    label: "MCP Servers",
    getValue: (t) => getMcpServers(t),
    setValue: (_v) => null, // read-only display
  },
  {
    key: "mcpTools",
    label: "MCP Tools",
    getValue: (t) => getMcpTools(t),
    setValue: (v) => {
      const tools = v
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      return { mcpTools: tools.length > 0 ? tools : undefined } as Partial<Task>;
    },
  },
  {
    key: "temperature",
    label: "Temperature",
    getValue: (t) => (t.temperature !== undefined ? String(t.temperature) : ""),
    setValue: (v) => {
      if (v.trim() === "") return { temperature: undefined } as Partial<Task>;
      const n = parseFloat(v);
      if (isNaN(n) || n < 0 || n > 2) return null;
      return { temperature: n } as Partial<Task>;
    },
  },
  {
    key: "max_tokens",
    label: "Max Tokens",
    getValue: (t) => (t.max_tokens !== undefined ? String(t.max_tokens) : ""),
    setValue: (v) => {
      if (v.trim() === "") return { max_tokens: undefined } as Partial<Task>;
      const n = parseInt(v, 10);
      if (isNaN(n) || n < 1 || n > 128000) return null;
      return { max_tokens: n } as Partial<Task>;
    },
  },
  {
    key: "seed",
    label: "Seed",
    getValue: (t) => (t.seed !== undefined ? String(t.seed) : ""),
    setValue: (v) => {
      if (v.trim() === "") return { seed: undefined } as Partial<Task>;
      const n = parseInt(v, 10);
      if (isNaN(n)) return null;
      return { seed: n } as Partial<Task>;
    },
  },
];

export function TaskDetail({
  task,
  defaultModel,
  changedFields,
  onUpdate,
  onBack,
  onCommandMode,
}: TaskDetailProps): React.ReactElement {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");

  const currentField = FIELDS[selectedIndex];

  useInput(
    (input, key) => {
      if (editing) return;

      if (key.escape) {
        onBack();
      } else if (key.upArrow) {
        setSelectedIndex((i) => (i > 0 ? i - 1 : i));
      } else if (key.downArrow) {
        setSelectedIndex((i) => (i < FIELDS.length - 1 ? i + 1 : i));
      } else if (key.return && currentField) {
        if (currentField.isToggle) {
          // Toggle type between agent and chat
          const newType = task.type === "agent" ? "chat" : "agent";
          if (newType === "agent") {
            onUpdate({
              type: "agent",
              memory: { context: [], history: [] },
              input: (task as { prompt?: string }).prompt ?? "",
            } as Partial<Task>);
          } else {
            onUpdate({
              type: "chat",
              prompt: task.type === "agent" ? task.input ?? "" : "",
              description: "",
            } as Partial<Task>);
          }
        } else {
          setEditValue(currentField.getValue(task));
          setEditing(true);
        }
      } else if (input === ":") {
        onCommandMode();
      }
    },
    { isActive: !editing }
  );

  const handleEditSubmit = (value: string) => {
    if (currentField) {
      // Special handling for "input" field based on task type
      if (currentField.key === "input") {
        if (task.type === "agent") {
          onUpdate({ input: value } as Partial<Task>);
        } else {
          onUpdate({ prompt: value } as Partial<Task>);
        }
      } else {
        const updates = currentField.setValue(value);
        if (updates) {
          onUpdate(updates);
        }
      }
    }
    setEditing(false);
  };

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>Task: {task.id}</Text>
        {defaultModel ? (
          <Text dimColor> (default model: {defaultModel})</Text>
        ) : null}
      </Box>

      {FIELDS.map((field, index) => {
        const isSelected = index === selectedIndex;
        const isChanged = changedFields?.has(field.key) ?? false;
        const value = field.getValue(task);
        const isEditingThis = editing && isSelected;

        return (
          <Box key={field.key}>
            <Text
              inverse={isSelected && !isEditingThis}
              color={isChanged ? "yellow" : isSelected ? "cyan" : undefined}
            >
              {isSelected ? "> " : "  "}
              {field.label.padEnd(16)}
            </Text>
            {isEditingThis ? (
              <TextInput
                value={editValue}
                onChange={setEditValue}
                onSubmit={handleEditSubmit}
              />
            ) : (
              <Text
                color={isChanged ? "yellow" : undefined}
              >
                {field.isToggle
                  ? `${value} (Enter to toggle)`
                  : value || "(empty)"}
              </Text>
            )}
          </Box>
        );
      })}

      <Box marginTop={1}>
        <Text dimColor>
          Up/Down: navigate | Enter: edit | Escape: back | :: command
        </Text>
      </Box>
    </Box>
  );
}
