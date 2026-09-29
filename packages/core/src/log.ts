import type { LogEntry } from "./types";

/** One provenance line. Every node returns at least one of these. */
export function logEntry(node: string, extra: Omit<LogEntry, "node" | "at"> = {}): LogEntry {
  return { node, at: new Date().toISOString(), ...extra };
}

export function totalCost(log: LogEntry[]): number {
  return log.reduce((sum, e) => sum + (e.costUsd ?? 0), 0);
}
