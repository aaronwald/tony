# tony

Tool to capture my operations workflows into simpler repeatable prompts.

## Setup

Tony uses [@dotenvx/dotenvx](https://github.com/dotenvx/dotenvx) to load environment variables from a `.env` file.

Create a `.env` file in the project root:

```sh
OPENROUTER_API_KEY=sk-or-v1-your-key-here
```

Get an API key from [openrouter.ai](https://openrouter.ai).

## Usage

```sh
# Build the binary
bun compile

# Run tasks from instructions.json
./tony run

# Run a specific task
./tony run -t my-task-id

# Interactive TUI editor
./tony churn

# Run a command-mode command headlessly
./tony churn -c "Add a new task to check the temporal namespace"

# Run tests
bun test
```
