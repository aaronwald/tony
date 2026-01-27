export interface MemoryEntry {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface MemoryConfig {
  context: string[];
  history: MemoryEntry[];
}

export class Memory {
  private context: string[];
  private history: MemoryEntry[];

  constructor(config: MemoryConfig) {
    this.context = [...config.context];
    this.history = [...config.history];
  }

  getContext(): readonly string[] {
    return this.context;
  }

  getHistory(): readonly MemoryEntry[] {
    return this.history;
  }

  append(entry: MemoryEntry): void {
    this.history.push(entry);
  }

  appendUser(content: string): void {
    this.append({ role: "user", content });
  }

  appendAssistant(content: string): void {
    this.append({ role: "assistant", content });
  }

  getLastEntry(): MemoryEntry | undefined {
    return this.history[this.history.length - 1];
  }

  hasUserMessage(): boolean {
    return this.history.some((e) => e.role === "user");
  }

  endsWithUserMessage(): boolean {
    const last = this.getLastEntry();
    return last?.role === "user";
  }

  toConfig(): MemoryConfig {
    return {
      context: [...this.context],
      history: [...this.history],
    };
  }

  clear(): void {
    this.history = [];
  }
}

export function createMemory(config: MemoryConfig): Memory {
  return new Memory(config);
}
