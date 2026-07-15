import type {
  AgentStatus,
  RootTreeAgentRecord,
  RootTreeEffectToken,
  RootTreeIdentity,
  RootTreeReservationLease,
  RootTreeResourceEffectKind,
  TerminalAgentStatus,
  WaitAgentCompletedDetails,
  WaitAgentResultDetails,
} from "../types.ts";
import { BROKER_REPORT_OUTPUT_MAX_BYTES, ROOT_TREE_LIFETIME_IDENTITY_LIMIT } from "../constants.ts";
import { oneLine } from "../utils.ts";
import {
  agentPathDepth,
  compareAgentPaths,
  isAgentPathWithin,
  joinAgentPath,
  parseAgentPath,
  resolveAgentReference,
  resolveAgentReferenceWithAliases,
  validateAgentSegment,
  validateSafeBasename,
} from "./agent-path.ts";

const DEFAULT_ROOT_TREE_CAPACITY = 16;
const RELOAD_RECORD_LIMIT = 1_024;
const MAX_PENDING_TERMINAL_NOTIFICATIONS_PER_CALLER = 4_096;

export interface RootTreeRegistryOptions {
  root: RootTreeIdentity;
  maxResidentAgents?: number;
  maxActiveAgents?: number;
  /** Internal/test seam; root-owned and never descendant-configurable. */
  maxPendingTerminalNotificationsPerCaller?: number;
  now?: () => number;
}

export interface ReserveRootTreeChildInput {
  id: string;
  taskName: string;
  maxDepth: number;
  lastTaskMessage: string;
  reloadable: boolean;
}

export interface RootTreeReservation {
  readonly path: string;
  readonly effect: RootTreeEffectToken;
  readonly record: Readonly<RootTreeAgentRecord>;
}

export interface RootTreeControllerUpdate {
  status?: AgentStatus;
  lastTaskMessage?: string | null;
  lastOutput?: string | null;
  mailboxPending?: number;
  outboxPending?: number;
  questionPending?: boolean;
  reloadable?: boolean;
}

export interface RootTreeSelfReport {
  status?: AgentStatus;
  lastTaskMessage?: string | null;
  lastOutput?: string | null;
}

export interface RootTreeResourceUpdate {
  resident?: boolean;
  active?: boolean;
}

export interface ListedRootTreeAgent {
  agent_name: string;
  agent_status: AgentStatus;
  last_task_message: string | null;
}

export interface RootTreeWaitInput {
  target?: string;
  all?: true;
}

interface CapturedWaitAgent {
  readonly id: string;
  readonly path: string;
  readonly activeEpoch: number;
  readonly connectionGeneration: number;
}

interface RootTreeTerminalEvent {
  readonly revision: number;
  readonly agentId: string;
  readonly agentPath: string;
  readonly activeEpoch: number;
  readonly connectionGeneration: number;
  readonly status: TerminalAgentStatus;
  readonly ancestorIds: readonly string[];
  readonly anyNotification: boolean;
}

interface RegistryWaiter {
  readonly id: number;
  readonly callerId: string;
  readonly mode: "any" | "target" | "all";
  readonly candidates: readonly CapturedWaitAgent[];
  readonly capturedRevision: number;
  readonly resolve: (result: WaitAgentResultDetails) => void;
  readonly signal?: AbortSignal;
  abortListener?: () => void;
}

interface PendingEffect {
  token: RootTreeEffectToken;
  residentClaim: boolean;
  activeClaim: boolean;
}

/**
 * Synchronous root-tree authority. It performs no I/O and never awaits while
 * registry state is reserved: callers prepare an effect, do I/O, then commit
 * or roll back the epoch-correlated token.
 */
export class RootTreeRegistry {
  private _maxResidentAgents: number;
  private _maxActiveAgents: number;
  private readonly now: () => number;
  private readonly maxPendingTerminalNotificationsPerCaller: number;
  private readonly recordsByPath = new Map<string, RootTreeAgentRecord>();
  private readonly pathByOpaqueId = new Map<string, string>();
  /** Successful logical identities remain reserved after heavy reload state is pruned. */
  private readonly committedPathReservations = new Map<string, string>();
  private readonly committedOpaqueReservations = new Map<string, string>();
  private readonly pendingEffects = new Map<string, PendingEffect>();
  private readonly pendingEffectByPath = new Map<string, string>();
  private readonly terminalEvents: RootTreeTerminalEvent[] = [];
  private readonly latestTerminalEventByPath = new Map<string, RootTreeTerminalEvent>();
  private readonly consumedTerminalRevisions = new Map<string, Set<number>>();
  private readonly waiters = new Map<number, RegistryWaiter>();
  /** Heavy-record retirement notifications consumed synchronously by the broker. */
  private readonly prunedPaths: string[] = [];
  private nextEffectId = 0;
  private nextTerminalRevision = 0;
  private nextWaiterId = 0;

  constructor(options: RootTreeRegistryOptions) {
    const root = validateRootIdentity(options.root);
    this._maxResidentAgents = validateCapacity(
      options.maxResidentAgents ?? DEFAULT_ROOT_TREE_CAPACITY,
      "resident",
    );
    this._maxActiveAgents = validateCapacity(
      options.maxActiveAgents ?? this._maxResidentAgents,
      "active",
    );
    this.maxPendingTerminalNotificationsPerCaller =
      validateTerminalNotificationCapacity(
        options.maxPendingTerminalNotificationsPerCaller ??
          MAX_PENDING_TERMINAL_NOTIFICATIONS_PER_CALLER,
      );
    this.now = options.now ?? Date.now;
    const timestamp = this.now();
    const record: RootTreeAgentRecord = {
      id: root.id,
      path: "/root",
      taskName: "root",
      controllerPath: "/root",
      depth: 0,
      maxDepth: root.maxDepth,
      connectionGeneration: root.connectionGeneration ?? 1,
      status: "running",
      lastTaskMessage: "Main thread",
      lastOutput: null,
      resident: true,
      registered: true,
      reloadable: false,
      activeEpoch: 1,
      nextActiveEpoch: 2,
      mailboxPending: 0,
      outboxPending: 0,
      questionPending: false,
      resourceEpoch: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.recordsByPath.set(record.path, record);
    this.pathByOpaqueId.set(record.id, record.path);
  }

  get size(): number {
    return this.recordsByPath.size;
  }

  get maxResidentAgents(): number {
    return this._maxResidentAgents;
  }

  get maxActiveAgents(): number {
    return this._maxActiveAgents;
  }

  get pendingWaiterCount(): number {
    return this.waiters.size;
  }

  get retainedTerminalEventCount(): number {
    return this.terminalEvents.length;
  }

  /** Drain heavy-record retirement notifications without releasing name reservations. */
  takePrunedPaths(): string[] {
    return this.prunedPaths.splice(0);
  }

  get(path: string): Readonly<RootTreeAgentRecord> | undefined {
    const record = this.recordsByPath.get(parseAgentPath(path));
    return record ? snapshot(record) : undefined;
  }

  identity(path: string): RootTreeIdentity {
    const record = this.requireRecord(path);
    return {
      id: record.id,
      path: record.path,
      parentId: record.parentId,
      parentPath: record.parentPath,
      depth: record.depth,
      maxDepth: record.maxDepth,
      connectionGeneration: record.connectionGeneration,
    };
  }

  resolveTarget(
    caller: RootTreeIdentity,
    reference: string,
  ): Readonly<RootTreeAgentRecord> {
    const callerRecord = this.assertCaller(caller);
    const resolved = this.resolveKnownReference(callerRecord.path, reference);
    const record = this.recordsByPath.get(resolved);
    return record
      ? snapshot(record)
      : snapshot(this.committedUnavailableRecord(resolved));
  }

  list(
    caller: RootTreeIdentity,
    pathPrefix?: string,
  ): { agents: ListedRootTreeAgent[] } {
    const callerRecord = this.assertCaller(caller);
    let prefix: string | undefined;
    if (pathPrefix !== undefined) {
      prefix = this.resolveKnownReference(callerRecord.path, pathPrefix);
    }
    const agents = [...this.recordsByPath.values()]
      .filter(
        (record) =>
          record.resident &&
          (record.path === "/root" || record.registered) &&
          (!prefix || isAgentPathWithin(record.path, prefix)),
      )
      .sort((left, right) => compareAgentPaths(left.path, right.path))
      .map((record) => ({
        agent_name: record.path,
        agent_status: cloneStatus(record.status),
        last_task_message:
          record.path === "/root" ? "Main thread" : record.lastTaskMessage,
      }));
    return { agents };
  }

  /**
   * Atomically snapshots the requested identities/epochs, registers the
   * waiter, and rechecks immutable terminal revisions before returning.
   */
  wait(
    caller: RootTreeIdentity,
    input: RootTreeWaitInput,
    signal?: AbortSignal,
  ): Promise<WaitAgentResultDetails> {
    const callerRecord = this.assertCaller(caller);
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Invalid root-tree wait input");
    for (const key of Object.keys(input))
      if (key !== "target" && key !== "all")
        throw new Error(`Unknown root-tree wait field '${key}'`);
    if (input.target !== undefined && input.all !== undefined)
      throw new Error("wait_agent target and all are mutually exclusive");
    if (input.all !== undefined && input.all !== true)
      throw new Error("wait_agent all must be true when provided");

    if (input.target !== undefined) {
      const target = this.resolveTarget(callerRecord, input.target);
      if (target.path === callerRecord.path)
        throw new Error("an agent cannot wait on itself");
      if (isTerminalStatus(target.status)) {
        const candidateTransition = this.latestTerminalEventByPath.get(target.path);
        const latestTransition = candidateTransition &&
            candidateTransition.agentId === target.id &&
            candidateTransition.connectionGeneration === target.connectionGeneration &&
            terminalStatusesEqual(candidateTransition.status, target.status as TerminalAgentStatus)
          ? candidateTransition
          : undefined;
        return Promise.resolve({
          message: "Wait completed.",
          timed_out: false,
          completed: [
            latestTransition
              ? terminalEventDetails(latestTransition)
              : currentTerminalDetails(target),
          ],
          pending: [],
        });
      }
      return this.registerWaiter(
        callerRecord.id,
        "target",
        [captureWaitAgent(target)],
        signal,
      );
    }

    const descendants = [...this.recordsByPath.values()]
      .filter(
        (record) =>
          record.path !== callerRecord.path &&
          isAgentPathWithin(record.path, callerRecord.path),
      )
      .sort((left, right) => compareAgentPaths(left.path, right.path));

    if (input.all === true) {
      const candidates = descendants
        .filter((record) => !isTerminalStatus(record.status))
        .map(captureWaitAgent);
      if (candidates.length === 0)
        return Promise.resolve(emptyWaitResult());
      return this.registerWaiter(
        callerRecord.id,
        "all",
        candidates,
        signal,
      );
    }

    const candidates = descendants
      .filter((record) => !isTerminalStatus(record.status))
      .map(captureWaitAgent);
    const eligible = this.unconsumedAnyNotifications(callerRecord.id).filter(
      (event) => event.ancestorIds.includes(callerRecord.id),
    );
    const oldest = eligible[0];
    if (oldest) {
      this.consumeEvents(callerRecord.id, [oldest]);
      return Promise.resolve({
        message: "Wait completed.",
        timed_out: false,
        completed: [terminalEventDetails(oldest)],
        pending: candidates.map((candidate) => candidate.path),
      });
    }
    if (candidates.length === 0)
      return Promise.resolve(emptyWaitResult());
    return this.registerWaiter(
      callerRecord.id,
      "any",
      candidates,
      signal,
    );
  }

  cancelAllWaiters(): void {
    for (const waiter of [...this.waiters.values()])
      this.finishWaiter(waiter, "cancel");
  }

  /** Return the complete safe LRU leaf set without mutating canonical state. */
  safeUnloadCandidates(limit = Number.MAX_SAFE_INTEGER): Readonly<RootTreeAgentRecord>[] {
    if (!Number.isSafeInteger(limit) || limit < 0)
      throw new Error("Safe unload candidate limit must be a non-negative integer");
    return [...this.recordsByPath.values()]
      .filter((record) => this.isSafeUnloadTarget(record))
      .sort((left, right) =>
        left.updatedAt - right.updatedAt || compareAgentPaths(left.path, right.path),
      )
      .slice(0, limit)
      .map(snapshot);
  }

  /**
   * Atomically lower or raise root-owned capacity. Every required safe eviction
   * is validated before any record or limit is changed.
   */
  rollbackFailedReload(targetPath: string): Readonly<RootTreeAgentRecord> {
    const target = this.requireRecord(targetPath);
    const before = snapshot(target);
    if (!target.reloadable || !target.resident || target.registered)
      throw new Error("Failed reload rollback is stale or unavailable");
    if (this.pendingEffectByPath.has(target.path))
      throw new Error("Failed reload rollback has a pending registry effect");
    target.resident = false;
    target.activeEpoch = null;
    target.status = "shutdown";
    target.resourceEpoch += 1;
    target.updatedAt = this.now();
    const after = snapshot(target);
    this.captureTerminalTransition(before, after);
    return after;
  }

  planCapacityChange(
    maxResidentAgents: number,
    maxActiveAgents: number,
  ): {
    residentLimit: number;
    activeLimit: number;
    candidates: Readonly<RootTreeAgentRecord>[];
  } {
    const residentLimit = validateCapacity(maxResidentAgents, "resident");
    const activeLimit = validateCapacity(maxActiveAgents, "active");
    const residentCount = this.residentClaimCount();
    const activeCount = this.activeClaimCount();
    if (activeCount > activeLimit)
      throw new Error(
        `Cannot lower root-tree active-agent capacity to ${activeLimit}; ${activeCount} executing claims remain`,
      );
    const required = Math.max(0, residentCount - residentLimit);
    const candidates = this.safeUnloadCandidates(required);
    if (candidates.length !== required)
      throw new Error(
        `Cannot lower root-tree resident-agent capacity to ${residentLimit}; ${required} safe leaf eviction(s) required`,
      );
    return { residentLimit, activeLimit, candidates };
  }

  commitCapacityChange(maxResidentAgents: number, maxActiveAgents: number): void {
    const residentLimit = validateCapacity(maxResidentAgents, "resident");
    const activeLimit = validateCapacity(maxActiveAgents, "active");
    if (this.residentClaimCount() > residentLimit || this.activeClaimCount() > activeLimit)
      throw new Error("Root-tree capacity commit still exceeds the requested limits");
    this._maxResidentAgents = residentLimit;
    this._maxActiveAgents = activeLimit;
  }

  setCapacities(
    maxResidentAgents: number,
    maxActiveAgents: number,
  ): { unloaded: string[] } {
    const plan = this.planCapacityChange(maxResidentAgents, maxActiveAgents);
    const mutable = plan.candidates.map((candidate) => {
      const record = this.requireRecord(candidate.path);
      this.validateResourceTransition(record, "unload");
      return record;
    });
    for (const record of mutable) {
      const before = snapshot(record);
      applyResourceTransition(record, "unload");
      record.resourceEpoch += 1;
      record.updatedAt = this.now();
      this.captureTerminalTransition(before, snapshot(record));
    }
    this.pruneReloadRecords();
    this.commitCapacityChange(plan.residentLimit, plan.activeLimit);
    return { unloaded: mutable.map((record) => record.path) };
  }

  reserveChild(
    caller: RootTreeIdentity,
    input: ReserveRootTreeChildInput,
  ): RootTreeReservation {
    const parent = this.assertCaller(caller);
    if (!parent.registered || !parent.resident)
      throw new Error("Only a live registered agent may reserve a child");
    this.assertNoAncestorUnloadPending(parent.path);
    if (parent.depth >= parent.maxDepth)
      throw new Error(
        `Cannot spawn: maxDepth ${parent.maxDepth} reached at depth ${parent.depth}`,
      );
    if (input.maxDepth !== parent.maxDepth)
      throw new Error("Child max depth must match the inherited root-tree max depth");
    const pendingIdentities = [...this.pendingEffects.values()].filter(
      (pending) => pending.token.kind === "reservation",
    ).length;
    if (
      this.committedPathReservations.size + pendingIdentities >=
        ROOT_TREE_LIFETIME_IDENTITY_LIMIT
    ) throw new Error(
      `Root-tree lifetime identity capacity (${ROOT_TREE_LIFETIME_IDENTITY_LIMIT}) is full`,
    );

    const taskName = validateAgentSegment(input.taskName);
    const id = validateSafeBasename(input.id, "agent id");
    const childPath = joinAgentPath(parent.path, taskName);
    if (this.recordsByPath.has(childPath) || this.committedPathReservations.has(childPath))
      throw new Error(`Task path '${childPath}' is already reserved in this tree`);
    if (this.pathByOpaqueId.has(id) || this.committedOpaqueReservations.has(id))
      throw new Error(`Agent id '${id}' is already reserved in this tree`);
    this.assertDisjointAlias(id, taskName, childPath);
    this.assertTerminalNotificationCapacity(parent.path);
    this.assertCapacityFor(true, true);

    const timestamp = this.now();
    const effect = this.makeEffect(
      "reservation",
      childPath,
      parent.path,
      1,
      0,
    );
    const lease: RootTreeReservationLease = Object.freeze({
      id: effect.id,
      epoch: effect.epoch,
      controllerPath: parent.path,
      residentClaim: true,
      activeClaim: true,
      createdAt: timestamp,
    });
    const record: RootTreeAgentRecord = {
      id,
      path: childPath,
      taskName,
      parentId: parent.id,
      parentPath: parent.path,
      controllerPath: parent.path,
      depth: parent.depth + 1,
      maxDepth: parent.maxDepth,
      connectionGeneration: 0,
      status: "pending_init",
      lastTaskMessage: oneLine(String(input.lastTaskMessage ?? ""), 240),
      lastOutput: null,
      resident: true,
      registered: false,
      reloadable: input.reloadable === true,
      activeEpoch: 1,
      nextActiveEpoch: 2,
      mailboxPending: 0,
      outboxPending: 0,
      questionPending: false,
      resourceEpoch: 1,
      reservationLease: lease,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.recordsByPath.set(record.path, record);
    this.pathByOpaqueId.set(record.id, record.path);
    // Reservation records already carry both claims in their staged state.
    this.rememberEffect(effect, false, false);
    return Object.freeze({
      path: record.path,
      effect,
      record: snapshot(record),
    });
  }

  commitReservation(
    token: RootTreeEffectToken,
    connectionGeneration?: number,
  ): Readonly<RootTreeAgentRecord> {
    const record = this.requirePendingToken(token, "reservation");
    const lease = record.reservationLease;
    if (!lease || lease.id !== token.id || lease.epoch !== token.epoch)
      throw new Error("Reservation lease is stale");
    const generation = connectionGeneration ?? record.connectionGeneration + 1;
    if (!Number.isSafeInteger(generation) || generation <= record.connectionGeneration)
      throw new Error("Connection generation must advance monotonically");
    record.connectionGeneration = generation;
    record.registered = true;
    record.reservationLease = undefined;
    this.committedPathReservations.set(record.path, record.id);
    this.committedOpaqueReservations.set(record.id, record.path);
    record.resourceEpoch += 1;
    record.updatedAt = this.now();
    this.forgetEffect(token);
    return snapshot(record);
  }

  commitReservationForConnection(
    path: string,
    connectionGeneration?: number,
  ): Readonly<RootTreeAgentRecord> {
    const record = this.requireRecord(path);
    const lease = record.reservationLease;
    if (!lease) throw new Error("Agent has no pending reservation lease");
    const pending = this.pendingEffects.get(lease.id);
    if (!pending) throw new Error("Reservation effect token is unavailable");
    return this.commitReservation(pending.token, connectionGeneration);
  }

  rollbackReservation(token: RootTreeEffectToken): void {
    const record = this.requirePendingToken(token, "reservation");
    if (!record.reservationLease || record.reservationLease.id !== token.id)
      throw new Error("Reservation lease is stale");
    this.captureRemovedAsNotFound(snapshot(record));
    this.recordsByPath.delete(record.path);
    this.pathByOpaqueId.delete(record.id);
    this.forgetEffect(token);
  }

  rollbackReservationForController(
    caller: RootTreeIdentity,
    targetPath: string,
  ): void {
    const controller = this.assertCaller(caller);
    const target = this.requireRecord(targetPath);
    if (target.controllerPath !== controller.path || !target.reservationLease)
      throw new Error("Only the owning controller may roll back this reservation");
    const pending = this.pendingEffects.get(target.reservationLease.id);
    if (!pending) throw new Error("Reservation effect token is unavailable");
    this.rollbackReservation(pending.token);
  }

  /** Remove an initially committed child when its controller cannot commit locally. */
  rollbackFailedCommittedChild(
    caller: RootTreeIdentity,
    targetPath: string,
    connectionGeneration: number,
  ): void {
    const controller = this.assertCaller(caller);
    const target = this.requireRecord(targetPath);
    if (
      target.path === "/root" ||
      target.controllerPath !== controller.path ||
      target.reservationLease ||
      target.connectionGeneration !== connectionGeneration
    )
      throw new Error("Failed child rollback is stale or unauthorized");
    if (
      [...this.recordsByPath.values()].some(
        (record) => record.parentPath === target.path,
      )
    ) throw new Error("Failed child rollback cannot orphan descendants");
    if (this.pendingEffectByPath.has(target.path))
      throw new Error("Failed child rollback has a pending registry effect");
    this.captureRemovedAsNotFound(snapshot(target));
    this.recordsByPath.delete(target.path);
    this.pathByOpaqueId.delete(target.id);
    // This child never completed its local spawn transaction, so its logical
    // identity was not exposed and remains reusable.
    this.committedPathReservations.delete(target.path);
    this.committedOpaqueReservations.delete(target.id);
  }

  beginControllerEffect(
    caller: RootTreeIdentity,
    targetPath: string,
    kind: RootTreeResourceEffectKind,
    expectedConnectionGeneration?: number,
  ): RootTreeEffectToken {
    const controller = this.assertCaller(caller);
    const target = this.requireRecord(targetPath);
    if (target.path === "/root" || target.controllerPath !== controller.path)
      throw new Error("Only the owning controller may mutate agent resources");
    if (target.reservationLease)
      throw new Error("Agent reservation has not committed");
    if (this.pendingEffectByPath.has(target.path))
      throw new Error(`Agent '${target.path}' already has a pending registry effect`);
    if (
      expectedConnectionGeneration !== undefined &&
      expectedConnectionGeneration !== target.connectionGeneration
    )
      throw new Error("Connection generation is stale");
    this.validateResourceTransition(target, kind);
    const token = this.makeEffect(
      kind,
      target.path,
      controller.path,
      target.resourceEpoch,
      target.connectionGeneration,
    );
    this.rememberEffect(token, kind === "reload", kind === "activate");
    return token;
  }

  commitControllerEffect(
    token: RootTreeEffectToken,
  ): Readonly<RootTreeAgentRecord> {
    if (token.kind === "reservation")
      throw new Error("Use commitReservation for reservation effects");
    const record = this.requirePendingToken(token, token.kind);
    this.validateResourceTransition(record, token.kind, token.id);
    const before = snapshot(record);
    applyResourceTransition(record, token.kind);
    record.resourceEpoch += 1;
    record.updatedAt = this.now();
    this.forgetEffect(token);
    const after = snapshot(record);
    this.captureTerminalTransition(before, after);
    if (token.kind === "unload" || token.kind === "disconnect")
      this.pruneReloadRecords();
    return after;
  }

  rollbackEffect(token: RootTreeEffectToken): void {
    if (token.kind === "reservation") return this.rollbackReservation(token);
    this.requirePendingToken(token, token.kind);
    this.forgetEffect(token);
  }

  updateController(
    caller: RootTreeIdentity,
    targetPath: string,
    update: RootTreeControllerUpdate,
    expectedActiveEpoch?: number | null,
    suppressAnyNotification = false,
  ): Readonly<RootTreeAgentRecord> {
    const controller = this.assertCaller(caller);
    const target = this.requireRecord(targetPath);
    if (target.controllerPath !== controller.path)
      throw new Error("Only the owning controller may update this agent record");
    if (
      expectedActiveEpoch !== undefined &&
      target.activeEpoch !== expectedActiveEpoch
    )
      throw new Error("Active turn epoch is stale");
    const validated = validateControllerUpdate(update);
    const before = snapshot(target);
    applyReport(target, validated);
    target.updatedAt = this.now();
    const after = snapshot(target);
    this.captureTerminalTransition(before, after, suppressAnyNotification);
    return after;
  }

  updateControllerAtomic(
    caller: RootTreeIdentity,
    targetPath: string,
    update: RootTreeControllerUpdate,
    resources: RootTreeResourceUpdate,
    expectedActiveEpoch?: number | null,
  ): Readonly<RootTreeAgentRecord> {
    const controller = this.assertCaller(caller);
    const target = this.requireRecord(targetPath);
    if (target.controllerPath !== controller.path)
      throw new Error("Only the owning controller may update this agent record");
    if (
      expectedActiveEpoch !== undefined &&
      target.activeEpoch !== expectedActiveEpoch
    )
      throw new Error("Active turn epoch is stale");
    if (!resources || typeof resources !== "object" || Array.isArray(resources))
      throw new Error("Invalid root-tree resource update");
    for (const key of Object.keys(resources)) {
      if (key !== "resident" && key !== "active")
        throw new Error(`Unknown root-tree resource field '${key}'`);
      const value = resources[key as keyof RootTreeResourceUpdate];
      if (value !== undefined && typeof value !== "boolean")
        throw new Error(`Root-tree resource field '${key}' must be boolean`);
    }

    const validated = validateControllerUpdate(update);
    const beforeSnapshot = snapshot(target);
    const staged: RootTreeAgentRecord = {
      ...target,
      status: cloneStatus(target.status),
      reservationLease: target.reservationLease
        ? { ...target.reservationLease }
        : undefined,
    };
    applyReport(staged, validated);

    let resourceTransitions = 0;
    if (
      resources.resident !== undefined &&
      resources.resident !== staged.resident
    ) {
      const kind = resources.resident ? "reload" : "unload";
      if (this.pendingEffectByPath.has(target.path))
        throw new Error(`Agent '${target.path}' already has a pending registry effect`);
      this.validateResourceTransition(staged, kind);
      applyResourceTransition(staged, kind);
      resourceTransitions += 1;
    }
    if (
      resources.active !== undefined &&
      resources.active !== (staged.activeEpoch !== null)
    ) {
      const kind = resources.active ? "activate" : "deactivate";
      if (this.pendingEffectByPath.has(target.path))
        throw new Error(`Agent '${target.path}' already has a pending registry effect`);
      this.validateResourceTransition(staged, kind);
      applyResourceTransition(staged, kind);
      resourceTransitions += 1;
    }

    applyReport(target, validated);
    target.status = cloneStatus(staged.status);
    target.resident = staged.resident;
    target.registered = staged.registered;
    target.activeEpoch = staged.activeEpoch;
    target.nextActiveEpoch = staged.nextActiveEpoch;
    target.resourceEpoch += resourceTransitions;
    target.updatedAt = this.now();
    const after = snapshot(target);
    this.captureTerminalTransition(beforeSnapshot, after);
    if (resources.resident === false) this.pruneReloadRecords();
    return after;
  }

  reportSelf(
    caller: RootTreeIdentity,
    activeEpoch: number,
    report: RootTreeSelfReport,
  ): Readonly<RootTreeAgentRecord> {
    const target = this.assertCaller(caller);
    if (!target.registered || !target.resident)
      throw new Error("Disconnected agents cannot report turn state");
    if (target.activeEpoch === null)
      throw new Error("Idle agents cannot report turn state");
    if (!Number.isSafeInteger(activeEpoch) || activeEpoch < 1)
      throw new Error("Self report must carry a valid active turn epoch");
    if (target.activeEpoch !== activeEpoch)
      throw new Error("Active turn epoch is stale");
    const keys = Object.keys(report as object);
    const allowed = new Set(["status", "lastTaskMessage", "lastOutput"]);
    for (const key of keys)
      if (!allowed.has(key))
        throw new Error(`Self report may not mutate resource field '${key}'`);
    const validated = validateControllerUpdate(report);
    if (validated.status !== undefined) {
      if (isTerminalStatus(target.status)) {
        if (
          !isTerminalStatus(validated.status) ||
          !terminalStatusesEqual(target.status, validated.status)
        ) throw new Error("Active turn epoch already reported its terminal status");
      } else if (isTerminalStatus(validated.status)) {
        if (!isSelfTurnTerminalStatus(validated.status))
          throw new Error("Self reports cannot claim process or registry terminal status");
        if (this.activeEpochHadTerminalTransition(target))
          throw new Error("Active turn epoch already reported its terminal status");
        this.assertTerminalTransitionCapacity(target);
      } else if (target.status === "running" && validated.status === "pending_init") {
        throw new Error("Self reports cannot regress a running active epoch to pending_init");
      }
    }
    const before = snapshot(target);
    applyReport(target, validated);
    target.updatedAt = this.now();
    const after = snapshot(target);
    this.captureTerminalTransition(before, after);
    return after;
  }

  private registerWaiter(
    callerId: string,
    mode: RegistryWaiter["mode"],
    candidates: readonly CapturedWaitAgent[],
    signal?: AbortSignal,
  ): Promise<WaitAgentResultDetails> {
    return new Promise((resolve) => {
      let waiter!: RegistryWaiter;
      waiter = {
        id: ++this.nextWaiterId,
        callerId,
        mode,
        candidates: Object.freeze([...candidates]),
        capturedRevision: this.nextTerminalRevision,
        resolve,
        signal,
      };
      if (signal) {
        waiter.abortListener = () => this.finishWaiter(waiter, "cancel");
        signal.addEventListener("abort", waiter.abortListener, { once: true });
      }
      this.waiters.set(waiter.id, waiter);
      // Snapshot + registration + recheck are synchronous with every registry
      // mutation, so no terminal revision can fall into a lost-wakeup gap.
      if (signal?.aborted) this.finishWaiter(waiter, "cancel");
      else this.tryCompleteWaiter(waiter);
    });
  }

  private tryCompleteWaiter(waiter: RegistryWaiter): void {
    if (!this.waiters.has(waiter.id)) return;
    const available = this.eventsForCandidates(waiter);
    if (waiter.mode === "all") {
      if (available.length === waiter.candidates.length)
        this.finishWaiter(waiter, "completed");
      return;
    }
    if (available.length > 0) this.finishWaiter(waiter, "completed");
  }

  private finishWaiter(
    waiter: RegistryWaiter,
    reason: "completed" | "cancel",
  ): void {
    if (this.waiters.get(waiter.id) !== waiter) return;
    this.waiters.delete(waiter.id);
    if (waiter.signal && waiter.abortListener)
      waiter.signal.removeEventListener("abort", waiter.abortListener);

    const available = this.eventsForCandidates(waiter);
    const selected =
      reason === "completed" && waiter.mode !== "all"
        ? available.slice(0, 1)
        : available;
    if (waiter.mode === "any")
      this.consumeEvents(waiter.callerId, selected);
    const completedKeys = new Set(available.map(terminalEventKey));
    const pending = waiter.candidates
      .filter((candidate) => !completedKeys.has(capturedWaitAgentKey(candidate)))
      .map((candidate) => candidate.path);
    waiter.resolve({
      message:
        reason === "cancel"
          ? "Wait interrupted by new input."
          : "Wait completed.",
      timed_out: false,
      completed: selected.map(terminalEventDetails),
      pending,
    });
    this.pruneConsumedTerminalEvents();
  }

  private eventsForCandidates(waiter: RegistryWaiter): RootTreeTerminalEvent[] {
    const wanted = new Set(waiter.candidates.map(capturedWaitAgentKey));
    const consumed = this.consumedTerminalRevisions.get(waiter.callerId);
    const events = this.terminalEvents.filter((event) => {
      if (!wanted.has(terminalEventKey(event))) return false;
      if (waiter.mode === "any") {
        if (consumed?.has(event.revision)) return false;
        return event.anyNotification || event.revision > waiter.capturedRevision;
      }
      return event.revision > waiter.capturedRevision;
    });
    if (waiter.mode !== "all") return events;
    const firstByCandidate = new Map<string, RootTreeTerminalEvent>();
    for (const event of events) {
      const key = terminalEventKey(event);
      if (!firstByCandidate.has(key)) firstByCandidate.set(key, event);
    }
    return [...firstByCandidate.values()].sort(
      (left, right) => left.revision - right.revision,
    );
  }

  private unconsumedAnyNotifications(callerId: string): RootTreeTerminalEvent[] {
    const consumed = this.consumedTerminalRevisions.get(callerId);
    return this.terminalEvents.filter(
      (event) => event.anyNotification && !consumed?.has(event.revision),
    );
  }

  private consumeEvents(
    callerId: string,
    events: readonly RootTreeTerminalEvent[],
  ): void {
    if (events.length === 0) return;
    const consumed = this.consumedTerminalRevisions.get(callerId) ?? new Set<number>();
    for (const event of events) consumed.add(event.revision);
    this.consumedTerminalRevisions.set(callerId, consumed);
    this.pruneConsumedTerminalEvents();
  }

  private pruneConsumedTerminalEvents(): void {
    const waiterNeeds = (event: RootTreeTerminalEvent): boolean => {
      const key = terminalEventKey(event);
      return [...this.waiters.values()].some(
        (waiter) =>
          event.revision > waiter.capturedRevision &&
          waiter.candidates.some(
            (candidate) => capturedWaitAgentKey(candidate) === key,
          ),
      );
    };
    const retained: RootTreeTerminalEvent[] = [];
    const pruned = new Set<number>();
    for (const event of this.terminalEvents) {
      const hasUnconsumedAny = event.anyNotification && event.ancestorIds.some(
        (callerId) => !this.consumedTerminalRevisions.get(callerId)?.has(event.revision),
      );
      if (hasUnconsumedAny || waiterNeeds(event)) retained.push(event);
      else pruned.add(event.revision);
    }
    if (pruned.size === 0) return;
    this.terminalEvents.splice(0, this.terminalEvents.length, ...retained);
    for (const [callerId, revisions] of this.consumedTerminalRevisions) {
      for (const revision of pruned) revisions.delete(revision);
      if (revisions.size === 0) this.consumedTerminalRevisions.delete(callerId);
    }
  }

  private captureTerminalTransition(
    before: Readonly<RootTreeAgentRecord>,
    after: Readonly<RootTreeAgentRecord>,
    suppressAnyNotification = false,
  ): void {
    if (!isTerminalStatus(after.status)) return;
    const beforeWasTerminal = isTerminalStatus(before.status);
    if (
      beforeWasTerminal &&
      terminalStatusesEqual(before.status, after.status) &&
      before.connectionGeneration === after.connectionGeneration
    ) return;
    const transitionEpoch = terminalTransitionEpoch(before);
    const prior = this.latestTerminalEventByPath.get(before.path);
    if (
      !beforeWasTerminal &&
      prior?.agentId === before.id &&
      prior.activeEpoch === transitionEpoch &&
      prior.connectionGeneration === before.connectionGeneration
    ) return;
    const ancestorIds: string[] = [];
    let parentPath = before.parentPath;
    while (parentPath) {
      const parent = this.recordsByPath.get(parentPath);
      if (!parent) break;
      ancestorIds.push(parent.id);
      parentPath = parent.parentPath;
    }
    const event: RootTreeTerminalEvent = Object.freeze({
      revision: ++this.nextTerminalRevision,
      agentId: before.id,
      agentPath: before.path,
      activeEpoch: transitionEpoch,
      connectionGeneration: before.connectionGeneration,
      status: frozenTerminalStatus(after.status),
      ancestorIds: Object.freeze(ancestorIds),
      anyNotification: !beforeWasTerminal && !suppressAnyNotification,
    });
    this.terminalEvents.push(event);
    this.latestTerminalEventByPath.set(event.agentPath, event);
    for (const waiter of [...this.waiters.values()]) this.tryCompleteWaiter(waiter);
    this.pruneConsumedTerminalEvents();
  }

  private captureRemovedAsNotFound(record: Readonly<RootTreeAgentRecord>): void {
    if (isTerminalStatus(record.status)) return;
    this.captureTerminalTransition(record, { ...record, status: "not_found" });
  }

  private resolveKnownReference(callerPath: string, reference: string): string {
    return resolveAgentReferenceWithAliases(
      callerPath,
      reference,
      {
        get: (alias: string) =>
          this.pathByOpaqueId.get(alias) ??
          this.committedOpaqueReservations.get(alias),
      },
      {
        has: (candidate: string) =>
          this.recordsByPath.has(candidate) ||
          this.committedPathReservations.has(candidate),
      },
    );
  }

  private committedUnavailableRecord(path: string): RootTreeAgentRecord {
    const id = this.committedPathReservations.get(path);
    if (!id) throw new Error(`Unknown agent '${path}'`);
    const parentPath = path.split("/").slice(0, -1).join("/");
    const parent = this.recordsByPath.get(parentPath);
    const parentId = parent?.id ?? this.committedPathReservations.get(parentPath);
    if (!parentId) throw new Error(`Committed agent '${path}' has no known parent`);
    const root = this.requireRecord("/root");
    return {
      id,
      path,
      taskName: path.split("/").at(-1)!,
      parentId,
      parentPath,
      controllerPath: parentPath,
      depth: agentPathDepth(path),
      maxDepth: root.maxDepth,
      connectionGeneration: 0,
      status: "not_found",
      lastTaskMessage: null,
      lastOutput: null,
      resident: false,
      registered: false,
      reloadable: false,
      activeEpoch: null,
      nextActiveEpoch: 1,
      mailboxPending: 0,
      outboxPending: 0,
      questionPending: false,
      resourceEpoch: 0,
      retired: true,
      createdAt: 0,
      updatedAt: 0,
    };
  }

  private assertCaller(identity: RootTreeIdentity): RootTreeAgentRecord {
    const path = parseAgentPath(identity.path);
    const record = this.recordsByPath.get(path);
    if (!record || record.id !== validateSafeBasename(identity.id, "agent id"))
      throw new Error("Caller is outside this root tree");
    if (
      identity.depth !== record.depth ||
      identity.maxDepth !== record.maxDepth ||
      identity.parentId !== record.parentId ||
      identity.parentPath !== record.parentPath ||
      identity.depth !== agentPathDepth(path)
    )
      throw new Error("Caller depth/parent metadata does not match the registry");
    if (
      identity.connectionGeneration !== undefined &&
      identity.connectionGeneration !== record.connectionGeneration
    )
      throw new Error("Caller connection generation is stale");
    return record;
  }

  private assertDisjointAlias(
    id: string,
    taskName: string,
    childPath: string,
  ): void {
    if (id === taskName)
      throw new Error(`Agent id '${id}' is ambiguous with canonical task name '${taskName}'`);
    for (const record of this.recordsByPath.values()) {
      if (record.taskName === id)
        throw new Error(
          `Agent id '${id}' is ambiguous with canonical path '${record.path}'`,
        );
    }
    for (const reservedPath of this.committedPathReservations.keys()) {
      if (reservedPath.split("/").at(-1) === id)
        throw new Error(
          `Agent id '${id}' is ambiguous with canonical path '${reservedPath}'`,
        );
    }
    const aliasPath = this.pathByOpaqueId.get(taskName) ??
      this.committedOpaqueReservations.get(taskName);
    if (aliasPath && aliasPath !== childPath)
      throw new Error(
        `Task name '${taskName}' is ambiguous with opaque id '${taskName}'`,
      );
    try {
      const candidate = resolveAgentReference(childPath.split("/").slice(0, -1).join("/"), id);
      if (this.recordsByPath.has(candidate))
        throw new Error(
          `Agent id '${id}' is ambiguous with canonical path '${candidate}'`,
        );
    } catch (error) {
      if (error instanceof Error && error.message.includes("ambiguous")) throw error;
      // Opaque IDs deliberately occupy a separate namespace and need not parse
      // as canonical path segments.
    }
  }

  private assertNoAncestorUnloadPending(path: string): void {
    for (const pending of this.pendingEffects.values()) {
      if (
        pending.token.kind === "unload" &&
        isAgentPathWithin(path, pending.token.path)
      ) throw new Error(
        `Cannot reserve a descendant while controller ${pending.token.path} is unloading`,
      );
    }
  }

  private residentClaimCount(ignoredEffectId?: string): number {
    return [...this.recordsByPath.values()].filter(
      (record) => record.resident,
    ).length + [...this.pendingEffects.values()].filter(
      (effect) => effect.token.id !== ignoredEffectId && effect.residentClaim,
    ).length;
  }

  private activeClaimCount(ignoredEffectId?: string): number {
    return [...this.recordsByPath.values()].filter(
      (record) => record.activeEpoch !== null,
    ).length + [...this.pendingEffects.values()].filter(
      (effect) => effect.token.id !== ignoredEffectId && effect.activeClaim,
    ).length;
  }

  private isSafeUnloadTarget(target: RootTreeAgentRecord): boolean {
    return (
      target.path !== "/root" &&
      target.resident &&
      target.registered &&
      target.reloadable &&
      target.activeEpoch === null &&
      target.mailboxPending === 0 &&
      target.outboxPending === 0 &&
      !target.questionPending &&
      !target.reservationLease &&
      !this.pendingEffectByPath.has(target.path) &&
      ![...this.recordsByPath.values()].some(
        (record) =>
          record.path !== target.path &&
          isAgentPathWithin(record.path, target.path),
      )
    );
  }

  private pruneReloadRecords(): void {
    const unloaded = [...this.recordsByPath.values()]
      .filter((record) => record.path !== "/root" && !record.resident)
      .sort((left, right) =>
        left.updatedAt - right.updatedAt || compareAgentPaths(left.path, right.path),
      );
    let retained = unloaded.length;
    while (retained > RELOAD_RECORD_LIMIT) {
      const index = unloaded.findIndex((candidate) =>
        this.recordsByPath.get(candidate.path) === candidate &&
        candidate.mailboxPending === 0 &&
        candidate.outboxPending === 0 &&
        !candidate.questionPending &&
        !candidate.reservationLease &&
        !this.pendingEffectByPath.has(candidate.path) &&
        ![...this.recordsByPath.values()].some(
          (record) =>
            record.path !== candidate.path &&
            isAgentPathWithin(record.path, candidate.path),
        )
      );
      if (index < 0) break;
      const [candidate] = unloaded.splice(index, 1);
      this.recordsByPath.delete(candidate!.path);
      this.pathByOpaqueId.delete(candidate!.id);
      this.latestTerminalEventByPath.delete(candidate!.path);
      this.prunedPaths.push(candidate!.path);
      retained -= 1;
    }
  }

  private assertCapacityFor(
    resident: boolean,
    active: boolean,
    ignoredEffectId?: string,
  ): void {
    const residentCount = this.residentClaimCount(ignoredEffectId);
    const activeCount = this.activeClaimCount(ignoredEffectId);
    if (resident && residentCount >= this.maxResidentAgents)
      throw new Error(
        `Root-tree resident-agent capacity (${this.maxResidentAgents}) is full`,
      );
    if (active && activeCount >= this.maxActiveAgents)
      throw new Error(
        `Root-tree active-agent capacity (${this.maxActiveAgents}) is full`,
      );
  }

  private validateResourceTransition(
    target: RootTreeAgentRecord,
    kind: RootTreeResourceEffectKind,
    ignoredEffectId?: string,
  ): void {
    switch (kind) {
      case "connect":
        if (!target.resident || target.registered)
          throw new Error("Agent is not awaiting a controller connection");
        break;
      case "disconnect":
        if (!target.registered) throw new Error("Agent is already disconnected");
        break;
      case "unload":
        if (!target.resident || !target.registered || !target.reloadable || target.activeEpoch !== null)
          throw new Error("Agent is not a live reloadable idle resident");
        if (target.mailboxPending > 0)
          throw new Error("Agent with a pending mailbox cannot be unloaded");
        if (target.outboxPending > 0)
          throw new Error("Agent with a pending completion outbox cannot be unloaded");
        if (target.questionPending)
          throw new Error("Agent with a pending question cannot be unloaded");
        if (
          [...this.recordsByPath.values()].some(
            (record) =>
              record.path !== target.path &&
              isAgentPathWithin(record.path, target.path),
          )
        ) throw new Error(
          "Agent with canonical descendants requiring controller reload ownership cannot be unloaded",
        );
        break;
      case "reload":
        if (target.resident || !target.reloadable)
          throw new Error("Agent is not an unloaded reloadable agent");
        this.assertCapacityFor(true, false, ignoredEffectId);
        break;
      case "activate":
        if (!target.resident || !target.registered || target.activeEpoch !== null)
          throw new Error("Agent is not an idle live resident");
        this.assertTerminalNotificationCapacity(target.parentPath ?? "/root");
        this.assertCapacityFor(false, true, ignoredEffectId);
        break;
      case "deactivate":
        if (target.activeEpoch === null) throw new Error("Agent is already idle");
        break;
    }
  }

  private assertTerminalNotificationCapacity(parentPath: string): void {
    let callerPath: string | undefined = parentPath;
    while (callerPath) {
      const caller = this.recordsByPath.get(callerPath);
      if (!caller) break;
      if (
        this.terminalNotificationUsage(caller) >=
          this.maxPendingTerminalNotificationsPerCaller
      ) throw new Error(
        `wait_agent notification backlog is full for ${caller.path}; consume terminal notifications before starting another turn`,
      );
      callerPath = caller.parentPath;
    }
  }

  /** Convert an already-reserved active-epoch claim into one terminal notification. */
  private assertTerminalTransitionCapacity(target: RootTreeAgentRecord): void {
    let callerPath = target.parentPath;
    while (callerPath) {
      const caller = this.recordsByPath.get(callerPath);
      if (!caller) break;
      if (
        this.terminalNotificationUsage(caller, target.path) >=
          this.maxPendingTerminalNotificationsPerCaller
      ) throw new Error(
        `wait_agent notification backlog is full for ${caller.path}; consume terminal notifications before reporting another terminal transition`,
      );
      callerPath = caller.parentPath;
    }
  }

  private terminalNotificationUsage(
    caller: RootTreeAgentRecord,
    excludedActivePath?: string,
  ): number {
    const consumed = this.consumedTerminalRevisions.get(caller.id);
    const queued = this.terminalEvents.filter(
      (event) =>
        event.anyNotification &&
        event.ancestorIds.includes(caller.id) &&
        !consumed?.has(event.revision),
    ).length;
    const activeClaims = [...this.recordsByPath.values()].filter(
      (record) =>
        record.path !== caller.path &&
        record.path !== excludedActivePath &&
        record.activeEpoch !== null &&
        isAgentPathWithin(record.path, caller.path) &&
        !this.activeEpochHasTerminalNotification(record),
    ).length;
    return queued + activeClaims;
  }

  private activeEpochHadTerminalTransition(record: RootTreeAgentRecord): boolean {
    if (record.activeEpoch === null) return false;
    const event = this.latestTerminalEventByPath.get(record.path);
    return event?.agentId === record.id &&
      event.activeEpoch === record.activeEpoch &&
      event.connectionGeneration === record.connectionGeneration;
  }

  private activeEpochHasTerminalNotification(record: RootTreeAgentRecord): boolean {
    if (!this.activeEpochHadTerminalTransition(record)) return false;
    return this.latestTerminalEventByPath.get(record.path)?.anyNotification === true;
  }

  private makeEffect(
    kind: RootTreeEffectToken["kind"],
    path: string,
    controllerPath: string,
    epoch: number,
    connectionGeneration: number,
  ): RootTreeEffectToken {
    return Object.freeze({
      id: `registry_effect_${++this.nextEffectId}`,
      kind,
      path,
      controllerPath,
      epoch,
      connectionGeneration,
    });
  }

  private rememberEffect(
    token: RootTreeEffectToken,
    residentClaim: boolean,
    activeClaim: boolean,
  ): void {
    this.pendingEffects.set(token.id, { token, residentClaim, activeClaim });
    this.pendingEffectByPath.set(token.path, token.id);
  }

  private forgetEffect(token: RootTreeEffectToken): void {
    this.pendingEffects.delete(token.id);
    if (this.pendingEffectByPath.get(token.path) === token.id)
      this.pendingEffectByPath.delete(token.path);
  }

  private requirePendingToken(
    token: RootTreeEffectToken,
    kind: RootTreeEffectToken["kind"],
  ): RootTreeAgentRecord {
    const pending = this.pendingEffects.get(token.id);
    if (!pending || pending.token !== token || token.kind !== kind)
      throw new Error("Registry effect token is unknown or stale");
    const record = this.requireRecord(token.path);
    if (
      record.resourceEpoch !== token.epoch ||
      record.controllerPath !== token.controllerPath ||
      record.connectionGeneration !== token.connectionGeneration
    )
      throw new Error("Registry effect epoch is stale");
    return record;
  }

  private requireRecord(path: string): RootTreeAgentRecord {
    const canonical = parseAgentPath(path);
    const record = this.recordsByPath.get(canonical);
    if (!record) throw new Error(`Unknown agent '${canonical}'`);
    return record;
  }
}

function applyResourceTransition(
  record: RootTreeAgentRecord,
  kind: RootTreeResourceEffectKind,
): void {
  switch (kind) {
    case "connect":
      record.resident = true;
      record.registered = true;
      record.connectionGeneration += 1;
      break;
    case "disconnect":
      record.registered = false;
      record.resident = false;
      record.activeEpoch = null;
      record.status = record.reloadable ? "shutdown" : "not_found";
      break;
    case "unload":
      record.resident = false;
      record.registered = false;
      record.activeEpoch = null;
      record.status = "shutdown";
      break;
    case "reload":
      record.resident = true;
      record.status = "pending_init";
      break;
    case "activate":
      record.activeEpoch = record.nextActiveEpoch++;
      record.status = "running";
      break;
    case "deactivate":
      record.activeEpoch = null;
      break;
  }
}

function validateRootIdentity(value: RootTreeIdentity): RootTreeIdentity {
  if (parseAgentPath(value.path) !== "/root" || value.depth !== 0)
    throw new Error("Only the canonical root may create a root-tree registry");
  if (
    value.parentId !== undefined ||
    value.parentPath !== undefined ||
    !Number.isInteger(value.maxDepth) ||
    value.maxDepth < 0 ||
    value.maxDepth > 20
  )
    throw new Error("Invalid root depth metadata");
  return {
    ...value,
    id: validateSafeBasename(value.id, "root agent id"),
  };
}

function validateCapacity(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 256)
    throw new Error(`Root-tree ${name} capacity must be between 1 and 256`);
  return value;
}

function validateTerminalNotificationCapacity(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100_000)
    throw new Error("Terminal notification capacity must be between 1 and 100000");
  return value;
}

function validateControllerUpdate(
  update: RootTreeControllerUpdate | RootTreeSelfReport,
): RootTreeControllerUpdate {
  if (!update || typeof update !== "object" || Array.isArray(update))
    throw new Error("Invalid root-tree agent update");
  const source = update as RootTreeControllerUpdate;
  const allowed = new Set([
    "status",
    "lastTaskMessage",
    "lastOutput",
    "mailboxPending",
    "outboxPending",
    "questionPending",
    "reloadable",
  ]);
  for (const key of Object.keys(update))
    if (!allowed.has(key)) throw new Error(`Unknown root-tree update field '${key}'`);
  const result: RootTreeControllerUpdate = {};
  if (source.status !== undefined) result.status = validateStatus(source.status);
  if (source.lastTaskMessage !== undefined)
    result.lastTaskMessage = source.lastTaskMessage === null
      ? null
      : oneLine(String(source.lastTaskMessage), 240);
  if (source.lastOutput !== undefined) {
    if (source.lastOutput !== null) {
      if (typeof source.lastOutput !== "string")
        throw new Error("last output must be a string or null");
      if (Buffer.byteLength(source.lastOutput, "utf8") > BROKER_REPORT_OUTPUT_MAX_BYTES)
        throw new Error("last output exceeds the root-tree report limit");
    }
    result.lastOutput = source.lastOutput;
  }
  for (const key of ["mailboxPending", "outboxPending"] as const) {
    if (source[key] === undefined) continue;
    const count = Number(source[key]);
    if (!Number.isSafeInteger(count) || count < 0 || count > 10_000)
      throw new Error(`Invalid ${key} count`);
    result[key] = count;
  }
  if (source.questionPending !== undefined) {
    if (typeof source.questionPending !== "boolean")
      throw new Error("questionPending must be boolean");
    result.questionPending = source.questionPending;
  }
  if (source.reloadable !== undefined) result.reloadable = source.reloadable === true;
  return result;
}

function applyReport(
  target: RootTreeAgentRecord,
  update: RootTreeControllerUpdate,
): void {
  if (update.status !== undefined) target.status = cloneStatus(update.status);
  if (update.lastTaskMessage !== undefined)
    target.lastTaskMessage = update.lastTaskMessage;
  if (update.lastOutput !== undefined) target.lastOutput = update.lastOutput;
  if (update.mailboxPending !== undefined)
    target.mailboxPending = update.mailboxPending;
  if (update.outboxPending !== undefined) target.outboxPending = update.outboxPending;
  if (update.questionPending !== undefined)
    target.questionPending = update.questionPending;
  if (update.reloadable !== undefined) target.reloadable = update.reloadable;
}

function validateStatus(value: AgentStatus): AgentStatus {
  if (
    value === "pending_init" ||
    value === "running" ||
    value === "interrupted" ||
    value === "shutdown" ||
    value === "not_found"
  )
    return value;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object);
    if (
      keys.length === 1 &&
      keys[0] === "completed" &&
      (object.completed === null || typeof object.completed === "string")
    ) {
      if (
        typeof object.completed === "string" &&
        Buffer.byteLength(object.completed, "utf8") > BROKER_REPORT_OUTPUT_MAX_BYTES
      ) throw new Error("Completed status exceeds the root-tree report limit");
      return { completed: object.completed as string | null };
    }
    if (
      keys.length === 1 &&
      keys[0] === "errored" &&
      typeof object.errored === "string"
    ) {
      if (Buffer.byteLength(object.errored, "utf8") > 2_000)
        throw new Error("Errored status exceeds the root-tree report limit");
      return { errored: object.errored };
    }
  }
  throw new Error("Invalid canonical agent status");
}

function cloneStatus(status: AgentStatus): AgentStatus {
  return typeof status === "object" ? { ...status } : status;
}

function isTerminalStatus(status: AgentStatus): status is TerminalAgentStatus {
  return status !== "pending_init" && status !== "running";
}

function isSelfTurnTerminalStatus(status: TerminalAgentStatus): boolean {
  return status === "interrupted" || typeof status === "object";
}

function capturedEpoch(record: Readonly<RootTreeAgentRecord>): number {
  return record.activeEpoch ?? record.nextActiveEpoch;
}

function terminalEpoch(record: Readonly<RootTreeAgentRecord>): number {
  return record.activeEpoch ?? Math.max(1, record.nextActiveEpoch - 1);
}

function terminalTransitionEpoch(record: Readonly<RootTreeAgentRecord>): number {
  return isTerminalStatus(record.status)
    ? terminalEpoch(record)
    : capturedEpoch(record);
}

function captureWaitAgent(
  record: Readonly<RootTreeAgentRecord>,
): CapturedWaitAgent {
  return Object.freeze({
    id: record.id,
    path: record.path,
    activeEpoch: capturedEpoch(record),
    connectionGeneration: record.connectionGeneration,
  });
}

function frozenTerminalStatus(status: AgentStatus): TerminalAgentStatus {
  if (!isTerminalStatus(status)) throw new Error("Agent status is not terminal");
  return typeof status === "object"
    ? Object.freeze({ ...status }) as TerminalAgentStatus
    : status;
}

function terminalStatusesEqual(
  left: TerminalAgentStatus,
  right: TerminalAgentStatus,
): boolean {
  if (typeof left === "string" || typeof right === "string") return left === right;
  if ("completed" in left && "completed" in right)
    return left.completed === right.completed;
  if ("errored" in left && "errored" in right)
    return left.errored === right.errored;
  return false;
}

function capturedWaitAgentKey(candidate: CapturedWaitAgent): string {
  return `${candidate.id}:${candidate.activeEpoch}:${candidate.connectionGeneration}`;
}

function terminalEventKey(event: RootTreeTerminalEvent): string {
  return `${event.agentId}:${event.activeEpoch}:${event.connectionGeneration}`;
}

function terminalEventDetails(
  event: RootTreeTerminalEvent,
): WaitAgentCompletedDetails {
  return {
    agent_id: event.agentId,
    agent_name: event.agentPath,
    agent_status: cloneStatus(event.status) as TerminalAgentStatus,
    terminal_revision: event.revision,
    active_epoch: event.activeEpoch,
    connection_generation: event.connectionGeneration,
  };
}

function currentTerminalDetails(
  record: Readonly<RootTreeAgentRecord>,
): WaitAgentCompletedDetails {
  if (!isTerminalStatus(record.status))
    throw new Error("Agent status is not terminal");
  return {
    agent_id: record.id,
    agent_name: record.path,
    agent_status: cloneStatus(record.status) as TerminalAgentStatus,
    active_epoch: terminalEpoch(record),
    connection_generation: record.connectionGeneration,
  };
}

function emptyWaitResult(): WaitAgentResultDetails {
  return {
    message: "No agents to wait for.",
    timed_out: false,
    completed: [],
    pending: [],
  };
}

function snapshot(record: RootTreeAgentRecord): Readonly<RootTreeAgentRecord> {
  return Object.freeze({
    ...record,
    status: cloneStatus(record.status),
    reservationLease: record.reservationLease
      ? Object.freeze({ ...record.reservationLease })
      : undefined,
  });
}
