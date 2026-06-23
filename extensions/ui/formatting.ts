import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { state } from "./state.ts";

export function color(token: string, text: string): string {
  return state.theme?.fg?.(token, text) ?? text;
}

export function bold(text: string): string {
  return state.theme?.bold?.(text) ?? text;
}

export function ratioProgressBar(ratio: number, width = 4): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(clamped * width);
  return (
    color("accent", "━".repeat(filled)) +
    color("borderMuted", "─".repeat(width - filled))
  );
}

export function padToWidth(line: string, width: number): string {
  const clipped = truncateToWidth(line, width, "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}
