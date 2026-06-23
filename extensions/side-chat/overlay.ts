import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";

import { SideChatController } from "./controller.ts";
import { framedPanel } from "./frame.ts";
import { renderTranscript } from "./transcript.ts";

interface VisibleTranscript {
  lines: string[];
  hiddenBefore: number;
}

export class SideChatOverlay implements Component, Focusable {
  private readonly input = new Input();
  private scrollFromBottom = 0;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private _focused = false;

  constructor(
    private readonly theme: Theme,
    private readonly controller: SideChatController,
    private readonly done: () => void,
    private readonly requestRender: () => void,
    private readonly getBodyRows: () => number,
  ) {
    this.input.onSubmit = (value) => this.submit(value);
    this.input.onEscape = () => this.done();
    this.controller.setRequestRender(() => this.invalidate());
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) return this.done();
    if (matchesKey(data, Key.up)) return this.scroll(1);
    if (matchesKey(data, Key.down)) return this.scroll(-1);
    this.input.handleInput(data);
    this.invalidate();
  }

  render(width: number): string[] {
    if (this.cachedWidth === width && this.cachedLines) return this.cachedLines;

    const panelWidth = Math.max(20, width);
    const contentWidth = Math.max(10, panelWidth - 6);
    const rows = Math.max(10, this.getBodyRows());
    const transcript = renderTranscript(this.theme, this.controller.items, contentWidth);
    const visible = this.visibleTranscript(transcript, Math.max(3, rows - 6));
    const body = this.renderBody(contentWidth, rows, visible);

    this.cachedLines = framedPanel(this.theme, "/btw side chat", body, panelWidth);
    this.cachedWidth = width;
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.requestRender();
  }

  private submit(value: string): void {
    const text = value.trim();
    if (!text) return;
    if (this.controller.submit(text)) {
      this.input.setValue("");
      this.scrollFromBottom = 0;
    }
    this.invalidate();
  }

  private scroll(delta: number): void {
    this.scrollFromBottom = Math.max(0, this.scrollFromBottom + delta);
    this.invalidate();
  }

  private visibleTranscript(lines: string[], rows: number): VisibleTranscript {
    const maxScroll = Math.max(0, lines.length - rows);
    this.scrollFromBottom = Math.min(this.scrollFromBottom, maxScroll);
    const start = Math.max(0, lines.length - rows - this.scrollFromBottom);
    return { lines: lines.slice(start, start + rows), hiddenBefore: start };
  }

  private renderBody(width: number, rows: number, visible: VisibleTranscript): string[] {
    const body = [
      this.theme.fg("warning", "SIDE CHAT — not saved to main history"),
      this.theme.fg("dim", this.modelLine()),
      visible.hiddenBefore > 0
        ? this.theme.fg("dim", `↑ ${visible.hiddenBefore} earlier line${visible.hiddenBefore === 1 ? "" : "s"}`)
        : "",
      ...visible.lines,
    ];

    while (body.length < Math.max(0, rows - 3)) body.push("");
    body.push(this.theme.fg("dim", this.hintText()));
    body.push(this.renderInput(width));
    return body;
  }

  private modelLine(): string {
    const snapshot = this.controller.snapshot;
    const model = `${snapshot.model.provider}/${snapshot.model.id}`;
    const context = `${snapshot.inheritedMessages.length} inherited msgs`;
    return `${model} · ${context} · Esc closes`;
  }

  private renderInput(width: number): string {
    const prefix = this.theme.fg("accent", "› ");
    const inputWidth = Math.max(8, width - visibleWidth(prefix));
    const rendered = this.input.render(inputWidth)[0] ?? "";
    return truncateToWidth(prefix + rendered, width, "…", true);
  }

  private hintText(): string {
    return this.controller.isBusy
      ? "Answering… you can draft; press Enter after it finishes."
      : "Type a side follow-up and press Enter.";
  }
}
