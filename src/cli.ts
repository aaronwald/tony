export interface Command {
  name: string;
  description: string;
  action: (args: string[]) => void | Promise<void>;
}

export interface CLI {
  name: string;
  version: string;
  commands: Map<string, Command>;
}

export function createCLI(name: string, version: string): CLI {
  return {
    name,
    version,
    commands: new Map(),
  };
}

export function addCommand(cli: CLI, command: Command): void {
  cli.commands.set(command.name, command);
}

export function printHelp(cli: CLI): void {
  console.log(`${cli.name} v${cli.version}\n`);
  console.log("Usage:");
  console.log(`  ${cli.name} <command> [args]\n`);
  console.log("Commands:");
  for (const [name, cmd] of cli.commands) {
    console.log(`  ${name.padEnd(12)} ${cmd.description}`);
  }
  console.log(`  ${"help".padEnd(12)} Show this help message`);
}

export async function runCli(cli: CLI, argv: string[] = process.argv.slice(2)): Promise<void> {
  const [commandName, ...args] = argv;

  if (!commandName || commandName === "help" || commandName === "--help" || commandName === "-h") {
    printHelp(cli);
    return;
  }

  const command = cli.commands.get(commandName);
  if (!command) {
    console.error(`Unknown command: ${commandName}\n`);
    printHelp(cli);
    process.exitCode = 1;
    return;
  }

  await command.action(args);
}