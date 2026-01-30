# Tony Churn - Interactive Instructions Editor

## Overview

`tony churn` is a new subcommand that launches an interactive TUI for managing `instructions.json`. It provides a hybrid interface: a structured form for navigating and editing task fields, plus an LLM-powered command mode for natural language modifications.

## Goals

- Full CRUD operations on tasks in `instructions.json`
- Structured form-based navigation and editing
- LLM command mode for natural language edits
- Reuse existing OpenRouter integration for LLM calls

## Architecture

### Modes

**Form Mode** (default): A navigable view of tasks and their fields. Standard keyboard-driven navigation for browsing, selecting, and inline editing.

**Command Mode**: Activated by pressing `:`. A text input appears at the bottom of the screen. Natural language commands are sent to the LLM along with the current instructions state. The LLM returns modified JSON, which is applied in-memory and highlighted for review.

### File Structure

```
src/
  tui/
    app.tsx              # Root Ink component, mode switching
    components/
      TaskList.tsx       # Task browser/selector
      TaskDetail.tsx     # Single task field editor
      CommandInput.tsx   # Command mode input + LLM response
      FieldEditor.tsx    # Inline field editing
    hooks/
      useInstructions.ts # Load/save/mutate instructions state
      useCommandMode.ts  # LLM integration for command mode
  cli.ts                 # Register 'churn' subcommand
```

### Dependencies

- `ink` + `react` - TUI rendering
- `ink-text-input` - Text field editing
- All LLM calls, file I/O, and validation reuse existing code

## Form Mode

### Task List View

The default screen when `tony churn` launches. Displays a vertical list of all tasks from `instructions.json`.

Each row shows:
- Task ID (e.g., `fluxtask001`)
- Task type (`agent` / `chat`)
- Model name
- Truncated input (first ~60 chars)

Keybindings:
- `Up/Down` - Navigate tasks
- `Enter` - Drill into selected task (TaskDetail view)
- `n` - Create new task (prompts for ID and type, then opens TaskDetail)
- `d` - Delete selected task (with confirmation)
- `:` - Enter command mode
- `Ctrl+S` - Save to disk
- `q` - Quit (warns if unsaved changes)

### Task Detail View

Displays the selected task's fields as a vertical list of editable rows:

- `id` - string
- `type` - select: `agent` | `chat`
- `model` - string (with default from `defaultModel`)
- `input` - multiline text
- `outcome` - multiline text
- `memory.context` - list of strings
- `mcpServers` - list (names displayed, drill in to edit)
- `mcpTools` - list of strings
- `temperature`, `max_tokens`, `seed` - numbers

Keybindings:
- `Up/Down` - Navigate fields
- `Enter` - Edit selected field inline
- `Escape` - Back to task list
- `:` - Enter command mode (scoped to this task)

For multiline fields (`input`, `outcome`), pressing Enter opens a text area. For list fields (`memory.context`), an add/remove sub-menu appears.

## Command Mode

### Activation

Press `:` from either view. A prompt appears at the bottom of the screen.

### Context Scoping

- From **Task List view**: The LLM receives the full `instructions.json`. Commands operate on the whole file (e.g., "add a task that checks disk usage", "change the default model").
- From **Task Detail view**: The LLM receives just the current task's JSON. Commands operate on that task (e.g., "make the outcome more specific", "add a memory context").

### Flow

1. Type a natural language command, press `Enter`
2. The command + current state are sent to `createAssistantMessage` with a system prompt explaining the instructions schema
3. The LLM streams its response inline below the command input
4. The LLM returns modified JSON (in a code fence) plus an explanation of changes
5. The TUI parses the JSON, diffs against current state, applies changes in-memory
6. Form mode resumes with changed fields highlighted
7. Press `Escape` to dismiss highlights, or `:` for another command

### Error Handling

If the LLM returns invalid JSON or parsing fails, the TUI shows an error and keeps the previous state. The user can retry or edit manually.

### Model

Uses `defaultModel` from instructions, with a hardcoded fallback for reliability with structured JSON output.

## Data Flow & Persistence

### Loading

On launch, `tony churn` calls `loadInstructions()` from `src/instructions.ts` to read and validate `instructions.json`. The result becomes initial React state via `useInstructions` hook.

### In-Memory Mutations

All edits update React state. No automatic file writes. A `dirty` flag tracks unsaved changes.

### Saving

`Ctrl+S` or `:w` serializes state to JSON and writes to the original file path. Validation runs before writing. On success, the `dirty` flag clears and a "Saved" indicator appears briefly.

### Undo

A simple undo stack (array of previous states). Each mutation pushes prior state onto the stack. `Ctrl+Z` or `:u` pops and restores. No redo.

## Launch

Registered as a subcommand in `src/cli.ts`:

```
tony churn [options]
  -f, --file <path>    Load instructions from custom path (default: instructions.json)
```

## Decisions

| Decision | Choice |
|---|---|
| Primary goal | Edit instructions interactively |
| Interaction model | Hybrid: form + LLM command mode |
| Framework | Ink (React for CLI) |
| LLM integration | Reuse existing OpenRouter path |
| Operations | Full CRUD |
| Launch | `tony churn` subcommand |
| Persistence | Explicit save, undo stack |
