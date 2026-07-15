import * as path from "node:path";
import { extractiveOutputSummary } from "../summaries/completion.ts";
import type {
  CompletionActivity,
  SubagentRecord,
  SubagentSettings,
} from "../types.ts";
import {
  bytes,
  ensureDir,
  makeId,
  safeWriteJson,
  safeWriteText,
  truncateUtf8,
} from "../utils.ts";

export interface TurnArtifactResult {
  activity: CompletionActivity;
  fullOutput: string;
  boundedOutput: string;
  outputPath?: string;
  metadataPath?: string;
  truncated: boolean;
}

export function writeAgentMetadata(record: SubagentRecord): void {
  if (!record.sessionDir) return;
  safeWriteJson(path.join(record.sessionDir, "agent.json"), {
    version: 2,
    agent_id: record.id,
    agent_name: record.agentName,
    task_name: record.taskName,
    mode: record.mode,
    depth: record.depth,
    max_depth: record.maxDepth,
    context: record.contextMode,
    process_state: record.processState,
    turn_state: record.turnState,
    turn_outcome: record.turnOutcome,
    reusable: record.reusable,
    turn_id: record.currentTurnId ?? null,
    turn_count: record.turnCount,
    pending_messages: record.mailbox.length,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    session_file: record.sessionFile,
    omitted_tools: record.omittedTools,
  });
}

export function writeTurnArtifacts(
  record: SubagentRecord,
  settings: SubagentSettings,
  outcome: "completed" | "errored",
): TurnArtifactResult {
  const turnId = record.currentTurnId ?? `turn_${record.turnCount || 1}`;
  const turnOutput = record.currentTurnOutput?.trim();
  const turnError = record.turnError?.trim() || record.error?.trim();
  const fullOutput =
    outcome === "errored"
      ? [
          `Error: ${turnError || "Child turn failed without an error message."}`,
          turnOutput ? `\nPartial turn output:\n${turnOutput}` : undefined,
        ]
          .filter(Boolean)
          .join("\n")
      : turnOutput ?? "";
  const eventId = makeId().replace(/^sa_/, "evt_");
  const timestamp = Date.now();
  let outputPath: string | undefined;
  let metadataPath: string | undefined;
  if (record.sessionDir) {
    const turnsDir = path.join(record.sessionDir, "turns");
    ensureDir(turnsDir);
    const ordinal = String(Math.max(1, record.turnCount)).padStart(4, "0");
    outputPath = path.join(turnsDir, `${ordinal}-final.md`);
    metadataPath = path.join(turnsDir, `${ordinal}.json`);
    safeWriteText(outputPath, fullOutput);
    safeWriteText(path.join(record.sessionDir, "final-output.md"), fullOutput);
    safeWriteJson(metadataPath, {
      version: 2,
      event_id: eventId,
      agent_id: record.id,
      agent_name: record.agentName,
      turn_id: turnId,
      turn_number: record.turnCount,
      outcome,
      error: record.turnError ?? record.error,
      output_path: outputPath,
      timestamp,
      usage: record.usage,
    });
  }

  const outputBudget = Math.max(500, Math.floor(settings.returnMaxBytes * 0.72));
  const truncated = bytes(fullOutput) > outputBudget;
  let boundedOutput = truncated
    ? extractiveOutputSummary(fullOutput, outputBudget)
    : fullOutput;
  boundedOutput = truncateUtf8(boundedOutput, outputBudget);
  if (truncated && outputPath)
    boundedOutput += `\n\n[Full output: ${outputPath}]`;
  boundedOutput = truncateUtf8(boundedOutput, Math.max(500, settings.returnMaxBytes - 1_000));

  const activity: CompletionActivity = {
    event_id: eventId,
    agent_id: record.id,
    agent_name: record.agentName,
    turn_id: turnId,
    outcome,
    output: boundedOutput,
    output_path: outputPath,
    timestamp,
  };
  writeAgentMetadata(record);
  return {
    activity,
    fullOutput,
    boundedOutput,
    outputPath,
    metadataPath,
    truncated,
  };
}
