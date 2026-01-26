#!/usr/bin/env bun

/**
 * Tony - A simple TypeScript application built with Bun
 * 
 * This is a template project demonstrating how to:
 * - Write TypeScript code
 * - Compile to a single binary using Bun
 * - Build using Make
 */

interface Config {
  appName: string;
  version: string;
}

const config: Config = {
  appName: "Tony",
  version: "1.0.0",
};

function greet(name: string): string {
  return `Hello, ${name}! Welcome to ${config.appName} v${config.version}`;
}

function main(): void {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log(greet("World"));
    console.log("\nUsage: tony [name]");
    console.log("  Greet someone by name\n");
    return;
  }

  if (args[0] === "--version" || args[0] === "-v") {
    console.log(`${config.appName} v${config.version}`);
    return;
  }

  if (args[0] === "--help" || args[0] === "-h") {
    console.log(`${config.appName} v${config.version}`);
    console.log("\nUsage: tony [options] [name]");
    console.log("\nOptions:");
    console.log("  -h, --help     Show this help message");
    console.log("  -v, --version  Show version information");
    console.log("\nExamples:");
    console.log("  tony              # Greet the world");
    console.log("  tony Alice        # Greet Alice");
    return;
  }

  console.log(greet(args.join(" ")));
}

// Run the application
main();
