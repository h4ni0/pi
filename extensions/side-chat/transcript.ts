import type { Theme } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

import type { ChatItem } from "./types.ts";

export function renderTranscript(
  theme: Theme,
  items: ChatItem[],
  width: number,
): string[] {
  const lines: string[] = [];
  for (const item of items) {
    if (lines.length > 0) lines.push("");
    lines.push(...renderItem(theme, item, width));
  }
  return lines.length ? lines : [theme.fg("dim", "Ask a side question to begin.")];
}

function renderItem(theme: Theme, item: ChatItem, width: number): string[] {
  if (item.kind === "user") {
    return [label(theme, "You (side)", "accent"), ...wrapBody(item.text, width)];
  }
  if (item.kind === "assistant") return renderAssistant(theme, item, width);
  if (item.kind === "tool") return [renderTool(theme, item)];

  const color = item.level === "error" ? "error" : item.level === "warning" ? "warning" : "dim";
  return wrapTextWithAnsi(theme.fg(color, `ⓘ ${item.text}`), width);
}

function renderAssistant(
  theme: Theme,
  item: Extract<ChatItem, { kind: "assistant" }>,
  width: number,
): string[] {
  const suffix = item.running ? theme.fg("warning", "  ●") : "";
  const body = item.text || (item.running ? "…" : "(no text)");
  const lines = [label(theme, "Pi (side)", "toolTitle") + suffix, ...wrapBody(body, width)];
  if (item.stopReason && !["stop", "toolUse"].includes(item.stopReason)) {
    lines.push(theme.fg("warning", `stop: ${item.stopReason}`));
  }
  return lines;
}

function wrapBody(text: string, width: number): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    for (const line of wrapTextWithAnsi(raw || " ", Math.max(8, width - 2))) {
      out.push(`  ${line}`);
    }
  }
  return out;
}

function renderTool(
  theme: Theme,
  item: Extract<ChatItem, { kind: "tool" }>,
): string {
  const color = item.status === "error" ? "error" : item.status === "done" ? "success" : "warning";
  const icon = item.status === "running" ? "…" : item.status === "done" ? "✓" : "✗";
  return theme.fg(color, `${icon} side tool: ${item.text}`);
}

function label(theme: Theme, text: string, color: "accent" | "toolTitle"): string {
  return theme.fg(color, theme.bold(text));
}
