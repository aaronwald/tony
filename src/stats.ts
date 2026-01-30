import { appendFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import type { AuditContext } from "./audit.js";

const statsPath = resolve(process.cwd(), "stats.csv");
const HEADER = "timestamp,runId,taskId,taskRunId,model,promptTokens,completionTokens,totalTokens,cost\n";
let initialized = false;

export type StatsEntry = {
  timestamp: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cost?: number;
  context?: AuditContext;
};

async function ensureHeader(): Promise<void> {
  if (initialized) {
    return;
  }
  try {
    await access(statsPath);
  } catch {
    await appendFile(statsPath, HEADER);
  }
  initialized = true;
}

function csvValue(value: string | number | undefined): string {
  if (value === undefined || value === null) {
    return "";
  }
  const str = String(value);
  if (str.includes(",") || str.includes("\n") || str.includes("\"")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export async function appendStats(entry: StatsEntry): Promise<void> {
  await ensureHeader();
  const runId = entry.context?.runId;
  const taskId = entry.context?.taskId;
  const taskRunId = entry.context?.taskRunId;
  const line = [
    entry.timestamp,
    runId,
    taskId,
    taskRunId,
    entry.model,
    entry.promptTokens,
    entry.completionTokens,
    entry.totalTokens,
    entry.cost,
  ]
    .map(csvValue)
    .join(",");
  await appendFile(statsPath, `${line}\n`);
}
