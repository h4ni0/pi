import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { DEFAULT_IMAGE_MODEL } from "./constants.ts";
import { callCodexImagesApi } from "./codex-api.ts";
import { saveGeneratedImage } from "./paths.ts";
import { imageGenParams } from "./schema.ts";
import type {
  ImageContentLike,
  ImageGenDetails,
  TextContentLike,
} from "./types.ts";

export function registerImageGenTool(pi: ExtensionAPI) {
  pi.registerTool<typeof imageGenParams, ImageGenDetails>({
    name: "image_gen",
    label: "Image Gen",
    description:
      "Generate a new image or edit an existing image using the user's OpenAI ChatGPT/Codex subscription. Returns PNG image bytes and saves the image to disk.",
    promptSnippet:
      "Generate or edit images with OpenAI; saved PNGs are returned as image content and written to disk",
    promptGuidelines: [
      "Use image_gen to generate an image, visual asset, diagram, meme, portrait, or image edit.",
      "Use image_gen with action=edit when want to modify an uploaded or previously generated image.",
    ],
    parameters: imageGenParams,
    executionMode: "sequential",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      onUpdate?.({
        content: [
          {
            type: "text",
            text: `Generating image (${params.action})...`,
          },
        ],
        details: {
          action: params.action,
          model: process.env.PI_IMAGE_GEN_MODEL || DEFAULT_IMAGE_MODEL,
          path: "",
        },
      });

      const result = await callCodexImagesApi(ctx, params, signal);
      const savedPath = await saveGeneratedImage(toolCallId, result.b64Json);
      const text: TextContentLike = {
        type: "text",
        text: `Generated image saved to ${savedPath}. If you need it elsewhere, copy it.`,
      };
      const image: ImageContentLike = {
        type: "image",
        data: result.b64Json,
        mimeType: "image/png",
      };

      return {
        content: [text, image],
        details: {
          action: params.action,
          model: process.env.PI_IMAGE_GEN_MODEL || DEFAULT_IMAGE_MODEL,
          path: savedPath,
          revisedPrompt: result.revisedPrompt,
        },
      };
    },
  });
}
