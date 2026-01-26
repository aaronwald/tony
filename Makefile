# Tony - TypeScript + Bun Build System

.PHONY: all build clean run install help

# Binary name
BINARY_NAME = tony

# Default target
all: build

# Install dependencies
install:
	@echo "Installing dependencies..."
	@bun install

# Build the single binary executable
build:
	@echo "Building $(BINARY_NAME) binary..."
	@bun build src/index.ts --compile --outfile $(BINARY_NAME)
	@echo "Build complete: ./$(BINARY_NAME)"

# Run the application in development mode
run:
	@bun run src/index.ts

# Run in watch mode for development
dev:
	@bun --watch src/index.ts

# Clean build artifacts
clean:
	@echo "Cleaning build artifacts..."
	@rm -f $(BINARY_NAME)
	@rm -rf node_modules
	@echo "Clean complete"

# Show help
help:
	@echo "Tony - TypeScript + Bun Build System"
	@echo ""
	@echo "Available targets:"
	@echo "  make install  - Install dependencies"
	@echo "  make build    - Build single binary executable"
	@echo "  make run      - Run application in development mode"
	@echo "  make dev      - Run with file watching"
	@echo "  make clean    - Remove build artifacts"
	@echo "  make help     - Show this help message"
	@echo ""
	@echo "Quick start:"
	@echo "  1. make install"
	@echo "  2. make build"
	@echo "  3. ./$(BINARY_NAME)"
