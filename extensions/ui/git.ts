import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { notifyEditors } from "./editorRegistry.ts";
import { state } from "./state.ts";

export async function updateBranch(pi: ExtensionAPI): Promise<void> {
  try {
    const result = await pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      timeout: 1000,
    });
    const branch = result.stdout.trim();
    state.branch = branch && branch !== "HEAD" ? branch : "detached";
  } catch {
    state.branch = "—";
  }
  notifyEditors();
}
