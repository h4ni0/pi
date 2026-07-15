import type {
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  ContextMode,
  DelegateDetails,
} from "../types.ts";
import type { SubagentRuntimeState } from "./state.ts";

/** Legacy public adapter backed by the same persistent-RPC collaboration manager. */
export async function spawnDelegate(
  state: SubagentRuntimeState,
  params: { title?: string; task: string; context?: ContextMode },
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<DelegateDetails> | undefined,
  ctx: ExtensionContext,
): Promise<AgentToolResult<DelegateDetails>> {
  if (!state.manager) throw new Error("Collaboration manager is not initialized");
  return state.manager.delegate(params, signal, onUpdate, ctx);
}
