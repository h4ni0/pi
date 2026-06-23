import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { MAX_EDIT_IMAGES } from "./constants.ts";
import type { ImageContentLike } from "./types.ts";

function dataUrlFromImage(image: ImageContentLike): string {
  return `data:${image.mimeType};base64,${image.data}`;
}

export function collectEditImages(ctx: ExtensionContext): string[] {
  const images: string[] = [];
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "message") {
      const content = entry.message.content;
      if (Array.isArray(content)) {
        for (const item of content) {
          if (item && typeof item === "object" && item.type === "image") {
            images.push(dataUrlFromImage(item as ImageContentLike));
          }
        }
      }
    } else if (entry.type === "custom_message") {
      const content = entry.content;
      if (Array.isArray(content)) {
        for (const item of content) {
          if (item && typeof item === "object" && item.type === "image") {
            images.push(dataUrlFromImage(item as ImageContentLike));
          }
        }
      }
    }
  }
  return images.slice(-MAX_EDIT_IMAGES);
}
