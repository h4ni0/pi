import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { EXTENSION_KEY, SUBAGENTS_GLOBAL_STATUS_KEY } from "./constants.ts";
import type { GlobalSubagentsStatus, RpcEvent, RpcEventSummary } from "./types.ts";
import { argsSummary, extractMessageText, now, oneLine, stripAnsi } from "./utils.ts";

export function globalSubagentsStatus(): GlobalSubagentsStatus {
  const root = globalThis as any;
  root[SUBAGENTS_GLOBAL_STATUS_KEY] ??= {
    running: 0,
    total: 0,
    waiting: 0,
    nested: 0,
    updatedAt: 0,
    listeners: new Set<() => void>(),
  };
  root[SUBAGENTS_GLOBAL_STATUS_KEY].listeners ??= new Set<() => void>();
  return root[SUBAGENTS_GLOBAL_STATUS_KEY] as GlobalSubagentsStatus;
}

export function parseSubagentStatusCount(text: unknown): number {
  if (typeof text !== "string") return 0;
  const clean = stripAnsi(text);
  const total = Number(clean.match(/agents\s+\d+\/(\d+)\s+running/i)?.[1] ?? 0);
  const nested = Number(clean.match(/(\d+)\s+nested/i)?.[1] ?? 0);
  if (Number.isFinite(total) || Number.isFinite(nested))
    return (
      (Number.isFinite(total) ? total : 0) +
      (Number.isFinite(nested) ? nested : 0)
    );
  return 0;
}

export function formatCwdForDisplay(cwd: string): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return cwd;
  const resolvedCwd = path.resolve(cwd);
  const resolvedHome = path.resolve(home);
  const relative = path.relative(resolvedHome, resolvedCwd);
  const insideHome =
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative));
  return insideHome ? (relative === "" ? "~" : `~${path.sep}${relative}`) : cwd;
}

export function usageTotals(ctx: ExtensionContext | undefined): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
} {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const entry of ctx?.sessionManager.getEntries() ?? []) {
    const message =
      (entry as any).type === "message" ? (entry as any).message : undefined;
    if (message?.role !== "assistant" || !message.usage) continue;
    totals.input += Number(message.usage.input ?? 0);
    totals.output += Number(message.usage.output ?? 0);
    totals.cacheRead += Number(message.usage.cacheRead ?? 0);
    totals.cacheWrite += Number(message.usage.cacheWrite ?? 0);
    totals.cost += Number(message.usage.cost?.total ?? message.usage.cost ?? 0);
  }
  return totals;
}

export function summarizeRpcEvent(event: RpcEvent): RpcEventSummary {
  const base: RpcEventSummary = {
    type: event.type ?? "unknown",
    timestamp: now(),
  };
  if (event.type === "extension_ui_request") {
    if (event.method === "setStatus" && event.statusKey === EXTENSION_KEY)
      base.text = oneLine(stripAnsi(event.statusText ?? ""), 220);
    if (event.method === "notify")
      base.text = oneLine(event.message ?? "notification", 220);
  }
  if (event.type === "message_end") {
    base.text = oneLine(extractMessageText(event.message), 260);
  }
  if (
    event.type === "tool_execution_start" ||
    event.type === "tool_execution_update" ||
    event.type === "tool_execution_end"
  ) {
    base.toolName = event.toolName;
    base.toolCallId = event.toolCallId;
    base.args = event.args;
    base.text = argsSummary(event.args);
    base.isError = event.isError === true;
    const result = event.result ?? event.partialResult;
    if (event.toolName === "delegate" && result?.details)
      base.delegateDetails = result.details;
  }
  if (event.type === "agent_start") base.text = "started";
  if (event.type === "agent_end") base.text = "finished";
  if (event.type === "process_exit" || event.type === "process_error") {
    base.text = oneLine(event.error ?? event.type, 260);
    base.isError = true;
  }
  if (event.type === "extension_error") {
    base.text = oneLine(event.error ?? "extension error", 220);
    base.isError = true;
  }
  return base;
}
