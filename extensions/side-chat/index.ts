import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import { ALIAS, COMMAND } from "./constants.ts";
import { openSideChat } from "./command.ts";

export default function sideChat(pi: ExtensionAPI) {
  const handler = (args: string, ctx: ExtensionCommandContext) => {
    return openSideChat(args, ctx, pi);
  };

  pi.registerCommand(COMMAND, {
    description: "Ask a temporary side question without adding it to main context/history",
    handler,
  });

  pi.registerCommand(ALIAS, {
    description: "Alias for /btw side chat",
    handler,
  });
}
