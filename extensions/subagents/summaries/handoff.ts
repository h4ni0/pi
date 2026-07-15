import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  buildSessionContext,
  estimateTokens,
  generateSummary,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { SubagentSettings } from "../types.ts";
import { argsSummary, bytes, extractMessageText, oneLine } from "../utils.ts";

export function selectRecentMessages(
  messages: AgentMessage[],
  tokenBudget: number,
): AgentMessage[] {
  const selected: AgentMessage[] = [];
  let total = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    const size = Math.max(1, estimateTokens(message));
    if (selected.length > 0 && total + size > tokenBudget) break;
    selected.unshift(message);
    total += size;
  }
  return selected;
}

export function fallbackHandoffSummary(
  messages: AgentMessage[],
  maxBytes: number,
): string {
  const readFiles = new Set<string>();
  const modifiedFiles = new Set<string>();
  const toolLines: string[] = [];
  const userSnippets: string[] = [];
  const assistantSnippets: string[] = [];
  for (const message of messages) {
    if ((message as any).role === "user")
      userSnippets.push(oneLine(extractMessageText(message), 500));
    if ((message as any).role === "assistant") {
      const text = oneLine(extractMessageText(message), 500);
      if (text) assistantSnippets.push(text);
      for (const part of (message as any).content ?? []) {
        if (part?.type !== "toolCall") continue;
        const args = part.arguments ?? {};
        const filePath = args.path ?? args.file_path;
        if (typeof filePath === "string") {
          if (part.name === "read") readFiles.add(filePath);
          if (part.name === "write" || part.name === "edit") modifiedFiles.add(filePath);
        }
        toolLines.push(`- ${part.name}: ${argsSummary(args)}`);
      }
    }
  }
  const lines = [
    "## Goal",
    userSnippets.at(-1) ||
      "No explicit user goal was recoverable from the compact fallback.",
    "",
    "## Constraints & Preferences",
    "- This is a fallback summary generated without a model summarizer; it intentionally avoids passing the full transcript.",
    "",
    "## Progress",
    "### Done",
    ...assistantSnippets.slice(-3).map((snippet) => `- ${snippet}`),
    "### In Progress",
    "- Continue from the delegated task and ask the parent if needed.",
    "### Blocked",
    "- Unknown from fallback summary.",
    "",
    "## Key Decisions",
    "- See parent if a decision materially affects scope, safety, or correctness.",
    "",
    "## Next Steps",
    "1. Solve the delegated task using available tools.",
    "2. Report evidence, files touched/read, commands, risks, and blockers.",
    "",
    "## Critical Context",
    ...toolLines.slice(-20),
    "<read-files>",
    ...Array.from(readFiles).slice(-40),
    "</read-files>",
    "<modified-files>",
    ...Array.from(modifiedFiles).slice(-40),
    "</modified-files>",
  ];
  let summary = lines.join("\n");
  if (bytes(summary) > maxBytes) summary = deterministicSummary(summary, maxBytes);
  return summary;
}

export async function generateHandoffSummary(
  ctx: ExtensionContext,
  settings: SubagentSettings,
  signal?: AbortSignal,
  thinkingLevel?: ThinkingLevel,
): Promise<string> {
  throwIfAborted(signal);
  const sessionContext = buildSessionContext(ctx.sessionManager.getBranch());
  const messages = selectRecentMessages(
    sessionContext.messages,
    settings.handoffKeepRecentTokens,
  );
  const instructions = [
    "Create an ephemeral handoff summary for a delegated child sub-agent.",
    "Do not include verbatim transcript except short identifiers/paths where necessary.",
    "Use this exact shape where possible:",
    "## Goal",
    "## Constraints & Preferences",
    "## Progress",
    "### Done",
    "### In Progress",
    "### Blocked",
    "## Key Decisions",
    "## Next Steps",
    "## Critical Context",
    "<read-files>",
    "...</read-files>",
    "<modified-files>",
    "...</modified-files>",
    "Explicitly state this is a summary, not the full transcript.",
  ].join("\n");

  const model = ctx.model;
  if (model) {
    try {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      throwIfAborted(signal);
      if (auth.ok) {
        let summary = await generateSummary(
          messages,
          model,
          Math.max(1_000, Math.floor(settings.handoffTokenBudget / 2)),
          auth.apiKey,
          auth.headers,
          signal,
          instructions,
          undefined,
          thinkingLevel,
        );
        throwIfAborted(signal);
        const maxSummaryBytes = settings.handoffTokenBudget * 4;
        if (bytes(summary) > maxSummaryBytes)
          summary = deterministicSummary(summary, maxSummaryBytes);
        return `Note: This is an ephemeral compacted summary of the immediate parent context, not the full transcript.\n\n${summary}`;
      }
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === "AbortError"))
        throw error;
      // Fall back only for genuine summarizer/auth failures.
    }
  }

  throwIfAborted(signal);
  return [
    "Note: This is an ephemeral compacted summary of the immediate parent context, not the full transcript.",
    "",
    fallbackHandoffSummary(messages, settings.handoffTokenBudget * 4),
  ].join("\n");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("Handoff summary aborted");
  error.name = "AbortError";
  throw error;
}

export function deterministicSummary(text: string, maxBytes: number): string {
  if (bytes(text) <= maxBytes) return text;
  const headBudget = Math.max(500, Math.floor(maxBytes * 0.7));
  const tailBudget = Math.max(300, maxBytes - headBudget - 200);
  let head = text.slice(0, headBudget);
  while (bytes(head) > headBudget) head = head.slice(0, -1);
  let tail = text.slice(-tailBudget);
  while (bytes(tail) > tailBudget) tail = tail.slice(1);
  return `${head}\n\n[Summary compressed: middle omitted; full source remains in the parent/child session logs.]\n\n${tail}`;
}
