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
      t.id === taskId ? ({ ...t, ...updates } as Task) : t
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
