import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { SubagentStatus } from "../types.ts";

export const LAST_TOOL_CALL_COUNT = 3;

export class OneLineList implements Component {
  constructor(private readonly lines: string[]) {}
  render(width: number): string[] {
    return this.lines.map((line) => truncateToWidth(line, width, "…", true));
  }
  invalidate(): void {}
}

export function statusRank(status: SubagentStatus): number {
  return status === "waiting_for_answer"
    ? 0
    : status === "running" || status === "starting"
      ? 1
      : 2;
}

export function fitAnsi(line: string, width: number): string {
  return truncateToWidth(line, Math.max(0, width), "…", true);
}

export function framedPanel(
  theme: Theme,
  title: string,
  body: string[],
  width: number,
  minBodyRows: number,
): string[] {
  const panelWidth = Math.max(10, width - 2);
  const innerWidth = Math.max(0, panelWidth - 2);
  const padX = 2;
  const contentWidth = Math.max(0, innerWidth - padX * 2);
  const border = (text: string) => theme.fg("border", text);
  const shadow = (text: string) => theme.fg("dim", text);
  const titleText = ` ${theme.fg("accent", theme.bold(title))} `;
  const titleWidth = visibleWidth(titleText);
  const right = Math.max(0, innerWidth - titleWidth);
  const lines = [border("┏") + titleText + border(`${"━".repeat(right)}┓`) + shadow("▌")];
  const rows = ["", ...body.slice(), ""];
  while (rows.length < minBodyRows) rows.push("");
  for (const row of rows) {
    const fitted = fitAnsi(row, contentWidth);
    const fill = " ".repeat(Math.max(0, contentWidth - visibleWidth(fitted)));
    lines.push(
      border("┃") +
        " ".repeat(padX) +
        fitted +
        fill +
        " ".repeat(padX) +
        border("┃") +
        shadow("▌"),
    );
  }
  lines.push(border(`┗${"━".repeat(innerWidth)}┛`) + shadow("▌"));
  lines.push(shadow(` ${"▀".repeat(panelWidth)}`));
  return lines.map((line) => truncateToWidth(line, width, "…", true));
}

export function statusText(status: SubagentStatus, theme: Theme): string {
  switch (status) {
    case "queued":
      return theme.fg("muted", "queued");
    case "starting":
      return theme.fg("accent", "starting");
    case "running":
      return theme.fg("accent", "running");
    case "waiting_for_answer":
      return theme.fg("warning", "waiting");
    case "completed":
      return theme.fg("success", "completed");
    case "failed":
      return theme.fg("error", "failed");
    case "aborted":
      return theme.fg("warning", "aborted");
  }
}
