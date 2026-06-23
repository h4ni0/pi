/**
 * Prompt builders: the memory block injected into the system prompt, the
 * periodic self-review nudge, and the review prompts (in-band + background).
 *
 * The memory block is built once per session (frozen snapshot, hermes-style):
 * keeping it byte-identical across turns preserves provider prefix caching,
 * and prevents the model from chasing its own mid-session edits.
 */

import { type MemoryConfig, type MemoryScope, memoryUsage, type MemoryUsage, readMemory } from "./store.ts";

const RULE = "═".repeat(56);

export function formatUsage(usage: MemoryUsage): string {
  return `${usage.pct}% — ${usage.chars}/${usage.limit} chars`;
}

export function buildMemoryBlock(projectRoot: string, config: MemoryConfig): string {
  const section = (title: string, scope: MemoryScope): string => {
    const text = readMemory(scope, projectRoot) || "(empty)";
    const usage = memoryUsage(scope, projectRoot, config);
    return `── ${title} (target: ${scope}) [${formatUsage(usage)}]\n${text}`;
  };

  return [
    RULE,
    "MEMORY — your persistent, self-curated notes",
    RULE,
    "Each session starts fresh; these notes are everything you chose to",
    "remember. You maintain them with the `memory` tool (add / replace / remove).",
    "",
    section("USER PROFILE", "user"),
    "",
    section("GENERAL NOTES — your behavior & environment", "global"),
    "",
    section(`PROJECT NOTES — ${projectRoot}`, "project"),
    "",
    "Memory maintenance:",
    '- Proactively save: explicit corrections ("use X, not Y"), durable preferences,',
    "  environment facts, project conventions and commands, tool quirks, hard-won",
    "  workarounds, lessons from failed approaches.",
    "- Save only lessons likely to improve future sessions; avoid one-off or",
    "  hyper-specific task/UI details unless they reveal a reusable preference or convention.",
    "- Never save: secrets/credentials, trivia, anything easily re-derived from the",
    "  repo, ephemeral session state.",
    "- Style: dense, declarative, single-line entries. No timestamps, no narration.",
    "- Targets: user = how they like to work, their preferences (everywhere);",
    "  global = your own behavior & environment (everywhere); project = this codebase only.",
    "- Over 80% full? Consolidate: merge related entries (replace), drop stale ones",
    "  (remove), generalize specifics.",
    "- This snapshot is frozen for the session; writes hit disk immediately and are",
    "  loaded next session.",
  ].join("\n");
}

export function buildNudgeText(interval: number): string {
  return (
    `[memory review] ${interval}+ user turns since the last memory update. ` +
    "Before answering, briefly check this conversation for broadly reusable durable lessons — corrections, " +
    "preferences, environment or project facts, conventions, workarounds — and store them " +
    "with the memory tool (consolidate any section over 80% first). Skip one-off or hyper-specific details. Then continue with the " +
    "user's request. If nothing is worth saving, continue without mentioning this."
  );
}

/** Sent as a visible user message by `/memory review`. */
export function buildReviewUserPrompt(): string {
  return (
    "Review this conversation for broadly reusable durable lessons worth persisting across sessions: " +
    "explicit corrections, user preferences, environment and project facts, conventions, " +
    "tool quirks, lessons from failed approaches. Skip one-off or hyper-specific details. Save them with the memory tool, choosing " +
    "targets carefully (user / global / project), and consolidate any section over 80% " +
    "capacity. Make at most 5 writes, then summarize in one line what changed (or state " +
    "that nothing qualified)."
  );
}

/** Prompt for the quiet background reviewer process (hermes-style post-turn review). */
export function buildBackgroundReviewPrompt(transcriptPath: string): string {
  return [
    "You are pi's quiet memory curator running in a background process; no user is watching",
    "and nobody will reply to you.",
    `Read the conversation transcript at ${transcriptPath} using the read tool.`,
    "Your current persistent memory is in your system prompt under MEMORY.",
    "Decide what from this transcript deserves persisting: explicit corrections, durable",
    "preferences, environment/project facts, conventions, tool quirks, lessons from failures.",
    "Only save broadly reusable lessons; skip one-off or hyper-specific details, trivia,",
    "secrets, and anything already remembered or easily re-derived.",
    "Use ONLY the memory tool to make changes (at most 5 writes), consolidating any section",
    "over 80% capacity. Do not modify other files and do not run commands.",
    "Finally print exactly one line summarizing what you changed, or 'nothing to save'.",
  ].join(" ");
}
