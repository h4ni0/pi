import * as fs from "node:fs";
import * as path from "node:path";
import {
  ASK_PARENT_POLL_MS,
  BRIDGE_POLL_MS,
} from "../../constants.ts";
import type { AskParentAnswer, AskParentRequest, SubagentRecord } from "../../types.ts";
import {
  currentProcessAgentId,
  now,
  removeFileQuietly,
  safeReadJson,
  safeWriteJson,
  sleep,
} from "../../utils.ts";
import type { SubagentRuntimeState } from "../state.ts";

export async function askParentViaBridge(
  state: SubagentRuntimeState,
  request: Omit<AskParentRequest, "id" | "childId" | "depth" | "createdAt">,
  signal?: AbortSignal,
): Promise<AskParentAnswer> {
  const bridgeDir = process.env.PI_SUBAGENT_BRIDGE_DIR;
  if (!bridgeDir) {
    return {
      id: "local_no_bridge",
      answer: "No parent bridge is available. Stop and report this blocker.",
      answeredAt: now(),
      aborted: true,
    };
  }
  const id = `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const fullRequest: AskParentRequest = {
    ...request,
    id,
    childId: currentProcessAgentId(state.latestCtx),
    childLabel: process.env.PI_SUBAGENT_LABEL,
    depth: state.currentDepth,
    createdAt: now(),
  };
  const requestPath = path.join(bridgeDir, "requests", `${id}.json`);
  const answerPath = path.join(bridgeDir, "answers", `${id}.json`);
  safeWriteJson(requestPath, fullRequest);
  if (!fullRequest.blocking) {
    return {
      id,
      answer: "Parent notified. Continue with the safe next step unless steered otherwise.",
      answeredAt: now(),
    };
  }
  while (true) {
    if (signal?.aborted) throw new Error("ask_parent aborted");
    const answer = safeReadJson<AskParentAnswer>(answerPath);
    if (answer) {
      removeFileQuietly(answerPath);
      return answer;
    }
    await sleep(ASK_PARENT_POLL_MS, signal);
  }
}

export function startBridgeRequestWatcher(
  record: SubagentRecord,
  onRequest: (request: AskParentRequest) => void,
) {
  if (!record.bridgeDir) return;
  const requestsDir = path.join(record.bridgeDir, "requests");
  record.bridgeTimer = setInterval(() => {
    let files: string[] = [];
    try {
      files = fs.readdirSync(requestsDir).filter((file) => file.endsWith(".json"));
    } catch {
      return;
    }
    for (const file of files) {
      const request = safeReadJson<AskParentRequest>(path.join(requestsDir, file));
      if (request) onRequest(request);
    }
  }, BRIDGE_POLL_MS);
}
