import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import { SideChatController } from "./controller.ts";
import { SideChatOverlay } from "./overlay.ts";
import { createSnapshot } from "./snapshot.ts";

export async function openSideChat(
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("/btw side chat requires interactive TUI mode", "error");
    return;
  }
  if (!ctx.model) {
    ctx.ui.notify("No model selected for /btw", "error");
    return;
  }

  const controller = new SideChatController(createSnapshot(ctx, pi));
  const initialQuestion = args.trim();
  let submittedInitial = false;

  try {
    await ctx.ui.custom<void>(
      (tui, theme, _keybindings, done) => {
        const overlay = new SideChatOverlay(
          theme,
          controller,
          done,
          () => tui.requestRender(),
          () => Math.max(12, Math.floor(tui.terminal.rows * 0.86) - 4),
        );

        if (initialQuestion && !submittedInitial) {
          submittedInitial = true;
          queueMicrotask(() => controller.submit(initialQuestion));
        }
        return overlay;
      },
      {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: "88%",
          maxHeight: "86%",
          margin: 1,
        },
        onHandle: (handle) => handle.focus(),
      },
    );
  } finally {
    await controller.dispose();
  }
}
