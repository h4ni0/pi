import type { Theme } from "@earendil-works/pi-coding-agent";
import type { RpcEventSummary } from "../types.ts";
import { formatDuration, now, oneLine } from "../utils.ts";

export function activityEvents(events: RpcEventSummary[]): RpcEventSummary[] {
  const tools = events.filter(
    (event) =>
      event.toolName &&
      (event.type === "tool_execution_start" || event.type === "tool_execution_end"),
  );
  const byId = new Map<string, number>();
  const out: RpcEventSummary[] = [];
  for (const event of tools) {
    const id = event.toolCallId;
    if (!id) {
      out.push(event);
      continue;
    }
    const previous = byId.get(id);
    if (previous === undefined) {
      byId.set(id, out.length);
      out.push(event);
      continue;
    }
    out[previous] = { ...out[previous], ...event, args: event.args ?? out[previous].args };
  }
  return out;
}

export function eventLabel(event: RpcEventSummary): string {
  switch (event.type) {
    case "agent_start":
      return "started";
    case "agent_end":
      return "finished";
    case "message_end":
      return "assistant";
    case "tool_execution_start":
      return event.toolName ?? "tool";
    case "tool_execution_end":
      return event.toolName ? `done ${event.toolName}` : "tool done";
    case "tool_execution_update":
      return event.toolName ? `update ${event.toolName}` : "tool update";
    case "parent_answer":
      return "parent answer";
    case "parent_steer":
      return "parent steer";
    case "extension_ui_request":
      return "notice";
    case "process_exit":
    case "process_error":
      return "process";
    default:
      return event.type.replace(/_/g, " ");
  }
}

export function renderEventLine(
  event: RpcEventSummary,
  theme: Theme,
  textLimit = 150,
): string {
  const age = formatDuration(now() - event.timestamp).padStart(5);
  const label = eventLabel(event);
  const color = event.isError
    ? "error"
    : event.type === "message_end"
      ? "toolOutput"
      : event.type.includes("tool")
        ? "accent"
        : "muted";
  const main = theme.fg(color as any, label.padEnd(14));
  const text = event.text ? ` ${theme.fg("dim", oneLine(event.text, textLimit))}` : "";
  return `${theme.fg("dim", age)}  ${main}${text}`;
}
