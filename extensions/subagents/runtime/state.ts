import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { CollaborationManager } from "./collaboration-manager.ts";
import type { RootTreeBroker } from "./root-tree-broker.ts";
import type {
  RootTreeIdentity,
  SubagentRecord,
  SubagentSettings,
} from "../types.ts";
import type { PiInvocationBase } from "../utils.ts";
import type { PiMailbox } from "./pi-mailbox.ts";
import type { SelfTurnReporter } from "./self-turn-reporter.ts";

export interface SubagentRuntimeState {
  pi: ExtensionAPI;
  /** Direct live RPC pipes owned by this process; canonical tree state lives in broker. */
  active: Map<string, SubagentRecord>;
  /** Bounded terminal/unloaded UI history, never canonical routing authority. */
  history: Map<string, SubagentRecord>;
  /** Durable bounded controller metadata required to lazily recreate RPC pipes. */
  reloadRecords: Map<string, SubagentRecord>;
  latestCtx?: ExtensionContext;
  settings: SubagentSettings;
  insideChildId?: string;
  parentAnswerQueue: Promise<void>;
  currentDepth: number;
  envMaxDepth: number;
  /** True only when PI_SUBAGENT_MAX_DEPTH was explicitly supplied/inherited. */
  envMaxDepthExplicit: boolean;
  isChild: boolean;
  extensionPath: string;
  currentPath: string;
  projectTrusted: boolean;
  closing: boolean;
  /** One shared teardown operation for every concurrent shutdown caller. */
  shutdownPromise: Promise<void> | undefined;
  manager?: CollaborationManager;
  broker?: RootTreeBroker;
  brokerReady?: Promise<void>;
  brokerIdentity?: RootTreeIdentity;
  /** Root-owned capacity inherited by descendants and immune to child settings. */
  treeMaxResidentAgents?: number;
  treeMaxActiveAgents?: number;
  /** Pinned only after trusted session identity/settings are available. */
  invocationBase?: PiInvocationBase;
  selfInboxChain: Promise<void>;
  piMailbox?: PiMailbox;
  selfTurnReporter?: SelfTurnReporter;
  deliveredMailboxEventIds: Set<string>;
  completionBurstBytes: number;
  completionBurstEpoch: number;
  guardToken: object;
}

export interface CreateSubagentRuntimeStateInput {
  pi: ExtensionAPI;
  settings: SubagentSettings;
  currentDepth: number;
  envMaxDepth: number;
  envMaxDepthExplicit?: boolean;
  extensionPath: string;
  currentPath: string;
  guardToken: object;
  invocationBase?: PiInvocationBase;
}

/** Construct the complete process-local state in one place. */
export function createSubagentRuntimeState(
  input: CreateSubagentRuntimeStateInput,
): SubagentRuntimeState {
  return {
    pi: input.pi,
    active: new Map(),
    history: new Map(),
    reloadRecords: new Map(),
    settings: input.settings,
    parentAnswerQueue: Promise.resolve(),
    currentDepth: input.currentDepth,
    envMaxDepth: input.envMaxDepth,
    envMaxDepthExplicit:
      input.envMaxDepthExplicit ?? (input.currentDepth > 0),
    isChild: input.currentDepth > 0,
    extensionPath: input.extensionPath,
    currentPath: input.currentPath,
    projectTrusted: false,
    closing: false,
    shutdownPromise: undefined,
    invocationBase: input.invocationBase,
    selfInboxChain: Promise.resolve(),
    deliveredMailboxEventIds: new Set(),
    completionBurstBytes: 0,
    completionBurstEpoch: 0,
    guardToken: input.guardToken,
  };
}
