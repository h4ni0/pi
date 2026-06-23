import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerImageGenTool } from "./tool.ts";

export default function imageGenExtension(pi: ExtensionAPI) {
  registerImageGenTool(pi);
}
