import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  applyFastModeToPayload,
  fastModeStatusText,
  getFastMode,
  setFastMode,
} from "./state.ts";

function notifyFastStatus(ctx: ExtensionCommandContext): void {
  ctx.ui.notify(fastModeStatusText(ctx));
}

async function handleFastCommand(args: string, ctx: ExtensionCommandContext) {
  const arg = args.trim().toLowerCase();
  if (arg && !["on", "off", "status"].includes(arg)) {
    ctx.ui.notify("Usage: /fast [on|off|status]", "warning");
    return;
  }

  if (arg === "status") {
    notifyFastStatus(ctx);
    return;
  }

  const enabled = arg === "on" ? true : arg === "off" ? false : !getFastMode(ctx);
  setFastMode(ctx, enabled);
  notifyFastStatus(ctx);
}

export default function fastModeExtension(pi: ExtensionAPI) {
  pi.registerCommand("fast", {
    description: "Toggle Fast mode for supported GPT-5.6/5.5/5.4 models",
    getArgumentCompletions(prefix) {
      const p = prefix.trim().toLowerCase();
      const items = [
        { value: "on", label: "on", description: "Enable Fast mode" },
        { value: "off", label: "off", description: "Disable Fast mode" },
        { value: "status", label: "status", description: "Show Fast mode status" },
      ];
      const filtered = items.filter((item) => item.value.startsWith(p));
      return filtered.length ? filtered : null;
    },
    handler: handleFastCommand,
  });

  pi.on("before_provider_request", (event, ctx) => {
    return applyFastModeToPayload(ctx, event.payload);
  });
}
