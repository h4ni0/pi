import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { SubagentRecord } from "../types.ts";
import { formatDuration, now } from "../utils.ts";
import { framedPanel, renderToolTree, statusText } from "../render-utils.ts";

export class ChildConsoleOverlay implements Component {
  private scroll = 0;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private refreshTimer?: NodeJS.Timeout;

  constructor(
    private readonly theme: Theme,
    private readonly record: SubagentRecord,
    private readonly done: (
      value: { action: "message" | "followup" | "interrupt" } | undefined,
    ) => void,
    private readonly requestRender: () => void,
    private readonly getBodyRows: () => number = () => 24,
  ) {
    this.refreshTimer = setInterval(() => this.invalidate(), 1_000);
  }

  render(width: number): string[] {
    if (this.cachedWidth === width && this.cachedLines) return this.cachedLines;
    const t = this.theme;
    const innerWidth = Math.max(20, width - 2);
    const maxRows = this.getBodyRows();
    const lines = [
      `${t.fg("toolTitle", t.bold("Sub-agent"))} ${t.fg("accent", this.record.generatedLabel || this.record.id)}`,
      `${statusText(this.record.status, t)} ${t.fg("dim", `depth ${this.record.depth} · ${formatDuration((this.record.endedAt ?? now()) - this.record.createdAt)}`)}`,
      t.fg("dim", "m message · f follow-up · i interrupt · r refresh · Esc return"),
      "",
    ];
    const rendered = renderToolTree(this.record.events, t, 180, Number.POSITIVE_INFINITY);
    lines.push(...rendered.slice(this.scroll, this.scroll + Math.max(1, maxRows - 5)));
    const wrapped = lines
      .slice(0, maxRows)
      .map((line) => truncateToWidth(line, innerWidth, "…", true));
    this.cachedWidth = width;
    this.cachedLines = framedPanel(
      t,
      `Inside sub-agent · ${this.record.generatedLabel || this.record.id}`,
      wrapped,
      width,
      Math.min(maxRows + 2, 26),
    );
    return this.cachedLines;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.done(undefined);
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.scroll = Math.max(0, this.scroll - 1);
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.scroll += 1;
      this.invalidate();
      return;
    }
    if (data === "m") this.done({ action: "message" });
    if (data === "f") this.done({ action: "followup" });
    if (data === "i") this.done({ action: "interrupt" });
    if (data === "r") this.invalidate();
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.requestRender();
  }

  dispose(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }
}
