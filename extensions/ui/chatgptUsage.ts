import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { notifyEditors } from "./editorRegistry.ts";
import { color, ratioProgressBar } from "./formatting.ts";
import { isOpenAICodexProvider } from "./providers.ts";
import { state } from "./state.ts";

const CHATGPT_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const WEEK_SECONDS = 7 * 24 * 60 * 60;
const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";
const USAGE_REFRESH_THROTTLE_MS = 30 * 1000;

let usageRequestId = 0;
let usageLastRefreshStartedAt = 0;

function decodeJwtPayload(token: string): Record<string, any> {
  const parts = token.split(".");
  if (parts.length < 2) return {};

  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

function getChatGptAccountId(token: string): string | undefined {
  const payload = decodeJwtPayload(token);
  const auth = payload[OPENAI_AUTH_CLAIM];
  return auth && typeof auth.chatgpt_account_id === "string"
    ? auth.chatgpt_account_id
    : undefined;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function usageLimitColor(percent: number | undefined): string {
  if (percent === undefined) return "muted";
  if (percent >= 90) return "error";
  if (percent >= 80) return "warning";
  return "muted";
}

export function chatGptWeeklyLimitLabel(): string | undefined {
  if (!isOpenAICodexProvider(state.provider)) return undefined;

  const usedPercent = state.chatGptWeeklyUsedPercent;
  const percentText =
    usedPercent === undefined
      ? "?%"
      : `${Math.round(clampPercent(usedPercent))}%`;
  const ratio = usedPercent === undefined ? 0 : clampPercent(usedPercent) / 100;

  return [
    color("warning", "󰓅 "),
    color(usageLimitColor(usedPercent), percentText),
    " ",
    ratioProgressBar(ratio),
  ].join("");
}

function normalizeUsageWindow(
  value: unknown,
): { usedPercent: number; windowSeconds: number } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const usedPercent =
    typeof record.used_percent === "number" ? record.used_percent : undefined;
  const windowSeconds =
    typeof record.limit_window_seconds === "number"
      ? record.limit_window_seconds
      : undefined;
  if (usedPercent === undefined || windowSeconds === undefined)
    return undefined;
  return { usedPercent, windowSeconds };
}

function extractWeeklyUsedPercent(data: unknown): number | undefined {
  if (!data || typeof data !== "object") return undefined;
  const rateLimit = (data as Record<string, any>).rate_limit;
  if (!rateLimit || typeof rateLimit !== "object") return undefined;

  const windows = [
    normalizeUsageWindow(rateLimit.primary_window),
    normalizeUsageWindow(rateLimit.secondary_window),
  ].filter(Boolean) as { usedPercent: number; windowSeconds: number }[];

  return windows.find(
    (window) => Math.abs(window.windowSeconds - WEEK_SECONDS) <= 120,
  )?.usedPercent;
}

export async function refreshChatGptUsage(
  ctx: ExtensionContext,
  options: { force?: boolean } = {},
): Promise<void> {
  const provider = ctx.model?.provider;

  if (!isOpenAICodexProvider(provider)) {
    usageRequestId++;
    usageLastRefreshStartedAt = 0;
    state.chatGptWeeklyUsedPercent = undefined;
    state.chatGptUsageProvider = undefined;
    notifyEditors();
    return;
  }

  const providerChanged = state.chatGptUsageProvider !== provider;
  if (providerChanged) {
    state.chatGptWeeklyUsedPercent = undefined;
    state.chatGptUsageProvider = provider;
    notifyEditors();
  }

  const now = Date.now();
  if (
    !options.force &&
    !providerChanged &&
    now - usageLastRefreshStartedAt < USAGE_REFRESH_THROTTLE_MS
  ) {
    return;
  }

  if (!options.force) usageLastRefreshStartedAt = now;
  const requestId = ++usageRequestId;

  try {
    const auth = await (ctx.modelRegistry as any).getApiKeyAndHeaders(
      ctx.model,
    );
    if (requestId !== usageRequestId) return;
    if (!auth?.ok || !auth.apiKey) {
      state.chatGptWeeklyUsedPercent = undefined;
      notifyEditors();
      return;
    }

    const accountId = getChatGptAccountId(auth.apiKey);
    const response = await fetch(CHATGPT_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${auth.apiKey}`,
        Accept: "application/json",
        "User-Agent": "pi-hypr-waves-ui",
        ...(accountId ? { "chatgpt-account-id": accountId } : {}),
      },
      signal: AbortSignal.timeout(15000),
    });
    if (requestId !== usageRequestId) return;

    state.chatGptWeeklyUsedPercent = response.ok
      ? extractWeeklyUsedPercent(await response.json())
      : undefined;
  } catch {
    if (requestId !== usageRequestId) return;
    state.chatGptWeeklyUsedPercent = undefined;
  }

  notifyEditors();
}

export function resetChatGptUsage(): void {
  usageRequestId++;
  usageLastRefreshStartedAt = 0;
  state.chatGptWeeklyUsedPercent = undefined;
  state.chatGptUsageProvider = undefined;
}
