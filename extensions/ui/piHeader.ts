import type { UiTheme } from "./types.ts";

type Rgb = readonly [number, number, number];

const FG_RESET = "\x1b[39m";
const PI_LEFT_PADDING = 2;

// Selected startup gradient: Neon dusk — red → magenta → blue.
const HYPR_WAVES_GRADIENT_STOPS: readonly Rgb[] = [
  [255, 77, 99], // primaryBright / red
  [196, 56, 120], // magentaBright
  [74, 156, 197], // blueBright
];

const PI_ART = [
  "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣀⣤⣤⣤⣶⣶⣶⣶⣶⣶⣶⣶⣶⣶⣶⣶⣶⣶⣶⣶⣶⣶⣶⣶⣶⣶⣶⣶⣶⣶⣶⣶⣶⣶⣶",
  "⠀⠀⠀⠀⠀⠀⠀⢀⣴⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿",
  "⠀⠀⠀⠀⠀⠀⢠⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿",
  "⠀⠀⠀⠀⠀⣰⣿⣿⣿⡿⠿⠟⠛⠛⠛⠛⢻⣿⣿⣿⡟⠛⠛⠛⠛⠛⠛⠛⠛⢻⣿⣿⣿⣿⣿⠛⠛⠛⠛⠛⠛⠛⠛⠛⠛",
  "⠀⠀⠀⠀⢰⣿⣿⡿⠉⠀⠀⠀⠀⠀⠀⠀⢸⣿⣿⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀⣼⣿⣿⣿⣿⣿",
  "⠀⠀⠀⠀⣼⣿⠟⠁⠀⠀⠀⠀⠀⠀⠀⠀⣾⣿⣿⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀⣿⣿⣿⣿⣿⣿",
  "⠀⠀⠀⠘⠿⠃⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣿⣿⣿⣿⠁⠀⠀⠀⠀⠀⠀⠀⢰⣿⣿⣿⣿⣿⣿",
  "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣿⣿⣿⣿⠀⠀⠀⠀⠀⠀⠀⠀⢸⣿⣿⣿⣿⣿⣿",
  "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢸⣿⣿⣿⣿⠀⠀⠀⠀⠀⠀⠀⠀⢸⣿⣿⣿⣿⣿⡏",
  "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣾⣿⣿⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀⢸⣿⣿⣿⣿⣿⡇",
  "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢸⣿⣿⣿⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀⣾⣿⣿⣿⣿⣿⡇",
  "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣾⣿⣿⣿⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀⣿⣿⣿⣿⣿⣿⠁",
  "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣼⣿⣿⣿⣿⣿⠇⠀⠀⠀⠀⠀⠀⠀⢠⣿⣿⣿⣿⣿⣿",
  "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣼⣿⣿⣿⣿⣿⡿⠀⠀⠀⠀⠀⠀⠀⠀⢸⣿⣿⣿⣿⣿⣿",
  "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣼⣿⣿⣿⣿⣿⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀⢸⣿⣿⣿⣿⣿⣿⡆⠀⠀⠀⠀⠀⠀⠀⠀⢀⣀",
  "⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣾⣿⣿⣿⣿⣿⣿⣿⠁⠀⠀⠀⠀⠀⠀⠀⠀⣼⣿⣿⣿⣿⣿⣿⣇⠀⠀⠀⠀⠀⠀⠀⢀⣾⣿",
  "⠀⠀⠀⠀⠀⠀⠀⠀⢰⣿⣿⣿⣿⣿⣿⣿⣿⣿⠀⠀⠀⠀⠀⠀⠀⠀⠀⢹⣿⣿⣿⣿⣿⣿⣿⣆⠀⠀⠀⠀⠀⢀⣼⣿⡏",
  "⠀⠀⠀⠀⠀⠀⠀⢰⣿⣿⣿⣿⣿⣿⣿⣿⣿⠏⠀⠀⠀⠀⠀⠀⠀⠀⠀⠸⣿⣿⣿⣿⣿⣿⣿⣿⣷⣶⣦⣶⣶⣿⣿⡿⠁",
  "⠀⠀⠀⠀⠀⠀⠀⣿⣿⣿⣿⣿⣿⣿⣿⣿⡟⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢻⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⠃",
  "⠀⠀⠀⠀⠀⠀⠀⢻⣿⣿⣿⣿⣿⣿⣿⡟⠃⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠻⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠟",
  "⠀⠀⠀⠀⠀⠀⠀⠀⠙⠻⠿⠿⠿⠟⠋⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠙⠛⠿⠿⠿⠿⠿⠛⠋",
] as const;

const PI_ART_WIDTH = Math.max(...PI_ART.map((line) => [...line].length));
const PI_ART_HEIGHT = PI_ART.length;

function mixChannel(from: number, to: number, amount: number): number {
  return Math.round(from + (to - from) * amount);
}

function gradientColor(stops: readonly Rgb[], position: number): Rgb {
  const clamped = Math.max(0, Math.min(1, position));
  const scaled = clamped * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.floor(scaled));
  const amount = scaled - index;
  const from = stops[index]!;
  const to = stops[index + 1]!;

  return [
    mixChannel(from[0], to[0], amount),
    mixChannel(from[1], to[1], amount),
    mixChannel(from[2], to[2], amount),
  ];
}

function rgbToAnsi256([r, g, b]: Rgb): number {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }

  const toCube = (value: number) => Math.round((value / 255) * 5);
  return 16 + 36 * toCube(r) + 6 * toCube(g) + toCube(b);
}

function rgbFg(rgb: Rgb, theme: UiTheme): string {
  const [r, g, b] = rgb;
  if (theme.getColorMode?.() === "256color") {
    return `\x1b[38;5;${rgbToAnsi256(rgb)}m`;
  }
  return `\x1b[38;2;${r};${g};${b}m`;
}

function gradientPiLine(
  line: string,
  row: number,
  theme: UiTheme,
  stops: readonly Rgb[],
): string {
  const chars = [...line];
  const maxColumn = Math.max(1, PI_ART_WIDTH - 1);
  const maxRow = Math.max(1, PI_ART_HEIGHT - 1);
  let output = " ".repeat(PI_LEFT_PADDING);
  let activeAnsi = "";

  for (let column = 0; column < chars.length; column++) {
    const char = chars[column]!;
    if (char === " ") {
      if (activeAnsi) {
        output += FG_RESET;
        activeAnsi = "";
      }
      output += char;
      continue;
    }

    const x = column / maxColumn;
    const y = row / maxRow;
    // Slightly bias the sweep to the right so the blue endpoint shows a bit more.
    const position = x * 0.86 + y * 0.18;
    const ansi = rgbFg(gradientColor(stops, position), theme);
    if (ansi !== activeAnsi) {
      output += ansi;
      activeAnsi = ansi;
    }
    output += char;
  }

  if (activeAnsi) output += FG_RESET;
  return output;
}

export function bigPiHeader(theme: UiTheme): string[] {
  return [
    "",
    ...PI_ART.map((line, row) =>
      gradientPiLine(line, row, theme, HYPR_WAVES_GRADIENT_STOPS),
    ),
    "",
  ];
}
