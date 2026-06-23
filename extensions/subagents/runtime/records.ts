import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { EVENT_LOG_LIMIT, EXTENSION_KEY } from "../constants.ts";
import type {
  DelegateDetails,
  LiveDelegateUpdater,
  RpcEvent,
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

export function removeActiveWhenSettled(
  state: SubagentRuntimeState,
  record: SubagentRecord,
) {
  if (!["completed", "failed", "aborted"].includes(record.status)) return;
  clearInterval(record.bridgeTimer);
  state.active.delete(record.id);
  updateStatus(state);
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
    else record.events.push(summary);
    if (record.events.length > EVENT_LOG_LIMIT)
      record.events.splice(0, record.events.length - EVENT_LOG_LIMIT);
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

export function handleRpcEvent(
  state: SubagentRuntimeState,
  record: SubagentRecord,
  event: RpcEvent,
) {
  pushEvent(record, event);
  if (
    event.type === "extension_ui_request" &&
    event.method === "setStatus" &&
    event.statusKey === EXTENSION_KEY
  ) {
    record.nestedActiveCount = parseSubagentStatusCount(event.statusText);
  }
  switch (event.type) {
    case "agent_start":
      record.status = "running";
      record.startedAt ??= now();
      break;
    case "agent_end":
      if (record.status !== "aborted" && record.status !== "failed")
        record.status = "completed";
      record.endedAt = now();
      break;
    case "extension_error":
      record.error = oneLine(event.error ?? "child extension error", 500);
      break;
  }
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
    maxDepth: currentSettings.maxDepth,
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
      const t = now();
      if (!force && t - last < 500) return;
      last = t;
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

export async function sendToChild(
  record: SubagentRecord,
  message: string,
): Promise<string> {
  if (!record.client) throw new Error(`sub-agent ${record.id} is not connected`);
  const state = await record.client.getState().catch(() => undefined);
  if (state?.isStreaming) await record.client.steer(message);
  else await record.client.prompt(message);
  record.events.push({
    type: "parent_steer",
    timestamp: now(),
    text: oneLine(message, 220),
  });
  return `Sent steering to ${record.id}.`;
}

export async function abortChild(
  state: SubagentRuntimeState,
  record: SubagentRecord,
): Promise<string> {
  if (record.client) {
    try {
      await record.client.abort();
    } catch {
      // process may already be gone
    }
    await record.client.stop().catch(() => undefined);
  }
  record.status = "aborted";
  record.endedAt = now();
  record.error = record.error ?? "Aborted by parent.";
  updateStatus(state);
  return `Aborted ${record.id}.`;
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
