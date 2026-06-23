import * as path from "node:path";
import type { AskParentAnswer, AskParentRequest, PendingQuestion, SubagentRecord } from "../../types.ts";
import { now, oneLine, removeFileQuietly, safeWriteJson } from "../../utils.ts";
import { updateStatus } from "../status-ui.ts";
import type { SubagentRuntimeState } from "../state.ts";
import { answerQuestionForChild } from "./response.ts";

async function serializeParentAnswer<T>(
  state: SubagentRuntimeState,
  work: () => Promise<T>,
): Promise<T> {
  const run = state.parentAnswerQueue.then(work, work);
  state.parentAnswerQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function handleBridgeRequest(
  state: SubagentRuntimeState,
  record: SubagentRecord,
  request: AskParentRequest,
) {
  if (record.handledBridgeRequestIds.has(request.id)) return;
  record.handledBridgeRequestIds.add(request.id);
  const enrichedRequest = enrichAskParentRequest(record, request);
  const pending: PendingQuestion = {
    id: enrichedRequest.id,
    message: enrichedRequest.message,
    question: enrichedRequest.question,
    reason: enrichedRequest.reason,
    blocking: enrichedRequest.blocking,
    recommendation: enrichedRequest.recommendation,
    options: enrichedRequest.options,
    createdAt: enrichedRequest.createdAt,
  };
  record.pendingQuestion = pending;
  if (enrichedRequest.blocking) record.status = "waiting_for_answer";
  updateStatus(state);

  let answerText: string;
  try {
    answerText = await serializeParentAnswer(state, () =>
      answerQuestionForChild(state, record, enrichedRequest),
    );
  } catch (err) {
    answerText = `The parent failed to answer: ${err instanceof Error ? err.message : String(err)}. Stop and report this blocker.`;
  }

  const answer: AskParentAnswer = {
    id: enrichedRequest.id,
    answer: answerText,
    answeredAt: now(),
  };
  if (record.bridgeDir)
    safeWriteJson(
      path.join(record.bridgeDir, "answers", `${enrichedRequest.id}.json`),
      answer,
    );
  removeFileQuietly(
    path.join(record.bridgeDir ?? "", "requests", `${enrichedRequest.id}.json`),
  );
  record.pendingQuestion = undefined;
  if (record.status === "waiting_for_answer") record.status = "running";
  record.events.push({
    type: "parent_answer",
    timestamp: now(),
    text: oneLine(answerText, 220),
  });
  updateStatus(state);
}

function enrichAskParentRequest(
  record: SubagentRecord,
  request: AskParentRequest,
): AskParentRequest {
  return {
    ...request,
    lastMessageSnippet: request.lastMessageSnippet ?? record.lastMessageSnippet,
    lastToolCall: request.lastToolCall ?? record.lastToolCall,
  };
}
