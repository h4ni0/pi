import type { SubagentRecord } from "../types.ts";
import { now } from "../utils.ts";

export function recordsToList(records: SubagentRecord[]): string {
  if (records.length === 0) return "No locally owned child sub-agents or retained UI history.";
  return records
    .map((record) =>
      JSON.stringify({
        id: record.id,
        name: record.agentName,
        taskName: record.taskName,
        label: record.generatedLabel,
        status: record.status,
        processState: record.processState,
        reusable: record.reusable,
        depth: record.depth,
        maxDepth: record.maxDepth,
        context: record.contextMode,
        turnId: record.currentTurnId,
        turnCount: record.turnCount,
        pendingMessages: record.mailbox.length,
        sharedWorkspace: true,
        elapsedMs: (record.endedAt ?? now()) - record.createdAt,
        lastToolCall: record.lastToolCall,
        lastMessageSnippet: record.lastMessageSnippet,
        model: record.model,
        thinkingLevel: record.thinkingLevel,
        nestedActiveCount: record.nestedActiveCount ?? 0,
        pendingQuestion: record.pendingQuestion,
        sessionFile: record.sessionFile,
      }),
    )
    .join("\n");
}
