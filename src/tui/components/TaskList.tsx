import React from "react";
import { Box, Text, useInput } from "ink";
import type { Instructions, Task } from "../../instructions.js";

export interface TaskListProps {
  instructions: Instructions;
  dirty: boolean;
  onSelectTask: (task: Task) => void;
  onNewTask: () => void;
  onDeleteTask: (task: Task) => void;
  onCommandMode: () => void;
  onSave: () => void;
  onQuit: () => void;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "\u2026";
}

function getTaskInput(task: Task): string {
  if (task.type === "agent") {
    return task.input ?? "";
  }
  return (task as { prompt?: string }).prompt ?? "";
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
}: TaskListProps): React.ReactElement {
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const tasks = instructions.tasks;

  // Clamp selected index when tasks change
  React.useEffect(() => {
    if (selectedIndex >= tasks.length && tasks.length > 0) {
      setSelectedIndex(tasks.length - 1);
    }
  }, [tasks.length, selectedIndex]);

  useInput((input, key) => {
    if (confirmDelete) {
      if (input === "y" || input === "Y") {
        const task = tasks[selectedIndex];
        if (task) {
          onDeleteTask(task);
        }
        setConfirmDelete(false);
      } else {
        setConfirmDelete(false);
      }
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((i) => (i > 0 ? i - 1 : i));
    } else if (key.downArrow) {
      setSelectedIndex((i) => (i < tasks.length - 1 ? i + 1 : i));
    } else if (key.return) {
      const task = tasks[selectedIndex];
      if (task) {
        onSelectTask(task);
      }
    } else if (input === "n") {
      onNewTask();
    } else if (input === "d") {
      if (tasks.length > 0) {
        setConfirmDelete(true);
      }
    } else if (input === ":") {
      onCommandMode();
    } else if (input === "q") {
      onQuit();
    } else if (input === "s" && key.ctrl) {
      onSave();
    }
  });

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>
          Tony Churn {dirty ? <Text color="yellow">[unsaved]</Text> : null}
        </Text>
      </Box>

      {tasks.length === 0 ? (
        <Text dimColor>No tasks. Press n to create one.</Text>
      ) : (
        tasks.map((task, index) => {
          const isSelected = index === selectedIndex;
          const inputText = truncate(getTaskInput(task), 40);
          const model = task.model ?? instructions.defaultModel ?? "";
          return (
            <Box key={task.id}>
              <Text
                inverse={isSelected}
                color={isSelected ? "cyan" : undefined}
              >
                {isSelected ? "> " : "  "}
                {task.id.padEnd(20)} {task.type.padEnd(6)} {model.padEnd(30)}{" "}
                {inputText}
              </Text>
            </Box>
          );
        })
      )}

      {confirmDelete && tasks[selectedIndex] ? (
        <Box marginTop={1}>
          <Text color="red">
            Delete task "{tasks[selectedIndex].id}"? (y/n)
          </Text>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text dimColor>
          Up/Down: navigate | Enter: edit | n: new | d: delete | :: command | Ctrl+S: save | q: quit
        </Text>
      </Box>
    </Box>
  );
}
