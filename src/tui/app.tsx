import React, { useState, useCallback } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { Instructions, Task } from "../instructions.js";
import {
  createInstructionsState,
  updateTask,
  addTask,
  deleteTask,
  undo,
  replaceInstructions,
  markSaved,
  reorderTask,
  type InstructionsState,
} from "./hooks/useInstructions.js";
import { saveInstructions, getFileMtime } from "./hooks/fileOps.js";
import { executeCommand } from "./hooks/useCommandMode.js";
import { TaskList } from "./components/TaskList.js";
import { TaskDetail } from "./components/TaskDetail.js";
import { CommandInput } from "./components/CommandInput.js";
import { NewTaskPrompt } from "./components/NewTaskPrompt.js";

type ViewState = "list" | "detail" | "command" | "newTask";

export interface AppProps {
  initialInstructions: Instructions;
  filePath: string;
  initialMtime: number;
}

export function App({
  initialInstructions,
  filePath,
  initialMtime,
}: AppProps): React.ReactElement {
  const { exit } = useApp();
  const [state, setState] = useState<InstructionsState>(() =>
    createInstructionsState(initialInstructions, filePath)
  );
  const [view, setView] = useState<ViewState>("list");
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [lastMtime, setLastMtime] = useState<number>(initialMtime);
  const [changedFields, setChangedFields] = useState<Set<string>>(new Set());
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [statusColor, setStatusColor] = useState<"red" | "green" | "yellow" | undefined>(undefined);

  // Command mode state
  const [cmdLoading, setCmdLoading] = useState(false);
  const [cmdResponse, setCmdResponse] = useState<string | null>(null);
  const [cmdError, setCmdError] = useState<string | null>(null);
  const [cmdChangedFields, setCmdChangedFields] = useState<string[]>([]);

  // Global keybindings: Ctrl+Z undo, Escape from newTask
  useInput((input, key) => {
    if (input === "z" && key.ctrl && view !== "command") {
      setState((s) => undo(s));
    }
    if (key.escape && view === "newTask") {
      setView("list");
    }
  });

  const handleSave = useCallback(() => {
    try {
      const currentMtime = getFileMtime(filePath);
      if (currentMtime > lastMtime) {
        setStatusMessage("File changed on disk. Save aborted (mtime conflict).");
        setStatusColor("red");
        return;
      }
    } catch {
      // File might not exist yet, that's fine
    }
    try {
      saveInstructions(filePath, state.instructions);
      setLastMtime(getFileMtime(filePath));
      setState((s) => markSaved(s));
      setStatusMessage("Saved");
      setStatusColor("green");
      setTimeout(() => setStatusMessage(null), 1500);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Save failed";
      setStatusMessage(message);
      setStatusColor("red");
    }
  }, [filePath, lastMtime, state.instructions]);

  const handleSelectTask = useCallback((task: Task) => {
    setSelectedTask(task);
    setChangedFields(new Set());
    setView("detail");
  }, []);

  const handleNewTask = useCallback(() => {
    setView("newTask");
  }, []);

  const handleDeleteTask = useCallback((task: Task) => {
    setState((s) => deleteTask(s, task.id));
  }, []);

  const handleReorderTask = useCallback((fromIndex: number, toIndex: number) => {
    setState((s) => reorderTask(s, fromIndex, toIndex));
  }, []);

  const handleCommandMode = useCallback(() => {
    setCmdResponse(null);
    setCmdError(null);
    setCmdChangedFields([]);
    setView("command");
  }, []);

  const handleQuit = useCallback(() => {
    exit();
  }, [exit]);

  const handleTaskUpdate = useCallback(
    (updates: Partial<Task>) => {
      if (!selectedTask) return;
      setState((s) => updateTask(s, selectedTask.id, updates));
      // Track changed fields
      const newChanged = new Set(changedFields);
      for (const key of Object.keys(updates)) {
        newChanged.add(key);
        if (key === "memory") {
          newChanged.add("memory.context");
        }
      }
      setChangedFields(newChanged);
      // Update the selected task reference
      setSelectedTask((prev) => (prev ? { ...prev, ...updates } as Task : null));
    },
    [selectedTask, changedFields]
  );

  const handleBack = useCallback(() => {
    setSelectedTask(null);
    setChangedFields(new Set());
    setView("list");
  }, []);

  const handleCommandSubmit = useCallback(
    async (command: string) => {
      // Handle :w as save shortcut
      if (command === "w") {
        handleSave();
        setView(selectedTask ? "detail" : "list");
        return;
      }
      // Handle :u as undo shortcut
      if (command === "u") {
        setState((s) => undo(s));
        setView(selectedTask ? "detail" : "list");
        return;
      }

      setCmdLoading(true);
      setCmdResponse(null);
      setCmdError(null);
      setCmdChangedFields([]);

      const scope = selectedTask ? "task" : "global";
      const context = {
        instructions: state.instructions,
        currentTask: selectedTask ?? undefined,
      };

      const result = await executeCommand(command, context, scope);

      setCmdLoading(false);

      if (result.error) {
        setCmdError(result.error);
        setCmdResponse(result.explanation || null);
        setCmdChangedFields(result.changedFields);
        return;
      }

      setCmdResponse(result.explanation);
      setCmdChangedFields(result.changedFields);

      if (result.instructions) {
        setState((s) => replaceInstructions(s, result.instructions!));
      }
      if (result.task && selectedTask) {
        setState((s) => updateTask(s, selectedTask.id, result.task as Partial<Task>));
        const newChanged = new Set<string>(result.changedFields);
        setChangedFields(newChanged);
        setSelectedTask(result.task);
      }

      // Return to previous view after brief display
      setTimeout(() => {
        setView(selectedTask ? "detail" : "list");
      }, 1500);
    },
    [state.instructions, selectedTask, handleSave]
  );

  const handleCommandCancel = useCallback(() => {
    setView(selectedTask ? "detail" : "list");
  }, [selectedTask]);

  // Refresh selected task from state when state changes
  const currentTask = selectedTask
    ? state.instructions.tasks.find((t) => t.id === selectedTask.id) ?? selectedTask
    : null;

  return (
    <Box flexDirection="column" padding={1}>
      {view === "list" && (
        <TaskList
          instructions={state.instructions}
          dirty={state.dirty}
          statusMessage={statusMessage}
          statusColor={statusColor}
          onSelectTask={handleSelectTask}
          onNewTask={handleNewTask}
          onDeleteTask={handleDeleteTask}
          onReorder={handleReorderTask}
          onCommandMode={handleCommandMode}
          onSave={handleSave}
          onQuit={handleQuit}
        />
      )}

      {view === "detail" && currentTask && (
        <TaskDetail
          task={currentTask}
          defaultModel={state.instructions.defaultModel}
          changedFields={changedFields}
          statusMessage={statusMessage}
          statusColor={statusColor}
          onUpdate={handleTaskUpdate}
          onBack={handleBack}
          onCommandMode={handleCommandMode}
        />
      )}

      {view === "command" && (
        <CommandInput
          onSubmit={handleCommandSubmit}
          onCancel={handleCommandCancel}
          loading={cmdLoading}
          response={cmdResponse}
          error={cmdError}
          changedFields={cmdChangedFields}
        />
      )}

      {view === "newTask" && (
        <NewTaskPrompt
          existingIds={state.instructions.tasks.map((t) => t.id)}
          onConfirm={(id, type) => {
            const newTask = type === "agent"
              ? { id, type: "agent" as const, memory: { context: [] as string[], history: [] as Array<{role: string; content: string}> } }
              : { id, type: "chat" as const, prompt: "", description: "" };
            try {
              setState((s) => addTask(s, newTask as any));
              setSelectedTask(newTask as any);
              setView("detail");
            } catch (e) {
              setView("list");
            }
          }}
          onCancel={() => setView("list")}
        />
      )}
    </Box>
  );
}
