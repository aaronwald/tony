import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import type { Task, MCPServerConfig } from "../../instructions.js";
import { SubList } from "./SubList.js";

export interface TaskDetailProps {
  task: Task;
  defaultModel?: string;
  changedFields?: Set<string>;
  statusMessage?: string | null;
  statusColor?: "red" | "green" | "yellow";
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
  isList?: boolean;
}

function getMemoryContextList(task: Task): string[] {
  if (task.type === "agent") {
    return task.memory.context ?? [];
  }
  const memory = (task as { memory?: { context?: string[] } }).memory;
  return memory?.context ?? [];
}

function getMemoryHistoryList(task: Task): string[] {
  const history = task.type === "agent"
    ? task.memory.history ?? []
    : (task as { memory?: { history?: Array<{ role: string; content: string }> } }).memory?.history ?? [];
  return history.map((entry) => `${entry.role}: ${entry.content.replace(/\n/g, "\\n")}`);
}

function parseMemoryHistory(items: string[]): Array<{ role: "user" | "assistant" | "system"; content: string }> {
  const validRoles = new Set(["user", "assistant", "system"] as const);
  const parsed: Array<{ role: "user" | "assistant" | "system"; content: string }> = [];
  for (const item of items) {
    const splitIndex = item.indexOf(":");
    if (splitIndex <= 0) {
      continue;
    }
    const role = item.slice(0, splitIndex).trim() as "user" | "assistant" | "system";
    if (!validRoles.has(role)) {
      continue;
    }
    const content = item.slice(splitIndex + 1).trim().replace(/\\n/g, "\n");
    parsed.push({ role, content });
  }
  return parsed;
}

function getMcpServerNames(task: Task): string[] {
  if (!task.mcpServers) return [];
  return task.mcpServers.map((s) => s.name).filter(Boolean);
}

function getMcpToolsList(task: Task): string[] {
  if (!task.mcpTools) return [];
  return task.mcpTools;
}

function getFieldsForTask(task: Task): FieldDef[] {
  const fields: FieldDef[] = [
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
  ];

  if (task.type === "agent") {
    fields.push({
      key: "input",
      label: "Input",
      getValue: (t) => (t.type === "agent" ? t.input ?? "" : ""),
      setValue: (v) => ({ input: v } as Partial<Task>),
    });
  } else {
    fields.push(
      {
        key: "prompt",
        label: "Prompt",
        getValue: (t) => (t.type === "chat" ? t.prompt ?? "" : ""),
        setValue: (v) => ({ prompt: v } as Partial<Task>),
      },
      {
        key: "description",
        label: "Description",
        getValue: (t) => (t.type === "chat" ? t.description ?? "" : ""),
        setValue: (v) => ({ description: v } as Partial<Task>),
      }
    );
  }

  fields.push(
    {
      key: "outcome",
      label: "Outcome",
      getValue: (t) => t.outcome ?? "",
      setValue: (v) => ({ outcome: v || undefined } as Partial<Task>),
    },
    {
      key: "memory.context",
      label: "Memory Context",
      getValue: (t) => getMemoryContextList(t).join(", "),
      setValue: (_v) => null,
      isList: true,
    },
    {
      key: "memory.history",
      label: "Memory History",
      getValue: (t) => {
        const count = getMemoryHistoryList(t).length;
        return count > 0 ? `[${count} items]` : "";
      },
      setValue: (_v) => null,
      isList: true,
    },
    {
      key: "mcpServers",
      label: "MCP Servers",
      getValue: (t) => getMcpServerNames(t).join(", "),
      setValue: (_v) => null,
      isList: true,
    },
    {
      key: "mcpTools",
      label: "MCP Tools",
      getValue: (t) => getMcpToolsList(t).join(", "),
      setValue: (_v) => null,
      isList: true,
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
      key: "top_p",
      label: "Top P",
      getValue: (t) => (t.top_p !== undefined ? String(t.top_p) : ""),
      setValue: (v) => {
        if (v.trim() === "") return { top_p: undefined } as Partial<Task>;
        const n = parseFloat(v);
        if (isNaN(n) || n < 0 || n > 1) return null;
        return { top_p: n } as Partial<Task>;
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
    }
  );

  return fields;
}

function isFieldChanged(fieldKey: string, changedFields?: Set<string>): boolean {
  if (!changedFields) return false;
  if (changedFields.has(fieldKey)) return true;
  const base = fieldKey.split(".")[0];
  return changedFields.has(base);
}

function buildMcpServers(names: string[], existing?: MCPServerConfig[]): MCPServerConfig[] | undefined {
  if (names.length === 0) return undefined;
  const existingByName = new Map((existing ?? []).map((s) => [s.name, s]));
  return names.map((name) => existingByName.get(name) ?? { name });
}

export function TaskDetail({
  task,
  defaultModel,
  changedFields,
  statusMessage,
  statusColor,
  onUpdate,
  onBack,
  onCommandMode,
}: TaskDetailProps): React.ReactElement {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [listKey, setListKey] = useState<"memory.context" | "memory.history" | "mcpTools" | "mcpServers" | null>(null);

  const fields = getFieldsForTask(task);
  const currentField = fields[selectedIndex];

  useInput(
    (input, key) => {
      if (listKey) return;
      if (editing) return;

      if (key.escape) {
        onBack();
      } else if (key.upArrow) {
        setSelectedIndex((i) => (i > 0 ? i - 1 : i));
      } else if (key.downArrow) {
        setSelectedIndex((i) => (i < fields.length - 1 ? i + 1 : i));
      } else if (key.return && currentField) {
        if (currentField.isToggle) {
          // Toggle type between agent and chat
          const newType = task.type === "agent" ? "chat" : "agent";
          if (newType === "agent") {
            onUpdate({
              type: "agent",
              memory: task.memory ?? { context: [], history: [] },
              input: task.type === "chat" ? task.prompt ?? "" : task.input ?? "",
              prompt: undefined,
              description: undefined,
            } as Partial<Task>);
          } else {
            onUpdate({
              type: "chat",
              prompt: task.type === "agent" ? task.input ?? "" : task.prompt ?? "",
              description: task.type === "agent" ? "" : task.description ?? "",
              tool: undefined,
              input: undefined,
            } as Partial<Task>);
          }
        } else if (currentField.isList) {
          if (
            currentField.key === "memory.context" ||
            currentField.key === "memory.history" ||
            currentField.key === "mcpTools" ||
            currentField.key === "mcpServers"
          ) {
            setListKey(
              currentField.key as
                | "memory.context"
                | "memory.history"
                | "mcpTools"
                | "mcpServers"
            );
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
      const updates = currentField.setValue(value);
      if (updates) {
        onUpdate(updates);
      }
    }
    setEditing(false);
  };

  const listItems = listKey === "memory.context"
    ? getMemoryContextList(task)
    : listKey === "memory.history"
      ? getMemoryHistoryList(task)
      : listKey === "mcpTools"
        ? getMcpToolsList(task)
        : getMcpServerNames(task);

  return listKey ? (
    <SubList
      label={
        listKey === "memory.context"
          ? "Memory Context"
          : listKey === "memory.history"
            ? "Memory History"
            : listKey === "mcpTools"
              ? "MCP Tools"
              : "MCP Servers"
      }
      items={listItems}
      helpText={
        listKey === "memory.history"
          ? "Format: role: content (roles: user|assistant|system, use \\n for newlines)"
          : undefined
      }
      onChange={(nextItems) => {
        if (listKey === "memory.context") {
          const history = task.memory?.history ?? [];
          const nextMemory = { context: nextItems, history };
          onUpdate({ memory: nextMemory } as Partial<Task>);
        } else if (listKey === "memory.history") {
          const contextItems = task.memory?.context ?? [];
          const nextHistory = parseMemoryHistory(nextItems);
          const nextMemory = { context: contextItems, history: nextHistory };
          onUpdate({ memory: nextMemory } as Partial<Task>);
        } else if (listKey === "mcpTools") {
          onUpdate({ mcpTools: nextItems.length > 0 ? nextItems : undefined } as Partial<Task>);
        } else {
          onUpdate({ mcpServers: buildMcpServers(nextItems, task.mcpServers) } as Partial<Task>);
        }
      }}
      onBack={() => setListKey(null)}
    />
  ) : (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>Task: {task.id}</Text>
        {defaultModel ? (
          <Text dimColor> (default model: {defaultModel})</Text>
        ) : null}
      </Box>

      {statusMessage ? (
        <Box marginBottom={1}>
          <Text color={statusColor}>{statusMessage}</Text>
        </Box>
      ) : null}

      {fields.map((field, index) => {
        const isSelected = index === selectedIndex;
        const isChanged = isFieldChanged(field.key, changedFields);
        const value = field.getValue(task);
        const isEditingThis = editing && isSelected;
        const isList = field.isList;

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
                  : isList
                    ? (value || "(empty)") + " (Enter to edit)"
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
