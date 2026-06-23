import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export function framedPanel(
  theme: Theme,
  title: string,
  body: string[],
  width: number,
): string[] {
  const inner = Math.max(1, width - 2);
  const border = (text: string) => theme.fg("border", text);
  const heading = ` ${theme.fg("accent", theme.bold(title))} `;
  const right = Math.max(0, inner - visibleWidth(heading));
  const lines = [border("╭") + heading + border(`${"─".repeat(right)}╮`)];

  for (const raw of body) {
    const content = truncateToWidth(raw, inner - 2, "…", true);
    lines.push(border("│") + " " + content + " " + border("│"));
  }

  lines.push(border(`╰${"─".repeat(inner)}╯`));
  return lines.map((line) => truncateToWidth(line, width, "…", true));
}
