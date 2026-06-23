export type KeybindingsManager = any;

export type UiTheme = {
  fg: (color: string, text: string) => string;
  bg?: (color: string, text: string) => string;
  bold?: (text: string) => string;
  getFgAnsi?: (color: string) => string;
  getColorMode?: () => "truecolor" | "256color";
};

export type HeaderState = {
  theme?: UiTheme;
  model: string;
  provider?: string;
  thinking: string;
  fastModeActive?: boolean;
  getFastModeActive?: () => boolean;
  cwd: string;
  folder: string;
  branch: string;
  getSessionName?: () => string | undefined;
  contextTokens?: number;
  contextWindow?: number;
  chatGptFiveHourUsedPercent?: number;
  chatGptUsageProvider?: string;
};

export type Rgb = readonly [number, number, number];
