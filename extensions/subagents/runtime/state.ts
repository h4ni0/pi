import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentRecord, SubagentSettings } from "../types.ts";

export interface SubagentRuntimeState {
  pi: ExtensionAPI;
  active: Map<string, SubagentRecord>;
  latestCtx?: ExtensionContext;
  settings: SubagentSettings;
  insideChildId?: string;
  parentAnswerQueue: Promise<void>;
  currentDepth: number;
  envMaxDepth: number;
  isChild: boolean;
  extensionPath: string;
}
