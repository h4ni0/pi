import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { JWT_CLAIM_PATH } from "./constants.ts";

function decodeJwtPayload(token: string): Record<string, any> {
  const parts = token.split(".");
  if (parts.length !== 3)
    throw new Error("OpenAI Codex OAuth token is not a JWT");
  const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    "=",
  );
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
}

export function extractAccountId(token: string): string {
  const accountId =
    decodeJwtPayload(token)?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
  if (!accountId)
    throw new Error(
      "Could not extract ChatGPT account id from OpenAI Codex OAuth token",
    );
  return accountId;
}

export async function resolveCodexToken(ctx: ExtensionContext): Promise<string> {
  const envToken =
    process.env.OPENAI_CODEX_ACCESS_TOKEN ||
    process.env.PI_OPENAI_CODEX_ACCESS_TOKEN;
  if (envToken) return envToken;

  const apiKey = await ctx.modelRegistry.getApiKeyForProvider("openai-codex");
  if (!apiKey) {
    throw new Error(
      "No OpenAI subscription auth found. Run /login and choose OpenAI ChatGPT, or set OPENAI_CODEX_ACCESS_TOKEN.",
    );
  }
  return apiKey;
}
