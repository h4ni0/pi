import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { EVENT_LOG_LIMIT, EXTENSION_KEY } from "../constants.ts";
import type {
  DelegateDetails,
  LiveDelegateUpdater,
  RpcEvent,
  RpcEventSummary,
  SubagentRecord,
  SubagentSettings,
  UsageStats,
} from "../types.ts";
import {
  LAST_TOOL_CALL_COUNT,
  activityEvents,
  eventLabel,
} from "../render-utils.ts";
import { parseSubagentStatusCount, summarizeRpcEvent } from "../status.ts";
import { argsSummary, now, oneLine } from "../utils.ts";
import { updateStatus } from "./status-ui.ts";
import type { SubagentRuntimeState } from "./state.ts";

export function pushEventSummary(
  record: SubagentRecord,
  summary: RpcEventSummary,
): void {
  record.events.push(summary);
  if (record.events.length > EVENT_LOG_LIMIT)
    record.events.splice(0, record.events.length - EVENT_LOG_LIMIT);
}

export function pushEvent(record: SubagentRecord, event: RpcEvent) {
  if (event.type === "message_start") record.streamingMessageBuffer = "";
  if (event.type === "message_update") {
    const delta = event.assistantMessageEvent?.delta;
    if (typeof delta === "string" && delta) {
      record.streamingMessageBuffer = `${record.streamingMessageBuffer ?? ""}${delta}`.slice(-2_000);
      record.lastMessageSnippet = oneLine(record.streamingMessageBuffer, 260);
    }
    return;
  }

  if (event.type === "tool_execution_update" && !event.isError) {
    const summary = summarizeRpcEvent(event);
    if (summary.delegateDetails && summary.toolCallId) {
      const existing = record.events.find(
        (item) => item.toolCallId === summary.toolCallId,
      );
      if (existing) existing.delegateDetails = summary.delegateDetails;
    }
    return;
  }

  const summary = summarizeRpcEvent(event);
  const isStatusChatter =
    event.type === "extension_ui_request" &&
    event.method === "setStatus" &&
    event.statusKey === EXTENSION_KEY;
  if (!isStatusChatter) {
    const replaceIndex =
      summary.toolCallId &&
      (event.type === "tool_execution_end" || event.type === "tool_execution_update")
        ? record.events.findIndex((item) => item.toolCallId === summary.toolCallId)
        : -1;
    if (replaceIndex >= 0)
      record.events[replaceIndex] = {
        ...record.events[replaceIndex],
        ...summary,
        args: summary.args ?? record.events[replaceIndex].args,
        text:
          summary.text === "(unserializable args)"
            ? record.events[replaceIndex].text
            : summary.text,
      };
    else pushEventSummary(record, summary);
  }
  if (summary.text && event.type === "message_end") {
    record.lastMessageSnippet = summary.text;
    record.streamingMessageBuffer = undefined;
  }
  if (
    event.type === "tool_execution_start" ||
    event.type === "tool_execution_update" ||
    event.type === "tool_execution_end"
  ) {
    record.lastToolCall = {
      name: event.toolName ?? "tool",
      argsSummary: argsSummary(event.args),
      timestamp: now(),
    };
  }
}

/**
 * Compatibility event projector. agent_end is deliberately informational;
 * agent_settled is the only completion boundary.
 */
export function handleRpcEvent(
  state: SubagentRuntimeState,
  record: SubagentRecord,
  event: RpcEvent,
) {
  // Compatibility-only projection: lifecycle authority belongs to
  // reduceTurnLifecycle in turn-controller.ts.
  pushEvent(record, event);
  if (
    event.type === "extension_ui_request" &&
    event.method === "setStatus" &&
    event.statusKey === EXTENSION_KEY
  ) record.nestedActiveCount = parseSubagentStatusCount(event.statusText);
  updateStatus(state);
}

export function toDelegateDetails(
  record: SubagentRecord,
  currentSettings: SubagentSettings,
): DelegateDetails {
  return {
    id: record.id,
    label: record.generatedLabel,
    status: record.status,
    contextMode: record.contextMode,
    depth: record.depth,
    maxDepth: record.maxDepth ?? currentSettings.maxDepth,
    task: record.task,
    sessionFile: record.sessionFile,
    sessionDir: record.sessionDir,
    lastMessageSnippet: record.lastMessageSnippet,
    usage: record.usage,
    model: record.model,
    thinkingLevel: record.thinkingLevel,
    error: record.error,
    finalOutput: record.finalOutput,
    events: record.events.slice(-40),
  };
}

export function renderProgress(record: SubagentRecord): string {
  const parts = [`${record.id} ${record.status}`];
  for (const event of activityEvents(record.events).slice(-LAST_TOOL_CALL_COUNT))
    parts.push(`${eventLabel(event)}${event.text ? ` ${event.text}` : ""}`);
  if (parts.length === 1) parts.push("no tool calls yet");
  return parts.join("\n");
}

export function makeLiveUpdater(
  state: SubagentRuntimeState,
  record: SubagentRecord,
  onUpdate: AgentToolUpdateCallback<DelegateDetails> | undefined,
): LiveDelegateUpdater | undefined {
  if (!onUpdate) return undefined;
  let closed = false;
  let last = 0;
  return {
    notify(force = false) {
      if (closed) return;
      const timestamp = now();
      if (!force && timestamp - last < 500) return;
      last = timestamp;
      try {
        onUpdate({
          content: [{ type: "text", text: renderProgress(record) }],
          details: toDelegateDetails(record, state.settings),
        });
      } catch {
        closed = true;
      }
    },
    close() {
      closed = true;
    },
  };
}

export function usageFromStats(stats: any): UsageStats {
  return {
    input: stats.tokens?.input,
    output: stats.tokens?.output,
    total: stats.tokens?.total,
    cost: stats.cost,
    contextTokens: stats.contextUsage?.tokens,
    contextPercent: stats.contextUsage?.percent,
  };
}
