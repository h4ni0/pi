import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { isFastModeActive } from "../fast-mode/state.ts";
import { isOpenAICodexProvider } from "./providers.ts";
import type { HeaderState, UiTheme } from "./types.ts";

export const state: HeaderState = {
  model: "model",
  thinking: "off",
  fastModeActive: false,
  cwd: process.cwd(),
  folder: path.basename(process.cwd()) || process.cwd(),
  branch: "—",
};

export function updateState(ctx: ExtensionContext, pi: ExtensionAPI): void {
  state.theme = ctx.ui.theme as unknown as UiTheme;
  state.cwd = ctx.cwd;
  state.folder = path.basename(ctx.cwd) || ctx.cwd;
  state.model = ctx.model?.id ?? "model";
  state.provider = ctx.model?.provider;
  state.thinking = pi.getThinkingLevel?.() ?? "off";
  state.fastModeActive = isFastModeActive(ctx);
  state.getFastModeActive = () => isFastModeActive(ctx);
  state.getSessionName = () => ctx.sessionManager.getSessionName();
  state.contextWindow = Number((ctx.model as any)?.contextWindow) || undefined;
  state.contextTokens =
    ctx.getContextUsage?.()?.tokens ?? state.contextTokens ?? 0;
  if (!isOpenAICodexProvider(state.provider)) {
    state.chatGptWeeklyUsedPercent = undefined;
    state.chatGptUsageProvider = undefined;
  }
}
