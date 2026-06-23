import type { RpcProcess } from "./rpc-process.ts";

export type ContextMode = "compact" | "fresh";
export type SubagentStatus =
  | "queued"
  | "starting"
  | "running"
  | "waiting_for_answer"
  | "completed"
  | "failed"
  | "aborted";
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
  statusHistoryLimit: number;
  shortcut: string;
  persistSessions: boolean;
  sessionDir: string;
  showInNormalResume: boolean;
  killChildrenOnParentExit: boolean;
  allowChildSubagents: boolean;
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

export interface SubagentRecord {
  id: string;
  generatedLabel: string;
  parentId?: string;
  rootId: string;
  depth: number;
  status: SubagentStatus;
  task: string;
  contextMode: ContextMode;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  sessionFile?: string;
  sessionDir?: string;
  bridgeDir?: string;
  pid?: number;
  lastToolCall?: { name: string; argsSummary: string; timestamp: number };
  lastMessageSnippet?: string;
  streamingMessageBuffer?: string;
  finalOutput?: string;
  error?: string;
  usage?: UsageStats;
  model?: string;
  thinkingLevel?: string;
  nestedActiveCount?: number;
  pendingQuestion?: PendingQuestion;
  client?: RpcProcess;
  events: RpcEventSummary[];
  handledBridgeRequestIds: Set<string>;
  bridgeTimer?: NodeJS.Timeout;
  completion?: Promise<CompletionPayload>;
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

export interface AskParentRequest {
  id: string;
  childId: string;
  childLabel?: string;
  depth: number;
  message: string;
  reason: AskParentReason;
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
  inside?: string;
  updatedAt: number;
  listeners: Set<() => void>;
}
