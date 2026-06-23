import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import os from "node:os";

import { DEFAULT_CODEX_BASE_URL } from "./constants.ts";
import { extractAccountId, resolveCodexToken } from "./auth.ts";
import { collectEditImages } from "./session-images.ts";
import type { ImageGenParams } from "./schema.ts";
import type { HostedImageResult } from "./types.ts";

function codexResponsesUrl(baseUrl: string | undefined): string {
  const raw = baseUrl?.trim() || DEFAULT_CODEX_BASE_URL;
  const normalized = raw.replace(/\/+$/, "");
  if (normalized.endsWith("/codex/responses")) return normalized;
  if (normalized.endsWith("/codex")) return `${normalized}/responses`;
  return `${normalized}/codex/responses`;
}

async function callHostedImageGeneration(
  ctx: ExtensionContext,
  params: ImageGenParams,
  token: string,
  accountId: string,
  signal: AbortSignal | undefined,
): Promise<HostedImageResult> {
  const modelBaseUrl =
    ctx.model?.provider === "openai-codex" ? ctx.model.baseUrl : undefined;
  const content: Array<Record<string, unknown>> = [
    { type: "input_text", text: params.prompt },
  ];
  if (params.action === "edit") {
    const images = collectEditImages(ctx);
    if (images.length === 0) {
      throw new Error(
        "image_gen edit requested, but no uploaded or previously generated images were found in this session.",
      );
    }
    for (const image_url of images)
      content.push({ type: "input_image", image_url, detail: "auto" });
  }

  const response = await fetch(codexResponsesUrl(modelBaseUrl), {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${token}`,
      "chatgpt-account-id": accountId,
      originator: "codex_cli_rs",
      "User-Agent": `codex_cli_rs/0.0.0 (${os.platform()} ${os.release()}; ${os.arch()})`,
      "OpenAI-Beta": "responses=experimental",
      accept: "text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: ctx.model?.provider === "openai-codex" ? ctx.model.id : "gpt-5.2",
      store: false,
      stream: true,
      instructions:
        "Generate or edit the requested image. Do not add explanatory text.",
      input: [{ role: "user", content }],
      tools: [{ type: "image_generation", output_format: "png" }],
      tool_choice: "auto",
      parallel_tool_calls: true,
    }),
  });
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `hosted image_generation failed (${response.status}): ${text.slice(0, 1000)}`,
    );
  }

  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body as any as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() || "";
    for (const event of events) {
      for (const line of event.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        const payload = JSON.parse(data);
        const item = payload.item;
        if (item?.type === "image_generation_call" && item.result) {
          return { result: item.result, revisedPrompt: item.revised_prompt };
        }
      }
    }
  }
  throw new Error("hosted image_generation returned no image data");
}

export async function callCodexImagesApi(
  ctx: ExtensionContext,
  params: ImageGenParams,
  signal: AbortSignal | undefined,
): Promise<{ b64Json: string; revisedPrompt?: string }> {
  const token = await resolveCodexToken(ctx);
  const accountId = extractAccountId(token);
  const hosted = await callHostedImageGeneration(
    ctx,
    params,
    token,
    accountId,
    signal,
  );
  return { b64Json: hosted.result, revisedPrompt: hosted.revisedPrompt };
}
