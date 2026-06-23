import type { SubagentRecord } from "../types.ts";
import type { SubagentRuntimeState } from "./state.ts";
import { startBridgeRequestWatcher } from "./ask-parent/bridge.ts";
import { handleBridgeRequest } from "./ask-parent/handler.ts";

export { askParentViaBridge } from "./ask-parent/bridge.ts";
export { askUserQuestions } from "./ask-parent/ui.ts";

export function startBridgeWatcher(
  state: SubagentRuntimeState,
  record: SubagentRecord,
) {
  return startBridgeRequestWatcher(record, (request) => {
    void handleBridgeRequest(state, record, request);
  });
}
