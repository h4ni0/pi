import * as fs from "node:fs";
import * as path from "node:path";
import {
  SessionManager,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { ForkTurns } from "../types.ts";

export interface ForkSessionSource {
  buildContextEntries(): SessionEntry[];
}

export interface SpawnCallIdentity {
  taskName: string;
  message: string;
  toolCallId?: string;
}

export interface ForkSeedOptions {
  source: ForkSessionSource;
  forkTurns: ForkTurns;
  spawnCall: SpawnCallIdentity;
  cwd: string;
  sessionDir: string;
  model?: { provider: string; id: string };
  thinkingLevel?: string;
}

export interface ForkSeedResult {
  sessionFile: string;
  entries: SessionEntry[];
}

/**
 * Select the active parent context for a v2 child. The selected entries remain
 * role-preserving Pi session entries rather than a text summary.
 */
export function selectForkContextEntries(
  source: ForkSessionSource,
  forkTurns: ForkTurns,
  spawnCall: SpawnCallIdentity,
): SessionEntry[] {
  if (forkTurns === "none") return [];
  const active = source.buildContextEntries().map(cloneEntry);
  const sanitized = sanitizeCurrentSpawnCall(active, spawnCall);
  const selected = forkTurns === "all"
    ? sanitized
    : selectLastTurns(sanitized, BigInt(forkTurns));
  return preserveToolPairs(selected);
}

/**
 * Materialize a child seed with exported SessionManager append APIs. Opening an
 * empty explicit path asks SessionManager to initialize the header immediately;
 * this also handles user-only seeds which Pi otherwise defers writing until the
 * first assistant message.
 */
export function prepareForkSeedSession(options: ForkSeedOptions): ForkSeedResult {
  fs.mkdirSync(options.sessionDir, { recursive: true });
  const sessionFile = path.join(options.sessionDir, "fork-seed.jsonl");
  const fd = fs.openSync(sessionFile, "wx");
  fs.closeSync(fd);

  try {
    const seed = SessionManager.open(
      sessionFile,
      options.sessionDir,
      options.cwd,
    );
    const entries = selectForkContextEntries(
      options.source,
      options.forkTurns,
      options.spawnCall,
    );
    for (const entry of entries) appendSeedEntry(seed, entry);

    // Context compaction can omit the entries which originally established
    // model/thinking state. Reassert the parent's active state without changing
    // message roles or order.
    const seededState = seed.buildSessionContext();
    if (
      options.model &&
      (seededState.model?.provider !== options.model.provider ||
        seededState.model?.modelId !== options.model.id)
    ) {
      seed.appendModelChange(options.model.provider, options.model.id);
    }
    if (
      options.thinkingLevel &&
      seededState.thinkingLevel !== options.thinkingLevel
    ) {
      seed.appendThinkingLevelChange(options.thinkingLevel);
    }

    return { sessionFile, entries };
  } catch (error) {
    fs.rmSync(sessionFile, { force: true });
    throw error;
  }
}

function selectLastTurns(entries: SessionEntry[], count: bigint): SessionEntry[] {
  let remaining = count;
  let start = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (!isTurnBoundary(entries[index]!)) continue;
    remaining -= 1n;
    if (remaining === 0n) {
      start = index;
      return entries.slice(start);
    }
  }
  return entries;
}

function isTurnBoundary(entry: SessionEntry): boolean {
  if (entry.type === "message" && entry.message.role === "user") {
    const text = messageText(entry.message.content);
    if (/^Message Type: NEW_TASK(?:\r?\n|$)/.test(text)) return true;
    if (/^Message Type: (?:MESSAGE|FINAL_ANSWER)(?:\r?\n|$)/.test(text))
      return false;
    return true;
  }
  if (entry.type !== "custom_message") return false;
  const trigger = (entry.details as { triggerTurn?: unknown } | undefined)
    ?.triggerTurn;
  if (trigger === true) return true;
  if (trigger === false) return false;
  return /^Message Type: NEW_TASK(?:\r?\n|$)/.test(
    messageText(entry.content),
  );
}

function messageText(
  content: string | Array<{ type: string; text?: string }>,
): string {
  if (typeof content === "string") return content;
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

function sanitizeCurrentSpawnCall(
  entries: SessionEntry[],
  identity: SpawnCallIdentity,
): SessionEntry[] {
  let targetId: string | undefined;
  let targetEntryIndex = -1;
  let targetBlockIndex = -1;

  for (let entryIndex = entries.length - 1; entryIndex >= 0; entryIndex -= 1) {
    const entry = entries[entryIndex]!;
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const content = Array.isArray(entry.message.content)
      ? entry.message.content
      : [];
    for (let blockIndex = content.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = content[blockIndex] as any;
      if (block?.type !== "toolCall" || block.name !== "spawn_agent") continue;
      const args = block.arguments ?? block.input ?? {};
      const exactId = identity.toolCallId && block.id === identity.toolCallId;
      if (
        exactId ||
        (!identity.toolCallId &&
          args.task_name === identity.taskName &&
          args.message === identity.message)
      ) {
        targetId = String(block.id ?? "");
        targetEntryIndex = entryIndex;
        targetBlockIndex = blockIndex;
        break;
      }
    }
    if (targetEntryIndex >= 0) break;
    // Argument matching is compatibility-only for direct manager callers. It
    // may inspect only the latest assistant entry, never an older identical
    // completed spawn. Production tool execution always supplies the exact ID.
    if (!identity.toolCallId) break;
  }

  if (targetEntryIndex < 0) return entries;
  const output: SessionEntry[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (
      targetId &&
      entry.type === "message" &&
      entry.message.role === "toolResult" &&
      entry.message.toolCallId === targetId
    ) {
      continue;
    }
    if (index !== targetEntryIndex || entry.type !== "message") {
      output.push(entry);
      continue;
    }
    const message = entry.message as any;
    const content = [...message.content];
    content.splice(targetBlockIndex, 1);
    if (content.length > 0) {
      const hasToolCall = content.some((block: any) => block.type === "toolCall");
      output.push({
        ...entry,
        message: {
          ...message,
          content,
          ...(message.stopReason === "toolUse" && !hasToolCall
            ? { stopReason: "stop" }
            : {}),
        },
      });
    }
  }
  return output;
}

/** Remove orphan/duplicate tool calls/results while leaving complete pairs untouched. */
function preserveToolPairs(entries: SessionEntry[]): SessionEntry[] {
  const calls = new Map<string, number[]>();
  const results = new Map<string, number[]>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.type !== "message") continue;
    if (entry.message.role === "assistant") {
      for (const block of entry.message.content) {
        if (block.type !== "toolCall") continue;
        const positions = calls.get(block.id) ?? [];
        positions.push(index);
        calls.set(block.id, positions);
      }
    } else if (entry.message.role === "toolResult") {
      const positions = results.get(entry.message.toolCallId) ?? [];
      positions.push(index);
      results.set(entry.message.toolCallId, positions);
    }
  }

  const paired = new Set<string>();
  for (const [id, callPositions] of calls) {
    const resultPositions = results.get(id) ?? [];
    if (
      callPositions.length === 1 &&
      resultPositions.length === 1 &&
      resultPositions[0]! > callPositions[0]! &&
      !entries
        .slice(callPositions[0]! + 1, resultPositions[0])
        .some(isTurnBoundary)
    ) {
      paired.add(id);
    }
  }
  const output: SessionEntry[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") {
      output.push(entry);
      continue;
    }
    if (entry.message.role === "toolResult") {
      if (paired.has(entry.message.toolCallId)) output.push(entry);
      continue;
    }
    if (entry.message.role !== "assistant") {
      output.push(entry);
      continue;
    }
    const content = entry.message.content.filter(
      (block) => block.type !== "toolCall" || paired.has(block.id),
    );
    if (content.length > 0) {
      const hasToolCall = content.some((block) => block.type === "toolCall");
      output.push({
        ...entry,
        message: {
          ...entry.message,
          content,
          ...(entry.message.stopReason === "toolUse" && !hasToolCall
            ? { stopReason: "stop" as const }
            : {}),
        },
      });
    }
  }
  return output;
}

function appendSeedEntry(seed: SessionManager, entry: SessionEntry): void {
  switch (entry.type) {
    case "message":
      seed.appendMessage(structuredClone(entry.message) as any);
      return;
    case "model_change":
      seed.appendModelChange(entry.provider, entry.modelId);
      return;
    case "thinking_level_change":
      seed.appendThinkingLevelChange(entry.thinkingLevel);
      return;
    case "compaction":
      seed.appendCompaction(
        entry.summary,
        entry.firstKeptEntryId,
        entry.tokensBefore,
        structuredClone(entry.details),
        entry.fromHook,
      );
      return;
    case "branch_summary":
      seed.branchWithSummary(
        seed.getLeafId(),
        entry.summary,
        structuredClone(entry.details),
        entry.fromHook,
      );
      return;
    case "custom_message":
      seed.appendCustomMessageEntry(
        entry.customType,
        structuredClone(entry.content),
        entry.display,
        structuredClone(entry.details),
      );
      return;
    // Plain custom state, labels, and display-only session metadata are not
    // parent conversation context and must not leak into the child session.
    case "custom":
    case "label":
    case "session_info":
      return;
  }
}

function cloneEntry<T extends SessionEntry>(entry: T): T {
  return structuredClone(entry);
}
