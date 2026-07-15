import type { RpcProcess } from "./rpc-process.ts";

export type ContextMode = "compact" | "fresh";
export type ForkTurns = "none" | "all" | `${number}`;
export type AgentMode = "v2" | "legacy" | "historical";
export type ProcessState =
  | "starting"
  | "alive"
  | "stopping"
  | "closed"
  | "crashed";
export type TurnState = "idle" | "running" | "interrupting";
export type TurnOutcome =
  | "none"
  | "completed"
  | "interrupted"
  | "errored";

/** UI/legacy projection retained for DelegateDetails compatibility. */
export type SubagentStatus =
  | "queued"
  | "starting"
  | "running"
  | "waiting_for_answer"
  | "completed"
  | "failed"
  | "aborted"
  | "interrupted"
  | "shutdown";

export type AgentStatus =
  | "pending_init"
  | "running"
  | "interrupted"
  | "shutdown"
  | "not_found"
  | { completed: string | null }
  | { errored: string };

export type TerminalAgentStatus = Exclude<
  AgentStatus,
  "pending_init" | "running"
>;

export interface WaitAgentCompletedDetails {
  agent_id: string;
  agent_name: string;
  agent_status: TerminalAgentStatus;
  /** Immutable broker terminal-event revision; absent for a current-state-only target observation. */
  terminal_revision?: number;
  active_epoch: number;
  connection_generation: number;
}

export interface WaitAgentResultDetails {
  message: string;
  timed_out: boolean;
  completed: WaitAgentCompletedDetails[];
  pending: string[];
}

export interface RootTreeIdentity {
  id: string;
  path: string;
  parentId?: string;
  parentPath?: string;
  depth: number;
  maxDepth: number;
  connectionGeneration?: number;
}

export type RootTreeResourceEffectKind =
  | "connect"
  | "disconnect"
  | "unload"
  | "reload"
  | "activate"
  | "deactivate";

export interface RootTreeEffectToken {
  readonly id: string;
  readonly kind: "reservation" | RootTreeResourceEffectKind;
  readonly path: string;
  readonly controllerPath: string;
  readonly epoch: number;
  readonly connectionGeneration: number;
}

export interface RootTreeReservationLease {
  readonly id: string;
  readonly epoch: number;
  readonly controllerPath: string;
  readonly residentClaim: boolean;
  readonly activeClaim: boolean;
  readonly createdAt: number;
}

/** Canonical root-owned record. Callers receive snapshots, never mutable entries. */
export interface RootTreeAgentRecord {
  id: string;
  path: string;
  taskName: string;
  parentId?: string;
  parentPath?: string;
  controllerPath: string;
  depth: number;
  maxDepth: number;
  connectionGeneration: number;
  status: AgentStatus;
  lastTaskMessage: string | null;
  lastOutput: string | null;
  resident: boolean;
  registered: boolean;
  reloadable: boolean;
  activeEpoch: number | null;
  nextActiveEpoch: number;
  mailboxPending: number;
  outboxPending: number;
  questionPending: boolean;
  resourceEpoch: number;
  /** Compact synthetic marker returned when heavy reload metadata was retired. */
  retired?: boolean;
  reservationLease?: RootTreeReservationLease;
  createdAt: number;
  updatedAt: number;
}

export type AskParentReason =
  | "need_decision"
  | "need_clarification"
  | "blocked"
  | "risk_detected"
  | "course_change";

export type RpcEvent = Record<string, any> & { type?: string };

export type RpcEventSummary = {
  type: string;
  timestamp: number;
  text?: string;
  toolName?: string;
  toolCallId?: string;
  args?: unknown;
  delegateDetails?: any;
  isError?: boolean;
};

export type LiveDelegateUpdater = {
  notify(force?: boolean): void;
  close(): void;
};

export interface SubagentSettings {
  maxDepth: number;
  defaultContext: ContextMode;
  handoffTokenBudget: number;
  handoffKeepRecentTokens: number;
  childTools: "inherit-parent-or-pi-default";
  returnMaxBytes: number;
  /** Independent model-facing asynchronous completion bound. */
  completionMessageMaxBytes: number;
  /** Aggregate accepted completion bytes per parent turn/window. */
  completionBurstMaxBytes: number;
  completionOutboxLimit: number;
  statusHistoryLimit: number;
  shortcut: string;
  persistSessions: boolean;
  sessionDir: string;
  showInNormalResume: boolean;
  killChildrenOnParentExit: boolean;
  allowChildSubagents: boolean;
  /** Root-tree-wide executing capacity, including the root process. */
  maxConcurrentAgents: number;
  /** Root-tree-wide resident capacity, including the root process. */
  maxPersistentAgents: number;
  rpcStartupTimeoutMs: number;
  rpcRequestTimeoutMs: number;
  rpcShutdownTimeoutMs: number;
  /** Explicit environment names inherited by child processes. */
  childEnvAllowlist: string[];
  askParentConfidential: boolean;
}

export interface UsageStats {
  input?: number;
  output?: number;
  total?: number;
  cost?: number;
  contextTokens?: number | null;
  contextPercent?: number | null;
}

export interface PendingQuestion {
  id: string;
  message: string;
  question?: string;
  reason: AskParentReason;
  blocking: boolean;
  recommendation?: string;
  options?: string[];
  createdAt: number;
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
  settled: boolean;
}

export interface CompletionActivity {
  readonly event_id: string;
  readonly agent_id: string;
  readonly agent_name: string;
  readonly turn_id: string;
  readonly outcome: "completed" | "errored";
  readonly output: string;
  readonly output_path?: string;
  readonly timestamp: number;
}

export interface BrokerMailboxItem {
  readonly seq: number;
  readonly eventId: string;
  readonly sender: string;
  readonly kind: "MESSAGE" | "NEW_TASK";
  readonly message: string;
  readonly triggerTurn: boolean;
}

export interface MailboxItem {
  seq: number;
  eventId: string;
  sender: string;
  envelope: string;
  message: string;
  triggerTurn: boolean;
  kind: "MESSAGE" | "NEW_TASK" | "FINAL_ANSWER";
}

export interface ActiveTurn {
  /** Target-local monotonic epoch. RPC events are consumed only by this epoch. */
  epoch: number;
  /** Stable protocol identity echoed by the child for every lifecycle event. */
  token: string;
  id: string;
  number: number;
  acceptance: "submitting" | "accepted" | "uncertain";
  state: "active" | "settled";
  interruptRequested: boolean;
  abortAccepted: boolean;
  abortResolution: "none" | "pending" | "accepted" | "rejected" | "unknown";
  startSeen: boolean;
  /** Distinguishes no assistant terminal event from a successful empty one. */
  terminalSeen: boolean;
  /** A final agent_end proves natural completion even with no assistant message. */
  naturalEndSeen: boolean;
  retryAttempt: number;
  transientErrors: string[];
  output: string;
  completionEventId?: string;
  assistantError?: string;
  turnError?: string;
  /** Settlement waits here while abort acceptance is unresolved. */
  pendingSettlementAt?: number;
  completion: Deferred<CompletionPayload>;
  settlement: Deferred<void>;
}

/** Immutable hand-off from the synchronous reducer to completion effects. */
export interface SettledTurnSnapshot {
  readonly epoch: number;
  readonly lifecycleEpoch: number;
  readonly id: string;
  readonly number: number;
  readonly outcome: Exclude<TurnOutcome, "none">;
  readonly output: string;
  readonly error?: string;
  readonly completionEventId?: string;
  readonly completion: Deferred<CompletionPayload>;
  readonly settledAt: number;
}

export type CompletionOutboxStage =
  | "processing"
  | "artifact_ready"
  | "injection_pending"
  | "accepted"
  | "observed";

export interface CompletionOutboxEvent extends CompletionActivity {
  readonly stage:
    CompletionOutboxStage;
  readonly content: string;
  readonly attempts: number;
}

export interface SelfCompletionOutboxEvent {
  readonly eventId: string;
  readonly lifecycleToken: string;
  readonly turnEpoch: number;
  readonly senderPath: string;
  readonly parentPath: string;
  readonly outcome: "completed" | "errored";
  readonly output: string;
  readonly error?: string;
  readonly artifactPath: string;
  readonly payload: string;
  readonly envelope: string;
  readonly stage: CompletionOutboxStage;
  readonly attempts: number;
  readonly createdAt: number;
}

export interface AgentSnapshot {
  agent_id: string;
  agent_name: string;
  task_name: string;
  agent_status: AgentStatus;
  depth: number;
  max_depth: number;
  context: ContextMode;
  reusable: boolean;
  turn_id: string | null;
  turn_count: number;
  pending_messages: number;
  created_at: number;
  updated_at: number;
  last_task_message: string | null;
  session_file?: string;
  session_dir?: string;
}

export interface SubagentRecord {
  id: string;
  generatedLabel: string;
  taskName: string;
  agentName: string;
  mode: AgentMode;
  parentId?: string;
  rootId: string;
  depth: number;
  maxDepth: number;
  status: SubagentStatus;
  processState: ProcessState;
  turnState: TurnState;
  turnOutcome: TurnOutcome;
  reusable: boolean;
  committed: boolean;
  intentionalClose: boolean;
  closeRequested: boolean;
  crashHandled: boolean;
  /** A transport that missed/corrupted a turn boundary can never be reused. */
  transportTainted: boolean;
  lifecycleAbort: AbortController;
  lifecycleEpoch: number;
  task: string;
  lastTaskMessage: string;
  contextMode: ContextMode;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  endedAt?: number;
  lastUsedAt: number;
  sessionFile?: string;
  sessionDir?: string;
  pid?: number;
  lastToolCall?: { name: string; argsSummary: string; timestamp: number };
  lastMessageSnippet?: string;
  streamingMessageBuffer?: string;
  finalOutput?: string;
  currentTurnOutput?: string;
  assistantError?: string;
  turnError?: string;
  error?: string;
  usage?: UsageStats;
  model?: string;
  thinkingLevel?: string;
  nestedActiveCount?: number;
  pendingQuestion?: PendingQuestion;
  client?: RpcProcess;
  events: RpcEventSummary[];
  completion?: Promise<CompletionPayload>;
  startup?: Promise<void>;
  startupResolve?: () => void;
  startupReject?: (error: Error) => void;
  operationChain: Promise<void>;
  mailbox: MailboxItem[];
  nextMailboxSeq: number;
  activeTurn?: ActiveTurn;
  nextTurnEpoch: number;
  currentTurnId?: string;
  pendingSettlement?: SettledTurnSnapshot;
  /** Mandatory terminal broker synchronization for the settled child epoch. */
  brokerSettlementSync?: { epoch: number; promise: Promise<void> };
  /** Bounded replay guard for lifecycle tokens belonging to closed turns. */
  closedTurnTokens: Set<string>;
  /** Last authoritative ingress sequence for active/recently closed tokens. */
  lifecycleSequences: Map<string, number>;
  fatalProtocolError?: string;
  settlementWatchdog?: NodeJS.Timeout;
  turnCount: number;
  turnCompletion?: Deferred<CompletionPayload>;
  settlementAck?: Deferred<void>;
  settledTurnIds: Set<string>;
  notifiedTurnIds: Set<string>;
  activityTurnIds: Set<string>;
  /** Mutable queue membership with immutable event snapshots. */
  completionOutbox: Map<string, Readonly<CompletionOutboxEvent>>;
  /** Controller mirror retained until the broker confirms child outbox clearance. */
  brokerPendingCompletionEventIds: Set<string>;
  activeSlotHeld: boolean;
  persistentSlotHeld: boolean;
  stopEventUpdates?: () => void;
  omittedTools?: string[];
  /** One-use child bootstrap credential, cleared after registration settles. */
  brokerCapability?: string;
  brokerGeneration?: number;
  brokerResident?: boolean;
  cleanupError?: string;
  /** Remove the local owner once transport termination is eventually confirmed. */
  removeAfterClose?: boolean;
  shutdownPromise?: Promise<void>;
  forkTurns?: ForkTurns;
  forkSessionFile?: string;
  spawnToolCallId?: string;
}

export interface DelegateDetails {
  id: string;
  label: string;
  status: SubagentStatus;
  contextMode: ContextMode;
  depth: number;
  maxDepth: number;
  task: string;
  sessionFile?: string;
  sessionDir?: string;
  lastMessageSnippet?: string;
  usage?: UsageStats;
  model?: string;
  thinkingLevel?: string;
  error?: string;
  finalOutput?: string;
  events: RpcEventSummary[];
}

export interface CompletionPayload {
  id: string;
  label: string;
  status: SubagentStatus;
  contextMode: ContextMode;
  depth: number;
  maxDepth: number;
  task: string;
  output: string;
  payload: string;
  wasSummarized: boolean;
  sessionFile?: string;
  sessionDir?: string;
  outputPath?: string;
  usage?: UsageStats;
  model?: string;
  thinkingLevel?: string;
  error?: string;
}

export interface AskParentInput {
  message: string;
  reason: AskParentReason;
  blocking?: boolean;
  question?: string;
  options?: string[];
  recommendation?: string;
}

/** Broker-authenticated request. Identity, lineage, ID, and time are trusted fields. */
export interface AskParentRequest extends Required<Pick<AskParentInput, "message" | "reason">> {
  id: string;
  childId: string;
  childPath: string;
  childLabel?: string;
  parentId: string;
  parentPath: string;
  depth: number;
  blocking: boolean;
  question?: string;
  options?: string[];
  recommendation?: string;
  lastMessageSnippet?: string;
  lastToolCall?: { name: string; argsSummary: string; timestamp: number };
  createdAt: number;
}

export interface AskParentAnswer {
  id: string;
  answer: string;
  answeredAt: number;
  aborted?: boolean;
}

export interface GlobalSubagentsStatus {
  running: number;
  total: number;
  waiting: number;
  nested: number;
  idle?: number;
  interrupted?: number;
  errored?: number;
  shutdown?: number;
  inside?: string;
  updatedAt: number;
  listeners: Set<() => void>;
}
