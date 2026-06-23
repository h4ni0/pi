import { CustomEditor } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  visibleWidth,
  type EditorTheme,
  type TUI,
} from "@earendil-works/pi-tui";
import { color, padToWidth } from "./formatting.ts";
import { buildHeader } from "./header.ts";
import type { KeybindingsManager } from "./types.ts";

function stripAnsi(input: string): string {
  return input
    .replaceAll(CURSOR_MARKER, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[P_\^][\s\S]*?\x1b\\/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "");
}

function looksLikeEditorBorder(line: string): boolean {
  const clean = stripAnsi(line).trim();
  return clean.includes("─") && /^[─ ↑↓0-9more]+$/.test(clean);
}

export class TerminalEditor extends CustomEditor {
  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
    // paddingX 0 avoids the stock editor's side-padding/wrap weirdness.
    super(tui, theme, keybindings, { paddingX: 0 });
  }

  requestRender(): void {
    this.invalidate();
    this.tui.requestRender();
  }

  override render(width: number): string[] {
    const promptSymbol = this.getText().startsWith("!") ? "# " : "❯ ";
    const prompt = color("success", "╰─") + color("accent", promptSymbol);
    const promptWidth = visibleWidth(prompt);
    const innerWidth = Math.max(1, width - promptWidth);

    const stockLines = super
      .render(innerWidth)
      .filter((line) => !looksLikeEditorBorder(line));

    const inputLines = stockLines.length > 0 ? stockLines : [""];
    const lines: string[] = [buildHeader(width)];

    for (let i = 0; i < inputLines.length; i++) {
      const prefix = i === 0 ? prompt : " ".repeat(promptWidth);
      lines.push(padToWidth(prefix + inputLines[i], width));
    }

    return lines;
  }
}
