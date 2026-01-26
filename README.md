# Tony

A template TypeScript project using [Bun](https://bun.sh) to compile to a single binary executable.

## Features

- 🚀 **TypeScript** - Full TypeScript support with strict type checking
- ⚡ **Bun** - Fast JavaScript runtime and toolkit
- 📦 **Single Binary** - Compiles to a standalone executable
- 🔧 **Makefile** - Simple build system with Make
- 🎯 **Zero Config** - Works out of the box

## Prerequisites

- [Bun](https://bun.sh) installed on your system
- Make (usually pre-installed on Unix systems)

## Quick Start

```bash
# Install dependencies
make install

# Build the binary
make build

# Run the binary
./tony
```

## Development

```bash
# Run in development mode
make run

# Run with file watching (auto-reload on changes)
make dev
```

## Build Commands

The project uses a Makefile for building. Available commands:

- `make install` - Install dependencies
- `make build` - Build single binary executable
- `make run` - Run application in development mode
- `make dev` - Run with file watching
- `make clean` - Remove build artifacts
- `make help` - Show help message

## Project Structure

```
.
├── src/
│   └── index.ts       # Main application entry point
├── Makefile           # Build system
├── package.json       # Project dependencies
├── tsconfig.json      # TypeScript configuration
└── README.md          # This file
```

## How It Works

This project uses Bun's built-in compiler to create a single binary:

1. **Development**: Bun runs TypeScript directly without compilation
2. **Production**: `bun build --compile` bundles everything into a single executable
3. **Distribution**: The binary includes the Bun runtime and all code

The resulting binary can be distributed and run on any compatible system without requiring Bun or Node.js to be installed.

## Customization

### Modifying the Application

Edit `src/index.ts` to customize the application logic.

### Build Options

The build command in the Makefile can be customized:

```makefile
bun build src/index.ts --compile --outfile tony
```

Add additional flags as needed:
- `--minify` - Minify the output
- `--target=bun` - Target specific runtime
- `--sourcemap` - Generate source maps

## License

See [LICENSE](LICENSE) file for details.
