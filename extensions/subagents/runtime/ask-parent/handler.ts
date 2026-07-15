import type {
  AskParentRequest,
  PendingQuestion,
  SubagentRecord,
} from "../../types.ts";
import { errorMessage, now, oneLine } from "../../utils.ts";
import { pushEventSummary } from "../records.ts";
import { updateStatus } from "../status-ui.ts";
import type { SubagentRuntimeState } from "../state.ts";
import { reduceTurnLifecycle } from "../turn-controller.ts";
import {
  AskParentAnswerLimitError,
  answerQuestionForChild,
  finalizeAskParentAnswer,
} from "./response.ts";

export interface AskParentDispatchAnswer {
  requestId: string;
  answer: string;
  answeredAt: number;
  modelCalls: 0 | 1;
}

interface LocalClaim {
  childPath: string;
  connectionGeneration: number;
  lifecycleEpoch: number;
  promise: Promise<AskParentDispatchAnswer>;
}

const CLAIM_CACHE_LIMIT = 512;
const claimsByState = new WeakMap<SubagentRuntimeState, Map<string, LocalClaim>>();

/**
 * Trusted immediate-parent endpoint. The broker supplies and authenticates all
 * identity/lineage fields; this process independently binds them to its owned
 * direct-child record before doing any reasoning.
 */
export function handleBrokerAskParentRequest(
  state: SubagentRuntimeState,
  record: SubagentRecord,
  request: AskParentRequest,
  connectionGeneration: number,
  signal?: AbortSignal,
): Promise<AskParentDispatchAnswer> {
  validateTrustedRequest(state, record, request, connectionGeneration);
  if (state.closing) throw new Error("Parent session is shutting down");

  let claims = claimsByState.get(state);
  if (!claims) {
    claims = new Map();
    claimsByState.set(state, claims);
  }
  const existing = claims.get(request.id);
  if (existing) {
    if (
      existing.childPath !== record.agentName ||
      existing.connectionGeneration !== connectionGeneration
    ) throw new Error("ask_parent request id replayed for a different child epoch");
    return existing.promise;
  }

  const lifecycleEpoch = record.lifecycleEpoch;
  const signals = [record.lifecycleAbort.signal];
  if (signal) signals.push(signal);
  const combined = signals.length === 1 ? signals[0]! : AbortSignal.any(signals);
  const promise = answerOnce(
    state,
    record,
    request,
    lifecycleEpoch,
    combined,
  );
  const claim: LocalClaim = {
    childPath: record.agentName,
    connectionGeneration,
    lifecycleEpoch,
    promise,
  };
  claims.set(request.id, claim);
  trimClaims(claims);
  void promise.catch((error) => {
    if (isAbort(error) && claims?.get(request.id) === claim)
      claims.delete(request.id); // cancellation releases the claim
  });
  return promise;
}

async function answerOnce(
  state: SubagentRuntimeState,
  record: SubagentRecord,
  request: AskParentRequest,
  lifecycleEpoch: number,
  signal: AbortSignal,
): Promise<AskParentDispatchAnswer> {
  assertLive(state, record, lifecycleEpoch, signal);
  const enriched: AskParentRequest = {
    ...request,
    lastMessageSnippet: record.lastMessageSnippet,
    lastToolCall: record.lastToolCall,
  };
  const pending: PendingQuestion = {
    id: enriched.id,
    message: enriched.message,
    question: enriched.question,
    reason: enriched.reason,
    blocking: enriched.blocking,
    recommendation: enriched.recommendation,
    options: enriched.options,
    createdAt: enriched.createdAt,
  };
  record.pendingQuestion = pending;
  if (enriched.blocking)
    reduceTurnLifecycle(record, { type: "question_waiting", timestamp: now() });
  updateStatus(state);

  try {
    const result = await answerQuestionForChild(
      state,
      record,
      enriched,
      signal,
      lifecycleEpoch,
    );
    assertLive(state, record, lifecycleEpoch, signal);
    const finalized = finalizeAskParentAnswer(result.answer);
    pushEventSummary(record, {
      type: "parent_answer",
      timestamp: now(),
      text: oneLine(finalized, 220),
    });
    return {
      requestId: enriched.id,
      answer: finalized,
      answeredAt: now(),
      modelCalls: result.modelCalls,
    };
  } catch (error) {
    if (
      !enriched.blocking ||
      error instanceof AskParentAnswerLimitError ||
      isAbort(error)
    ) throw error;
    assertLive(state, record, lifecycleEpoch, signal);
    const answer = finalizeAskParentAnswer(
      `The parent failed to answer: ${errorMessage(error)}. Stop and report this blocker.`,
    );
    record.error ??= `parent agent answer failed: ${errorMessage(error)}`;
    pushEventSummary(record, {
      type: "parent_answer",
      timestamp: now(),
      text: oneLine(answer, 220),
    });
    return {
      requestId: enriched.id,
      answer,
      answeredAt: now(),
      modelCalls: 0,
    };
  } finally {
    if (isLive(state, record, lifecycleEpoch)) {
      record.pendingQuestion = undefined;
      reduceTurnLifecycle(record, { type: "question_resolved", timestamp: now() });
      updateStatus(state);
    }
  }
}

function validateTrustedRequest(
  state: SubagentRuntimeState,
  record: SubagentRecord,
  request: AskParentRequest,
  connectionGeneration: number,
): void {
  const expectedKeys = new Set([
    "id",
    "childId",
    "childPath",
    "childLabel",
    "parentId",
    "parentPath",
    "depth",
    "message",
    "reason",
    "blocking",
    "question",
    "options",
    "recommendation",
    "createdAt",
  ]);
  if (!request || typeof request !== "object" || Array.isArray(request))
    throw new Error("Invalid trusted ask_parent request");
  for (const key of Object.keys(request))
    if (!expectedKeys.has(key))
      throw new Error(`Unknown trusted ask_parent request field '${key}'`);
  if (
    !/^q_[a-f0-9]{36}$/.test(request.id) ||
    request.childId !== record.id ||
    request.childPath !== record.agentName ||
    request.parentId !== state.brokerIdentity?.id ||
    request.parentPath !== state.currentPath ||
    request.depth !== state.currentDepth + 1 ||
    record.depth !== request.depth ||
    record.brokerGeneration !== connectionGeneration
  ) throw new Error("Trusted ask_parent identity, lineage, or epoch mismatch");
}

function assertLive(
  state: SubagentRuntimeState,
  record: SubagentRecord,
  lifecycleEpoch: number,
  signal: AbortSignal,
): void {
  if (signal.aborted || !isLive(state, record, lifecycleEpoch)) {
    const error = new Error("ask_parent work aborted or stale");
    error.name = "AbortError";
    throw error;
  }
}

function isLive(
  state: SubagentRuntimeState,
  record: SubagentRecord,
  lifecycleEpoch: number,
): boolean {
  return !state.closing &&
    !record.closeRequested &&
    !record.lifecycleAbort.signal.aborted &&
    record.lifecycleEpoch === lifecycleEpoch;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error &&
    (error.name === "AbortError" || /abort|stale|shut/i.test(error.message));
}

function trimClaims(claims: Map<string, LocalClaim>): void {
  while (claims.size > CLAIM_CACHE_LIMIT) {
    const oldest = claims.keys().next().value as string | undefined;
    if (!oldest) break;
    claims.delete(oldest);
  }
}
