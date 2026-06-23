import { chatGptFiveHourLimitLabel } from "./chatgptUsage.ts";
import { bold, color, padToWidth, ratioProgressBar } from "./formatting.ts";
import { state } from "./state.ts";
import { subagentsLabel } from "./subagents.ts";

function shortTokens(tokens: number | undefined): string {
  if (!Number.isFinite(tokens)) return "?";
  const value = Math.max(0, Number(tokens));
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}m`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(Math.round(value));
}

function contextLabel(): string {
  const window = state.contextWindow;
  if (!window) return "?/?";
  const used = state.contextTokens ?? 0;
  return `${shortTokens(used)}/${shortTokens(window)}`;
}

function contextProgressBar(width = 4): string {
  const window = state.contextWindow ?? 0;
  const used = state.contextTokens ?? 0;
  const ratio = window > 0 ? used / window : 0;
  return ratioProgressBar(ratio, width);
}

function thinkingColor(level: string): string {
  switch (level) {
    case "minimal":
      return "thinkingMinimal";
    case "low":
      return "thinkingLow";
    case "medium":
      return "thinkingMedium";
    case "high":
      return "thinkingHigh";
    case "xhigh":
      return "thinkingXhigh";
    default:
      return "thinkingOff";
  }
}

function cyan(text: string): string {
  return `\x1b[36m${text}\x1b[39m`;
}

function sessionNameLabel(): string | undefined {
  let name: string | undefined;
  try {
    name = state.getSessionName?.();
  } catch {
    name = undefined;
  }
  const clean = name?.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
  if (!clean) return undefined;
  return color("customMessageLabel", " ") + color("accent", clean);
}

export function buildHeader(width: number): string {
  const sep = color("borderMuted", " | ");
  const fastModeActive = state.getFastModeActive?.() ?? state.fastModeActive;
  const model = [
    color("toolTitle", "󰧑 "),
    color("toolTitle", bold(state.model)),
    color("muted", " • "),
    color(thinkingColor(state.thinking), state.thinking),
    fastModeActive ? color("muted", " • ") + cyan("fast") : "",
  ].join("");
  const folder = color("success", "󰉋 ") + color("success", state.folder || "~");
  const branch = color("warning", " ") + color("warning", state.branch || "—");
  const context =
    color("customMessageLabel", "󰍛 ") +
    color("muted", contextLabel()) +
    " " +
    contextProgressBar();
  const subagents = subagentsLabel();
  const chatGptLimit = chatGptFiveHourLimitLabel();
  const parts = [folder, branch, model, context];
  if (subagents) parts.push(subagents);
  if (chatGptLimit) parts.push(chatGptLimit);
  const sessionName = sessionNameLabel();
  if (sessionName) parts.push(sessionName);

  return padToWidth(`${color("success", "╭─")} ${parts.join(sep)}`, width);
}
