import * as path from "node:path";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { generateSummary, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CompletionPayload, SubagentRecord, SubagentSettings } from "../types.ts";
import {
  bytes,
  formatTokens,
  oneLine,
  safeWriteText,
  truncateUtf8,
} from "../utils.ts";

export function extractiveOutputSummary(output: string, maxBytes: number): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const important = lines.filter((line) =>
    /^(#{1,4}\s|[-*]\s|\d+[.)]\s)|\b(summary|result|conclusion|changed|modified|read|file|command|test|error|fail|risk|block|next|todo|decision|evidence)\b/i.test(
      line,
    ),
  );
  const source = important.length >= 8 ? important : lines.slice(0, 80);
  const out = [
    "## Summarized sub-agent output",
    "The original output exceeded the configured return limit. This extractive summary keeps high-signal lines; the full original remains in the child session/output file.",
    "",
  ];
  for (const line of source) {
    const next = `${out.join("\n")}\n- ${line}`;
    if (bytes(next) > maxBytes) break;
    out.push(`- ${line}`);
  }
  if (out.length <= 3)
    out.push(
      "- No compact high-signal lines could be extracted. See the full output file referenced above.",
    );
  return out.join("\n");
}

export async function summarizeOutputForPayload(
  output: string,
  ctx: ExtensionContext | undefined,
  settings: SubagentSettings,
  signal?: AbortSignal,
  thinkingLevel?: ThinkingLevel,
): Promise<{ text: string; summarized: boolean }> {
  throwIfAborted(signal);
  const model = ctx?.model;
  if (model) {
    try {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      throwIfAborted(signal);
      if (auth.ok) {
        const synthetic = [
          {
            role: "assistant",
            content: [{ type: "text", text: output }],
            timestamp: Date.now(),
          },
        ] as AgentMessage[];
        const summary = await generateSummary(
          synthetic,
          model,
          Math.max(1_000, Math.floor(settings.returnMaxBytes / 8)),
          auth.apiKey,
          auth.headers,
          signal,
          "Summarize this sub-agent final output for the parent model. Preserve conclusions, evidence, files changed/read, commands, risks, blockers, and next steps. Do not include the full transcript.",
          undefined,
          thinkingLevel,
        );
        throwIfAborted(signal);
        return { text: summary, summarized: true };
      }
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === "AbortError"))
        throw error;
      // Deterministic fallback only for genuine summarizer/auth failures.
    }
  }
  throwIfAborted(signal);
  return {
    text: extractiveOutputSummary(
      output,
      Math.max(1_000, Math.floor(settings.returnMaxBytes * 0.8)),
    ),
    summarized: true,
  };
}

export function buildCompletionPayload(
  record: SubagentRecord,
  payloadOutput: string,
  settings: SubagentSettings,
  summarized: boolean,
  outputPath?: string,
): string {
  const lines = [
    `Sub-agent ${record.id} (${record.generatedLabel}) ${record.status}.`,
    `Task: ${oneLine(record.task, 400)}`,
    `Context: ${record.contextMode}`,
    `Depth: ${record.depth}/${settings.maxDepth}`,
  ];
  if (record.sessionFile) lines.push(`Session: ${oneLine(record.sessionFile, 600)}`);
  if (record.sessionDir) lines.push(`Session dir: ${oneLine(record.sessionDir, 600)}`);
  if (record.model || record.thinkingLevel)
    lines.push(
      `Model: ${[record.model, record.thinkingLevel ? `thinking=${record.thinkingLevel}` : undefined].filter(Boolean).join(" ")}`,
    );
  if (outputPath) lines.push(`Full final output: ${oneLine(outputPath, 600)}`);
  if (record.error) lines.push(`Error: ${oneLine(record.error, 600)}`);
  if (record.usage) {
    const usageParts = [
      record.usage.input !== undefined ? `input=${formatTokens(record.usage.input)}` : undefined,
      record.usage.output !== undefined ? `output=${formatTokens(record.usage.output)}` : undefined,
      record.usage.total !== undefined ? `total=${formatTokens(record.usage.total)}` : undefined,
      record.usage.cost !== undefined ? `cost=$${record.usage.cost.toFixed(4)}` : undefined,
      record.usage.contextTokens !== undefined
        ? `ctx=${formatTokens(record.usage.contextTokens)}`
        : undefined,
    ]
      .filter(Boolean)
      .join(" ");
    if (usageParts) lines.push(`Usage: ${usageParts}`);
  }
  if (summarized)
    lines.push(
      "Output note: original output exceeded the configured return limit and was summarized for parent context. The full original remains on disk.",
    );
  lines.push("", "## Child final output", payloadOutput.trim() || "(no final output)");
  return lines.join("\n");
}

export async function makeCompletionPayload(
  record: SubagentRecord,
  ctx: ExtensionContext | undefined,
  settings: SubagentSettings,
  signal?: AbortSignal,
  thinkingLevel?: ThinkingLevel,
): Promise<CompletionPayload> {
  throwIfAborted(signal);
  let output = record.finalOutput ?? "";
  let outputPath: string | undefined;
  if (record.sessionDir) {
    outputPath = path.join(record.sessionDir, "final-output.md");
    try {
      throwIfAborted(signal);
      safeWriteText(outputPath, output);
      throwIfAborted(signal);
    } catch {
      outputPath = undefined;
    }
  }
  let payloadOutput = output;
  let wasSummarized = false;
  if (bytes(buildCompletionPayload(record, payloadOutput, settings, false, outputPath)) > settings.returnMaxBytes) {
    const summary = await summarizeOutputForPayload(output, ctx, settings, signal, thinkingLevel);
    throwIfAborted(signal);
    payloadOutput = summary.text;
    wasSummarized = summary.summarized;
  }
  let payload = buildCompletionPayload(
    record,
    payloadOutput,
    settings,
    wasSummarized,
    outputPath,
  );
  if (bytes(payload) > settings.returnMaxBytes) {
    payloadOutput = extractiveOutputSummary(
      payloadOutput,
      Math.max(1_000, Math.floor(settings.returnMaxBytes * 0.6)),
    );
    wasSummarized = true;
    payload = buildCompletionPayload(
      record,
      payloadOutput,
      settings,
      wasSummarized,
      outputPath,
    );
  }
  let tightenAttempts = 0;
  while (bytes(payload) > settings.returnMaxBytes && tightenAttempts < 4) {
    const budget = Math.max(
      500,
      Math.floor(settings.returnMaxBytes * (0.5 - tightenAttempts * 0.08)),
    );
    payloadOutput = extractiveOutputSummary(payloadOutput, budget);
    payload = buildCompletionPayload(
      record,
      `${payloadOutput}\n\n[Further summarized to fit returnMaxBytes. Full output remains on disk.]`,
      settings,
      true,
      outputPath,
    );
    tightenAttempts++;
  }
  if (bytes(payload) > settings.returnMaxBytes) {
    payloadOutput =
      "The child completed, but even the summarized payload exceeded returnMaxBytes. Use the referenced child session/final-output file for the full result.";
    payload = buildCompletionPayload(
      record,
      payloadOutput,
      settings,
      true,
      outputPath,
    );
  }
  throwIfAborted(signal);
  payload = truncateUtf8(payload, settings.returnMaxBytes);
  return {
    id: record.id,
    label: record.generatedLabel,
    status: record.status,
    contextMode: record.contextMode,
    depth: record.depth,
    maxDepth: settings.maxDepth,
    task: record.task,
    output,
    payload,
    wasSummarized,
    sessionFile: record.sessionFile,
    sessionDir: record.sessionDir,
    outputPath,
    usage: record.usage,
    model: record.model,
    thinkingLevel: record.thinkingLevel,
    error: record.error,
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("Completion payload aborted");
  error.name = "AbortError";
  throw error;
}
