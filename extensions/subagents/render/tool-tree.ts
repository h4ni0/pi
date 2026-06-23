import type { Theme } from "@earendil-works/pi-coding-agent";
import type { RpcEventSummary, SubagentRecord } from "../types.ts";
import { generatedLabel, oneLine } from "../utils.ts";
import { LAST_TOOL_CALL_COUNT } from "./common.ts";
import { activityEvents, eventLabel } from "./events.ts";

function argsObject(event: RpcEventSummary): Record<string, any> {
  if (event.args && typeof event.args === "object")
    return event.args as Record<string, any>;
  if (event.text) {
    try {
      const parsed = JSON.parse(event.text);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // fall through
    }
  }
  return {};
}

function toolLabel(name: string): string {
  const labels: Record<string, string> = {
    bash: "Bash",
    read: "Read",
    write: "Write",
    edit: "Edit",
    grep: "Grep",
    find: "Find",
    ls: "Ls",
    delegate: "Delegate",
  };
  return labels[name] ?? `${name.slice(0, 1).toUpperCase()}${name.slice(1)}`;
}

function toolValue(event: RpcEventSummary, limit: number): string {
  const args = argsObject(event);
  const name = event.toolName ?? "tool";
  const path = args.path ?? args.file_path;
  if (name === "read") {
    let suffix = "";
    if (args.offset !== undefined || args.limit !== undefined) {
      const start = args.offset ?? 1;
      const end = args.limit !== undefined ? start + args.limit - 1 : "";
      suffix = `:${start}${end ? `-${end}` : ""}`;
    }
    return oneLine(`${path ?? ""}${suffix}`.trim(), limit);
  }
  if (name === "write" || name === "edit") return oneLine(String(path ?? ""), limit);
  if (name === "bash") return oneLine(String(args.command ?? ""), limit);
  if (name === "ls") return oneLine(String(path ?? "."), limit);
  if (name === "find") {
    const pattern = args.pattern ?? "*";
    return oneLine(path ? `${pattern} in ${path}` : String(pattern), limit);
  }
  if (name === "grep") {
    const pattern = args.pattern ?? "";
    return oneLine(path ? `/${pattern}/ in ${path}` : `/${pattern}/`, limit);
  }
  return event.text ? oneLine(event.text, limit) : "";
}

function delegateTitle(event: RpcEventSummary): string {
  const args = argsObject(event);
  const details = event.delegateDetails;
  return oneLine(
    String(details?.label ?? args.title ?? generatedLabel(String(args.task ?? "sub-agent"))),
    80,
  );
}

export function renderToolLine(
  event: RpcEventSummary,
  theme: Theme,
  textLimit = 150,
  prefix = "",
): string {
  const name = event.toolName ?? eventLabel(event);
  if (name === "delegate") {
    return `${theme.fg("dim", prefix)}${theme.fg("toolTitle", theme.bold("Delegate:"))} ${theme.fg("accent", delegateTitle(event))}`;
  }
  const value = toolValue(event, textLimit);
  const text = value ? `${toolLabel(name)}: ${value}` : toolLabel(name);
  return `${theme.fg("dim", prefix)}${theme.fg("dim", text)}`;
}

export function renderToolTree(
  events: RpcEventSummary[],
  theme: Theme,
  textLimit = 150,
  count = LAST_TOOL_CALL_COUNT,
  ancestors: boolean[] = [],
): string[] {
  const tools = activityEvents(events).slice(-count);
  const lines: string[] = [];
  for (let i = 0; i < tools.length; i++) {
    const event = tools[i];
    const isLast = i === tools.length - 1;
    const isDelegate = event.toolName === "delegate";
    const trunk = ancestors.map((last) => (last ? "   " : "│  ")).join("");
    const connector = isDelegate ? (isLast ? "└─ " : "├─ ") : ancestors.length ? "   " : "";
    lines.push(renderToolLine(event, theme, textLimit, `${trunk}${connector}`));
    const childEvents = event.delegateDetails?.events;
    if (isDelegate && Array.isArray(childEvents))
      lines.push(...renderToolTree(childEvents, theme, textLimit, count, [...ancestors, isLast]));
  }
  return lines;
}

export function renderActivityTail(
  record: SubagentRecord,
  theme: Theme,
  count = LAST_TOOL_CALL_COUNT,
  textLimit = 150,
): string[] {
  return renderToolTree(record.events, theme, textLimit, count);
}
