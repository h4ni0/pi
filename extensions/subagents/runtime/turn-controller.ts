import { SETTLED_TURN_ID_LIMIT } from "../constants.ts";
import { taskEnvelope } from "../prompts.ts";
import type {
  ActiveTurn,
  AgentSnapshot,
  CompletionPayload,
  ContextMode,
  ForkTurns,
  MailboxItem,
  RpcEvent,
  SettledTurnSnapshot,
  SubagentRecord,
} from "../types.ts";
import {
  createDeferred,
  errorMessage,
  extractMessageText,
  oneLine,
  requireNonEmptyString,
} from "../utils.ts";

interface LiveRecordFactoryBase {
  id: string;
  generatedLabel: string;
  taskName: string;
  agentName: string;
  parentId: string;
  rootId: string;
  depth: number;
  maxDepth: number;
  message: string;
  sessionDir: string;
  createdAt?: number;
}

export type LiveRecordFactoryInput = LiveRecordFactoryBase &
  (
    | {
        mode: "v2";
        forkTurns: ForkTurns;
        contextMode?: never;
      }
    | {
        mode: "legacy";
        contextMode: ContextMode;
        forkTurns?: never;
      }
  );

/** Construct every live lifecycle field exactly once. */
export function createLiveSubagentRecord(
  input: LiveRecordFactoryInput,
): SubagentRecord {
  const createdAt = input.createdAt ?? Date.now();
  const turnCompletion = createDeferred<CompletionPayload>();
  void turnCompletion.promise.catch(() => undefined);
  const settlement = createDeferred<void>();
  const activeTurn: ActiveTurn = {
    epoch: 1,
    token: lifecycleToken(input.id, 1),
    id: "turn_0001",
    number: 1,
    acceptance: "submitting",
    state: "active",
    interruptRequested: false,
    abortAccepted: false,
    abortResolution: "none",
    startSeen: false,
    terminalSeen: false,
    naturalEndSeen: false,
    retryAttempt: 0,
    transientErrors: [],
    output: "",
    completion: turnCompletion,
    settlement,
  };
  return {
    id: input.id,
    generatedLabel: input.generatedLabel,
    taskName: input.taskName,
    agentName: input.agentName,
    mode: input.mode,
    parentId: input.parentId,
    rootId: input.rootId,
    depth: input.depth,
    maxDepth: input.maxDepth,
    status: "queued",
    processState: "starting",
    turnState: "running",
    turnOutcome: "none",
    reusable: false,
    committed: false,
    intentionalClose: false,
    closeRequested: false,
    crashHandled: false,
    transportTainted: false,
    lifecycleAbort: new AbortController(),
    lifecycleEpoch: 1,
    task: input.message,
    lastTaskMessage: input.message,
    // contextMode is retained only as a legacy/UI compatibility projection.
    // Canonical v2 context selection is represented solely by forkTurns.
    contextMode: input.mode === "legacy" ? input.contextMode : "fresh",
    createdAt,
    updatedAt: createdAt,
    lastUsedAt: createdAt,
    sessionDir: input.sessionDir,
    nestedActiveCount: 0,
    events: [],
    operationChain: Promise.resolve(),
    mailbox: [],
    nextMailboxSeq: 1,
    activeTurn,
    nextTurnEpoch: 2,
    currentTurnId: activeTurn.id,
    turnCount: 1,
    turnCompletion,
    settlementAck: settlement,
    settledTurnIds: new Set(),
    closedTurnTokens: new Set(),
    lifecycleSequences: new Map(),
    notifiedTurnIds: new Set(),
    activityTurnIds: new Set(),
    completionOutbox: new Map(),
    brokerPendingCompletionEventIds: new Set(),
    activeSlotHeld: false,
    persistentSlotHeld: input.mode === "v2",
    shutdownPromise: undefined,
    forkTurns: input.mode === "v2" ? input.forkTurns : undefined,
  };
}

export interface HistoricalRecordFactoryInput {
  snapshot: AgentSnapshot;
  rootId: string;
  timestamp?: number;
}

/** Restore UI history without creating a live/reusable lifecycle. */
export function createHistoricalSubagentRecord(
  input: HistoricalRecordFactoryInput,
): SubagentRecord {
  const { snapshot } = input;
  const timestamp =
    input.timestamp ?? (snapshot.updated_at || snapshot.created_at || Date.now());
  const lifecycleAbort = new AbortController();
  lifecycleAbort.abort();
  return {
    id: snapshot.agent_id,
    generatedLabel: snapshot.task_name,
    taskName: snapshot.task_name,
    agentName: snapshot.agent_name,
    mode: "historical",
    rootId: input.rootId,
    depth: snapshot.depth,
    maxDepth: snapshot.max_depth,
    status: "shutdown",
    processState: "closed",
    turnState: "idle",
    turnOutcome: "none",
    reusable: false,
    committed: true,
    intentionalClose: true,
    closeRequested: true,
    crashHandled: false,
    transportTainted: false,
    lifecycleAbort,
    lifecycleEpoch: 1,
    task: snapshot.last_task_message ?? "historical agent",
    lastTaskMessage: snapshot.last_task_message ?? "historical agent",
    contextMode: snapshot.context,
    createdAt: snapshot.created_at,
    updatedAt: timestamp,
    lastUsedAt: timestamp,
    sessionFile: snapshot.session_file,
    sessionDir: snapshot.session_dir,
    events: [],
    operationChain: Promise.resolve(),
    mailbox: [],
    nextMailboxSeq: 1,
    nextTurnEpoch: Math.max(1, snapshot.turn_count + 1),
    currentTurnId: snapshot.turn_id ?? undefined,
    turnCount: snapshot.turn_count,
    settledTurnIds: new Set(),
    closedTurnTokens: new Set(),
    lifecycleSequences: new Map(),
    notifiedTurnIds: new Set(),
    activityTurnIds: new Set(),
    completionOutbox: new Map(),
    brokerPendingCompletionEventIds: new Set(),
    activeSlotHeld: false,
    persistentSlotHeld: false,
    shutdownPromise: undefined,
  };
}

export interface MailboxItemInput {
  sender: string;
  kind: MailboxItem["kind"];
  message: string;
  triggerTurn: boolean;
  eventId?: string;
}

/** Assign a target-local monotonic sequence and preserve message bytes. */
export function createMailboxItem(
  record: SubagentRecord,
  input: MailboxItemInput,
): MailboxItem {
  const message = requireNonEmptyString(input.message, "message");
  const seq = record.nextMailboxSeq++;
  return {
    seq,
    eventId: input.eventId ?? `mail_${record.id}_${String(seq).padStart(8, "0")}`,
    sender: input.sender,
    envelope: taskEnvelope(input.kind, record.agentName, input.sender, message),
    message,
    triggerTurn: input.triggerTurn,
    kind: input.kind,
  };
}

export type TurnLifecycleAction =
  | { type: "install"; message: string; timestamp: number }
  | { type: "prompt_accepted"; epoch: number }
  | { type: "prompt_uncertain"; epoch: number }
  | { type: "interrupt_requested"; epoch: number }
  | { type: "interrupt_accepted"; epoch: number; timestamp?: number }
  | { type: "interrupt_rejected"; epoch: number; acceptance: "rejected" | "unknown"; timestamp?: number }
  | { type: "rpc_event"; epoch: number; token: string; event: RpcEvent; timestamp: number }
  | { type: "slot_acquired"; slot: "active" | "persistent" }
  | { type: "slot_released"; slot: "active" | "persistent" }
  | { type: "process_started"; pid?: number; timestamp: number }
  | { type: "spawn_committed"; timestamp: number }
  | { type: "spawn_failed"; error: string; timestamp: number }
  | { type: "legacy_outcome"; outcome: "aborted" | "failed"; error?: string; timestamp: number }
  | { type: "question_waiting" | "question_resolved"; timestamp: number }
  | { type: "taint"; error: string; timestamp: number }
  | { type: "settlement_effect_failed"; epoch: number; error: string; timestamp: number }
  | { type: "close"; reason: string; timestamp: number }
  | { type: "close_completed"; lifecycleEpoch: number; reason: string; timestamp: number }
  | { type: "close_failed"; lifecycleEpoch: number; error: string; timestamp: number }
  | { type: "crash"; error: string; timestamp: number }
  | { type: "crash_cleanup_completed"; lifecycleEpoch: number; timestamp: number }
  | { type: "crash_cleanup_failed"; lifecycleEpoch: number; error: string; timestamp: number };

export interface TurnReducerResult {
  installed?: ActiveTurn;
  settled?: SettledTurnSnapshot;
  releasedActiveSlot?: boolean;
  duplicateSettlement?: boolean;
  pendingSettlement?: boolean;
  armSettlementWatchdog?: boolean;
  ignored?: boolean;
  protocolViolation?: string;
}

const CLOSED_TOKEN_LIMIT = 128;

function lifecycleToken(recordId: string, epoch: number): string {
  return `${recordId}.${epoch}`;
}

function rememberClosedToken(record: SubagentRecord, token: string): void {
  record.closedTurnTokens.add(token);
  while (record.closedTurnTokens.size > CLOSED_TOKEN_LIMIT) {
    const oldest = record.closedTurnTokens.values().next().value as string | undefined;
    if (oldest === undefined) break;
    record.closedTurnTokens.delete(oldest);
  }
}

export function rememberSettledTurnId(
  record: SubagentRecord,
  turnId: string,
): void {
  record.settledTurnIds.add(turnId);
  while (record.settledTurnIds.size > SETTLED_TURN_ID_LIMIT) {
    const oldest = record.settledTurnIds.values().next().value as string | undefined;
    if (oldest === undefined) break;
    record.settledTurnIds.delete(oldest);
  }
}

function quarantineUncertainAbortSettlement(
  record: SubagentRecord,
  turn: ActiveTurn,
  timestamp: number,
): TurnReducerResult {
  const error = `Abort acceptance was unknown when turn epoch ${turn.epoch} settled without a natural terminal`;
  turn.pendingSettlementAt ??= timestamp;
  turn.turnError ??= error;
  record.transportTainted = true;
  record.reusable = false;
  record.turnError ??= error;
  record.error ??= error;
  record.updatedAt = timestamp;
  return { pendingSettlement: true };
}

function settleActiveTurn(
  record: SubagentRecord,
  turn: ActiveTurn,
  timestamp: number,
): TurnReducerResult {
  turn.state = "settled";
  turn.pendingSettlementAt = undefined;
  turn.settlement.resolve(undefined);
  rememberClosedToken(record, turn.token);
  const effectiveError = turn.assistantError ?? turn.turnError;
  const outcome = effectiveError
    ? "errored"
    : turn.interruptRequested &&
        turn.abortResolution === "accepted" &&
        !turn.terminalSeen &&
        !turn.naturalEndSeen
      ? "interrupted"
      : "completed";
  const snapshot: SettledTurnSnapshot = Object.freeze({
    epoch: turn.epoch,
    lifecycleEpoch: record.lifecycleEpoch,
    id: turn.id,
    number: turn.number,
    outcome,
    output: turn.output,
    error: effectiveError,
    completionEventId: turn.completionEventId,
    completion: turn.completion,
    settledAt: timestamp,
  });
  rememberSettledTurnId(record, turn.id);
  record.turnOutcome = outcome;
  record.turnState = "idle";
  record.status = outcome === "errored" ? "failed" : outcome === "interrupted" ? "interrupted" : "completed";
  record.currentTurnOutput = turn.output;
  record.finalOutput = turn.output;
  record.assistantError = turn.assistantError;
  record.turnError = effectiveError;
  record.error = effectiveError;
  record.reusable = record.processState === "alive" && !record.transportTainted;
  record.endedAt = timestamp;
  record.updatedAt = timestamp;
  record.lastUsedAt = timestamp;
  const releasedActiveSlot = record.activeSlotHeld;
  record.activeSlotHeld = false;
  return { settled: snapshot, releasedActiveSlot };
}

/** The sole post-construction writer for process, slot, close and turn lifecycle. */
export function reduceTurnLifecycle(
  record: SubagentRecord,
  action: TurnLifecycleAction,
): TurnReducerResult {
  if (action.type === "slot_acquired") {
    if (action.slot === "active") record.activeSlotHeld = true;
    else record.persistentSlotHeld = true;
    return {};
  }
  if (action.type === "slot_released") {
    if (action.slot === "active") record.activeSlotHeld = false;
    else record.persistentSlotHeld = false;
    return {};
  }
  if (action.type === "process_started") {
    if (record.closeRequested) return { ignored: true };
    record.pid = action.pid;
    record.processState = "alive";
    record.reusable = !record.transportTainted;
    record.status = "starting";
    record.startedAt ??= action.timestamp;
    return {};
  }
  if (action.type === "spawn_committed") {
    if (record.closeRequested || record.fatalProtocolError) return { ignored: true };
    record.committed = true;
    if (record.activeTurn?.state === "active") {
      record.status = "running";
      record.turnState = "running";
    }
    record.updatedAt = action.timestamp;
    return {};
  }
  if (action.type === "spawn_failed") {
    record.status = "failed";
    record.reusable = false;
    record.error = oneLine(action.error, 2_000);
    record.updatedAt = action.timestamp;
    return {};
  }
  if (action.type === "legacy_outcome") {
    record.status = action.outcome;
    record.turnOutcome = action.outcome === "aborted" ? "interrupted" : "errored";
    record.reusable = false;
    if (action.error) record.error = oneLine(action.error, 2_000);
    record.updatedAt = action.timestamp;
    return {};
  }
  if (action.type === "question_waiting") {
    record.status = "waiting_for_answer";
    record.updatedAt = action.timestamp;
    return {};
  }
  if (action.type === "question_resolved") {
    if (record.status === "waiting_for_answer") record.status = "running";
    record.updatedAt = action.timestamp;
    return {};
  }
  if (action.type === "taint") {
    record.transportTainted = true;
    record.reusable = false;
    if (record.activeTurn?.state === "active") record.activeTurn.turnError ??= action.error;
    record.turnError ??= action.error;
    record.error ??= action.error;
    record.updatedAt = action.timestamp;
    return {};
  }
  if (action.type === "settlement_effect_failed") {
    if (record.activeTurn?.epoch !== action.epoch || record.activeTurn.state !== "settled")
      return { ignored: true };
    record.turnError = oneLine(action.error, 2_000);
    record.error = record.turnError;
    record.turnOutcome = "errored";
    record.turnState = "idle";
    record.status = "failed";
    record.updatedAt = action.timestamp;
    record.endedAt = action.timestamp;
    const releasedActiveSlot = record.activeSlotHeld;
    record.activeSlotHeld = false;
    return { releasedActiveSlot };
  }
  if (action.type === "install") {
    if (record.closeRequested || record.processState !== "alive")
      throw new Error(`Agent ${record.agentName} cannot start a turn while ${record.processState}`);
    if (record.activeTurn?.state === "active")
      throw new Error(`Agent ${record.agentName} still owns active turn epoch ${record.activeTurn.epoch}`);
    const completion = createDeferred<CompletionPayload>();
    void completion.promise.catch(() => undefined);
    const settlement = createDeferred<void>();
    const number = record.turnCount + 1;
    const epoch = record.nextTurnEpoch++;
    const turn: ActiveTurn = {
      epoch,
      token: lifecycleToken(record.id, epoch),
      id: `turn_${String(number).padStart(4, "0")}`,
      number,
      acceptance: "submitting",
      state: "active",
      interruptRequested: false,
      abortAccepted: false,
      abortResolution: "none",
      startSeen: false,
      terminalSeen: false,
      naturalEndSeen: false,
      retryAttempt: 0,
      transientErrors: [],
      output: "",
      completion,
      settlement,
    };
    record.activeTurn = turn;
    record.turnCount = number;
    record.currentTurnId = turn.id;
    record.turnCompletion = completion;
    record.settlementAck = settlement;
    record.turnState = "running";
    record.turnOutcome = "none";
    record.status = "running";
    record.currentTurnOutput = undefined;
    record.finalOutput = undefined;
    record.streamingMessageBuffer = undefined;
    record.assistantError = undefined;
    record.turnError = undefined;
    record.error = undefined;
    record.lastTaskMessage = action.message;
    record.startedAt = action.timestamp;
    record.endedAt = undefined;
    record.updatedAt = action.timestamp;
    record.lastUsedAt = action.timestamp;
    return { installed: turn };
  }

  if (action.type === "close") {
    if (record.closeRequested) return { ignored: true };
    record.lifecycleEpoch += 1;
    record.closeRequested = true;
    record.intentionalClose = true;
    record.reusable = false;
    record.processState = "stopping";
    record.status = "shutdown";
    record.lifecycleAbort.abort();
    if (record.settlementWatchdog) clearTimeout(record.settlementWatchdog);
    record.settlementWatchdog = undefined;
    return {};
  }
  if (action.type === "close_completed") {
    if (record.lifecycleEpoch !== action.lifecycleEpoch || !record.closeRequested)
      return { ignored: true };
    record.processState = "closed";
    record.turnState = "idle";
    record.status = "shutdown";
    record.turnOutcome = record.turnOutcome === "none" ? "interrupted" : record.turnOutcome;
    record.error ??= action.reason;
    record.endedAt ??= action.timestamp;
    record.updatedAt = action.timestamp;
    record.reusable = false;
    const releasedActiveSlot = record.activeSlotHeld;
    record.activeSlotHeld = false;
    record.persistentSlotHeld = false;
    return { releasedActiveSlot };
  }
  if (action.type === "close_failed") {
    if (record.lifecycleEpoch !== action.lifecycleEpoch) return { ignored: true };
    record.processState = "stopping";
    record.cleanupError = oneLine(action.error, 2_000);
    record.error = record.cleanupError;
    record.reusable = false;
    record.updatedAt = action.timestamp;
    return {};
  }
  if (action.type === "crash") {
    if (record.crashHandled || record.intentionalClose || record.processState === "closed")
      return { ignored: true };
    record.lifecycleEpoch += 1;
    record.crashHandled = true;
    record.transportTainted = true;
    record.processState = "stopping";
    record.reusable = false;
    record.turnOutcome = "errored";
    record.status = "failed";
    record.error = oneLine(action.error, 2_000);
    record.turnError = record.error;
    record.endedAt = action.timestamp;
    record.updatedAt = action.timestamp;
    const turn = record.activeTurn;
    if (turn?.state === "active") {
      // A transport crash is terminal for this epoch even though active/resident
      // capacity remains owned until OS termination is confirmed.
      turn.state = "settled";
      turn.pendingSettlementAt = undefined;
      rememberClosedToken(record, turn.token);
    }
    if (record.settlementWatchdog) clearTimeout(record.settlementWatchdog);
    record.settlementWatchdog = undefined;
    return {};
  }
  if (action.type === "crash_cleanup_completed") {
    if (record.lifecycleEpoch !== action.lifecycleEpoch || !record.crashHandled)
      return { ignored: true };
    record.processState = "crashed";
    record.turnState = "idle";
    const releasedActiveSlot = record.activeSlotHeld;
    record.activeSlotHeld = false;
    record.persistentSlotHeld = false;
    return { releasedActiveSlot };
  }
  if (action.type === "crash_cleanup_failed") {
    if (record.lifecycleEpoch !== action.lifecycleEpoch) return { ignored: true };
    record.processState = "stopping";
    record.cleanupError = oneLine(action.error, 2_000);
    record.error = `${record.error ?? "Child crashed"}; cleanup failed: ${record.cleanupError}`;
    return {};
  }

  if (record.closeRequested || record.crashHandled) return { ignored: true };
  const turn = record.activeTurn;
  if (!turn || turn.state !== "active") {
    if (action.type === "rpc_event" && record.closedTurnTokens.has(action.token))
      return { duplicateSettlement: action.event.type === "agent_settled", ignored: true };
    if (action.type === "rpc_event" && action.event.type === "agent_start") {
      const protocolViolation = "Unsolicited agent_start without an active turn token";
      record.transportTainted = true;
      record.reusable = false;
      record.fatalProtocolError ??= protocolViolation;
      return { protocolViolation };
    }
    return { ignored: true };
  }

  const actionEpoch = "epoch" in action ? action.epoch : undefined;
  if (actionEpoch !== undefined && actionEpoch !== turn.epoch) return { ignored: true };

  if (action.type === "prompt_accepted") {
    turn.acceptance = "accepted";
    return {};
  }
  if (action.type === "prompt_uncertain") {
    turn.acceptance = "uncertain";
    return {};
  }
  if (action.type === "interrupt_requested") {
    turn.interruptRequested = true;
    turn.abortResolution = "pending";
    record.turnState = "interrupting";
    return {};
  }
  if (action.type === "interrupt_accepted") {
    turn.abortAccepted = true;
    turn.abortResolution = "accepted";
    return turn.pendingSettlementAt === undefined
      ? {}
      : settleActiveTurn(record, turn, turn.pendingSettlementAt || action.timestamp || Date.now());
  }
  if (action.type === "interrupt_rejected") {
    turn.abortAccepted = false;
    turn.abortResolution = action.acceptance;
    if (
      action.acceptance === "unknown" &&
      turn.pendingSettlementAt !== undefined &&
      !turn.terminalSeen &&
      !turn.naturalEndSeen
    ) {
      record.turnState = "interrupting";
      return quarantineUncertainAbortSettlement(
        record,
        turn,
        turn.pendingSettlementAt || action.timestamp || Date.now(),
      );
    }
    record.turnState = "running";
    return turn.pendingSettlementAt === undefined
      ? {}
      : settleActiveTurn(record, turn, turn.pendingSettlementAt || action.timestamp || Date.now());
  }
  if (action.type !== "rpc_event") return { ignored: true };

  if (record.closedTurnTokens.has(action.token))
    return { duplicateSettlement: action.event.type === "agent_settled", ignored: true };
  if (action.token !== turn.token || action.epoch !== turn.epoch) {
    const protocolViolation = `Lifecycle token ${action.token || "<missing>"} does not identify active turn epoch ${turn.epoch}`;
    record.transportTainted = true;
    record.reusable = false;
    record.fatalProtocolError ??= protocolViolation;
    return { protocolViolation };
  }

  const { event } = action;
  if (event.type === "agent_start") {
    if (turn.startSeen) {
      const protocolViolation = `Duplicate agent_start for turn epoch ${turn.epoch}`;
      record.transportTainted = true;
      record.reusable = false;
      record.fatalProtocolError ??= protocolViolation;
      return { protocolViolation };
    }
    turn.startSeen = true;
    turn.acceptance = "accepted";
    record.status = "running";
    record.turnState = turn.interruptRequested ? "interrupting" : "running";
    record.startedAt ??= action.timestamp;
    return {};
  }
  if ((event.type === "message_end" || event.type === "turn_end") && event.message?.role === "assistant") {
    const text = extractMessageText(event.message).trim();
    turn.terminalSeen = true;
    turn.output = text;
    turn.assistantError = event.message.stopReason === "error"
      ? event.message.errorMessage || "Child assistant turn failed"
      : undefined;
    if (!turn.assistantError) turn.turnError = undefined;
    record.currentTurnOutput = text;
    record.finalOutput = text;
    record.lastMessageSnippet = text ? oneLine(text, 260) : undefined;
    record.assistantError = turn.assistantError;
    record.turnError = turn.turnError;
    return {};
  }
  if (event.type === "agent_end") {
    if (event.willRetry === true) {
      const transient = turn.assistantError ?? turn.turnError;
      if (transient) turn.transientErrors.push(transient);
      turn.retryAttempt += 1;
      // Pi emits a fresh agent_start for each provider retry inside the same
      // logical turn. Reset only the attempt-local start marker so a genuine
      // duplicate within one attempt still fails closed.
      turn.startSeen = false;
      turn.assistantError = undefined;
      turn.turnError = undefined;
      turn.terminalSeen = false;
      turn.naturalEndSeen = false;
      record.assistantError = undefined;
      record.turnError = undefined;
      return {};
    }
    turn.naturalEndSeen = true;
    return { armSettlementWatchdog: true };
  }
  if (event.type === "extension_error") {
    const message = oneLine(event.error ?? "child extension error", 1_000);
    turn.turnError = message;
    record.turnError = message;
    return {};
  }
  if (event.type !== "agent_settled") return {};
  if (typeof event.completion_event_id === "string")
    turn.completionEventId = event.completion_event_id;
  if (!turn.startSeen) {
    const protocolViolation = `agent_settled arrived before agent_start for turn epoch ${turn.epoch}`;
    record.transportTainted = true;
    record.reusable = false;
    record.fatalProtocolError ??= protocolViolation;
    return { protocolViolation };
  }
  if (record.settlementWatchdog) clearTimeout(record.settlementWatchdog);
  record.settlementWatchdog = undefined;
  if (turn.interruptRequested && turn.abortResolution === "pending") {
    turn.pendingSettlementAt = action.timestamp;
    return { pendingSettlement: true };
  }
  if (
    turn.interruptRequested &&
    turn.abortResolution === "unknown" &&
    !turn.terminalSeen &&
    !turn.naturalEndSeen
  ) {
    return quarantineUncertainAbortSettlement(record, turn, action.timestamp);
  }
  return settleActiveTurn(record, turn, action.timestamp);
}

/** Mark an uncertain/missing boundary unusable before closing its transport. */
export function taintTurnTransport(record: SubagentRecord, reason: unknown): void {
  reduceTurnLifecycle(record, {
    type: "taint",
    error: oneLine(errorMessage(reason), 2_000),
    timestamp: Date.now(),
  });
}

/**
 * Serialize command effects for one child without a manager-global lock.
 * Lifecycle commits themselves go through reduceTurnLifecycle synchronously.
 */
export function enqueueAgentOperation<T>(
  record: SubagentRecord,
  operation: () => Promise<T> | T,
): Promise<T> {
  const run = record.operationChain.then(operation, operation);
  record.operationChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
