import type { SubagentRecord } from "../types.ts";
import { now } from "../utils.ts";

export function recordsToList(records: SubagentRecord[]): string {
  if (records.length === 0) return "No active direct child sub-agents.";
  return records
    .map((record) =>
      JSON.stringify({
        id: record.id,
        label: record.generatedLabel,
        status: record.status,
        depth: record.depth,
        context: record.contextMode,
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
