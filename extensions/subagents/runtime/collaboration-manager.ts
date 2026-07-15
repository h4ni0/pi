import * as path from "node:path";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  BROKER_REPORT_OUTPUT_MAX_BYTES,
  COMPLETION_MESSAGE_TYPE,
  NOTICE_MESSAGE_TYPE,
  STATE_ENTRY_TYPE,
} from "../constants.ts";
import {
  parseForkTurns,
  parseWaitAgentInput,
  type SpawnAgentInput,
  type WaitAgentInput,
} from "../schemas.ts";
import {
  buildInitialPrompt,
  canonicalCompletionPayload,
  taskEnvelope,
} from "../prompts.ts";
import {
  RpcProcess,
  RpcRequestTimeoutError,
  type RpcProcessOptions,
} from "../rpc-process.ts";
import type {
  AgentSnapshot,
  AgentStatus,
  BrokerMailboxItem,
  CompletionActivity,
  CompletionPayload,
  ContextMode,
  DelegateDetails,
  ForkTurns,
  LiveDelegateUpdater,
  RpcEvent,
  SettledTurnSnapshot,
  SubagentRecord,
  WaitAgentResultDetails,
} from "../types.ts";
import {
  buildChildBrokerEnvironment,
  currentProcessAgentId,
  currentRootId,
  ensureDir,
  errorMessage,
  generatedLabel,
  getPiInvocation,
  makeId,
  now,
  readChildBrokerBootstrapEnvironment,
  requireNonEmptyString,
  resolvePiInvocationBase,
  oneLine,
  truncateUtf8,
} from "../utils.ts";
import { generateHandoffSummary, makeCompletionPayload } from "../summaries.ts";
import { parseSubagentStatusCount } from "../status.ts";
import { loadSettings } from "../settings.ts";
import { handleBrokerAskParentRequest } from "./ask-parent/handler.ts";
import {
  makeLiveUpdater,
  pushEvent,
  pushEventSummary,
  toDelegateDetails,
  usageFromStats,
} from "./records.ts";
import type { SubagentRuntimeState } from "./state.ts";
import { updateStatus } from "./status-ui.ts";
import {
  extensionSourcesForSpawn,
  type SpawnToolSources,
} from "./tool-list.ts";
import { prepareForkSeedSession } from "./fork-context.ts";
import {
  createHistoricalSubagentRecord,
  createLiveSubagentRecord,
  createMailboxItem,
  enqueueAgentOperation,
  reduceTurnLifecycle,
  rememberSettledTurnId,
  taintTurnTransport,
} from "./turn-controller.ts";
import {
  agentPathDepth,
  isAgentPathWithin,
  resolveAgentReference,
  resolveAgentReferenceWithAliases,
  validateAgentSegment,
} from "./agent-path.ts";
import { writeAgentMetadata, writeTurnArtifacts } from "./persistence.ts";
import { isTurnLifecycleEvent } from "./lifecycle-protocol.ts";
import {
  RootTreeBroker,
  type BrokerConnectionGrant,
  type BrokerDispatch,
} from "./root-tree-broker.ts";

interface SpawnResult {
  agent_id: string;
  agent_name: string;
  status: AgentStatus;
  depth: number;
  max_depth: number;
  fork_turns: ForkTurns;
  shared_workspace: true;
  omitted_tools?: string[];
}

interface ReservedRecord {
  record: SubagentRecord;
}

const RELOAD_RECORD_LIMIT = 1_024;

export type RpcProcessFactory = (
  command: string,
  args: string[],
  options: RpcProcessOptions,
) => RpcProcess;

export interface CollaborationManagerDependencies {
  generateHandoffSummary?: typeof generateHandoffSummary;
  makeCompletionPayload?: typeof makeCompletionPayload;
}

export class CollaborationManager {
  private readonly reservedNames = new Set<string>();
  private waitAbort?: AbortController;
  private readonly failedAudit: Array<{
    task_name: string;
    agent_name: string;
    error: string;
    timestamp: number;
  }> = [];

  constructor(
    private readonly state: SubagentRuntimeState,
    private readonly rpcFactory: RpcProcessFactory = (command, args, options) =>
      new RpcProcess(command, args, options),
    private readonly dependencies: CollaborationManagerDependencies = {},
  ) {}

  async initializeBroker(ctx: ExtensionContext): Promise<void> {
    if (this.state.broker) return;
    if (this.state.brokerReady) return this.state.brokerReady;
    const ready = this.initializeBrokerOnce(ctx);
    this.state.brokerReady = ready;
    try {
      await ready;
    } catch (error) {
      if (this.state.brokerReady === ready) this.state.brokerReady = undefined;
      throw error;
    }
  }

  private async initializeBrokerOnce(ctx: ExtensionContext): Promise<void> {
    this.state.latestCtx = ctx;
    this.state.invocationBase ??= resolvePiInvocationBase();
    const dispatch = (message: BrokerDispatch, signal?: AbortSignal) =>
      this.handleBrokerDispatch(message, signal);
    if (!this.state.isChild) {
      const identity = {
        id: currentProcessAgentId(ctx),
        path: "/root",
        depth: 0,
        maxDepth: this.state.settings.maxDepth,
        connectionGeneration: 1,
      } as const;
      const broker = await RootTreeBroker.createRoot({
        identity,
        maxResidentAgents: this.state.settings.maxPersistentAgents,
        maxActiveAgents: this.state.settings.maxConcurrentAgents,
        completionOutboxLimit: this.state.settings.completionOutboxLimit,
        dispatch,
      });
      this.state.brokerIdentity = identity;
      this.state.treeMaxResidentAgents = this.state.settings.maxPersistentAgents;
      this.state.treeMaxActiveAgents = this.state.settings.maxConcurrentAgents;
      this.state.broker = broker;
      return;
    }

    const bootstrap = readChildBrokerBootstrapEnvironment();
    if (
      bootstrap.identity.path !== this.state.currentPath ||
      bootstrap.identity.depth !== this.state.currentDepth ||
      bootstrap.identity.maxDepth !== this.state.envMaxDepth ||
      bootstrap.rootId !== currentRootId(ctx)
    ) throw new Error("Inherited child broker identity does not match runtime state");
    this.state.settings.maxDepth = bootstrap.identity.maxDepth;
    this.state.settings.maxPersistentAgents = bootstrap.maxResidentAgents;
    this.state.settings.maxConcurrentAgents = bootstrap.maxActiveAgents;
    this.state.treeMaxResidentAgents = bootstrap.maxResidentAgents;
    this.state.treeMaxActiveAgents = bootstrap.maxActiveAgents;
    const broker = await RootTreeBroker.connectChild({
      identity: bootstrap.identity,
      maxResidentAgents: bootstrap.maxResidentAgents,
      maxActiveAgents: bootstrap.maxActiveAgents,
      completionOutboxLimit: this.state.settings.completionOutboxLimit,
      socketPath: bootstrap.socketPath,
      capability: bootstrap.capability,
      dispatch,
    });
    this.state.brokerIdentity = bootstrap.identity;
    this.state.broker = broker;
  }

  async handleBrokerDispatch(
    dispatch: BrokerDispatch,
    signal?: AbortSignal,
  ): Promise<any> {
    if (signal?.aborted) throw abortFailure("Broker dispatch aborted");
    switch (dispatch.op) {
      case "inbox":
        return this.dispatchSelfInbox(dispatch.payload, signal);
      case "deliver_mailbox":
        return this.deliverBrokerMailbox(dispatch.payload, signal);
      case "prepare_followup": {
        const record = this.requireOwnedDispatchRecord(dispatch.payload);
        await this.awaitStartup(record);
        return enqueueAgentOperation(record, async () => {
          this.assertManageable(record);
          if (!record.reusable || record.turnState !== "idle") {
            await this.awaitBrokerSettlementSync(
              record,
              Number(dispatch.payload?.activeEpoch),
            );
            if (!record.reusable || record.turnState !== "idle")
              throw new Error(`Agent ${record.agentName} cannot accept an idle follow-up`);
          }
          return {};
        });
      }
      case "interrupt": {
        const record = this.requireOwnedDispatchRecord(dispatch.payload);
        return this.interruptOwnedAgent(
          record.id,
          dispatch.payload?.expectedActiveEpoch,
          dispatch.payload?.connectionGeneration,
        );
      }
      case "prepare_unload": {
        const record = this.requireOwnedDispatchRecord(dispatch.payload);
        this.assertLocallyUnloadable(record);
        return {};
      }
      case "unload": {
        const record = this.requireOwnedDispatchRecord(dispatch.payload);
        this.assertLocallyUnloadable(record);
        await this.closeAgent(record, "broker requested unload", true);
        return {};
      }
      case "disconnect_cleanup": {
        const record = this.requireOwnedRetainedRecord(dispatch.payload);
        if (
          Number(dispatch.payload?.connectionGeneration) !==
            record.brokerGeneration
        ) throw new Error("Disconnected child generation is stale");
        if (record.processState !== "closed")
          await this.closeAgent(record, "broker link disconnected", true);
        return {
          closed: true,
          connectionGeneration: record.brokerGeneration,
        };
      }
      case "reload":
        return this.reloadOwnedRecord(dispatch.payload, signal);
      case "retry_outbox": {
        if (dispatch.payload?.targetPath !== this.state.currentPath)
          throw new Error("Completion outbox retry target does not match this process");
        const reporter = this.state.selfTurnReporter;
        const ctx = this.state.latestCtx;
        if (!reporter || !ctx) throw new Error("Completion outbox reporter is unavailable");
        return reporter.retryPending(ctx);
      }
      case "outbox_cleared": {
        const record = this.requireOwnedRetainedRecord(dispatch.payload);
        const eventId = requireNonEmptyString(
          dispatch.payload?.eventId,
          "cleared completion event id",
        );
        record.brokerPendingCompletionEventIds.delete(eventId);
        this.trimReloadRecords();
        return {};
      }
      case "ask_parent": {
        const record = this.requireOwnedDispatchRecord(dispatch.payload);
        const generation = Number(dispatch.payload?.connectionGeneration);
        if (
          !Number.isSafeInteger(generation) ||
          generation !== record.brokerGeneration
        ) throw new Error("ask_parent dispatch connection generation is stale");
        const activeEpoch = dispatch.payload?.activeEpoch;
        if (
          activeEpoch !== null &&
          activeEpoch !== undefined &&
          activeEpoch !== record.activeTurn?.epoch
        ) throw new Error("ask_parent dispatch active epoch is stale");
        return handleBrokerAskParentRequest(
          this.state,
          record,
          dispatch.payload?.request,
          generation,
          signal,
        );
      }
    }
  }

  private async deliverBrokerMailbox(
    payload: any,
    signal?: AbortSignal,
  ): Promise<{
    disposition: "accepted" | "retry";
    reason?: "target_settled" | "epoch_changed";
  }> {
    if (signal?.aborted) throw abortFailure("Broker mailbox delivery aborted");
    const targetPath = requireNonEmptyString(payload?.targetPath, "mailbox target");
    const source: unknown[] = Array.isArray(payload?.items) ? payload.items : [];
    const items: BrokerMailboxItem[] = source.filter((item: any): item is BrokerMailboxItem =>
      Number.isSafeInteger(item?.seq) &&
      typeof item?.eventId === "string" &&
      typeof item?.sender === "string" &&
      (item?.kind === "MESSAGE" || item?.kind === "NEW_TASK") &&
      typeof item?.message === "string"
    );
    if (items.length !== source.length || items.length === 0)
      throw new Error("Invalid broker mailbox delivery batch");
    const fresh = items.filter(
      (item) => !this.state.deliveredMailboxEventIds.has(item.eventId),
    );
    if (fresh.length === 0) return { disposition: "accepted" };
    for (let index = 1; index < fresh.length; index++)
      if (fresh[index]!.seq <= fresh[index - 1]!.seq)
        throw new Error("Broker mailbox delivery is not strictly FIFO");
    const content = fresh.map((item) =>
      taskEnvelope(item.kind, targetPath, item.sender, item.message)
    ).join("\n\n");
    const triggerTurn = payload?.triggerTurn === true;

    if (targetPath === this.state.currentPath) {
      const mailbox = this.state.piMailbox;
      if (!mailbox) throw new Error("Awaitable Pi mailbox adapter is unavailable");
      await mailbox.insert({
        eventId: `batch_${fresh[0]!.eventId}_${fresh.at(-1)!.eventId}`,
        customType: NOTICE_MESSAGE_TYPE,
        content,
        details: { brokerMailboxEventIds: fresh.map((item) => item.eventId) },
        triggerTurn,
      });
    } else {
      const record = this.requireOwnedDispatchRecord(payload);
      await this.awaitStartup(record);
      const result = await enqueueAgentOperation(record, async () => {
        this.assertManageable(record);
        if (
          payload?.connectionGeneration !== undefined &&
          Number(payload.connectionGeneration) !== record.brokerGeneration
        ) return { disposition: "retry" as const, reason: "epoch_changed" as const };
        const expectedActiveEpoch = Number(payload?.activeEpoch);
        const currentMatches = triggerTurn
          ? record.nextTurnEpoch === expectedActiveEpoch && record.turnState === "idle"
          : record.activeTurn?.state === "active" &&
            record.activeTurn.epoch === expectedActiveEpoch;
        if (!currentMatches) {
          await this.awaitBrokerSettlementSync(record, expectedActiveEpoch);
          return { disposition: "retry" as const, reason: "target_settled" as const };
        }
        if (triggerTurn) {
          if (!record.reusable || record.turnState !== "idle")
            return { disposition: "retry" as const, reason: "epoch_changed" as const };
          this.reserveActiveSlot(record);
          const turn = this.beginTurn(record, fresh.at(-1)!.message);
          try {
            await record.client!.prompt(content, turn.token);
            reduceTurnLifecycle(record, { type: "prompt_accepted", epoch: turn.epoch });
          } catch (error) {
            taintTurnTransport(record, `Broker mailbox acceptance is unknown: ${errorMessage(error)}`);
            await this.processCrash(record, `Broker mailbox delivery failed: ${errorMessage(error)}`);
            throw error;
          }
        } else {
          try {
            await record.client!.steer(content);
          } catch (error) {
            taintTurnTransport(
              record,
              `Running mailbox steer acceptance is unknown: ${errorMessage(error)}`,
            );
            await this.processCrash(
              record,
              `Running mailbox steer could not be safely correlated: ${errorMessage(error)}`,
            );
            throw error;
          }
        }
        return { disposition: "accepted" as const };
      });
      if (result.disposition === "retry") return result;
    }
    for (const item of fresh) this.rememberDeliveredMailboxEvent(item.eventId);
    return { disposition: "accepted" };
  }

  private rememberDeliveredMailboxEvent(eventId: string): void {
    this.state.deliveredMailboxEventIds.add(eventId);
    while (this.state.deliveredMailboxEventIds.size > 4_096) {
      const oldest = this.state.deliveredMailboxEventIds.values().next().value as string | undefined;
      if (!oldest) break;
      this.state.deliveredMailboxEventIds.delete(oldest);
    }
  }

  private dispatchSelfInbox(
    payload: any,
    signal?: AbortSignal,
  ): Promise<any> {
    const operation = this.state.selfInboxChain.then(async () => {
      if (signal?.aborted) throw abortFailure("Broker inbox dispatch aborted");
      if (payload?.targetPath !== this.state.currentPath)
        throw new Error("Broker inbox target does not match this process identity");
      const kind = payload?.kind;
      if (kind !== "MESSAGE" && kind !== "NEW_TASK" && kind !== "FINAL_ANSWER")
        throw new Error("Invalid broker inbox kind");
      const sender = requireNonEmptyString(payload?.sender, "inbox sender");
      const content = kind === "FINAL_ANSWER"
        ? requireNonEmptyString(payload?.content, "completion content")
        : taskEnvelope(
            kind,
            this.state.currentPath,
            sender,
            requireNonEmptyString(payload?.message, "inbox message"),
          );
      if (signal?.aborted) throw abortFailure("Broker inbox dispatch aborted");
      if (kind === "FINAL_ANSWER") {
        const eventId = requireNonEmptyString(payload?.eventId, "completion event id");
        const size = Buffer.byteLength(content, "utf8");
        if (size > this.state.settings.completionMessageMaxBytes)
          throw new Error("Completion exceeds the configured model-facing bound");
        const epoch = Math.floor(Date.now() / 1_000);
        if (this.state.completionBurstEpoch !== epoch) {
          this.state.completionBurstEpoch = epoch;
          this.state.completionBurstBytes = 0;
        }
        if (this.state.completionBurstBytes + size > this.state.settings.completionBurstMaxBytes)
          throw new Error("Completion burst bound is full; retry later");
        const mailbox = this.state.piMailbox;
        if (!mailbox) throw new Error("Awaitable Pi mailbox adapter is unavailable");
        await mailbox.insert({
          eventId,
          customType: COMPLETION_MESSAGE_TYPE,
          content,
          details: payload?.details,
          triggerTurn: false,
        });
        this.state.completionBurstBytes += size;
        return { observed: true };
      }
      this.state.pi.sendMessage(
        {
          customType: NOTICE_MESSAGE_TYPE,
          content,
          display: true,
          details: payload?.details,
        },
        {
          deliverAs: "steer",
          triggerTurn: kind === "NEW_TASK" && payload?.triggerTurn === true,
        },
      );
      return { observed: false };
    });
    this.state.selfInboxChain = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async reloadOwnedRecord(
    payload: any,
    signal?: AbortSignal,
  ): Promise<Record<string, never>> {
    if (signal?.aborted) throw abortFailure("Broker reload aborted");
    const targetId = requireNonEmptyString(payload?.targetId, "target id");
    const targetPath = requireNonEmptyString(payload?.targetPath, "target path");
    const previous = this.state.reloadRecords.get(targetId);
    if (!previous || previous.agentName !== targetPath || previous.mode !== "v2")
      throw new Error("Broker reload target is not retained by its controller");
    if (this.state.active.has(targetId))
      throw new Error("Broker reload target already owns a live RPC pipe");
    const ctx = this.state.latestCtx;
    if (!ctx) throw new Error("No active session context for broker reload");
    const grant = payload?.broker;
    const sources = this.requireSpawnToolSources();
    const record = createLiveSubagentRecord({
      id: previous.id,
      generatedLabel: previous.generatedLabel,
      taskName: previous.taskName,
      agentName: previous.agentName,
      parentId: previous.parentId ?? currentProcessAgentId(ctx),
      rootId: previous.rootId,
      depth: previous.depth,
      maxDepth: previous.maxDepth,
      message: previous.lastTaskMessage,
      sessionDir: previous.sessionDir!,
      mode: "v2",
      forkTurns: previous.forkTurns ?? "all",
      createdAt: previous.createdAt,
    });
    record.activeTurn = undefined;
    record.currentTurnId = previous.currentTurnId;
    record.nextTurnEpoch = previous.nextTurnEpoch;
    record.turnCount = previous.turnCount;
    record.turnState = "idle";
    record.turnOutcome = previous.turnOutcome;
    record.activeSlotHeld = false;
    record.persistentSlotHeld = true;
    record.committed = true;
    record.status = previous.status;
    record.finalOutput = previous.finalOutput;
    record.sessionFile = previous.sessionFile;
    record.forkSessionFile = previous.forkSessionFile;
    record.events = [...previous.events];
    record.settledTurnIds = new Set(previous.settledTurnIds);
    record.closedTurnTokens = new Set(previous.closedTurnTokens);
    record.notifiedTurnIds = new Set(previous.notifiedTurnIds);
    record.activityTurnIds = new Set(previous.activityTurnIds);
    record.brokerPendingCompletionEventIds = new Set(
      previous.brokerPendingCompletionEventIds,
    );
    record.brokerCapability = requireNonEmptyString(grant?.capability, "reload capability");
    record.brokerGeneration = Number(grant?.generation);
    record.brokerResident = false;
    this.state.history.delete(record.id);
    this.state.active.set(record.id, record);
    try {
      const args = [
        "--mode", "rpc", "--no-extensions", "--tools",
        sources.childTools.join(","), "--name", record.generatedLabel,
      ];
      for (const sourcePath of sources.paths) args.push("-e", sourcePath);
      args.push("-e", this.state.extensionPath, "--session-dir", record.sessionDir!);
      const session = record.sessionFile ?? record.forkSessionFile;
      if (session) args.push("--session", session);
      else args.push("--no-session");
      if (ctx.model) args.push("--model", `${ctx.model.provider}/${ctx.model.id}`);
      const thinking = this.state.pi.getThinkingLevel?.();
      if (thinking) args.push("--thinking", thinking);
      const invocation = getPiInvocation(args, this.state.invocationBase);
      const environment = buildChildBrokerEnvironment({
        identity: {
          id: record.id,
          path: record.agentName,
          parentId: currentProcessAgentId(ctx),
          parentPath: this.state.currentPath,
          depth: record.depth,
          maxDepth: record.maxDepth,
          connectionGeneration: record.brokerGeneration,
        },
        socketPath: requireNonEmptyString(grant?.socketPath, "reload socket"),
        capability: record.brokerCapability,
        rootId: record.rootId,
        maxResidentAgents: this.state.treeMaxResidentAgents!,
        maxActiveAgents: this.state.treeMaxActiveAgents!,
      });
      const client = this.rpcFactory(invocation.command, invocation.args, {
        cwd: ctx.cwd,
        env: {
          ...environment,
          PI_SUBAGENT_LABEL: record.generatedLabel,
          PI_SUBAGENT_ACTIVE_TOOLS: JSON.stringify(sources.childTools),
        },
        envAllowlist: this.state.settings.childEnvAllowlist,
        startupTimeoutMs: this.state.settings.rpcStartupTimeoutMs,
        requestTimeoutMs: this.state.settings.rpcRequestTimeoutMs,
        shutdownTimeoutMs: this.state.settings.rpcShutdownTimeoutMs,
      });
      record.client = client;
      record.stopEventUpdates = client.onEvent((event) => this.onRpcEvent(record, event));
      await client.start();
      if (signal?.aborted) throw abortFailure("Broker reload aborted");
      reduceTurnLifecycle(record, {
        type: "process_started",
        pid: client.pid,
        timestamp: now(),
      });
      record.status = previous.status;
      record.turnState = "idle";
      record.turnOutcome = previous.turnOutcome;
      record.activeTurn = undefined;
      record.activeSlotHeld = false;
      record.reusable = true;
      record.brokerCapability = undefined;
      record.brokerResident = true;
      record.startup = Promise.resolve();
      this.applyChildState(record, await client.getState());
      await client.setSessionName(record.generatedLabel).catch(() => undefined);
      this.persistState();
      updateStatus(this.state);
      return {};
    } catch (error) {
      await record.client?.stop().catch(() => undefined);
      this.state.active.delete(record.id);
      this.archiveRecord(previous);
      throw error;
    }
  }

  private assertLocallyUnloadable(record: SubagentRecord): void {
    if (
      record.turnState !== "idle" ||
      record.mailbox.length > 0 ||
      record.pendingQuestion ||
      [...this.state.active.values()].some(
        (candidate) => candidate.parentId === record.id,
      )
    ) throw new Error("Broker refused to unload a locally busy or owning agent");
  }

  private requireOwnedRetainedRecord(payload: any): SubagentRecord {
    const targetId = requireNonEmptyString(payload?.targetId, "target id");
    const targetPath = requireNonEmptyString(payload?.targetPath, "target path");
    const record = this.state.active.get(targetId) ??
      this.state.reloadRecords.get(targetId) ??
      this.state.history.get(targetId);
    if (
      !record ||
      record.agentName !== targetPath ||
      record.mode !== "v2" ||
      agentPathDepth(record.agentName) !== this.state.currentDepth + 1 ||
      !isAgentPathWithin(record.agentName, this.state.currentPath)
    ) throw new Error("Broker dispatch target is not retained by this process");
    return record;
  }

  private requireOwnedDispatchRecord(payload: any): SubagentRecord {
    const targetId = requireNonEmptyString(payload?.targetId, "target id");
    const targetPath = requireNonEmptyString(payload?.targetPath, "target path");
    const record = this.state.active.get(targetId);
    if (
      !record ||
      record.agentName !== targetPath ||
      record.mode === "historical" ||
      agentPathDepth(record.agentName) !== this.state.currentDepth + 1 ||
      !isAgentPathWithin(record.agentName, this.state.currentPath)
    )
      throw new Error("Broker dispatch target is not owned by this process");
    return record;
  }

  refreshSettings(ctx: ExtensionContext): void {
    this.state.latestCtx = ctx;
    this.state.projectTrusted = ctx.isProjectTrusted();
    this.state.settings = loadSettings(ctx.cwd, this.state.projectTrusted);
    if (this.state.brokerIdentity)
      this.state.settings.maxDepth = this.state.brokerIdentity.maxDepth;
    // An explicit PI_SUBAGENT_MAX_DEPTH is authoritative for every role,
    // including depth-0 roots before their broker identity is initialized.
    if (this.state.envMaxDepthExplicit)
      this.state.settings.maxDepth = this.state.envMaxDepth;
    if (this.state.treeMaxResidentAgents !== undefined)
      this.state.settings.maxPersistentAgents = this.state.treeMaxResidentAgents;
    if (this.state.treeMaxActiveAgents !== undefined)
      this.state.settings.maxConcurrentAgents = this.state.treeMaxActiveAgents;
    this.trimStatusHistory();
  }

  restoreHistorical(ctx: ExtensionContext): void {
    if (!this.state.settings.showInNormalResume || this.state.active.size > 0) return;
    const entries = ctx.sessionManager.getEntries() as any[];
    const saved = [...entries]
      .reverse()
      .find(
        (entry) =>
          entry?.type === "custom" &&
          entry?.customType === STATE_ENTRY_TYPE &&
          Array.isArray(entry?.data?.agents),
      );
    if (!saved) return;
    for (const snapshot of saved.data.agents as AgentSnapshot[]) {
      if (!snapshot?.agent_id || snapshot.agent_name === this.state.currentPath) continue;
      try {
        if (!isAgentPathWithin(snapshot.agent_name, this.state.currentPath)) continue;
      } catch {
        continue;
      }
      const record = this.historicalRecord(snapshot);
      this.archiveRecord(record);
      this.reservedNames.add(record.taskName);
    }
    updateStatus(this.state, ctx);
  }

  async spawnAgent(
    params: SpawnAgentInput,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
    toolCallId?: string,
  ): Promise<SpawnResult> {
    this.refreshSettings(ctx);
    this.assertOpen();
    this.assertCanSpawn(true);
    const taskName = validateTaskName(params.task_name);
    const message = requireNonEmptyString(params.message, "message");
    const forkTurns = parseForkTurns(params.fork_turns);
    // Exact tool inheritance is validated before a name/process reservation.
    const toolSources = this.requireSpawnToolSources();
    const id = makeId();
    const grant = await this.reserveBrokerChild(
      id,
      taskName,
      message,
      true,
    );
    let record: SubagentRecord | undefined;
    try {
      const reserved = this.reserveRecord({
        mode: "v2",
        taskName,
        message,
        label: taskName,
        ctx,
        forkTurns,
        id,
      });
      record = reserved.record;
      this.applyBrokerGrant(record, grant);
      record.spawnToolCallId = toolCallId;
      record.startup = this.startRecord(
        record,
        message,
        ctx,
        signal,
        undefined,
        toolSources,
      );
      await record.startup;
      return {
        agent_id: record.id,
        agent_name: record.agentName,
        status: this.publicStatus(record),
        depth: record.depth,
        max_depth: record.maxDepth,
        fork_turns: record.forkTurns!,
        shared_workspace: true,
        ...(record.omittedTools?.length
          ? { omitted_tools: [...record.omittedTools] }
          : {}),
      };
    } catch (error) {
      if (record) await this.rollbackProvisional(record, error);
      else await this.rollbackBrokerOnly(grant.path, error);
      throw error;
    }
  }

  async sendMessage(target: string, message: string): Promise<{
    target: string;
    delivery: "steer" | "queued";
    pending_messages: number;
    event_id: string;
  }> {
    const payload = requireNonEmptyString(message, "message");
    const broker = this.requireBroker() as any;
    if (typeof broker.route === "function") {
      const routed = await broker.route("send", target, payload);
      return {
        target: routed.target,
        delivery: routed.delivery === "queued" ? "queued" : "steer",
        pending_messages: routed.delivery === "queued" ? 1 : 0,
        event_id: routed.event_id,
      };
    }
    const record = this.resolveTarget(target);
    await this.awaitStartup(record);
    return enqueueAgentOperation(record, async () => {
      this.assertManageable(record);
      const item = createMailboxItem(record, {
        sender: this.state.currentPath,
        kind: "MESSAGE",
        message: payload,
        triggerTurn: false,
      });
      if (record.turnState === "running" || record.turnState === "interrupting") {
        const operationEpoch = record.lifecycleEpoch;
        const turnToken = record.activeTurn?.token;
        await record.client!.steer(item.envelope);
        this.assertOperationCurrent(record, operationEpoch, turnToken);
        record.updatedAt = now();
        record.lastUsedAt = record.updatedAt;
        pushEventSummary(record, {
          type: "parent_message",
          timestamp: now(),
          text: oneLine(payload, 220),
        });
        updateStatus(this.state);
        return {
          target: record.agentName,
          delivery: "steer" as const,
          pending_messages: record.mailbox.length,
          event_id: item.eventId,
        };
      }
      record.updatedAt = now();
      record.lastUsedAt = record.updatedAt;
      record.mailbox.push(item);
      await this.syncBrokerRecord(record);
      this.tryWriteAgentMetadata(record);
      this.persistState();
      updateStatus(this.state);
      return {
        target: record.agentName,
        delivery: "queued" as const,
        pending_messages: record.mailbox.length,
        event_id: item.eventId,
      };
    });
  }

  async followupTask(target: string, message: string): Promise<{
    target: string;
    delivery: "prompt" | "steer";
    turn_id: string;
    event_id: string;
  }> {
    const payload = requireNonEmptyString(message, "message");
    const broker = this.requireBroker() as any;
    if (typeof broker.route === "function") {
      const routed = await broker.route("followup", target, payload);
      return {
        target: routed.target,
        delivery: routed.started_turn === false ? "steer" : "prompt",
        turn_id: `broker_turn_${routed.sequence}`,
        event_id: routed.event_id,
      };
    }
    const record = this.resolveTarget(target);
    await this.awaitStartup(record);
    return enqueueAgentOperation(record, async () => {
      this.assertManageable(record);
      const followup = createMailboxItem(record, {
        sender: this.state.currentPath,
        kind: "NEW_TASK",
        message: payload,
        triggerTurn: true,
      });
      if (record.turnState === "running" || record.turnState === "interrupting") {
        const operationEpoch = record.lifecycleEpoch;
        const turnToken = record.activeTurn?.token;
        await record.client!.steer(followup.envelope);
        this.assertOperationCurrent(record, operationEpoch, turnToken);
        record.lastTaskMessage = payload;
        record.updatedAt = now();
        record.lastUsedAt = record.updatedAt;
        return {
          target: record.agentName,
          delivery: "steer" as const,
          turn_id: record.currentTurnId!,
          event_id: followup.eventId,
        };
      }
      if (!record.reusable)
        throw new Error(`Agent ${record.agentName} is ${record.processState} and cannot be reused`);

      await this.requireBroker().updateAgent(record.agentName, { active: true });
      this.reserveActiveSlot(record);
      const queued = [...record.mailbox];
      record.mailbox = [];
      const activeTurn = this.beginTurn(record, payload);
      const prompt = [
        ...queued.map((item) => item.envelope),
        followup.envelope,
      ].join("\n\n");
      const operationEpoch = record.lifecycleEpoch;
      try {
        await record.client!.prompt(prompt, activeTurn.token);
        this.assertOperationCurrent(record, operationEpoch, activeTurn.token);
        reduceTurnLifecycle(record, {
          type: "prompt_accepted",
          epoch: activeTurn.epoch,
        });
      } catch (error) {
        if (record.closeRequested || record.lifecycleEpoch !== operationEpoch) throw error;
        if (
          record.activeTurn?.epoch === activeTurn.epoch &&
          record.activeTurn.state === "settled"
        ) {
          throw new Error(
            `Follow-up acceptance response timed out; ${record.agentName} activity is still tracked for ${activeTurn.id}`,
          );
        }
        if (error instanceof RpcRequestTimeoutError) {
          const lifecycleEpoch = record.lifecycleEpoch;
          const childState = await record.client!.getState().catch(() => undefined);
          this.assertOperationCurrent(record, lifecycleEpoch, activeTurn.token);
          if (childState?.isStreaming === true) {
            reduceTurnLifecycle(record, {
              type: "prompt_uncertain",
              epoch: activeTurn.epoch,
            });
            this.persistState();
            updateStatus(this.state);
            throw new Error(
              `Follow-up acceptance response timed out; ${record.agentName} activity is still tracked for ${activeTurn.id}`,
            );
          }
        }
        taintTurnTransport(
          record,
          `Follow-up is missing an authoritative settlement: ${errorMessage(error)}`,
        );
        await this.processCrash(
          record,
          `Follow-up transport became unsafe without agent_settled: ${errorMessage(error)}`,
        );
        throw error;
      }
      this.tryWriteAgentMetadata(record);
      this.persistState();
      updateStatus(this.state);
      return {
        target: record.agentName,
        delivery: "prompt" as const,
        turn_id: activeTurn.id,
        event_id: followup.eventId,
      };
    });
  }

  async waitAgent(
    input: WaitAgentInput,
    signal?: AbortSignal,
  ): Promise<WaitAgentResultDetails> {
    this.assertOpen();
    const parsed = parseWaitAgentInput(input);
    if (this.waitAbort) throw new Error("Only one wait_agent call may be pending per manager");
    const controller = new AbortController();
    const relayAbort = () => controller.abort();
    signal?.addEventListener("abort", relayAbort, { once: true });
    this.waitAbort = controller;
    if (signal?.aborted) controller.abort();
    try {
      if ("seconds" in parsed) {
        await waitForClockDelay(parsed.seconds * 1_000, controller.signal);
        return {
          message: `Waited ${parsed.seconds} second${parsed.seconds === 1 ? "" : "s"}.`,
          timed_out: false,
          completed: [],
          pending: [],
        };
      }
      return await this.requireBroker().waitAgent(parsed, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) throw error;
      return {
        message: "Wait interrupted by new input.",
        timed_out: false,
        completed: [],
        pending: [],
      };
    } finally {
      signal?.removeEventListener("abort", relayAbort);
      if (this.waitAbort === controller) this.waitAbort = undefined;
    }
  }

  cancelPendingWait(): void {
    this.waitAbort?.abort();
  }

  async interruptAgent(target: string): Promise<{
    target: string;
    previous_status: AgentStatus;
    current_status: AgentStatus;
  }> {
    const broker = this.requireBroker() as any;
    if (typeof broker.route !== "function") return this.interruptOwnedAgent(target);
    const routed = await broker.route("interrupt", target);
    return {
      target,
      previous_status: routed.previous_status,
      current_status: routed.previous_status,
    };
  }

  private async interruptOwnedAgent(
    target: string,
    expectedActiveEpoch?: number | null,
    expectedConnectionGeneration?: number,
  ): Promise<{
    target: string;
    previous_status: AgentStatus;
    current_status: AgentStatus;
  }> {
    const record = this.resolveTarget(target);
    await this.awaitStartup(record);
    return enqueueAgentOperation(record, async () => {
      this.assertManageable(record);
      const previous = this.publicStatus(record);
      if (
        expectedConnectionGeneration !== undefined &&
        record.brokerGeneration !== expectedConnectionGeneration
      ) {
        return {
          target: record.agentName,
          previous_status: previous,
          current_status: this.publicStatus(record),
        };
      }
      const activeTurn = record.activeTurn;
      if (
        expectedActiveEpoch !== undefined &&
        (expectedActiveEpoch === null
          ? activeTurn?.state === "active"
          : activeTurn?.state !== "active" || activeTurn.epoch !== expectedActiveEpoch)
      ) {
        if (expectedActiveEpoch !== null)
          await this.awaitBrokerSettlementSync(record, expectedActiveEpoch);
        return {
          target: record.agentName,
          previous_status: previous,
          current_status: this.publicStatus(record),
        };
      }
      if (!activeTurn || activeTurn.state === "settled") {
        return {
          target: record.agentName,
          previous_status: previous,
          current_status: this.publicStatus(record),
        };
      }
      reduceTurnLifecycle(record, {
        type: "interrupt_requested",
        epoch: activeTurn.epoch,
      });
      const operationEpoch = record.lifecycleEpoch;
      try {
        await record.client!.abort(
          Math.max(
            this.state.settings.rpcRequestTimeoutMs,
            this.state.settings.rpcShutdownTimeoutMs * 2,
          ),
        );
        this.assertOperationCurrent(record, operationEpoch, activeTurn.token);
        const reduction = reduceTurnLifecycle(record, {
          type: "interrupt_accepted",
          epoch: activeTurn.epoch,
          timestamp: now(),
        });
        this.handleTurnReduction(record, reduction);
      } catch (error) {
        if (record.closeRequested || record.lifecycleEpoch !== operationEpoch) throw error;
        const reduction = reduceTurnLifecycle(record, {
          type: "interrupt_rejected",
          epoch: activeTurn.epoch,
          acceptance: error instanceof RpcRequestTimeoutError ? "unknown" : "rejected",
          timestamp: now(),
        });
        this.handleTurnReduction(record, reduction);
        if (record.activeTurn?.state === "active") {
          taintTurnTransport(
            record,
            `Interrupt is missing an authoritative settlement: ${errorMessage(error)}`,
          );
          await this.processCrash(
            record,
            `Interrupt left child transport unsafe: ${errorMessage(error)}`,
          );
        }
        throw new Error(
          `Interrupt failed for ${record.agentName}: ${errorMessage(error)}`,
        );
      }
      this.scheduleMissingSettlement(record, activeTurn.epoch);
      this.persistState();
      updateStatus(this.state);
      return {
        target: record.agentName,
        previous_status: previous,
        current_status: this.publicStatus(record),
      };
    });
  }

  async listAgents(pathPrefix?: string): Promise<{
    scope: "root_tree";
    shared_workspace: true;
    agents: Array<{
      agent_name: string;
      agent_status: AgentStatus;
      last_task_message: string | null;
    }>;
  }> {
    const listed = await this.requireBroker().list(pathPrefix);
    return {
      scope: "root_tree",
      shared_workspace: true,
      agents: listed.agents,
    };
  }

  async delegate(
    params: { title?: string; task: string; context?: ContextMode },
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<DelegateDetails> | undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<DelegateDetails>> {
    this.refreshSettings(ctx);
    const contextMode = params.context ?? this.state.settings.defaultContext;
    if (!this.canSpawn()) return this.depthFailure(params.task, contextMode);
    const task = requireNonEmptyString(params.task, "task");
    const toolSources = this.requireSpawnToolSources();
    const id = makeId();
    const taskName = `legacy_${id.replace(/[^a-z0-9_]/g, "_").slice(-24)}`;
    const label = oneLine(params.title?.trim() || generatedLabel(task), 48);
    let record: SubagentRecord | undefined;
    let grant: BrokerConnectionGrant | undefined;
    let liveUpdate: LiveDelegateUpdater | undefined;
    let persistentSignalListener: (() => void) | undefined;
    try {
      grant = await this.reserveBrokerChild(id, taskName, task, false);
      const reserved = this.reserveRecord({
        mode: "legacy",
        taskName,
        message: task,
        contextMode,
        label,
        ctx,
        id,
      });
      record = reserved.record;
      this.applyBrokerGrant(record, grant);
      liveUpdate = makeLiveUpdater(this.state, record, onUpdate);
      record.startup = this.startRecord(
        record,
        task,
        ctx,
        signal,
        liveUpdate,
        toolSources,
      );
      await record.startup;
      if (signal) {
        persistentSignalListener = () => {
          if (!record) return;
          reduceTurnLifecycle(record, {
            type: "legacy_outcome",
            outcome: "aborted",
            timestamp: now(),
          });
          void this.closeAgent(record, "legacy delegate cancelled", false);
        };
        if (signal.aborted) persistentSignalListener();
        else signal.addEventListener("abort", persistentSignalListener, { once: true });
      }
      const completion = await record.turnCompletion!.promise;
      const details = toDelegateDetails(record, this.state.settings);
      // The bounded payload, not a 220-character UI summary, is model-visible.
      return {
        content: [{ type: "text", text: completion.payload }],
        details,
      };
    } catch (error) {
      const aborted = signal?.aborted ||
        (error instanceof Error && error.name === "AbortError");
      if (!record) {
        if (grant) await this.rollbackBrokerOnly(grant.path, error);
        throw error;
      }
      if (!record.committed) await this.rollbackProvisional(record, error);
      reduceTurnLifecycle(record, {
        type: "legacy_outcome",
        outcome: aborted ? "aborted" : "failed",
        error: errorMessage(error),
        timestamp: now(),
      });
      if (aborted) throw abortFailure("Legacy delegate cancelled");
      record.finalOutput ||= record.error;
      const completion = await (
        this.dependencies.makeCompletionPayload ?? makeCompletionPayload
      )(
        record,
        ctx,
        this.state.settings,
        signal,
        this.state.pi.getThinkingLevel?.(),
      );
      return {
        content: [{ type: "text", text: completion.payload }],
        details: toDelegateDetails(record, this.state.settings),
      };
    } finally {
      if (signal && persistentSignalListener)
        signal.removeEventListener("abort", persistentSignalListener);
      liveUpdate?.close();
      if (record) {
        await this.closeAgent(record, "legacy delegate settled", false);
        if (record.processState === "closed") {
          this.state.active.delete(record.id);
          this.reservedNames.delete(record.taskName);
        }
        updateStatus(this.state);
      }
    }
  }

  closeAgent(
    record: SubagentRecord,
    reason: string,
    retain = true,
  ): Promise<void> {
    if (!retain) record.removeAfterClose = true;
    if (record.shutdownPromise) return record.shutdownPromise;
    // Commit close synchronously in reducer order before any awaited teardown.
    reduceTurnLifecycle(record, { type: "close", reason, timestamp: now() });
    const closeEpoch = record.lifecycleEpoch;
    const operation = enqueueAgentOperation(record, async () => {
      if (record.processState === "closed") return;
      if (record.activeTurn?.state === "active" && record.client) {
        try {
          await record.client.abort(this.state.settings.rpcRequestTimeoutMs);
        } catch {
          // Stop remains authoritative even when soft abort is rejected.
        }
      }
      try {
        await record.client?.stop();
      } catch (error) {
        reduceTurnLifecycle(record, {
          type: "close_failed",
          lifecycleEpoch: closeEpoch,
          error: errorMessage(error),
          timestamp: now(),
        });
        updateStatus(this.state);
        throw error;
      }
      if (record.lifecycleEpoch !== closeEpoch)
        throw new Error(`Close lifecycle for ${record.agentName} became stale`);
      record.stopEventUpdates?.();
      record.stopEventUpdates = undefined;
      reduceTurnLifecycle(record, {
        type: "close_completed",
        lifecycleEpoch: closeEpoch,
        reason,
        timestamp: now(),
      });
      record.mailbox = [];
      record.activeTurn?.completion.reject(new Error(`Agent closed: ${reason}`));
      record.activeTurn?.settlement.resolve(undefined);
      try {
        writeAgentMetadata(record);
      } catch (error) {
        record.error = `${record.error ?? reason}; metadata write failed: ${errorMessage(error)}`;
      }
      if (!retain) {
        this.state.active.delete(record.id);
        this.state.history.delete(record.id);
        this.state.reloadRecords.delete(record.id);
        this.reservedNames.delete(record.taskName);
      } else if (record.mode === "v2") {
        this.archiveRecord(record);
      }
      this.persistState();
      updateStatus(this.state);
    });
    const shutdown = operation.catch((error) => {
      if (record.shutdownPromise === shutdown) record.shutdownPromise = undefined;
      throw error;
    });
    record.shutdownPromise = shutdown;
    return shutdown;
  }

  shutdown(): Promise<void> {
    if (this.state.shutdownPromise) return this.state.shutdownPromise;
    this.state.closing = true;
    const shutdown = this.shutdownInternal().catch((error) => {
      // Teardown is idempotent; allow a later reload/shutdown attempt to finish
      // cleanup after a transient drain, transport, or socket failure.
      this.state.shutdownPromise = undefined;
      throw error;
    });
    this.state.shutdownPromise = shutdown;
    return shutdown;
  }

  private async shutdownInternal(): Promise<void> {
    this.cancelPendingWait();
    const brokerForDrain = this.state.broker as any;
    if (
      !this.state.isChild &&
      typeof brokerForDrain?.waitForCompletionOutboxDrain === "function"
    ) {
      // A durable pending outbox must not prevent process teardown or poison
      // extension reload. The sidecar remains available for recovery.
      await brokerForDrain.waitForCompletionOutboxDrain(
        Math.max(500, this.state.settings.rpcShutdownTimeoutMs * 2),
      ).catch(() => undefined);
    }
    const closable = [...this.state.active.values()].filter(
      (record) =>
        record.mode === "v2" ||
        record.mode === "historical" ||
        this.state.settings.killChildrenOnParentExit,
    );
    const closes = closable.map((record) =>
      this.closeAgent(record, "parent session shutdown", true),
    );
    const gracefulMs = Math.max(2_000, this.state.settings.rpcShutdownTimeoutMs * 2);
    let results: PromiseSettledResult<void>[];
    try {
      results = await withTimeout(
        Promise.allSettled(closes),
        gracefulMs,
        "Timed out gracefully closing sub-agents",
      );
    } catch (timeoutError) {
      const forced = await Promise.allSettled(closable.map((record) => record.client?.stop()));
      results = await withTimeout(
        Promise.allSettled(closes),
        this.state.settings.rpcShutdownTimeoutMs + 1_000,
        "Timed out finalizing forced sub-agent shutdown",
      ).catch(() => [{ status: "rejected", reason: timeoutError } as PromiseRejectedResult]);
      for (const result of forced)
        if (result.status === "rejected") results.push(result);
    }
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    for (const record of closable) {
      if (record.processState !== "closed") continue;
      this.state.active.delete(record.id);
      this.reservedNames.delete(record.taskName);
    }
    this.persistState();
    const unconfirmed = closable.filter((record) => record.processState !== "closed");
    if (unconfirmed.length > 0)
      throw new AggregateError(
        failures.length > 0 ? failures : unconfirmed.map((record) => record.cleanupError),
        `Failed to confirm shutdown of ${unconfirmed.length} sub-agent transport(s); broker remains available for recovery`,
      );
    const broker = this.state.broker;
    if (!broker) return;
    try {
      await broker.close();
    } catch (error) {
      throw new AggregateError(
        [error],
        "Owned children closed but root-tree broker cleanup failed",
      );
    }
    this.state.broker = undefined;
    this.state.brokerReady = undefined;
    this.state.brokerIdentity = undefined;
  }

  private reserveRecord(
    input: {
      taskName: string;
      message: string;
      label: string;
      ctx: ExtensionContext;
      id?: string;
    } &
      (
        | { mode: "v2"; forkTurns: ForkTurns; contextMode?: never }
        | { mode: "legacy"; contextMode: ContextMode; forkTurns?: never }
      ),
  ): ReservedRecord {
    this.assertOpen();
    if (this.reservedNames.has(input.taskName))
      throw new Error(`Task name '${input.taskName}' is already reserved in this manager`);

    // Root-tree reservation has already acquired canonical resident/executing
    // capacity. Process-local slots below only mirror those broker leases.
    const id = input.id ?? makeId();
    const depth = this.state.currentDepth + 1;
    const rootId = currentRootId(input.ctx);
    const agentName = resolveAgentReference(
      this.state.currentPath,
      input.taskName,
    );
    const sessionDir = path.join(this.state.settings.sessionDir, rootId, id);
    const record = createLiveSubagentRecord({
      id,
      generatedLabel: input.label,
      taskName: input.taskName,
      agentName,
      parentId: currentProcessAgentId(input.ctx),
      rootId,
      depth,
      maxDepth: this.state.settings.maxDepth,
      message: input.message,
      sessionDir,
      createdAt: now(),
      ...(input.mode === "v2"
        ? { mode: "v2" as const, forkTurns: input.forkTurns }
        : { mode: "legacy" as const, contextMode: input.contextMode }),
    });
    this.reserveActiveSlot(record);
    if (input.mode === "v2") this.reservePersistentSlot(record);
    this.reservedNames.add(input.taskName);
    this.state.active.set(record.id, record);
    try {
      updateStatus(this.state, input.ctx);
    } catch (error) {
      this.state.active.delete(record.id);
      this.reservedNames.delete(input.taskName);
      throw error;
    }
    return { record };
  }

  private async startRecord(
    record: SubagentRecord,
    message: string,
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    liveUpdate: LiveDelegateUpdater | undefined,
    sources: SpawnToolSources,
  ): Promise<void> {
    let committed = false;
    let commitStarted = false;
    const spawnSignal = signal
      ? AbortSignal.any([signal, record.lifecycleAbort.signal])
      : record.lifecycleAbort.signal;
    let cancelled = spawnSignal.aborted;
    const abortListener = () => {
      if (committed) return;
      cancelled = true;
      if (commitStarted) return;
      reduceTurnLifecycle(record, {
        type: "close",
        reason: "Sub-agent spawn cancelled",
        timestamp: now(),
      });
      void record.client?.stop().catch(() => undefined);
    };
    spawnSignal.addEventListener("abort", abortListener, { once: true });
    const checkCancelled = () => {
      if (record.fatalProtocolError)
        throw new Error(`Sub-agent lifecycle protocol failed: ${record.fatalProtocolError}`);
      if (cancelled || spawnSignal.aborted || record.closeRequested)
        throw new Error("Sub-agent spawn cancelled");
    };
    try {
      checkCancelled();
      ensureDir(record.sessionDir!);
      const handoff =
        record.mode === "legacy" && record.contextMode === "compact"
          ? await (
              this.dependencies.generateHandoffSummary ?? generateHandoffSummary
            )(
              ctx,
              this.state.settings,
              spawnSignal,
              this.state.pi.getThinkingLevel?.(),
            )
          : undefined;
      checkCancelled();
      const initialPrompt =
        record.mode === "v2"
          ? taskEnvelope(
              "NEW_TASK",
              record.agentName,
              this.state.currentPath,
              message,
            )
          : buildInitialPrompt(
              message,
              record.contextMode,
              handoff,
              record.depth,
              record.maxDepth,
              record.agentName,
              this.state.currentPath,
            );
      record.omittedTools = sources.omittedTools;
      if (record.mode === "v2") {
        const seed = prepareForkSeedSession({
          source: ctx.sessionManager,
          forkTurns: record.forkTurns!,
          spawnCall: {
            taskName: record.taskName,
            message,
            toolCallId: record.spawnToolCallId,
          },
          cwd: ctx.cwd,
          sessionDir: record.sessionDir!,
          model: ctx.model
            ? { provider: ctx.model.provider, id: ctx.model.id }
            : undefined,
          thinkingLevel: this.state.pi.getThinkingLevel?.(),
        });
        record.forkSessionFile = seed.sessionFile;
      }
      const args = [
        "--mode",
        "rpc",
        "--no-extensions",
        "--tools",
        sources.childTools.join(","),
        "--name",
        record.generatedLabel,
      ];
      // Load reconstructable tool providers first and the collaboration manager
      // last. Pi 0.80.x can terminate early when a session-lifecycle extension
      // is followed by another explicit -e provider during RPC startup.
      for (const sourcePath of sources.paths) args.push("-e", sourcePath);
      args.push("-e", this.state.extensionPath);
      if (record.mode === "v2") {
        // A concrete seed file is required even for `none`: it makes the child
        // history choice explicit and gives every reusable turn one session.
        args.push("--session-dir", record.sessionDir!);
        args.push("--session", record.forkSessionFile!);
      } else if (this.state.settings.persistSessions) {
        args.push("--session-dir", record.sessionDir!);
      } else {
        args.push("--no-session");
      }
      if (ctx.model) args.push("--model", `${ctx.model.provider}/${ctx.model.id}`);
      const thinking = this.state.pi.getThinkingLevel?.();
      if (thinking) args.push("--thinking", thinking);
      const invocation = getPiInvocation(args, this.state.invocationBase);
      const brokerEnvironment = this.childBrokerEnvironment(record, ctx);
      checkCancelled();
      const client = this.rpcFactory(invocation.command, invocation.args, {
        cwd: ctx.cwd,
        env: {
          ...brokerEnvironment,
          PI_SUBAGENT_LABEL: record.generatedLabel,
          PI_SUBAGENT_ACTIVE_TOOLS: JSON.stringify(sources.childTools),
        },
        envAllowlist: this.state.settings.childEnvAllowlist,
        startupTimeoutMs: this.state.settings.rpcStartupTimeoutMs,
        requestTimeoutMs: this.state.settings.rpcRequestTimeoutMs,
        shutdownTimeoutMs: this.state.settings.rpcShutdownTimeoutMs,
      });
      record.client = client;
      record.stopEventUpdates = client.onEvent((event) => {
        this.onRpcEvent(record, event);
        liveUpdate?.notify();
      });
      try {
        await client.start();
      } catch (error) {
        if (record.fatalProtocolError)
          throw new Error(`Sub-agent lifecycle protocol failed: ${record.fatalProtocolError}`);
        throw error;
      }
      checkCancelled();
      if (record.turnError) {
        throw new Error(
          `Sub-agent extension startup failed: ${record.turnError}`,
        );
      }
      reduceTurnLifecycle(record, {
        type: "process_started",
        pid: client.pid,
        timestamp: now(),
      });
      await this.requireBroker().awaitChildRegistration(
        record.agentName,
        record.brokerGeneration!,
        this.state.settings.rpcStartupTimeoutMs,
        spawnSignal,
      );
      checkCancelled();
      const childState = await client.getState();
      checkCancelled();
      this.applyChildState(record, childState);
      await client.setSessionName(record.generatedLabel).catch(() => undefined);
      checkCancelled();
      const initialTurn = record.activeTurn!;
      const promptLifecycleEpoch = record.lifecycleEpoch;
      try {
        await client.prompt(initialPrompt, initialTurn.token);
      } catch (error) {
        if (record.fatalProtocolError)
          throw new Error(`Sub-agent lifecycle protocol failed: ${record.fatalProtocolError}`);
        throw error;
      }
      checkCancelled();
      if (
        record.lifecycleEpoch !== promptLifecycleEpoch ||
        record.activeTurn?.token !== initialTurn.token
      ) throw new Error("Sub-agent spawn prompt completed after its lifecycle became stale");
      reduceTurnLifecycle(record, {
        type: "prompt_accepted",
        epoch: initialTurn.epoch,
      });
      checkCancelled();
      if (client.exited)
        throw new Error("Sub-agent process exited before spawn commit");
      commitStarted = true;
      await this.requireBroker().commitChildRegistration(
        record.agentName,
        record.brokerGeneration!,
      );
      record.brokerCapability = undefined;
      record.brokerResident = true;
      checkCancelled();
      const commit = reduceTurnLifecycle(record, {
        type: "spawn_committed",
        timestamp: now(),
      });
      if (commit.ignored)
        throw new Error("Sub-agent spawn could not commit its lifecycle");
      committed = true;
      await this.syncBrokerRecord(record, true);
      const pendingSettlement = record.pendingSettlement;
      record.pendingSettlement = undefined;
      if (pendingSettlement) {
        const operation = this.processSettlement(record, pendingSettlement);
        record.brokerSettlementSync = {
          epoch: pendingSettlement.epoch,
          promise: operation,
        };
        void operation.catch((error) =>
          this.handleLifecycleFailure(record, pendingSettlement, error));
      }
      record.updatedAt = now();
      record.lastUsedAt = record.updatedAt;
      this.tryWriteAgentMetadata(record);
      this.persistState();
      try {
        updateStatus(this.state, ctx);
        liveUpdate?.notify(true);
      } catch (error) {
        record.error ??= `Post-commit status observer failed: ${errorMessage(error)}`;
      }
    } finally {
      spawnSignal.removeEventListener("abort", abortListener);
    }
  }

  private onRpcEvent(record: SubagentRecord, event: RpcEvent): void {
    this.commitRpcEvent(record, event);
  }

  private commitRpcEvent(record: SubagentRecord, event: RpcEvent): void {
    if (record.processState === "closed" || record.processState === "crashed") return;
    if (record.processState === "stopping" && event.type === "process_exit") {
      if (record.closeRequested) {
        reduceTurnLifecycle(record, {
          type: "close_completed",
          lifecycleEpoch: record.lifecycleEpoch,
          reason: record.cleanupError ?? "Transport termination confirmed after cleanup timeout",
          timestamp: now(),
        });
        if (record.removeAfterClose || !record.committed) {
          this.state.active.delete(record.id);
          this.state.history.delete(record.id);
          this.state.reloadRecords.delete(record.id);
          this.reservedNames.delete(record.taskName);
        } else if (record.mode === "v2") {
          this.archiveRecord(record);
        }
      } else if (record.crashHandled) {
        reduceTurnLifecycle(record, {
          type: "crash_cleanup_completed",
          lifecycleEpoch: record.lifecycleEpoch,
          timestamp: now(),
        });
      }
      record.stopEventUpdates?.();
      record.stopEventUpdates = undefined;
      this.persistState();
      updateStatus(this.state);
      return;
    }
    if (record.closeRequested || record.crashHandled) return;
    const lifecycleEpoch = record.lifecycleEpoch;

    if (isTurnLifecycleEvent(event)) {
      const token = typeof event.turn_token === "string" ? event.turn_token : undefined;
      if (!token) {
        const violation = !record.committed && event.type === "extension_error" && event.error
          ? oneLine(event.error, 2_000)
          : `Uncorrelated ${event.type ?? "lifecycle"} event cannot mutate a reusable turn`;
        record.fatalProtocolError ??= violation;
        taintTurnTransport(record, violation);
        reduceTurnLifecycle(record, { type: "spawn_failed", error: violation, timestamp: now() });
        record.lifecycleAbort.abort();
        if (record.committed)
          void this.processCrash(record, violation).catch(() => undefined);
        return;
      }
      const prefix = `${record.id}.`;
      const parsedEpoch = token.startsWith(prefix)
        ? Number(token.slice(prefix.length))
        : Number.NaN;
      if (!Number.isSafeInteger(parsedEpoch) || parsedEpoch < 1) {
        const violation = `Invalid lifecycle token ${token}`;
        record.fatalProtocolError ??= violation;
        taintTurnTransport(record, violation);
        record.lifecycleAbort.abort();
        if (record.committed)
          void this.processCrash(record, violation).catch(() => undefined);
        return;
      }
      const sequence = event.turn_sequence;
      if (!Number.isSafeInteger(sequence) || sequence < 1) {
        const violation = `Lifecycle token ${token} has missing or invalid sequence`;
        record.fatalProtocolError ??= violation;
        taintTurnTransport(record, violation);
        record.lifecycleAbort.abort();
        if (record.committed)
          void this.processCrash(record, violation).catch(() => undefined);
        return;
      }
      const previousSequence = record.lifecycleSequences.get(token);
      if (record.closedTurnTokens.has(token)) {
        // A replay of a fully correlated closed-token event is quarantined. It
        // cannot mutate the active turn and does not grow replay state.
        if (previousSequence !== undefined && sequence <= previousSequence) return;
        const violation = `Closed lifecycle token ${token} advanced to sequence ${sequence}`;
        record.fatalProtocolError ??= violation;
        taintTurnTransport(record, violation);
        record.lifecycleAbort.abort();
        if (record.committed)
          void this.processCrash(record, violation).catch(() => undefined);
        return;
      }
      if (record.activeTurn?.token !== token) {
        const violation = `Lifecycle token ${token} does not identify the active child turn`;
        record.fatalProtocolError ??= violation;
        taintTurnTransport(record, violation);
        record.lifecycleAbort.abort();
        if (record.committed)
          void this.processCrash(record, violation).catch(() => undefined);
        return;
      }
      const expectedSequence = (previousSequence ?? 0) + 1;
      if (sequence !== expectedSequence) {
        const violation = `Lifecycle token ${token} sequence ${sequence} did not equal ${expectedSequence}`;
        record.fatalProtocolError ??= violation;
        taintTurnTransport(record, violation);
        record.lifecycleAbort.abort();
        if (record.committed)
          void this.processCrash(record, violation).catch(() => undefined);
        return;
      }
      record.lifecycleSequences.set(token, sequence);
      pushEvent(record, event);
      record.updatedAt = now();
      const reduction = reduceTurnLifecycle(record, {
        type: "rpc_event",
        epoch: parsedEpoch,
        token,
        event,
        timestamp: now(),
      });
      this.handleTurnReduction(record, reduction);
      for (const trackedToken of record.lifecycleSequences.keys()) {
        if (
          trackedToken !== record.activeTurn?.token &&
          !record.closedTurnTokens.has(trackedToken)
        ) record.lifecycleSequences.delete(trackedToken);
      }
      if (reduction.protocolViolation) {
        record.lifecycleAbort.abort();
        if (record.committed)
          void this.processCrash(record, reduction.protocolViolation).catch(() => undefined);
        return;
      }
      if (record.lifecycleEpoch === lifecycleEpoch) updateStatus(this.state);
      return;
    }

    pushEvent(record, event);
    record.updatedAt = now();
    if (
      event.type === "extension_ui_request" &&
      event.method === "setStatus" &&
      event.statusKey === "subagents"
    ) record.nestedActiveCount = parseSubagentStatusCount(event.statusText);

    if (
      event.type === "process_exit" ||
      event.type === "process_error" ||
      event.type === "process_stdin_error" ||
      event.type === "rpc_protocol_error"
    ) {
      if (event.intentional || record.intentionalClose || (event.type === "process_exit" && event.transport_failure_reported))
        return;
      const message = event.error || "Child process exited unexpectedly";
      record.fatalProtocolError ??= !record.committed ? message : undefined;
      if (!record.committed) record.lifecycleAbort.abort();
      else void this.processCrash(record, message).catch(() => undefined);
      return;
    }
    if (record.lifecycleEpoch === lifecycleEpoch) updateStatus(this.state);
  }

  private handleTurnReduction(record: SubagentRecord, reduction: ReturnType<typeof reduceTurnLifecycle>): void {
    if (reduction.armSettlementWatchdog && record.activeTurn)
      this.scheduleMissingSettlement(record, record.activeTurn.epoch);
    if (!reduction.settled) return;
    const settled = reduction.settled;
    if (!record.committed) record.pendingSettlement = settled;
    else {
      const operation = this.processSettlement(record, settled);
      record.brokerSettlementSync = { epoch: settled.epoch, promise: operation };
      void operation.catch((error) =>
        this.handleLifecycleFailure(record, settled, error));
    }
  }

  private async processSettlement(
    record: SubagentRecord,
    settled: SettledTurnSnapshot,
  ): Promise<void> {
    if (settled.completionEventId)
      record.brokerPendingCompletionEventIds.add(settled.completionEventId);
    // Release canonical executing capacity before optional completion effects.
    await this.syncBrokerRecord(
      record,
      false,
      settled.outcome === "interrupted" ? undefined : settled.completionEventId,
    );
    // The reducer has already made status/capacity/follow-up eligibility visible.
    // Completion effects use an immutable turn projection so a later turn cannot
    // leak into this turn's artifact or notification.
    const turnRecord: SubagentRecord = {
      ...record,
      currentTurnId: settled.id,
      turnCount: settled.number,
      currentTurnOutput: settled.output,
      finalOutput: settled.output,
      assistantError: settled.error,
      turnError: settled.error,
      error: settled.error,
      turnOutcome: settled.outcome,
      status:
        settled.outcome === "errored"
          ? "failed"
          : settled.outcome === "interrupted"
            ? "interrupted"
            : "completed",
      endedAt: settled.settledAt,
      updatedAt: settled.settledAt,
    };
    // Optional diagnostics run independently and never gate terminal effects.
    void this.collectSettlementDiagnostics(record, settled);

    if (settled.outcome === "interrupted") {
      settled.completion.resolve({
        id: record.id,
        label: record.generatedLabel,
        status: "interrupted",
        contextMode: record.contextMode,
        depth: record.depth,
        maxDepth: record.maxDepth,
        task: turnRecord.lastTaskMessage,
        output: settled.output,
        payload: `Agent ${record.agentName} turn ${settled.id} was interrupted.`,
        wasSummarized: false,
        sessionFile: record.sessionFile,
        sessionDir: record.sessionDir,
        error: settled.error,
      });
    } else if (record.mode === "v2") {
      // The child-self reporter owns normal v2 artifacts and completion delivery.
      // This parent projection is retained only for local lifecycle bookkeeping.
      settled.completion.resolve({
        id: record.id,
        label: record.generatedLabel,
        status: turnRecord.status,
        contextMode: record.contextMode,
        depth: record.depth,
        maxDepth: record.maxDepth,
        task: turnRecord.lastTaskMessage,
        output: settled.output,
        payload: settled.output,
        wasSummarized: false,
        sessionFile: record.sessionFile,
        sessionDir: record.sessionDir,
        usage: record.usage,
        model: record.model,
        thinkingLevel: record.thinkingLevel,
        error: settled.error,
      });
    } else if (record.mode === "legacy") {
      const completion = await (
        this.dependencies.makeCompletionPayload ?? makeCompletionPayload
      )(
        turnRecord,
        this.state.latestCtx,
        this.state.settings,
        record.lifecycleAbort.signal,
        this.state.pi.getThinkingLevel?.(),
      );
      if (
        record.lifecycleEpoch !== settled.lifecycleEpoch ||
        record.closeRequested
      )
        return;
      settled.completion.resolve(completion);
    }

    if (
      record.lifecycleEpoch !== settled.lifecycleEpoch ||
      record.closeRequested
    )
      return;
    try {
      writeAgentMetadata(record);
    } catch (error) {
      if (record.lifecycleEpoch === settled.lifecycleEpoch)
        record.error ??= `Agent metadata write failed: ${errorMessage(error)}`;
    }
    if (record.lifecycleEpoch !== settled.lifecycleEpoch) return;
    this.persistState();
    updateStatus(this.state);
  }

  private async collectSettlementDiagnostics(
    record: SubagentRecord,
    settled: SettledTurnSnapshot,
  ): Promise<void> {
    const diagnosticsMs = Math.max(
      25,
      Math.min(250, Math.floor(this.state.settings.rpcRequestTimeoutMs / 4)),
    );
    const diagnostics = Promise.all([
      record.client?.getState().catch(() => undefined),
      record.client?.getSessionStats().catch(() => undefined),
    ]);
    const result = await withTimeout(
      diagnostics,
      diagnosticsMs,
      "Optional child diagnostics timed out",
    ).catch(() => undefined);
    if (!result) return;
    if (
      record.lifecycleEpoch !== settled.lifecycleEpoch ||
      record.closeRequested ||
      record.activeTurn?.epoch !== settled.epoch ||
      record.activeTurn.state !== "settled"
    )
      return;
    const [childState, stats] = result;
    if (childState) this.applyChildState(record, childState);
    if (stats) record.usage = usageFromStats(stats);
    if (
      record.lifecycleEpoch !== settled.lifecycleEpoch ||
      record.closeRequested
    )
      return;
    this.tryWriteAgentMetadata(record);
  }

  private async processCrash(record: SubagentRecord, message: string): Promise<void> {
    if (
      record.crashHandled ||
      record.intentionalClose ||
      record.processState === "closed" ||
      !record.committed
    )
      return;
    const crashTurnEpoch = record.activeTurn?.epoch;
    const reduction = reduceTurnLifecycle(record, {
      type: "crash",
      error: message,
      timestamp: now(),
    });
    if (reduction.ignored) return;
    const crashEpoch = record.lifecycleEpoch;
    try {
      await record.client?.stop();
    } catch (error) {
      reduceTurnLifecycle(record, {
        type: "crash_cleanup_failed",
        lifecycleEpoch: crashEpoch,
        error: errorMessage(error),
        timestamp: now(),
      });
      updateStatus(this.state);
      throw error;
    }
    if (record.lifecycleEpoch !== crashEpoch || record.closeRequested) return;
    record.stopEventUpdates?.();
    record.stopEventUpdates = undefined;
    // process_exit may already have confirmed cleanup while stop() was awaiting
    // OS termination. Do not run the slot-release transition twice.
    if (record.processState !== "crashed") {
      reduceTurnLifecycle(record, {
        type: "crash_cleanup_completed",
        lifecycleEpoch: crashEpoch,
        timestamp: now(),
      });
    }
    record.activeTurn?.completion.reject(new Error(record.error!));
    record.activeTurn?.settlement.resolve(undefined);

    if (record.mode === "v2") {
      let activity: CompletionActivity;
      if (record.currentTurnId && !record.settledTurnIds.has(record.currentTurnId)) {
        rememberSettledTurnId(record, record.currentTurnId);
        try {
          activity = writeTurnArtifacts(
            record,
            this.state.settings,
            "errored",
          ).activity;
        } catch (error) {
          activity = this.fallbackActivity(
            record,
            record.currentTurnId,
            `Crash artifact failed: ${errorMessage(error)}. ${record.error}`,
          );
        }
      } else {
        activity = this.fallbackActivity(
          record,
          `process_exit_${Date.now().toString(36)}`,
          record.error ?? "Child process exited unexpectedly",
        );
      }
      if (crashTurnEpoch !== undefined) {
        const eventId = `crash_${record.id}_${crashTurnEpoch}`;
        activity = { ...activity, event_id: eventId };
        const payload = canonicalCompletionPayload(
          "errored",
          oneLine(record.error ?? "Child process crashed", 2_000),
        );
        const content = truncateUtf8(
          taskEnvelope("FINAL_ANSWER", this.state.currentPath, record.agentName, payload),
          this.state.settings.completionMessageMaxBytes,
        );
        try {
          await this.requireBroker().reportCrash({
            targetPath: record.agentName,
            eventId,
            activeEpoch: crashTurnEpoch,
            content,
            details: activity,
          });
        } catch (error) {
          record.error = `${record.error}; parent crash completion delivery failed: ${errorMessage(error)}`;
        }
      }
    }
    try {
      writeAgentMetadata(record);
    } catch {
      // The model-visible fallback above remains authoritative.
    }
    if (record.mode === "v2") this.archiveRecord(record);
    this.persistState();
    updateStatus(this.state);
  }

  private async handleLifecycleFailure(
    record: SubagentRecord,
    settled: SettledTurnSnapshot,
    error: unknown,
  ): Promise<void> {
    if (
      record.lifecycleEpoch !== settled.lifecycleEpoch ||
      record.closeRequested ||
      record.activeTurn?.epoch !== settled.epoch ||
      record.activeTurn.state !== "settled"
    )
      return;
    const message = [
      `Collaboration lifecycle failure: ${errorMessage(error)}`,
      settled.output
        ? `\nRecovered child turn output:\n${settled.output}`
        : undefined,
    ]
      .filter(Boolean)
      .join("\n");
    reduceTurnLifecycle(record, {
      type: "settlement_effect_failed",
      epoch: settled.epoch,
      error: message,
      timestamp: now(),
    });
    settled.completion.reject(new Error(message));
    this.persistState();
    updateStatus(this.state);
  }

  private fallbackActivity(
    record: SubagentRecord,
    turnId: string,
    message: string,
  ): CompletionActivity {
    return {
      event_id: makeId().replace(/^sa_/, "evt_"),
      agent_id: record.id,
      agent_name: record.agentName,
      turn_id: turnId,
      outcome: "errored",
      output: truncateUtf8(
        message,
        Math.max(500, this.state.settings.returnMaxBytes - 1_000),
      ),
      timestamp: now(),
    };
  }

  private publishCompletion(
    record: SubagentRecord,
    activity: CompletionActivity,
  ): void {
    if (record.notifiedTurnIds.has(activity.turn_id)) return;
    if (!record.activityTurnIds.has(activity.turn_id))
      record.activityTurnIds.add(activity.turn_id);
    const payload = canonicalCompletionPayload(
      activity.outcome,
      activity.outcome === "errored"
        ? oneLine(
            record.turnError ?? record.error ?? activity.output,
            2_000,
          )
        : activity.output,
    );
    const content = truncateUtf8(
      taskEnvelope(
        "FINAL_ANSWER",
        this.state.currentPath,
        record.agentName,
        payload,
      ),
      this.state.settings.completionMessageMaxBytes,
    );
    this.state.pi.sendMessage(
      {
        customType: COMPLETION_MESSAGE_TYPE,
        content,
        display: true,
        details: activity,
      },
      { deliverAs: "steer", triggerTurn: false },
    );
    record.notifiedTurnIds.add(activity.turn_id);
  }

  private beginTurn(
    record: SubagentRecord,
    message: string,
  ): NonNullable<SubagentRecord["activeTurn"]> {
    const reduction = reduceTurnLifecycle(record, {
      type: "install",
      message,
      timestamp: now(),
    });
    return reduction.installed!;
  }

  private scheduleMissingSettlement(record: SubagentRecord, epoch: number): void {
    const lifecycleEpoch = record.lifecycleEpoch;
    const timeoutMs = Math.max(
      50,
      this.state.settings.rpcRequestTimeoutMs,
    );
    if (record.settlementWatchdog) clearTimeout(record.settlementWatchdog);
    const watchdog = setTimeout(() => {
      if (
        record.lifecycleEpoch !== lifecycleEpoch ||
        record.closeRequested ||
        record.activeTurn?.epoch !== epoch ||
        record.activeTurn.state !== "active"
      ) return;
      record.settlementWatchdog = undefined;
      taintTurnTransport(
        record,
        `Turn epoch ${epoch} did not emit authoritative agent_settled`,
      );
      void this.processCrash(
        record,
        `Missing agent_settled for turn epoch ${epoch}`,
      ).catch(() => undefined);
    }, timeoutMs);
    watchdog.unref?.();
    record.settlementWatchdog = watchdog;
  }

  private applyChildState(record: SubagentRecord, childState: any): void {
    if (childState?.sessionFile) record.sessionFile = childState.sessionFile;
    if (childState?.model)
      record.model = `${childState.model.provider}/${childState.model.id}`;
    if (childState?.thinkingLevel) record.thinkingLevel = childState.thinkingLevel;
  }

  private reserveActiveSlot(record: SubagentRecord): void {
    if (!record.activeSlotHeld)
      reduceTurnLifecycle(record, { type: "slot_acquired", slot: "active" });
  }

  private reservePersistentSlot(record: SubagentRecord): void {
    if (!record.persistentSlotHeld)
      reduceTurnLifecycle(record, { type: "slot_acquired", slot: "persistent" });
  }

  private releaseActiveSlot(record: SubagentRecord): void {
    reduceTurnLifecycle(record, { type: "slot_released", slot: "active" });
  }

  private releasePersistentSlot(record: SubagentRecord): void {
    reduceTurnLifecycle(record, { type: "slot_released", slot: "persistent" });
  }

  private async rollbackProvisional(
    record: SubagentRecord,
    error: unknown,
  ): Promise<void> {
    const failure = oneLine(errorMessage(error), 2_000);
    record.removeAfterClose = true;
    reduceTurnLifecycle(record, { type: "spawn_failed", error: failure, timestamp: now() });
    reduceTurnLifecycle(record, { type: "close", reason: failure, timestamp: now() });
    const cleanupEpoch = record.lifecycleEpoch;
    const cleanupErrors: unknown[] = [];
    try {
      await record.client?.stop();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      await this.requireBroker().abortChildRegistration(
        record.agentName,
        record.brokerGeneration!,
      );
      record.brokerCapability = undefined;
      record.brokerResident = false;
    } catch (brokerCleanupError) {
      cleanupErrors.push(brokerCleanupError);
    }
    if (cleanupErrors.length > 0) {
      reduceTurnLifecycle(record, {
        type: "close_failed",
        lifecycleEpoch: cleanupEpoch,
        error: cleanupErrors.map(errorMessage).join("; "),
        timestamp: now(),
      });
      updateStatus(this.state);
      throw new AggregateError(
        [error, ...cleanupErrors],
        `Spawn failed and cleanup is unconfirmed for ${record.agentName}`,
      );
    }
    record.stopEventUpdates?.();
    record.stopEventUpdates = undefined;
    reduceTurnLifecycle(record, {
      type: "close_completed",
      lifecycleEpoch: cleanupEpoch,
      reason: failure,
      timestamp: now(),
    });
    this.state.active.delete(record.id);
    this.reservedNames.delete(record.taskName);
    this.failedAudit.push({
      task_name: record.taskName,
      agent_name: record.agentName,
      error: failure,
      timestamp: now(),
    });
    if (this.failedAudit.length > 40) this.failedAudit.shift();
    updateStatus(this.state);
  }

  private async awaitBrokerSettlementSync(
    record: SubagentRecord,
    expectedEpoch: number,
  ): Promise<void> {
    const sync = record.brokerSettlementSync;
    if (sync?.epoch === expectedEpoch) await sync.promise;
  }

  private assertOperationCurrent(
    record: SubagentRecord,
    lifecycleEpoch: number,
    turnToken?: string,
  ): void {
    if (
      record.lifecycleEpoch !== lifecycleEpoch ||
      record.closeRequested ||
      (turnToken !== undefined && record.activeTurn?.token !== turnToken)
    ) throw new Error(`Operation for ${record.agentName} completed after its lifecycle became stale`);
  }

  private awaitStartup(record: SubagentRecord): Promise<void> {
    if (!record.startup) return Promise.reject(new Error(`Agent ${record.agentName} did not start`));
    return record.startup;
  }

  private assertManageable(record: SubagentRecord): void {
    if (record.closeRequested || record.intentionalClose)
      throw new Error(`Agent ${record.agentName} is closing and cannot accept new operations`);
    if (record.mode === "historical")
      throw new Error(`Agent ${record.agentName} is historical and cannot be managed`);
    if (record.processState !== "alive" || !record.client)
      throw new Error(`Agent ${record.agentName} is ${record.processState} and cannot be managed`);
  }

  private resolveTarget(target: string): SubagentRecord {
    this.assertOpen();
    const value = requireNonEmptyString(target, "target");
    const records = [...this.state.active.values()];
    const resolvedPath = resolveAgentReferenceWithAliases(
      this.state.currentPath,
      value,
      new Map(records.map((record) => [record.id, record.agentName])),
      new Set(records.map((record) => record.agentName)),
    );
    const record = records.find(
      (candidate) => candidate.agentName === resolvedPath,
    );
    if (!record || record.mode === "legacy")
      throw new Error(`Unknown direct child target '${value}'`);
    if (
      !isAgentPathWithin(record.agentName, this.state.currentPath) ||
      agentPathDepth(record.agentName) !==
        agentPathDepth(this.state.currentPath) + 1
    )
      throw new Error(`Target '${value}' is not a direct child`);
    return record;
  }

  private publicStatus(record: SubagentRecord): AgentStatus {
    if (record.processState === "starting") return "pending_init";
    if (record.processState === "stopping")
      return record.cleanupError
        ? { errored: truncateUtf8(`Cleanup unconfirmed: ${record.cleanupError}`, 2_000) }
        : "running";
    if (record.processState === "closed" || record.status === "shutdown") return "shutdown";
    if (record.processState === "crashed")
      return { errored: truncateUtf8(record.error ?? "child process crashed", 2_000) };
    if (record.turnState === "running" || record.turnState === "interrupting")
      return "running";
    if (record.turnOutcome === "interrupted" || record.status === "interrupted")
      return "interrupted";
    if (record.turnOutcome === "errored" || record.status === "failed")
      return { errored: truncateUtf8(record.error ?? "turn failed", 2_000) };
    if (record.turnOutcome === "completed" || record.status === "completed")
      return {
        completed: record.finalOutput
          ? truncateUtf8(record.finalOutput, BROKER_REPORT_OUTPUT_MAX_BYTES)
          : null,
      };
    return "pending_init";
  }

  private snapshot(record: SubagentRecord): AgentSnapshot {
    return {
      agent_id: record.id,
      agent_name: record.agentName,
      task_name: record.taskName,
      agent_status: this.publicStatus(record),
      depth: record.depth,
      max_depth: record.maxDepth,
      context: record.contextMode,
      reusable: record.reusable && record.processState === "alive",
      turn_id: record.currentTurnId ?? null,
      turn_count: record.turnCount,
      pending_messages: record.mailbox.length,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
      last_task_message: record.lastTaskMessage
        ? oneLine(record.lastTaskMessage, 240)
        : null,
      session_file: record.sessionFile,
      session_dir: record.sessionDir,
    };
  }

  private selfSnapshot(): AgentSnapshot {
    return {
      agent_id: currentProcessAgentId(this.state.latestCtx),
      agent_name: this.state.currentPath,
      task_name: this.state.currentPath.split("/").pop() || "root",
      agent_status: "running",
      depth: this.state.currentDepth,
      max_depth: this.state.settings.maxDepth,
      context: "fresh",
      reusable: true,
      turn_id: null,
      turn_count: 0,
      pending_messages: 0,
      created_at: now(),
      updated_at: now(),
      last_task_message: "Main thread",
      session_file: this.state.latestCtx?.sessionManager.getSessionFile(),
      session_dir: this.state.latestCtx?.sessionManager.getSessionDir(),
    };
  }

  private filterSnapshotsByPrefix(
    snapshots: AgentSnapshot[],
    prefix: string,
  ): AgentSnapshot[] {
    const value = requireNonEmptyString(prefix, "path_prefix");
    const canonical = resolveAgentReference(this.state.currentPath, value);
    return snapshots.filter((snapshot) =>
      isAgentPathWithin(snapshot.agent_name, canonical),
    );
  }

  private historicalRecord(snapshot: AgentSnapshot): SubagentRecord {
    return createHistoricalSubagentRecord({
      snapshot,
      rootId: currentRootId(this.state.latestCtx),
      timestamp: snapshot.updated_at || snapshot.created_at || now(),
    });
  }

  private archiveRecord(record: SubagentRecord): void {
    this.state.active.delete(record.id);
    this.state.history.delete(record.id);
    this.state.reloadRecords.delete(record.id);
    this.state.reloadRecords.set(record.id, record);
    this.trimReloadRecords();
    if (this.state.settings.statusHistoryLimit <= 0) return;
    this.state.history.set(record.id, record);
    this.trimStatusHistory();
  }

  private trimReloadRecords(): void {
    while (this.state.reloadRecords.size > RELOAD_RECORD_LIMIT) {
      const oldest = [...this.state.reloadRecords.values()]
        .filter((candidate) => candidate.brokerPendingCompletionEventIds.size === 0)
        .sort((left, right) => left.updatedAt - right.updatedAt)[0];
      if (!oldest) break;
      this.state.reloadRecords.delete(oldest.id);
      if (
        !(oldest.mode === "v2" && oldest.committed) &&
        !this.state.active.has(oldest.id) &&
        !this.state.history.has(oldest.id)
      ) this.reservedNames.delete(oldest.taskName);
    }
  }

  private trimStatusHistory(): void {
    while (this.state.history.size > this.state.settings.statusHistoryLimit) {
      const oldest = [...this.state.history.values()].sort(
        (left, right) => left.updatedAt - right.updatedAt,
      )[0];
      if (!oldest) break;
      this.state.history.delete(oldest.id);
      if (
        !(oldest.mode === "v2" && oldest.committed) &&
        !this.state.active.has(oldest.id) &&
        !this.state.reloadRecords.has(oldest.id)
      ) this.reservedNames.delete(oldest.taskName);
    }
  }

  private async syncBrokerRecord(
    record: SubagentRecord,
    active?: boolean,
    pendingCompletionEventId?: string,
  ): Promise<void> {
    if (!record.committed || record.mode === "historical") return;
    await this.requireBroker().updateAgent(record.agentName, {
      status: this.publicStatus(record),
      lastTaskMessage: record.lastTaskMessage,
      lastOutput: record.finalOutput === undefined
        ? null
        : truncateUtf8(record.finalOutput, BROKER_REPORT_OUTPUT_MAX_BYTES),
      mailboxPending: record.mailbox.length,
      // Completion outbox cardinality is broker-derived from stable event IDs;
      // the controller must never overwrite it with process-local UI state.
      questionPending: !!record.pendingQuestion,
      ...(active === undefined ? {} : { active }),
      ...(pendingCompletionEventId ? { pendingCompletionEventId } : {}),
    }, record.activeTurn?.epoch);
  }

  private requireBroker(): RootTreeBroker {
    const broker = this.state.broker;
    if (!broker)
      throw new Error("Root-tree broker is not initialized for this session");
    return broker;
  }

  private async reserveBrokerChild(
    id: string,
    taskName: string,
    message: string,
    reloadable: boolean,
  ): Promise<BrokerConnectionGrant> {
    const broker = this.requireBroker();
    const expectedPath = resolveAgentReference(this.state.currentPath, taskName);
    const grant = await broker.reserveChild({
      id,
      taskName,
      maxDepth: this.state.settings.maxDepth,
      lastTaskMessage: message,
      reloadable,
      transactional: true,
    });
    if (grant.path === expectedPath) return grant;
    await broker.releaseReservation(grant.path).catch(() => undefined);
    throw new Error("Broker reserved an unexpected canonical child path");
  }

  private applyBrokerGrant(
    record: SubagentRecord,
    grant: BrokerConnectionGrant,
  ): void {
    if (grant.path !== record.agentName)
      throw new Error("Local owner record does not match broker reservation");
    record.brokerCapability = grant.capability;
    record.brokerGeneration = grant.generation;
    record.brokerResident = false;
  }

  private childBrokerEnvironment(
    record: SubagentRecord,
    ctx: ExtensionContext,
  ): Record<string, string> {
    const broker = this.requireBroker();
    const socketPath = broker.endpoint?.socketPath;
    if (
      !socketPath ||
      !record.brokerCapability ||
      !record.brokerGeneration
    ) throw new Error("Child broker bootstrap grant is unavailable");
    return buildChildBrokerEnvironment({
      identity: {
        id: record.id,
        path: record.agentName,
        parentId: currentProcessAgentId(ctx),
        parentPath: this.state.currentPath,
        depth: record.depth,
        maxDepth: record.maxDepth,
        connectionGeneration: record.brokerGeneration,
      },
      socketPath,
      capability: record.brokerCapability,
      rootId: record.rootId,
      maxResidentAgents:
        this.state.treeMaxResidentAgents ??
        this.state.settings.maxPersistentAgents,
      maxActiveAgents:
        this.state.treeMaxActiveAgents ??
        this.state.settings.maxConcurrentAgents,
    });
  }

  private async rollbackBrokerOnly(
    targetPath: string,
    originalError: unknown,
  ): Promise<void> {
    try {
      await this.requireBroker().releaseReservation(targetPath);
    } catch (cleanupError) {
      throw new AggregateError(
        [originalError, cleanupError],
        `Spawn failed and broker reservation cleanup failed for ${targetPath}`,
      );
    }
  }

  private requireSpawnToolSources(): SpawnToolSources {
    const sources = extensionSourcesForSpawn(this.state);
    if (sources.fatalOmittedTools.length) {
      throw new Error(
        `Cannot reconstruct active child tools: ${sources.fatalOmittedTools.join(", ")}. Disable SDK-only tools or provide loadable extension source paths.`,
      );
    }
    return sources;
  }

  private tryWriteAgentMetadata(record: SubagentRecord): void {
    try {
      writeAgentMetadata(record);
    } catch (error) {
      record.error ??= `Agent metadata write failed: ${errorMessage(error)}`;
    }
  }

  private persistState(): void {
    try {
      this.state.pi.appendEntry(STATE_ENTRY_TYPE, {
        version: 2,
        self: this.state.currentPath,
        timestamp: now(),
        agents: [...this.state.active.values(), ...this.state.history.values()]
          .filter((record) => record.mode !== "legacy")
          .map((record) => this.snapshot(record)),
        failed_audit: this.failedAudit.slice(-10),
      });
    } catch {
      // Sessionless/RPC teardown may make append unavailable; artifacts remain on disk.
    }
  }

  private assertOpen(): void {
    if (this.state.closing) throw new Error("Collaboration manager is shutting down");
  }

  private canSpawn(): boolean {
    return (
      this.state.settings.allowChildSubagents &&
      this.state.currentDepth < this.state.settings.maxDepth
    );
  }

  private assertCanSpawn(throwOnFailure: boolean): boolean {
    if (this.canSpawn()) return true;
    if (throwOnFailure)
      throw new Error(
        `Cannot spawn: maxDepth ${this.state.settings.maxDepth} reached at depth ${this.state.currentDepth}`,
      );
    return false;
  }

  private depthFailure(
    task: string,
    contextMode: ContextMode,
  ): AgentToolResult<DelegateDetails> {
    const text = `Cannot delegate: maxDepth ${this.state.settings.maxDepth} reached at depth ${this.state.currentDepth}.`;
    return {
      content: [{ type: "text", text }],
      details: {
        id: "",
        label: "max depth",
        status: "failed",
        contextMode,
        depth: this.state.currentDepth,
        maxDepth: this.state.settings.maxDepth,
        task,
        error: "max depth reached",
        events: [],
      },
    };
  }
}

function abortFailure(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function waitForClockDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortFailure("Clock delay interrupted"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(abortFailure("Clock delay interrupted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function validateTaskName(value: string): string {
  return validateAgentSegment(requireNonEmptyString(value, "task_name"));
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
