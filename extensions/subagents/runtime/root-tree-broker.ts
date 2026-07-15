import * as crypto from "node:crypto";
import * as net from "node:net";
import * as path from "node:path";
import type {
  AgentStatus,
  AskParentAnswer,
  AskParentInput,
  AskParentRequest,
  BrokerMailboxItem,
  RootTreeAgentRecord,
  RootTreeIdentity,
  WaitAgentResultDetails,
} from "../types.ts";
import {
  ASK_PARENT_ANSWER_MAX_BYTES,
  ASK_PARENT_CLAIM_CACHE_LIMIT,
  ASK_PARENT_DELIVERY_ATTEMPTS,
  ASK_PARENT_DELIVERY_RETRY_MS,
  ASK_PARENT_GLOBAL_MODEL_CALLS_PER_WINDOW,
  ASK_PARENT_GLOBAL_REQUESTS_PER_WINDOW,
  ASK_PARENT_MAX_CONCURRENT,
  ASK_PARENT_MAX_QUEUED,
  ASK_PARENT_PER_CHILD_MODEL_CALLS_PER_WINDOW,
  ASK_PARENT_PER_CHILD_REQUESTS_PER_WINDOW,
  ASK_PARENT_RATE_WINDOW_MS,
  ASK_PARENT_REQUEST_FRAME_MAX_BYTES,
  BROKER_MAILBOX_MAX_BYTES_PER_TARGET,
  BROKER_MAILBOX_MAX_BYTES_PER_TREE,
  BROKER_MAILBOX_MAX_ITEMS_PER_TARGET,
} from "../constants.ts";
import {
  createDeferred,
  errorMessage,
  oneLine,
  requireNonEmptyString,
} from "../utils.ts";
import {
  agentPathDepth,
  isAgentPathWithin,
  parseAgentPath,
  validateSafeBasename,
} from "./agent-path.ts";
import {
  BoundedSocketWriter,
  BrokerFrameDecoder,
  BrokerRateLimiter,
  BROKER_PROTOCOL_VERSION,
  brokerProtocolLimits,
  randomBrokerToken,
  validateFrameId,
  validateGeneration,
  validateOperation,
  validateOperationToken,
  validateSequence,
  type BrokerProtocolLimits,
} from "./broker-protocol.ts";
import { CompletionDedupeLedger } from "./completion-dedupe.ts";
import {
  RootTreeRegistry,
  type RootTreeWaitInput,
} from "./root-tree-registry.ts";
import {
  makeBrokerSocketPath,
  prepareBrokerSocketLocation,
  registerBrokerSocketExitCleanup,
  safeRemoveBrokerSocket,
  scavengeStaleBrokerSockets,
  secureAndVerifyBrokerSocket,
  type SocketIdentity,
} from "./broker-socket.ts";

const REQUEST_TIMEOUT_MS = 60_000;
const CAPABILITY_RE = /^[a-f0-9]{64}$/;

type RouteKind = "send" | "followup" | "interrupt";

export interface BrokerIdentity extends RootTreeIdentity {}
export type BrokerAgent = RootTreeAgentRecord;

export interface ListedBrokerAgent {
  agent_name: string;
  agent_status: AgentStatus;
  last_task_message: string | null;
}

export interface BrokerDispatch {
  op:
    | "inbox"
    | "deliver_mailbox"
    | "prepare_followup"
    | "interrupt"
    | "prepare_unload"
    | "unload"
    | "disconnect_cleanup"
    | "reload"
    | "retry_outbox"
    | "outbox_cleared"
    | "ask_parent";
  payload: any;
}

export type BrokerDispatchHandler = (
  dispatch: BrokerDispatch,
  signal?: AbortSignal,
) => Promise<any>;

export interface BrokerConnectionGrant {
  path: string;
  capability: string;
  generation: number;
}

export interface AskParentBrokerLimits {
  requestFrameMaxBytes: number;
  answerMaxBytes: number;
  rateWindowMs: number;
  perChildRequestsPerWindow: number;
  globalRequestsPerWindow: number;
  perChildModelCallsPerWindow: number;
  globalModelCallsPerWindow: number;
  maxQueued: number;
  maxConcurrent: number;
  deliveryAttempts: number;
  deliveryRetryMs: number;
  claimCacheLimit: number;
}

export interface BrokerOptions {
  identity: BrokerIdentity;
  maxResidentAgents: number;
  maxActiveAgents: number;
  completionOutboxLimit?: number;
  dispatch: BrokerDispatchHandler;
  socketPath?: string;
  capability?: string;
  protocolLimits?: Partial<BrokerProtocolLimits>;
  /** Testable broker-owned ask_parent budgets; children cannot override them. */
  askParentLimits?: Partial<AskParentBrokerLimits>;
}

interface ClientPendingRequest {
  id: string;
  op: string;
  sequence: number;
  operationToken: string;
  resolve(value: any): void;
  reject(error: Error): void;
  timer?: NodeJS.Timeout;
  removeAbort?: () => void;
}

interface ClientDispatchJob {
  id: string;
  op: string;
  sequence: number;
  operationToken: string;
  abort: AbortController;
  settled?: Promise<void>;
}

interface ClientDispatchTombstone {
  id: string;
  op: string;
  sequence: number;
  operationToken: string;
  socket: net.Socket;
  identityPath: string;
  generation: number;
  connectionToken: string;
}

interface MailboxPumpResult {
  startedTurn: boolean;
  delivered: boolean;
}

interface CapabilityGrant {
  capability: string;
  generation: number;
  /** Bootstrap reservations commit only after controller prompt acceptance. */
  transactional: boolean;
}

interface OutboxClearNotification {
  childId: string;
  childPath: string;
  controllerPath: string;
  eventId: string;
  attempts: number;
  timer?: NodeJS.Timeout;
}

interface ServerRequestJob {
  id: string;
  op: string;
  sequence: number;
  operationToken: string;
  abort: AbortController;
  settled?: Promise<void>;
}

interface ServerFrameTombstone {
  id: string;
  op: string;
  sequence: number;
  operationToken: string;
  connection: Connection;
  identityPath: string;
  generation: number;
  connectionToken: string;
}

interface ServerDispatchPending {
  id: string;
  op: string;
  sequence: number;
  operationToken: string;
  connection: Connection;
  identityPath: string;
  generation: number;
  resolve(value: any): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  removeAbort?: () => void;
  canceling: boolean;
  cancelError?: Error;
}

interface Connection {
  socket: net.Socket;
  decoder: BrokerFrameDecoder;
  writer: BoundedSocketWriter;
  rate: BrokerRateLimiter;
  state: "unauthenticated" | "authenticated";
  identity?: BrokerIdentity;
  generation?: number;
  connectionToken?: string;
  closed: boolean;
  authTimer: NodeJS.Timeout;
  nextRequestSequence: number;
  nextDispatchSequence: number;
  requestJobs: Map<string, ServerRequestJob>;
  requestTombstones: Map<string, ServerFrameTombstone>;
  outboundDispatches: Set<string>;
  provisionalRegistration: boolean;
}

interface AskParentQueuedWork {
  caller: BrokerIdentity;
  request: AskParentRequest;
  dispatch: BrokerDispatch;
  signal?: AbortSignal;
  resolve(answer: AskParentAnswer): void;
  reject(error: Error): void;
  removeAbort?: () => void;
  started: boolean;
}

interface AskParentClaim {
  callerPath: string;
  callerGeneration: number;
  promise: Promise<AskParentAnswer>;
  answer?: AskParentAnswer;
}

/**
 * Authenticated logical root-tree control plane. Capabilities prevent one
 * cooperative child from acting as another tree identity; they are not a
 * hostile same-UID sandbox boundary.
 */
export class RootTreeBroker {
  private readonly limits: Readonly<BrokerProtocolLimits>;
  private server?: BrokerServer;
  private socket?: net.Socket;
  private decoder?: BrokerFrameDecoder;
  private writer?: BoundedSocketWriter;
  private requestCounter = 0;
  private nextRequestSequence = 1;
  private expectedDispatchSequence = 1;
  private readonly pending = new Map<string, ClientPendingRequest>();
  private readonly dispatchJobs = new Map<string, ClientDispatchJob>();
  private readonly dispatchTombstones = new Map<
    string,
    ClientDispatchTombstone
  >();
  private readonly clientRate: BrokerRateLimiter;
  private helloPending?: {
    id: string;
    generation: number;
    deferred: ReturnType<typeof createDeferred<void>>;
    timer: NodeJS.Timeout;
  };
  private connectionGeneration?: number;
  private connectionToken?: string;
  private closePromise?: Promise<void>;
  private connected = false;
  private closing = false;
  private closed = false;

  private constructor(private readonly options: BrokerOptions) {
    this.limits = brokerProtocolLimits(options.protocolLimits);
    this.clientRate = new BrokerRateLimiter(
      this.limits.maxRequestsPerWindow,
      this.limits.rateWindowMs,
    );
  }

  static async createRoot(options: BrokerOptions): Promise<RootTreeBroker> {
    if (options.identity.path !== "/root" || options.identity.depth !== 0)
      throw new Error("Only the canonical root may create a root-tree broker");
    const broker = new RootTreeBroker(options);
    const socketPath = options.socketPath ?? makeBrokerSocketPath(options.identity.id);
    broker.server = new BrokerServer(socketPath, options, broker.limits);
    await broker.server.start();
    broker.connected = true;
    return broker;
  }

  static async connectChild(options: BrokerOptions): Promise<RootTreeBroker> {
    const socketPath = options.socketPath;
    const capability = options.capability;
    if (
      !socketPath ||
      !path.isAbsolute(socketPath) ||
      typeof capability !== "string" ||
      !CAPABILITY_RE.test(capability)
    )
      throw new Error("Child broker endpoint/capability is missing or invalid");
    if (options.identity.path === "/root" || options.identity.depth === 0)
      throw new Error("The broker root has no remotely usable identity");
    const broker = new RootTreeBroker(options);
    await broker.connect(socketPath, capability);
    return broker;
  }

  /** The root endpoint deliberately contains no root impersonation credential. */
  get endpoint(): { socketPath: string } | undefined {
    const socketPath = this.server?.socketPath ?? this.options.socketPath;
    return socketPath ? { socketPath } : undefined;
  }

  get serverSecurityCounts(): Record<string, number> | undefined {
    return this.server?.securityCounts();
  }

  async reserveChild(input: {
    id: string;
    taskName: string;
    maxDepth: number;
    lastTaskMessage: string;
    reloadable: boolean;
    /** Defer registry commit until the owning controller accepts the prompt. */
    transactional?: boolean;
  }): Promise<BrokerConnectionGrant> {
    const caller = this.options.identity;
    if (caller.depth >= caller.maxDepth)
      throw new Error(
        `Cannot spawn: maxDepth ${caller.maxDepth} reached at depth ${caller.depth}`,
      );
    return this.request("reserve", input);
  }

  async awaitChildRegistration(
    targetPath: string,
    generation: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.request(
      "await_registration",
      { targetPath, generation, timeoutMs },
      timeoutMs + 1_000,
      signal,
    );
  }

  async commitChildRegistration(
    targetPath: string,
    generation: number,
  ): Promise<void> {
    await this.request("commit_registration", { targetPath, generation });
  }

  async abortChildRegistration(
    targetPath: string,
    generation: number,
  ): Promise<void> {
    await this.request("abort_registration", { targetPath, generation });
  }

  async releaseReservation(targetPath: string): Promise<void> {
    await this.request("release", { targetPath });
  }

  async updateAgent(
    targetPath: string,
    update: Partial<{
      status: AgentStatus;
      lastTaskMessage: string | null;
      lastOutput: string | null;
      resident: boolean;
      reloadable: boolean;
      mailboxPending: number;
      outboxPending: number;
      questionPending: boolean;
      active: boolean;
      pendingCompletionEventId: string;
    }>,
    activeEpoch?: number,
  ): Promise<void | BrokerConnectionGrant> {
    return this.request("update", { targetPath, update, activeEpoch });
  }

  async restoreCompletionOutbox(eventIds: string[]): Promise<void> {
    if (eventIds.length === 0) return;
    await this.request("restore_outbox", { eventIds });
  }

  async waitForCompletionOutboxDrain(
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.request("drain_outbox", { timeoutMs }, timeoutMs + 1_000, signal);
  }

  async route(kind: RouteKind, target: string, message?: string): Promise<any> {
    return this.request("route", { kind, target, message });
  }

  async list(pathPrefix?: string): Promise<{ agents: ListedBrokerAgent[] }> {
    return this.request("list", { pathPrefix });
  }

  async waitAgent(
    input: RootTreeWaitInput,
    signal?: AbortSignal,
  ): Promise<WaitAgentResultDetails> {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("wait_agent arguments must be an object");
    for (const key of Object.keys(input))
      if (key !== "target" && key !== "all")
        throw new Error(`Unknown agent-wait argument '${key}'`);
    if (input.target !== undefined && input.all !== undefined)
      throw new Error("wait_agent target and all are mutually exclusive");
    if (input.all !== undefined && input.all !== true)
      throw new Error("wait_agent all must be true when provided");
    if (
      input.target !== undefined &&
      (typeof input.target !== "string" || input.target.length === 0)
    ) throw new Error("wait_agent target must be a non-empty agent reference");
    return this.request(
      "wait",
      { target: input.target, all: input.all },
      null,
      signal,
      true,
    );
  }

  async setCapacities(
    maxResidentAgents: number,
    maxActiveAgents: number,
  ): Promise<{ unloaded: string[] }> {
    return this.request("set_capacity", { maxResidentAgents, maxActiveAgents });
  }

  async askParent(
    request: AskParentInput,
    signal?: AbortSignal,
  ): Promise<AskParentAnswer> {
    const input = validateAskParentInput(request);
    return this.request("ask_parent", { request: input }, REQUEST_TIMEOUT_MS * 10, signal);
  }

  async reportCrash(input: {
    targetPath: string;
    eventId: string;
    activeEpoch: number;
    content: string;
    details: unknown;
  }): Promise<{ accepted: true; observed: boolean; duplicate?: boolean }> {
    return this.request("crash_completion", input);
  }

  async deliverCompletion(input: {
    targetPath: string;
    eventId: string;
    sender: string;
    content: string;
    details: unknown;
  }): Promise<{ accepted: true; observed: boolean; duplicate?: boolean }> {
    return this.request("completion", input);
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    const operation = this.closeInternal();
    const close = operation.then(
      () => {
        this.closed = true;
      },
      (error) => {
        this.closing = false;
        if (this.closePromise === close) this.closePromise = undefined;
        throw error;
      },
    );
    this.closePromise = close;
    return close;
  }

  private async request(
    op: string,
    payload?: any,
    timeoutMs: number | null = REQUEST_TIMEOUT_MS,
    signal?: AbortSignal,
    awaitCancellationResponse = false,
  ): Promise<any> {
    if (this.closed || this.closing) throw new Error("Root-tree broker is closed");
    if (this.server)
      return this.server.requestLocal(this.options.identity, op, payload, signal);
    if (!this.socket || !this.writer || !this.connected)
      throw new Error("Root-tree broker client is not connected");
    if (this.pending.size >= this.limits.maxOutstandingRequests)
      throw new Error("Broker outstanding request limit is full");
    if (!this.clientRate.take()) throw new Error("Broker request rate limit exceeded");

    const operation = validateOperation(op);
    const id = validateFrameId(`br_${process.pid}_${++this.requestCounter}`);
    const sequence = this.nextRequestSequence++;
    const operationToken = randomBrokerToken();
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, value?: any) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.removeAbort?.();
        if (error) reject(error);
        else resolve(value);
      };
      const sendCancel = () => {
        this.sendCancellation({
          kind: "cancel",
          id,
          op: operation,
          sequence,
          ...this.clientBinding(operationToken),
        });
      };
      const timer = timeoutMs === null
        ? undefined
        : setTimeout(() => {
            finish(new Error(`Broker ${operation} request timed out`));
            sendCancel();
          }, timeoutMs);
      const onAbort = () => {
        if (!awaitCancellationResponse)
          finish(abortError("Broker request aborted"));
        sendCancel();
      };
      const pending: ClientPendingRequest = {
        id,
        op: operation,
        sequence,
        operationToken,
        resolve: (value) => finish(undefined, value),
        reject: (error) => finish(error),
        timer,
      };
      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
        pending.removeAbort = () => signal.removeEventListener("abort", onAbort);
      }
      this.pending.set(id, pending);
      if (signal?.aborted && !awaitCancellationResponse) {
        onAbort();
        return;
      }
      void this.write({
        kind: "request",
        id,
        op: operation,
        sequence,
        payload,
        ...this.clientBinding(operationToken),
      }).catch((error) => pending.reject(asError(error)));
      // BoundedSocketWriter preserves request-before-cancel FIFO ordering.
      if (signal?.aborted) onAbort();
    });
  }

  private async connect(socketPath: string, capability: string): Promise<void> {
    const socket = net.createConnection(socketPath);
    this.socket = socket;
    this.decoder = new BrokerFrameDecoder(this.limits.frameMaxBytes);
    this.writer = new BoundedSocketWriter(socket, this.limits);
    socket.setNoDelay(true);
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("error", (error) => this.failAll(error));
    socket.on("close", () => {
      this.connected = false;
      this.writer?.fail(new Error("Root-tree broker connection closed"));
      if (!this.closed) this.failAll(new Error("Root-tree broker connection closed"));
    });
    await onceConnected(socket);

    const generation = validateGeneration(
      this.options.identity.connectionGeneration ?? 1,
    );
    const helloId = validateFrameId(
      `hello_${process.pid}_${crypto.randomBytes(4).toString("hex")}`,
    );
    const deferred = createDeferred<void>();
    // The rejection is observed immediately even if write/auth setup fails first.
    void deferred.promise.catch(() => undefined);
    const timer = setTimeout(
      () => deferred.reject(new Error("Broker authentication timed out")),
      this.limits.authenticationDeadlineMs,
    );
    this.helloPending = { id: helloId, generation, deferred, timer };
    try {
      await this.write({
        kind: "hello",
        id: helloId,
        protocol: BROKER_PROTOCOL_VERSION,
        identity: { ...this.options.identity, connectionGeneration: generation },
        capability,
      });
      await deferred.promise;
      this.connected = true;
    } finally {
      clearTimeout(timer);
      this.helloPending = undefined;
      if (!this.connected) socket.destroy();
    }
  }

  private onData(chunk: Buffer): void {
    let frames: unknown[];
    try {
      frames = this.decoder!.push(chunk);
    } catch (error) {
      this.failAll(asError(error));
      this.socket?.destroy();
      return;
    }
    for (const frame of frames) {
      try {
        this.handleFrame(frame as any);
      } catch (error) {
        this.failAll(asError(error));
        this.socket?.destroy();
        return;
      }
    }
  }

  private handleFrame(frame: any): void {
    if (frame?.kind === "response") {
      if (this.helloPending && frame.id === this.helloPending.id) {
        if (!frame.ok)
          return this.helloPending.deferred.reject(
            new Error(frame.error || "Broker authentication failed"),
          );
        const result = frame.result;
        if (
          result?.identity !== this.options.identity.path ||
          validateGeneration(result?.generation) !== this.helloPending.generation
        )
          throw new Error("Broker authentication response identity mismatch");
        this.connectionGeneration = result.generation;
        this.connectionToken = validateOperationToken(result?.connectionToken);
        this.helloPending.deferred.resolve(undefined);
        return;
      }
      const id = validateFrameId(frame?.id);
      const pending = this.pending.get(id);
      if (!pending) return; // Bounded client pending state consumes late responses.
      this.assertClientResponseBinding(frame, pending);
      if (frame.ok) pending.resolve(frame.result);
      else pending.reject(new Error(frame.error || "Broker request failed"));
      return;
    }
    if (frame?.kind === "dispatch") {
      this.handleDispatchFrame(frame);
      return;
    }
    if (frame?.kind === "dispatch_cancel") {
      this.handleDispatchCancel(frame);
      return;
    }
    throw new Error("Unexpected broker frame kind");
  }

  private handleDispatchFrame(frame: any): void {
    const id = validateFrameId(frame?.id, "broker dispatch id");
    const op = validateOperation(frame?.op);
    const sequence = validateSequence(frame?.sequence);
    const operationToken = validateOperationToken(frame?.operationToken);
    this.assertServerBinding(frame);
    if (sequence !== this.expectedDispatchSequence++)
      throw new Error("Broker dispatch replay or sequence gap");
    if (this.dispatchJobs.size >= this.limits.maxOutstandingRequests)
      throw new Error("Broker dispatch queue is full");
    if (this.dispatchJobs.has(id) || this.dispatchTombstones.has(id))
      throw new Error("Duplicate broker dispatch id");
    const abort = new AbortController();
    const job: ClientDispatchJob = { id, op, sequence, operationToken, abort };
    this.dispatchJobs.set(id, job);
    const settled = Promise.resolve(
      this.options.dispatch({ op: op as BrokerDispatch["op"], payload: frame.payload }, abort.signal),
    ).then(
      (result) => this.sendDispatchResponseWithRetry(job, true, result),
      (error) => this.sendDispatchResponseWithRetry(
        job,
        false,
        undefined,
        boundedError(error),
      ),
    ).catch(() => undefined).finally(() => {
      if (this.dispatchJobs.get(id) !== job) return;
      this.rememberClientDispatchTombstone(job);
      this.dispatchJobs.delete(id);
    });
    job.settled = settled;
  }

  private async sendDispatchResponseWithRetry(
    job: ClientDispatchJob,
    ok: boolean,
    result?: unknown,
    error?: string,
  ): Promise<void> {
    const attempts = job.op === "ask_parent"
      ? askParentBrokerLimits(this.options.askParentLimits).deliveryAttempts
      : 1;
    let failure: Error | undefined;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      // A canceled dispatch still owes the broker a correlated terminal response;
      // skipping it forces timeout-based connection destruction during normal drain.
      if (this.closed)
        throw abortError("Broker dispatch response aborted");
      try {
        await this.write({
          kind: "dispatch_response",
          id: job.id,
          op: job.op,
          sequence: job.sequence,
          ok,
          result,
          error,
          ...this.clientBinding(job.operationToken),
        });
        return;
      } catch (cause) {
        failure = asError(cause);
        if (attempt < attempts)
          await delayWithAbort(
            askParentBrokerLimits(this.options.askParentLimits).deliveryRetryMs,
          );
      }
    }
    throw failure ?? new Error("Broker dispatch response delivery failed");
  }

  private handleDispatchCancel(frame: any): void {
    const id = validateFrameId(frame?.id, "broker dispatch id");
    this.assertServerBinding(frame);
    const job = this.dispatchJobs.get(id);
    if (!job) {
      const tombstone = this.dispatchTombstones.get(id);
      if (!tombstone) throw new Error("Unknown broker dispatch cancellation");
      this.assertClientDispatchTombstone(frame, tombstone);
      return;
    }
    if (
      validateOperation(frame?.op) !== job.op ||
      validateSequence(frame?.sequence) !== job.sequence ||
      validateOperationToken(frame?.operationToken) !== job.operationToken
    )
      throw new Error("Broker dispatch cancellation binding mismatch");
    job.abort.abort();
  }

  private assertClientResponseBinding(
    frame: any,
    pending: ClientPendingRequest,
  ): void {
    this.assertServerBinding(frame);
    if (
      validateOperation(frame?.op) !== pending.op ||
      validateSequence(frame?.sequence) !== pending.sequence ||
      validateOperationToken(frame?.operationToken) !== pending.operationToken
    )
      throw new Error("Broker response operation binding mismatch");
  }

  private assertServerBinding(frame: any): void {
    if (
      frame?.identity !== this.options.identity.path ||
      validateGeneration(frame?.generation) !== this.connectionGeneration ||
      validateOperationToken(frame?.connectionToken) !== this.connectionToken
    )
      throw new Error("Broker frame connection binding mismatch");
  }

  private clientBinding(operationToken: string): Record<string, unknown> {
    if (!this.connectionGeneration || !this.connectionToken)
      throw new Error("Broker connection binding is unavailable");
    return {
      identity: this.options.identity.path,
      generation: this.connectionGeneration,
      connectionToken: this.connectionToken,
      operationToken,
    };
  }

  private write(frame: unknown): Promise<void> {
    if (!this.writer) return Promise.reject(new Error("Broker socket is closed"));
    return this.writer.send(frame);
  }

  private sendCancellation(frame: unknown): void {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) this.destroyClientConnection(error);
    };
    const timer = setTimeout(
      () => finish(new Error("Broker cancellation write did not drain")),
      this.limits.dispatchDrainTimeoutMs,
    );
    void this.write(frame).then(
      () => finish(),
      (error) => finish(asError(error)),
    );
  }

  private destroyClientConnection(error: Error): void {
    this.connected = false;
    this.failAll(error);
    this.writer?.fail(error);
    this.socket?.destroy();
  }

  private rememberClientDispatchTombstone(job: ClientDispatchJob): void {
    if (
      !this.socket ||
      !this.connectionGeneration ||
      !this.connectionToken
    )
      return;
    rememberBounded(
      this.dispatchTombstones,
      job.id,
      {
        id: job.id,
        op: job.op,
        sequence: job.sequence,
        operationToken: job.operationToken,
        socket: this.socket,
        identityPath: this.options.identity.path,
        generation: this.connectionGeneration,
        connectionToken: this.connectionToken,
      },
      512,
    );
  }

  private assertClientDispatchTombstone(
    frame: any,
    tombstone: ClientDispatchTombstone,
  ): void {
    if (
      tombstone.socket !== this.socket ||
      frame?.identity !== tombstone.identityPath ||
      validateGeneration(frame?.generation) !== tombstone.generation ||
      validateOperationToken(frame?.connectionToken) !==
        tombstone.connectionToken ||
      validateOperation(frame?.op) !== tombstone.op ||
      validateSequence(frame?.sequence) !== tombstone.sequence ||
      validateOperationToken(frame?.operationToken) !==
        tombstone.operationToken
    )
      throw new Error("Broker dispatch cancellation tombstone binding mismatch");
  }

  private failAll(error: Error): void {
    this.helloPending?.deferred.reject(error);
    for (const pending of [...this.pending.values()]) pending.reject(error);
    for (const job of this.dispatchJobs.values()) job.abort.abort();
    this.dispatchJobs.clear();
    this.dispatchTombstones.clear();
  }

  private async closeInternal(): Promise<void> {
    if (this.closed) return;
    const failures: unknown[] = [];
    const dispatchDrains = [...this.dispatchJobs.values()]
      .map((job) => job.settled)
      .filter((job): job is Promise<void> => !!job);
    this.failAll(new Error("Root-tree broker closed"));
    try {
      await boundedDrain(dispatchDrains, this.limits.dispatchDrainTimeoutMs);
    } catch (error) {
      failures.push(error);
    }
    this.writer?.fail(new Error("Root-tree broker closed"));
    if (this.socket) {
      this.socket.end();
      this.socket.destroy();
      this.socket = undefined;
    }
    try {
      await this.server?.close();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0)
      throw new AggregateError(failures, "Root-tree broker close was incomplete");
  }
}

class BrokerServer {
  private readonly registry: RootTreeRegistry;
  private readonly capabilitiesByPath = new Map<string, CapabilityGrant>();
  private readonly connections = new Map<string, Connection>();
  private readonly acceptedConnections = new Set<Connection>();
  private readonly dispatchPending = new Map<string, ServerDispatchPending>();
  private readonly dispatchTombstones = new Map<
    string,
    ServerFrameTombstone
  >();
  /** Paths whose authenticated process is still inside spawn's two-phase commit. */
  private readonly transactionalReservations = new Map<string, string>();
  private readonly mailboxByPath = new Map<string, BrokerMailboxItem[]>();
  private readonly nextMailboxSequence = new Map<string, number>();
  private readonly deliveredMailboxEventIds = new Map<string, Set<string>>();
  /** Active epochs committed for a follow-up whose FIFO delivery is not yet acknowledged. */
  private readonly pendingMailboxActivationEpochs = new Map<string, number>();
  private readonly mailboxPumps = new Map<string, Promise<MailboxPumpResult>>();
  private readonly mailboxRetryState = new Map<
    string,
    { attempts: number; timer?: NodeJS.Timeout }
  >();
  /** Permanent compact tombstone ledger keyed by the authenticated child path. */
  private readonly completionDedupe = new CompletionDedupeLedger();
  private readonly pendingCompletionEventIdsByAgent = new Map<string, Set<string>>();
  private readonly outboxRecoveryState = new Map<
    string,
    { attempts: number; timer?: NodeJS.Timeout }
  >();
  private readonly outboxClearNotifications = new Map<
    string,
    OutboxClearNotification
  >();
  private readonly disconnectReconciliations = new Map<string, Promise<void>>();
  private readonly askParentLimits: Readonly<AskParentBrokerLimits>;
  private readonly askParentPerChildRates = new Map<string, BrokerRateLimiter>();
  private readonly askParentPerChildModelRates = new Map<string, BrokerRateLimiter>();
  private readonly askParentGlobalRate: BrokerRateLimiter;
  private readonly askParentGlobalModelRate: BrokerRateLimiter;
  private readonly askParentQueue: AskParentQueuedWork[] = [];
  private readonly askParentClaims = new Map<string, AskParentClaim>();
  private askParentActive = 0;
  private dispatchCounter = 0;
  private server?: net.Server;
  private closePromise?: Promise<void>;
  private closing = false;
  private socketIdentity?: SocketIdentity;
  private socketDirectoryIdentity?: SocketIdentity;
  private createdSocketDirectory = false;
  private exitCleanup?: () => void;

  constructor(
    readonly socketPath: string,
    private readonly options: BrokerOptions,
    private readonly limits: Readonly<BrokerProtocolLimits>,
  ) {
    this.registry = new RootTreeRegistry({
      root: options.identity,
      maxResidentAgents: options.maxResidentAgents,
      maxActiveAgents: options.maxActiveAgents,
    });
    this.askParentLimits = askParentBrokerLimits(options.askParentLimits);
    this.askParentGlobalRate = new BrokerRateLimiter(
      this.askParentLimits.globalRequestsPerWindow,
      this.askParentLimits.rateWindowMs,
    );
    this.askParentGlobalModelRate = new BrokerRateLimiter(
      this.askParentLimits.globalModelCallsPerWindow,
      this.askParentLimits.rateWindowMs,
    );
  }

  async start(): Promise<void> {
    const prepared = prepareBrokerSocketLocation(this.socketPath);
    await scavengeStaleBrokerSockets(path.dirname(this.socketPath), this.socketPath);
    this.socketDirectoryIdentity = prepared.directoryIdentity;
    this.createdSocketDirectory = prepared.createdDirectory;
    this.server = net.createServer((socket) => this.accept(socket));
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          this.server!.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          this.server!.off("error", onError);
          try {
            this.socketIdentity = secureAndVerifyBrokerSocket(this.socketPath);
            this.exitCleanup = registerBrokerSocketExitCleanup({
              socketPath: this.socketPath,
              socketIdentity: this.socketIdentity,
              directoryIdentity: this.socketDirectoryIdentity,
              removeDirectory: this.createdSocketDirectory,
            });
            resolve();
          } catch (error) {
            reject(error);
          }
        };
        this.server!.once("error", onError);
        this.server!.once("listening", onListening);
        this.server!.listen(this.socketPath);
      });
    } catch (error) {
      const server = this.server;
      this.server = undefined;
      if (server)
        await boundedServerClose(server, this.limits.shutdownTimeoutMs).catch(
          () => undefined,
        );
      safeRemoveBrokerSocket(
        this.socketPath,
        this.socketIdentity,
        this.socketDirectoryIdentity,
        this.createdSocketDirectory,
      );
      throw error;
    }
  }

  requestLocal(
    identity: BrokerIdentity,
    op: string,
    payload: any,
    signal?: AbortSignal,
  ): Promise<any> {
    const trustedRoot = this.registry.identity(identity.path);
    return this.handleRequest(trustedRoot, validateOperation(op), payload, signal);
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    const operation = this.closeInternal();
    const close = operation.catch((error) => {
      if (this.closePromise === close) this.closePromise = undefined;
      throw error;
    });
    this.closePromise = close;
    return close;
  }

  private async closeInternal(): Promise<void> {
    const failures: unknown[] = [];
    this.registry.cancelAllWaiters();
    for (const state of this.mailboxRetryState.values()) clearTimeout(state.timer);
    this.mailboxRetryState.clear();
    for (const state of this.outboxRecoveryState.values()) clearTimeout(state.timer);
    this.outboxRecoveryState.clear();
    for (const state of this.outboxClearNotifications.values()) clearTimeout(state.timer);
    this.outboxClearNotifications.clear();
    const closeError = new Error("Broker server closed");
    for (const work of this.askParentQueue.splice(0)) {
      work.removeAbort?.();
      work.reject(closeError);
    }
    const requestDrains: Promise<void>[] = [
      ...this.disconnectReconciliations.values(),
    ];
    for (const connection of [...this.acceptedConnections]) {
      clearTimeout(connection.authTimer);
      for (const job of connection.requestJobs.values()) {
        if (job.settled) requestDrains.push(job.settled);
        job.abort.abort();
      }
      connection.writer.fail(closeError);
      connection.socket.destroy();
    }
    try {
      await boundedDrain(requestDrains, this.limits.dispatchDrainTimeoutMs);
    } catch (error) {
      failures.push(error);
    }
    for (const connection of this.acceptedConnections)
      connection.requestJobs.clear();
    for (const pending of [...this.dispatchPending.values()])
      this.finishDispatch(pending, closeError);

    const server = this.server;
    if (server) {
      try {
        await boundedServerClose(server, this.limits.shutdownTimeoutMs);
        this.server = undefined;
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      safeRemoveBrokerSocket(
        this.socketPath,
        this.socketIdentity,
        this.socketDirectoryIdentity,
        this.createdSocketDirectory,
      );
      this.exitCleanup?.();
      this.exitCleanup = undefined;
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0)
      throw new AggregateError(failures, "Broker server close was incomplete");
  }

  securityCounts(): Record<string, number> {
    return {
      accepted: this.acceptedConnections.size,
      authenticated: this.connections.size,
      capabilities: this.capabilitiesByPath.size,
      requestJobs: [...this.acceptedConnections].reduce(
        (sum, connection) => sum + connection.requestJobs.size,
        0,
      ),
      dispatches: this.dispatchPending.size,
      waiters: this.registry.pendingWaiterCount,
      tombstones: this.dispatchTombstones.size,
      askParentActive: this.askParentActive,
      askParentQueued: this.askParentQueue.length,
      askParentClaims: this.askParentClaims.size,
      mailboxRetries: this.mailboxRetryState.size,
      mailboxTargets: this.mailboxByPath.size,
      mailboxSequences: this.nextMailboxSequence.size,
      mailboxDedupeTargets: this.deliveredMailboxEventIds.size,
      outboxRecoveries: this.outboxRecoveryState.size,
      outboxClearNotifications: this.outboxClearNotifications.size,
    };
  }

  private accept(socket: net.Socket): void {
    if (
      this.closing ||
      this.acceptedConnections.size >= this.limits.maxAcceptedConnections
    ) {
      socket.destroy();
      return;
    }
    socket.setNoDelay(true);
    let connection!: Connection;
    const authTimer = setTimeout(() => {
      if (connection.state === "unauthenticated")
        connection.socket.destroy(new Error("Broker authentication timed out"));
    }, this.limits.authenticationDeadlineMs);
    connection = {
      socket,
      decoder: new BrokerFrameDecoder(this.limits.frameMaxBytes),
      writer: new BoundedSocketWriter(socket, this.limits),
      rate: new BrokerRateLimiter(
        this.limits.maxRequestsPerWindow,
        this.limits.rateWindowMs,
      ),
      state: "unauthenticated",
      closed: false,
      authTimer,
      nextRequestSequence: 1,
      nextDispatchSequence: 1,
      requestJobs: new Map(),
      requestTombstones: new Map(),
      outboundDispatches: new Set(),
      provisionalRegistration: false,
    };
    this.acceptedConnections.add(connection);
    socket.on("data", (chunk) => this.onConnectionData(connection, chunk));
    socket.on("error", () => undefined);
    socket.on("close", () => this.dropConnection(connection));
  }

  private onConnectionData(connection: Connection, chunk: Buffer): void {
    let frames: unknown[];
    try {
      frames = connection.decoder.push(chunk);
    } catch (error) {
      connection.socket.destroy(asError(error));
      return;
    }
    for (const value of frames) {
      const frame = value as any;
      try {
        if (connection.state === "unauthenticated") {
          this.authenticate(connection, frame);
          continue;
        }
        if (frame?.kind === "request") this.handleRequestFrame(connection, frame);
        else if (frame?.kind === "cancel") this.handleCancelFrame(connection, frame);
        else if (frame?.kind === "dispatch_response")
          this.handleDispatchResponse(connection, frame);
        else throw new Error("Unexpected broker frame kind");
      } catch (error) {
        connection.socket.destroy(asError(error));
        return;
      }
    }
  }

  private authenticate(connection: Connection, frame: any): void {
    let id = "hello";
    try {
      id = validateFrameId(frame?.id, "broker hello id");
      if (frame?.kind !== "hello" || frame.protocol !== BROKER_PROTOCOL_VERSION)
        throw new Error("Broker authentication required");
      const identity = validateIdentity(frame.identity, true);
      if (identity.path === "/root")
        throw new Error("The broker root has no remotely usable capability");
      const expected = this.registry.get(identity.path);
      if (!expected || expected.id !== identity.id)
        throw new Error("Unknown broker identity");
      if (
        expected.parentId !== identity.parentId ||
        expected.parentPath !== identity.parentPath ||
        expected.depth !== identity.depth ||
        expected.maxDepth !== identity.maxDepth
      )
        throw new Error("Broker identity metadata mismatch");
      const grant = this.capabilitiesByPath.get(identity.path);
      if (
        !grant ||
        grant.generation !== identity.connectionGeneration ||
        !safeEqual(grant.capability, String(frame.capability ?? ""))
      )
        throw new Error("Invalid or stale broker capability");
      const existing = this.connections.get(identity.path);
      if (existing && !existing.closed)
        throw new Error("Broker identity already has an active connection");

      let connectedGeneration: number;
      if (expected.reservationLease) {
        if (grant.transactional) {
          connectedGeneration = grant.generation;
          connection.provisionalRegistration = true;
        } else {
          const committed = this.registry.commitReservationForConnection(
            identity.path,
            grant.generation,
          );
          connectedGeneration = committed.connectionGeneration;
        }
      } else {
        const controller = this.registry.identity(expected.controllerPath);
        const effect = this.registry.beginControllerEffect(
          controller,
          identity.path,
          "connect",
          expected.connectionGeneration,
        );
        const committed = this.registry.commitControllerEffect(effect);
        if (committed.connectionGeneration !== grant.generation)
          throw new Error("Broker reconnect generation did not advance exactly once");
        connectedGeneration = committed.connectionGeneration;
      }

      this.capabilitiesByPath.delete(identity.path); // one-use credential
      connection.state = "authenticated";
      connection.identity = {
        ...identity,
        connectionGeneration: connectedGeneration,
      };
      connection.generation = connectedGeneration;
      connection.connectionToken = randomBrokerToken();
      clearTimeout(connection.authTimer);
      this.connections.set(identity.path, connection);
      void this.send(connection, {
        kind: "response",
        id,
        ok: true,
        result: {
          identity: identity.path,
          generation: connectedGeneration,
          connectionToken: connection.connectionToken,
        },
      }).catch((error) => {
        connection.socket.destroy(asError(error));
      });
    } catch (error) {
      void this.send(connection, {
        kind: "response",
        id,
        ok: false,
        error: boundedError(error),
      }).finally(() => {
        connection.socket.destroy();
      }).catch(() => undefined);
    }
  }

  private handleRequestFrame(connection: Connection, frame: any): void {
    this.assertConnectionBinding(connection, frame);
    const id = validateFrameId(frame?.id);
    const op = validateOperation(frame?.op);
    const sequence = validateSequence(frame?.sequence);
    const operationToken = validateOperationToken(frame?.operationToken);
    if (sequence !== connection.nextRequestSequence) {
      this.sendBoundResponseOrClose(
        connection,
        { id, op, sequence, operationToken },
        "Broker request replay or sequence gap",
      );
      return;
    }
    // A valid request sequence is consumed even when rate-limited; otherwise
    // the client advances while the server remains permanently one behind.
    connection.nextRequestSequence += 1;
    if (!connection.rate.take()) {
      this.sendBoundResponseOrClose(
        connection,
        { id, op, sequence, operationToken },
        "Broker request rate limit exceeded",
      );
      return;
    }
    if (
      connection.requestJobs.size >= this.limits.maxOutstandingRequests ||
      connection.requestJobs.has(id) ||
      connection.requestTombstones.has(id)
    ) {
      this.sendBoundResponseOrClose(
        connection,
        { id, op, sequence, operationToken },
        "Broker outstanding request limit is full",
      );
      return;
    }
    const abort = new AbortController();
    const job: ServerRequestJob = { id, op, sequence, operationToken, abort };
    connection.requestJobs.set(id, job);
    const settled = this.handleRequest(connection.identity!, op, frame.payload, abort.signal).then(
      (result) => this.sendBoundResponse(connection, job, true, result),
      (error) => this.sendBoundResponse(
        connection,
        job,
        false,
        undefined,
        boundedError(error),
      ),
    ).catch((error) => {
      connection.socket.destroy(asError(error));
    }).finally(() => {
      if (connection.requestJobs.get(id) !== job) return;
      rememberBounded(
        connection.requestTombstones,
        id,
        this.serverFrameTombstone(connection, job),
        512,
      );
      connection.requestJobs.delete(id);
    });
    job.settled = settled;
  }

  private handleCancelFrame(connection: Connection, frame: any): void {
    this.assertConnectionBinding(connection, frame);
    const id = validateFrameId(frame?.id);
    const job = connection.requestJobs.get(id);
    if (!job) {
      const tombstone = connection.requestTombstones.get(id);
      if (!tombstone) throw new Error("Unknown broker request cancellation");
      this.assertServerFrameTombstone(
        connection,
        frame,
        tombstone,
        "request cancellation",
      );
      return;
    }
    if (
      validateOperation(frame?.op) !== job.op ||
      validateSequence(frame?.sequence) !== job.sequence ||
      validateOperationToken(frame?.operationToken) !== job.operationToken
    )
      throw new Error("Broker request cancellation binding mismatch");
    job.abort.abort();
  }

  private handleDispatchResponse(connection: Connection, frame: any): void {
    this.assertConnectionBinding(connection, frame);
    const id = validateFrameId(frame?.id, "broker dispatch id");
    const pending = this.dispatchPending.get(id);
    if (!pending) {
      const tombstone = this.dispatchTombstones.get(id);
      if (!tombstone) throw new Error("Unknown broker dispatch response");
      this.assertServerFrameTombstone(
        connection,
        frame,
        tombstone,
        "dispatch response",
      );
      return;
    }
    if (
      pending.connection !== connection ||
      pending.identityPath !== connection.identity!.path ||
      pending.generation !== connection.generation ||
      validateOperation(frame?.op) !== pending.op ||
      validateSequence(frame?.sequence) !== pending.sequence ||
      validateOperationToken(frame?.operationToken) !== pending.operationToken
    )
      throw new Error("Broker dispatch response ownership mismatch");
    if (pending.canceling)
      this.finishDispatch(
        pending,
        pending.cancelError ?? abortError("Broker dispatch aborted"),
      );
    else if (frame.ok) this.finishDispatch(pending, undefined, frame.result);
    else this.finishDispatch(
      pending,
      new Error(frame.error || "Broker dispatch failed"),
    );
  }

  private assertConnectionBinding(connection: Connection, frame: any): void {
    if (
      !connection.identity ||
      frame?.identity !== connection.identity.path ||
      validateGeneration(frame?.generation) !== connection.generation ||
      validateOperationToken(frame?.connectionToken) !== connection.connectionToken
    )
      throw new Error("Broker frame connection binding mismatch");
    const current = this.registry.get(connection.identity.path);
    if (
      !current ||
      !current.registered ||
      current.connectionGeneration !== connection.generation
    )
      throw new Error("Broker connection generation is stale");
  }

  private serverFrameTombstone(
    connection: Connection,
    frame: Pick<ServerRequestJob, "id" | "op" | "sequence" | "operationToken">,
  ): ServerFrameTombstone {
    return {
      id: frame.id,
      op: frame.op,
      sequence: frame.sequence,
      operationToken: frame.operationToken,
      connection,
      identityPath: connection.identity!.path,
      generation: connection.generation!,
      connectionToken: connection.connectionToken!,
    };
  }

  private assertServerFrameTombstone(
    connection: Connection,
    frame: any,
    tombstone: ServerFrameTombstone,
    kind: string,
  ): void {
    if (
      tombstone.connection !== connection ||
      frame?.identity !== tombstone.identityPath ||
      validateGeneration(frame?.generation) !== tombstone.generation ||
      validateOperationToken(frame?.connectionToken) !==
        tombstone.connectionToken ||
      validateOperation(frame?.op) !== tombstone.op ||
      validateSequence(frame?.sequence) !== tombstone.sequence ||
      validateOperationToken(frame?.operationToken) !==
        tombstone.operationToken
    )
      throw new Error(`Broker ${kind} tombstone binding mismatch`);
  }

  private sendBoundResponse(
    connection: Connection,
    job: Pick<ServerRequestJob, "id" | "op" | "sequence" | "operationToken">,
    ok: boolean,
    result?: any,
    error?: string,
  ): Promise<void> {
    return this.send(connection, {
      kind: "response",
      id: job.id,
      op: job.op,
      sequence: job.sequence,
      ok,
      result,
      error,
      ...connectionBinding(connection, job.operationToken),
    });
  }

  private sendBoundResponseOrClose(
    connection: Connection,
    job: Pick<ServerRequestJob, "id" | "op" | "sequence" | "operationToken">,
    error: string,
  ): void {
    void this.sendBoundResponse(
      connection,
      job,
      false,
      undefined,
      error,
    ).catch((sendError) => connection.socket.destroy(asError(sendError)));
  }

  private async handleRequest(
    caller: BrokerIdentity,
    op: string,
    payload: any,
    signal?: AbortSignal,
  ): Promise<any> {
    throwIfAborted(signal);
    const callerRecord = this.registry.get(caller.path);
    if (
      !callerRecord ||
      callerRecord.id !== caller.id ||
      callerRecord.connectionGeneration !== caller.connectionGeneration
    )
      throw new Error("Caller is outside this broker tree or has a stale generation");
    try {
      switch (op) {
        case "reserve":
          return await this.reserve(caller, payload, signal);
        case "await_registration":
          return await this.awaitRegistration(caller, payload, signal);
        case "commit_registration":
          return await this.commitRegistration(caller, payload);
        case "abort_registration":
          return await this.abortRegistration(caller, payload);
        case "release":
          return await this.release(caller, payload);
        case "update":
          return await this.update(caller, payload);
        case "restore_outbox":
          return await this.restoreOutbox(caller, payload);
        case "drain_outbox":
          return await this.drainOutbox(caller, payload, signal);
        case "route":
          return await this.route(caller, payload, signal);
        case "list":
          return await this.list(caller, payload);
        case "wait":
          return await this.wait(caller, payload, signal);
        case "set_capacity":
          return await this.setCapacity(caller, payload, signal);
        case "completion":
          return await this.completion(caller, payload, signal);
        case "crash_completion":
          return await this.crashCompletion(caller, payload, signal);
        case "ask_parent":
          return await this.askParent(caller, payload, signal);
        default:
          throw new Error(`Unsupported broker operation '${op}'`);
      }
    } finally {
      this.cleanupPrunedTargetState();
    }
  }

  private cleanupPrunedTargetState(): void {
    for (const targetPath of this.registry.takePrunedPaths()) {
      this.mailboxByPath.delete(targetPath);
      this.nextMailboxSequence.delete(targetPath);
      this.deliveredMailboxEventIds.delete(targetPath);
      this.pendingMailboxActivationEpochs.delete(targetPath);
      this.mailboxPumps.delete(targetPath);
      const retry = this.mailboxRetryState.get(targetPath);
      clearTimeout(retry?.timer);
      this.mailboxRetryState.delete(targetPath);
      // Pending completion records are not eligible for retirement. The
      // compact completion replay ledger deliberately survives as the
      // permanent committed-identity tombstone.
    }
  }

  private async reserve(
    caller: BrokerIdentity,
    payload: any,
    signal?: AbortSignal,
  ): Promise<BrokerConnectionGrant> {
    const input = {
      id: payload?.id,
      taskName: payload?.taskName,
      maxDepth: payload?.maxDepth,
      lastTaskMessage: String(payload?.lastTaskMessage ?? ""),
      reloadable: payload?.reloadable === true,
    };
    let reservation;
    try {
      reservation = this.registry.reserveChild(caller, input);
    } catch (error) {
      if (!asError(error).message.includes("resident-agent capacity")) throw error;
      const candidate = this.registry.safeUnloadCandidates(1)[0];
      if (!candidate) throw error;
      await this.unloadSafely(candidate, signal);
      reservation = this.registry.reserveChild(caller, input);
    }
    const transactional = payload?.transactional === true;
    if (transactional)
      this.transactionalReservations.set(reservation.path, caller.path);
    return this.issueCapability(reservation.path, transactional);
  }

  private async unloadSafely(
    target: BrokerAgent,
    signal?: AbortSignal,
  ): Promise<void> {
    const controller = this.registry.identity(target.controllerPath);
    // Reserve the unload before destructive controller I/O. This blocks a
    // concurrent child reservation from creating an orphan beneath a process
    // that has already accepted shutdown.
    const effect = this.registry.beginControllerEffect(
      controller,
      target.path,
      "unload",
      target.connectionGeneration,
    );
    try {
      await this.dispatchToController(
        target,
        {
          op: "unload",
          payload: { targetId: target.id, targetPath: target.path },
        },
        signal,
      );
      this.registry.commitControllerEffect(effect);
    } catch (error) {
      this.registry.rollbackEffect(effect);
      throw error;
    }
    this.capabilitiesByPath.delete(target.path);
    this.connections.get(target.path)?.socket.destroy();
  }

  private async awaitRegistration(
    caller: BrokerIdentity,
    payload: any,
    signal?: AbortSignal,
  ): Promise<void> {
    const targetPath = parseAgentPath(payload?.targetPath);
    const generation = validateGeneration(payload?.generation);
    const timeoutMs = Number(payload?.timeoutMs);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000)
      throw new Error("Invalid broker registration timeout");
    const deadline = Date.now() + timeoutMs;
    while (true) {
      throwIfAborted(signal);
      const target = this.registry.get(targetPath);
      if (!target || target.controllerPath !== caller.path)
        throw new Error("Child broker reservation is unavailable");
      if (!target.reservationLease ||
          this.transactionalReservations.get(targetPath) !== caller.path)
        throw new Error("Child broker reservation is not awaiting registration");
      const connection = this.connections.get(targetPath);
      if (
        connection &&
        !connection.closed &&
        connection.provisionalRegistration &&
        connection.generation === generation
      ) return;
      if (Date.now() >= deadline)
        throw new Error(`Child broker registration timed out for ${targetPath}`);
      await delayWithAbort(Math.min(10, Math.max(1, deadline - Date.now())), signal);
    }
  }

  private commitRegistration(caller: BrokerIdentity, payload: any): void {
    const targetPath = parseAgentPath(payload?.targetPath);
    const generation = validateGeneration(payload?.generation);
    const target = this.registry.get(targetPath);
    const connection = this.connections.get(targetPath);
    if (
      !target ||
      target.controllerPath !== caller.path ||
      !target.reservationLease ||
      this.transactionalReservations.get(targetPath) !== caller.path ||
      !connection ||
      connection.closed ||
      !connection.provisionalRegistration ||
      connection.generation !== generation
    ) throw new Error("Child broker registration commit is stale or unavailable");
    const committed = this.registry.commitReservationForConnection(
      targetPath,
      generation,
    );
    if (committed.connectionGeneration !== generation)
      throw new Error("Child broker registration generation did not commit exactly");
    connection.provisionalRegistration = false;
    this.transactionalReservations.delete(targetPath);
  }

  private abortRegistration(caller: BrokerIdentity, payload: any): void {
    const targetPath = parseAgentPath(payload?.targetPath);
    const generation = validateGeneration(payload?.generation);
    const target = this.registry.get(targetPath);
    if (!target) return;
    if (target.controllerPath !== caller.path)
      throw new Error("Caller does not own this child registration");
    if (target.reservationLease) {
      const grant = this.capabilitiesByPath.get(targetPath);
      const connection = this.connections.get(targetPath);
      if (
        grant?.generation !== generation &&
        connection?.generation !== generation
      ) throw new Error("Child registration rollback generation is stale");
      this.registry.rollbackReservationForController(caller, targetPath);
    } else {
      this.registry.rollbackFailedCommittedChild(
        caller,
        targetPath,
        generation,
      );
    }
    this.transactionalReservations.delete(targetPath);
    this.capabilitiesByPath.delete(targetPath);
    this.connections.get(targetPath)?.socket.destroy();
  }

  private release(caller: BrokerIdentity, payload: any): void {
    const targetPath = parseAgentPath(payload?.targetPath);
    const target = this.registry.get(targetPath);
    if (!target) return;
    this.registry.rollbackReservationForController(caller, targetPath);
    this.transactionalReservations.delete(targetPath);
    this.capabilitiesByPath.delete(targetPath);
    this.connections.get(targetPath)?.socket.destroy();
  }

  private update(
    caller: BrokerIdentity,
    payload: any,
  ): void | BrokerConnectionGrant {
    const targetPath = parseAgentPath(payload?.targetPath);
    const before = this.registry.get(targetPath);
    if (!before) throw new Error(`Unknown agent '${targetPath}'`);
    const update = payload?.update ?? {};
    const resourceKeys = ["resident", "active"] as const;
    if (before.path === caller.path) {
      for (const key of [
        ...resourceKeys,
        "reloadable",
        "mailboxPending",
        "outboxPending",
        "questionPending",
        "pendingCompletionEventId",
      ])
        if (update[key] !== undefined)
          throw new Error(`Self update may not mutate resource field '${key}'`);
      this.registry.reportSelf(caller, payload?.activeEpoch, {
        status: update.status,
        lastTaskMessage: update.lastTaskMessage,
        lastOutput: update.lastOutput,
      });
      return;
    }
    if (before.controllerPath !== caller.path)
      throw new Error("Caller does not own this agent record");

    const pendingEventId = update.pendingCompletionEventId === undefined
      ? undefined
      : validateCompletionEventId(update.pendingCompletionEventId);
    if (pendingEventId && update.active !== false)
      throw new Error("Pending completion registration requires terminal deactivation");
    const terminalEpoch = update.active === false ? before.activeEpoch : null;
    if (update.active === false && terminalEpoch === null)
      throw new Error("Terminal controller update requires an active epoch");
    const priorPending = this.pendingCompletionEventIdsByAgent.get(targetPath) ?? new Set<string>();
    const stagedPending = new Set(priorPending);
    const pendingAlreadyAccepted = pendingEventId && terminalEpoch !== null
      ? this.completionDedupe.check(targetPath, terminalEpoch, pendingEventId) === "duplicate"
      : false;
    if (pendingEventId && !pendingAlreadyAccepted) stagedPending.add(pendingEventId);

    const after = this.registry.updateControllerAtomic(
      caller,
      targetPath,
      {
        status: update.status,
        lastTaskMessage: update.lastTaskMessage,
        lastOutput: update.lastOutput,
        mailboxPending: update.mailboxPending,
        outboxPending: pendingEventId ? stagedPending.size : update.outboxPending,
        questionPending: update.questionPending,
        reloadable: update.reloadable,
      },
      { resident: update.resident, active: update.active },
      payload?.activeEpoch,
    );
    if (terminalEpoch !== null)
      this.completionDedupe.terminal(targetPath, terminalEpoch, pendingEventId);
    if (pendingEventId && !pendingAlreadyAccepted) {
      this.pendingCompletionEventIdsByAgent.set(targetPath, stagedPending);
      this.scheduleOutboxRecovery(targetPath, true);
    } else if (pendingEventId && pendingAlreadyAccepted) {
      this.scheduleOutboxClearNotification(before, pendingEventId, true);
    }
    if (after.resident) this.wakeMailboxPump(targetPath);
    if (update.active === false) {
      for (const queuedPath of this.mailboxByPath.keys())
        this.wakeMailboxPump(queuedPath);
    }
    if (before.resident && !after.resident) {
      this.capabilitiesByPath.delete(targetPath);
      this.connections.get(targetPath)?.socket.destroy();
      return;
    }
    if (!before.resident && after.resident) return this.issueCapability(targetPath);
  }

  private restoreOutbox(caller: BrokerIdentity, payload: any): void {
    if (caller.path === "/root") throw new Error("Root has no child completion outbox");
    const source = payload?.eventIds;
    if (!Array.isArray(source) || source.length === 0 || source.length > 256)
      throw new Error("Invalid restored completion outbox");
    // Restore every authenticated durable sidecar. Already-accepted events are
    // cleared idempotently when their epoch-bound replay reaches completion().
    const restored = new Set(source.map(validateCompletionEventId));
    this.pendingCompletionEventIdsByAgent.set(caller.path, restored);
    this.registry.updateController(
      this.registry.identity(caller.parentPath!),
      caller.path,
      { outboxPending: restored.size },
    );
    if (restored.size > 0) this.scheduleOutboxRecovery(caller.path, true);
  }

  private async drainOutbox(
    caller: BrokerIdentity,
    payload: any,
    signal?: AbortSignal,
  ): Promise<void> {
    if (caller.path !== "/root")
      throw new Error("Only root may drain the tree completion outbox");
    const timeoutMs = Number(payload?.timeoutMs);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
      throw new Error("Invalid completion outbox drain timeout");
    const deadline = Date.now() + timeoutMs;
    while ([...this.pendingCompletionEventIdsByAgent.values()].some((set) => set.size > 0)) {
      throwIfAborted(signal);
      if (Date.now() >= deadline)
        throw new Error("Timed out draining pending child final answers");
      await delayWithAbort(Math.min(25, deadline - Date.now()), signal);
    }
  }

  private async route(
    caller: BrokerIdentity,
    payload: any,
    signal?: AbortSignal,
  ): Promise<any> {
    const kind = payload?.kind as RouteKind;
    if (kind !== "send" && kind !== "followup" && kind !== "interrupt")
      throw new Error("Invalid broker route kind");
    let target = this.resolveTarget(caller, payload?.target);
    if (target.retired) {
      if (kind === "interrupt")
        return { previous_status: "not_found" as AgentStatus };
      throw new Error(
        `Agent '${target.path}' is known but unavailable because its reload metadata was retired`,
      );
    }
    if (target.path !== "/root" && !target.reloadable)
      throw new Error("Disposable legacy delegates are not targetable");
    if ((kind === "followup" || kind === "interrupt") && target.path === "/root")
      throw new Error(
        kind === "followup"
          ? "Follow-up tasks can't target the root agent"
          : "root is not a spawned agent",
      );
    if (kind === "interrupt" && target.path === caller.path)
      throw new Error(
        "an agent cannot interrupt itself; return your result and let the parent interrupt you if needed",
      );
    if (kind === "interrupt" && !target.resident)
      return { previous_status: "not_found" as AgentStatus };
    if (kind === "interrupt") {
      const previous = target.status;
      await this.dispatchToController(
        target,
        {
          op: "interrupt",
          payload: {
            targetId: target.id,
            targetPath: target.path,
            expectedActiveEpoch: target.activeEpoch,
            connectionGeneration: target.connectionGeneration,
          },
        },
        signal,
      );
      return { previous_status: previous };
    }

    const message = requireBoundedMessage(payload?.message, "message");
    if (!target.resident) {
      await this.reload(target, signal);
      target = this.registry.get(target.path)!;
    }
    const triggerTurn = kind === "followup";
    const queue = this.mailboxByPath.get(target.path) ?? [];
    const item: BrokerMailboxItem = Object.freeze({
      seq: this.nextMailboxSequence.get(target.path) ?? 1,
      eventId: `mail_${crypto.randomBytes(12).toString("hex")}`,
      sender: caller.path,
      kind: triggerTurn ? "NEW_TASK" : "MESSAGE",
      message,
      triggerTurn,
    });
    const projectedQueue = [...queue, item];
    if (projectedQueue.length > BROKER_MAILBOX_MAX_ITEMS_PER_TARGET)
      throw new Error(
        `Agent ${target.path} mailbox item limit (${BROKER_MAILBOX_MAX_ITEMS_PER_TARGET}) is full`,
      );
    const projectedBytes = serializedMailboxBytes(projectedQueue);
    if (projectedBytes > BROKER_MAILBOX_MAX_BYTES_PER_TARGET)
      throw new Error(
        `Agent ${target.path} mailbox byte limit (${BROKER_MAILBOX_MAX_BYTES_PER_TARGET}) is full`,
      );
    let treeBytes = projectedBytes;
    for (const [queuedPath, queuedItems] of this.mailboxByPath) {
      if (queuedPath !== target.path) treeBytes += serializedMailboxBytes(queuedItems);
    }
    if (treeBytes > BROKER_MAILBOX_MAX_BYTES_PER_TREE)
      throw new Error(
        `Root-tree mailbox byte limit (${BROKER_MAILBOX_MAX_BYTES_PER_TREE}) is full`,
      );
    this.nextMailboxSequence.set(target.path, item.seq + 1);
    queue.push(item);
    this.mailboxByPath.set(target.path, queue);
    this.updateMailboxCount(target.path);

    let pumpResult: MailboxPumpResult = { startedTurn: false, delivered: false };
    if (triggerTurn || target.activeEpoch !== null) {
      try {
        // FIFO ownership is already committed. Delivery failure must retain the
        // same event ID for broker-owned retry, never reject the caller into a
        // duplicate semantic retry.
        pumpResult = await this.pumpMailbox(target.path);
      } catch {
        this.scheduleMailboxRetry(target.path);
      }
    }
    const delivered = this.deliveredMailboxEventIds.get(target.path)?.has(item.eventId) === true;
    return {
      target: target.path,
      event_id: item.eventId,
      sequence: item.seq,
      trigger_turn: triggerTurn,
      started_turn: pumpResult.startedTurn,
      delivery: delivered ? "accepted" : "queued",
    };
  }

  private pumpMailbox(
    targetPath: string,
    signal?: AbortSignal,
  ): Promise<MailboxPumpResult> {
    const previous = this.mailboxPumps.get(targetPath) ??
      Promise.resolve({ startedTurn: false, delivered: false });
    const pump = previous
      .catch(() => ({ startedTurn: false, delivered: false }))
      .then(() => this.pumpMailboxOnce(targetPath, signal));
    this.mailboxPumps.set(targetPath, pump);
    void pump.finally(() => {
      if (this.mailboxPumps.get(targetPath) === pump) this.mailboxPumps.delete(targetPath);
    }).catch(() => undefined);
    return pump;
  }

  private scheduleMailboxRetry(targetPath: string, immediate = false): void {
    if (this.closing || !this.shouldPumpMailbox(targetPath)) return;
    const state = this.mailboxRetryState.get(targetPath) ?? { attempts: 0 };
    if (state.timer) {
      if (!immediate) return;
      clearTimeout(state.timer);
    }
    const delay = immediate
      ? 0
      : Math.min(5_000, 50 * 2 ** Math.min(7, state.attempts));
    state.timer = setTimeout(() => {
      state.timer = undefined;
      if (this.closing || !this.shouldPumpMailbox(targetPath)) {
        this.mailboxRetryState.delete(targetPath);
        return;
      }
      void this.pumpMailbox(targetPath).then(
        (result) => {
          if (result.delivered) state.attempts = 0;
          else state.attempts += 1;
          if (this.shouldPumpMailbox(targetPath))
            this.scheduleMailboxRetry(targetPath);
          else
            this.mailboxRetryState.delete(targetPath);
        },
        () => {
          state.attempts += 1;
          this.scheduleMailboxRetry(targetPath);
        },
      );
    }, delay);
    state.timer.unref?.();
    this.mailboxRetryState.set(targetPath, state);
  }

  private wakeMailboxPump(targetPath: string): void {
    if (this.shouldPumpMailbox(targetPath))
      this.scheduleMailboxRetry(targetPath, true);
  }

  private shouldPumpMailbox(targetPath: string): boolean {
    const queue = this.mailboxByPath.get(targetPath);
    if (!queue?.length) return false;
    return queue.some((item) => item.triggerTurn) ||
      (this.registry.get(targetPath)?.activeEpoch ?? null) !== null;
  }

  private async pumpMailboxOnce(
    targetPath: string,
    signal?: AbortSignal,
  ): Promise<MailboxPumpResult> {
    const queue = this.mailboxByPath.get(targetPath) ?? [];
    if (queue.length === 0) return { startedTurn: false, delivered: false };
    const delivered = this.deliveredMailboxEventIds.get(targetPath) ?? new Set<string>();
    const batch = queue.filter((item) => !delivered.has(item.eventId));
    if (batch.length === 0) {
      queue.length = 0;
      this.updateMailboxCount(targetPath);
      return { startedTurn: false, delivered: true };
    }

    let startedTurn = false;
    let acceptedOnce = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      let target = this.registry.get(targetPath);
      if (!target) throw new Error(`Mailbox target '${targetPath}' disappeared`);
      if (!target.resident) {
        await this.reload(target, signal);
        target = this.registry.get(targetPath)!;
      }
      const hasFollowup = batch.some((item) => item.triggerTurn);
      let triggerTurn = false;
      const pendingActivationEpoch = this.pendingMailboxActivationEpochs.get(targetPath);
      if (!acceptedOnce && pendingActivationEpoch !== undefined) {
        // If the epoch already settled before its delivery ACK reached the
        // broker, first probe recipient dedupe without allocating a new epoch.
        // A fresh recipient returns retry; an already accepted event returns
        // accepted and prevents a phantom follow-up activation.
        triggerTurn = target.activeEpoch === pendingActivationEpoch;
        startedTurn = true;
      } else if (!acceptedOnce && hasFollowup && target.activeEpoch === null) {
        target = await this.activateMailboxTarget(target, batch, signal);
        triggerTurn = true;
        startedTurn = true;
      } else if (!acceptedOnce && target.activeEpoch === null) {
        return { startedTurn, delivered: false };
      }
      const expectedActiveEpoch = pendingActivationEpoch ?? target.activeEpoch;
      const expectedGeneration = target.connectionGeneration;
      const dispatchResult = await this.dispatchToController(
        target,
        {
          op: "deliver_mailbox",
          payload: {
            targetId: target.id,
            targetPath,
            items: batch,
            triggerTurn,
            activeEpoch: expectedActiveEpoch,
            connectionGeneration: expectedGeneration,
          },
        },
        signal,
      );
      if (dispatchResult?.disposition === "retry") {
        if (this.registry.get(targetPath)?.activeEpoch !== expectedActiveEpoch)
          this.pendingMailboxActivationEpochs.delete(targetPath);
        // The owning controller synchronizes its terminal epoch before asking
        // the broker to reclassify this unchanged FIFO batch.
        acceptedOnce = false;
        continue;
      }
      acceptedOnce = true;
      const current = this.registry.get(targetPath);
      const settledDedupeProbe = pendingActivationEpoch !== undefined &&
        !triggerTurn &&
        current?.activeEpoch === null;
      if (
        current?.resident &&
        current.registered &&
        (current.activeEpoch === expectedActiveEpoch || settledDedupeProbe) &&
        current.connectionGeneration === expectedGeneration
      ) {
        for (const item of batch) {
          delivered.add(item.eventId);
          while (delivered.size > 4_096) {
            const oldest = delivered.values().next().value as string | undefined;
            if (!oldest) break;
            delivered.delete(oldest);
          }
        }
        this.deliveredMailboxEventIds.set(targetPath, delivered);
        if (this.pendingMailboxActivationEpochs.get(targetPath) === expectedActiveEpoch)
          this.pendingMailboxActivationEpochs.delete(targetPath);
        const prefix = queue.slice(0, batch.length).map((item) => item.eventId);
        if (prefix.some((eventId, index) => eventId !== batch[index]!.eventId))
          throw new Error("Broker mailbox FIFO changed during delivery commit");
        queue.splice(0, batch.length);
        this.updateMailboxCount(targetPath);
        return { startedTurn, delivered: true };
      }
      // Acceptance is known, but the registry epoch changed before commit.
      // Retry the same event IDs without starting another turn; recipient and
      // controller deduplication make this second phase idempotent.
    }
    throw new Error(`Mailbox delivery for ${targetPath} could not commit a stable epoch`);
  }

  private async activateMailboxTarget(
    target: BrokerAgent,
    batch: readonly BrokerMailboxItem[],
    signal?: AbortSignal,
  ): Promise<BrokerAgent> {
    const outboxLimit = this.options.completionOutboxLimit ?? 64;
    if (target.outboxPending >= outboxLimit)
      throw new Error(
        `Agent ${target.path} completion outbox is full; pending final answers must be accepted before another turn`,
      );
    const controller = this.registry.identity(target.controllerPath);
    const effect = this.registry.beginControllerEffect(
      controller,
      target.path,
      "activate",
    );
    let committed = false;
    try {
      await this.dispatchToController(
        target,
        {
          op: "prepare_followup",
          payload: { targetId: target.id, targetPath: target.path },
        },
        signal,
      );
      const activated = this.registry.commitControllerEffect(effect);
      committed = true;
      const task = [...batch].reverse().find((item) => item.triggerTurn);
      this.registry.updateController(
        controller,
        target.path,
        { lastTaskMessage: task?.message ?? target.lastTaskMessage ?? "" },
      );
      this.pendingMailboxActivationEpochs.set(
        target.path,
        activated.activeEpoch!,
      );
      return activated;
    } catch (error) {
      if (!committed) this.registry.rollbackEffect(effect);
      throw error;
    }
  }

  private updateMailboxCount(targetPath: string): void {
    const target = this.registry.get(targetPath);
    if (!target || target.path === "/root") return;
    const controller = this.registry.identity(target.controllerPath);
    this.registry.updateController(controller, targetPath, {
      mailboxPending: this.mailboxByPath.get(targetPath)?.length ?? 0,
    });
  }

  private list(caller: BrokerIdentity, payload: any): { agents: ListedBrokerAgent[] } {
    return this.registry.list(caller, payload?.pathPrefix);
  }

  private wait(
    caller: BrokerIdentity,
    payload: any,
    signal?: AbortSignal,
  ): Promise<WaitAgentResultDetails> {
    const input: RootTreeWaitInput = {};
    if (payload?.target !== undefined) input.target = payload.target;
    if (payload?.all !== undefined) input.all = payload.all;
    return this.registry.wait(caller, input, signal);
  }

  private async setCapacity(
    caller: BrokerIdentity,
    payload: any,
    signal?: AbortSignal,
  ): Promise<{ unloaded: string[] }> {
    if (caller.path !== "/root")
      throw new Error("Only the root controller may change tree capacity");
    const plan = this.registry.planCapacityChange(
      Number(payload?.maxResidentAgents),
      Number(payload?.maxActiveAgents),
    );
    for (const target of plan.candidates) {
      await this.dispatchToController(
        target,
        {
          op: "prepare_unload",
          payload: { targetId: target.id, targetPath: target.path },
        },
        signal,
      );
    }

    const unloads = await Promise.allSettled(
      plan.candidates.map((target) => this.unloadSafely(target, signal)),
    );
    const failures = unloads
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0) {
      const rollbackFailures: unknown[] = [];
      for (const target of plan.candidates) {
        const current = this.registry.get(target.path);
        if (current && !current.resident && current.reloadable) {
          try {
            await this.reload(current, signal);
          } catch (error) {
            rollbackFailures.push(error);
          }
        }
      }
      throw new AggregateError(
        [...failures, ...rollbackFailures],
        rollbackFailures.length > 0
          ? "Capacity lowering failed and operational rollback was incomplete"
          : "Capacity lowering failed and every closed agent was reloaded",
      );
    }
    this.registry.commitCapacityChange(plan.residentLimit, plan.activeLimit);
    for (const targetPath of this.mailboxByPath.keys()) this.wakeMailboxPump(targetPath);
    for (const targetPath of this.pendingCompletionEventIdsByAgent.keys())
      this.scheduleOutboxRecovery(targetPath, true);
    return { unloaded: plan.candidates.map((target) => target.path) };
  }

  private async crashCompletion(
    caller: BrokerIdentity,
    payload: any,
    signal?: AbortSignal,
  ): Promise<{ accepted: true; observed: boolean; duplicate?: boolean }> {
    const targetPath = parseAgentPath(payload?.targetPath);
    const target = this.registry.get(targetPath);
    if (!target || target.controllerPath !== caller.path)
      throw new Error("Only the owning controller may report a child crash");
    const activeEpoch = Number(payload?.activeEpoch);
    if (
      !Number.isSafeInteger(activeEpoch) ||
      activeEpoch < 1 ||
      (target.activeEpoch !== activeEpoch &&
        !(target.activeEpoch === null && !target.registered && target.nextActiveEpoch - 1 === activeEpoch))
    ) throw new Error("Crash report active epoch is stale");
    const eventId = String(payload?.eventId ?? "");
    if (eventId !== `crash_${target.id}_${activeEpoch}`)
      throw new Error("Invalid crash completion event id");
    if (
      this.completionDedupe.check(target.path, activeEpoch, eventId) ===
        "duplicate"
    ) return { accepted: true, observed: true, duplicate: true };
    const content = String(payload?.content ?? "");
    if (Buffer.byteLength(content, "utf8") > 24 * 1024)
      throw new Error("Crash completion envelope exceeds the hard model-facing limit");
    const details = requireBoundedCompletionDetails(payload?.details);
    const insertion = await this.dispatchToIdentity(
      caller.path,
      {
        op: "inbox",
        payload: {
          targetPath: caller.path,
          kind: "FINAL_ANSWER",
          sender: target.path,
          eventId,
          content,
          details,
          triggerTurn: false,
        },
      },
      signal,
    );
    this.completionDedupe.acceptTerminal(target.path, activeEpoch, eventId);
    return { accepted: true, observed: insertion?.observed === true };
  }

  private async completion(
    caller: BrokerIdentity,
    payload: any,
    signal?: AbortSignal,
  ): Promise<{ accepted: true; observed: boolean; duplicate?: boolean }> {
    const targetPath = parseAgentPath(payload?.targetPath);
    const target = this.registry.get(targetPath);
    if (!target || !target.resident)
      throw new Error("Completion mailbox target is unavailable");
    if (caller.parentPath !== targetPath)
      throw new Error("Completion delivery is restricted to the direct parent");
    if (payload?.sender !== caller.path)
      throw new Error("Completion sender does not match authenticated child identity");
    const eventId = validateCompletionEventId(payload?.eventId);
    const completionEpoch = completionEpochFromPayload(caller, payload, eventId);
    const senderRecord = this.registry.get(caller.path);
    const latestSenderEpoch = senderRecord?.activeEpoch ??
      Math.max(1, (senderRecord?.nextActiveEpoch ?? 1) - 1);
    if (!senderRecord || completionEpoch > latestSenderEpoch)
      throw new Error("Completion lifecycle epoch is ahead of the authenticated child");
    if (
      this.completionDedupe.check(caller.path, completionEpoch, eventId) ===
        "duplicate"
    ) {
      this.clearPendingCompletion(caller, eventId);
      return { accepted: true, observed: true, duplicate: true };
    }
    const content = String(payload?.content ?? "");
    if (Buffer.byteLength(content, "utf8") > 24 * 1024)
      throw new Error("Completion envelope exceeds the hard model-facing limit");
    const details = requireBoundedCompletionDetails(payload?.details);
    const insertion = await this.dispatchToIdentity(
      target.path,
      {
        op: "inbox",
        payload: {
          targetPath,
          kind: "FINAL_ANSWER",
          sender: caller.path,
          eventId,
          content,
          details,
          triggerTurn: false,
        },
      },
      signal,
    );
    this.completionDedupe.accept(caller.path, completionEpoch, eventId);
    this.clearPendingCompletion(caller, eventId);
    return { accepted: true, observed: insertion?.observed === true };
  }

  private clearPendingCompletion(caller: BrokerIdentity, eventId: string): void {
    const pending = this.pendingCompletionEventIdsByAgent.get(caller.path);
    if (!pending?.delete(eventId)) return;
    if (pending.size === 0) this.pendingCompletionEventIdsByAgent.delete(caller.path);
    const current = this.registry.get(caller.path);
    if (!current || !caller.parentPath) return;
    this.registry.updateController(
      this.registry.identity(caller.parentPath),
      caller.path,
      { outboxPending: pending.size },
    );
    if (pending.size === 0) this.clearOutboxRecovery(caller.path);
    this.scheduleOutboxClearNotification(current, eventId, true);
    this.wakeMailboxPump(caller.path);
  }

  private scheduleOutboxClearNotification(
    child: Readonly<RootTreeAgentRecord>,
    eventId: string,
    immediate = false,
  ): void {
    if (this.closing || !child.parentPath) return;
    const key = `${child.path}\0${eventId}`;
    const state = this.outboxClearNotifications.get(key) ?? {
      childId: child.id,
      childPath: child.path,
      controllerPath: child.controllerPath,
      eventId,
      attempts: 0,
    };
    if (state.timer) {
      if (!immediate) return;
      clearTimeout(state.timer);
    }
    const delay = immediate
      ? 0
      : Math.min(1_000, 25 * 2 ** Math.min(6, state.attempts));
    state.timer = setTimeout(() => {
      state.timer = undefined;
      if (this.closing) {
        this.outboxClearNotifications.delete(key);
        return;
      }
      void this.dispatchToIdentity(state.controllerPath, {
        op: "outbox_cleared",
        payload: {
          targetId: state.childId,
          targetPath: state.childPath,
          eventId: state.eventId,
        },
      }).then(
        () => this.outboxClearNotifications.delete(key),
        () => {
          state.attempts += 1;
          this.scheduleOutboxClearNotification(
            {
              id: state.childId,
              path: state.childPath,
              controllerPath: state.controllerPath,
              parentPath: state.controllerPath,
            } as RootTreeAgentRecord,
            state.eventId,
          );
        },
      );
    }, delay);
    state.timer.unref?.();
    this.outboxClearNotifications.set(key, state);
  }

  private scheduleOutboxRecovery(targetPath: string, immediate = false): void {
    if (this.closing) return;
    const pending = this.pendingCompletionEventIdsByAgent.get(targetPath);
    if (!pending?.size) {
      this.clearOutboxRecovery(targetPath);
      return;
    }
    const state = this.outboxRecoveryState.get(targetPath) ?? { attempts: 0 };
    if (state.timer) {
      if (!immediate) return;
      clearTimeout(state.timer);
    }
    const delay = immediate
      ? 0
      : Math.min(1_000, 25 * 2 ** Math.min(6, state.attempts));
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void this.runOutboxRecovery(targetPath, state);
    }, delay);
    state.timer.unref?.();
    this.outboxRecoveryState.set(targetPath, state);
  }

  private async runOutboxRecovery(
    targetPath: string,
    state: { attempts: number; timer?: NodeJS.Timeout },
  ): Promise<void> {
    if (this.closing) return this.clearOutboxRecovery(targetPath);
    const pending = this.pendingCompletionEventIdsByAgent.get(targetPath);
    const current = this.registry.get(targetPath);
    if (!pending?.size || !current)
      return this.clearOutboxRecovery(targetPath);
    try {
      if (!current.resident || !current.registered) {
        await this.reload(current);
      } else {
        await this.dispatchToIdentity(current.path, {
          op: "retry_outbox",
          payload: { targetPath: current.path },
        });
      }
      state.attempts = 0;
    } catch {
      state.attempts += 1;
    }
    if (this.pendingCompletionEventIdsByAgent.get(targetPath)?.size)
      this.scheduleOutboxRecovery(targetPath);
    else
      this.clearOutboxRecovery(targetPath);
  }

  private clearOutboxRecovery(targetPath: string): void {
    const state = this.outboxRecoveryState.get(targetPath);
    clearTimeout(state?.timer);
    this.outboxRecoveryState.delete(targetPath);
  }

  private async askParent(
    caller: BrokerIdentity,
    payload: any,
    signal?: AbortSignal,
  ): Promise<AskParentAnswer> {
    if (this.closing) throw new Error("Broker server closed");
    if (!caller.parentPath || !caller.parentId)
      throw new Error("The root agent has no parent");
    assertExactKeys(payload, ["request"], "ask_parent broker payload");
    const input = validateAskParentInput(payload?.request);

    const child = this.registry.get(caller.path);
    const parent = this.registry.get(caller.parentPath);
    if (
      !child ||
      child.id !== caller.id ||
      child.parentPath !== caller.parentPath ||
      child.parentId !== caller.parentId ||
      child.connectionGeneration !== caller.connectionGeneration
    ) throw new Error("ask_parent caller identity or generation is stale");
    if (!parent || !parent.resident || !parent.registered)
      throw new Error("Immediate parent agent is unavailable");

    const request: AskParentRequest = {
      ...input,
      id: `q_${crypto.randomBytes(18).toString("hex")}`,
      childId: child.id,
      childPath: child.path,
      childLabel: child.taskName,
      parentId: parent.id,
      parentPath: parent.path,
      depth: child.depth,
      blocking: input.blocking !== false,
      createdAt: Date.now(),
    };
    const dispatch: BrokerDispatch = {
      op: "ask_parent",
      payload: {
        targetId: child.id,
        targetPath: child.path,
        connectionGeneration: child.connectionGeneration,
        activeEpoch: child.activeEpoch,
        request,
      },
    };
    if (
      askParentTrustedDispatchBytes(dispatch, parent.path) >
        this.askParentLimits.requestFrameMaxBytes
    ) throw new Error("ask_parent trusted dispatch frame is too large");

    const childRate = getRateLimiter(
      this.askParentPerChildRates,
      caller.path,
      this.askParentLimits.perChildRequestsPerWindow,
      this.askParentLimits.rateWindowMs,
      this.askParentLimits.claimCacheLimit,
    );
    if (!childRate.take())
      throw new Error("ask_parent per-child request rate limit exceeded");
    if (!this.askParentGlobalRate.take())
      throw new Error("ask_parent global request rate limit exceeded");
    if (input.blocking !== false) {
      const childModelRate = getRateLimiter(
        this.askParentPerChildModelRates,
        caller.path,
        this.askParentLimits.perChildModelCallsPerWindow,
        this.askParentLimits.rateWindowMs,
        this.askParentLimits.claimCacheLimit,
      );
      if (!childModelRate.take())
        throw new Error("ask_parent per-child model-call limit exceeded");
      if (!this.askParentGlobalModelRate.take())
        throw new Error("ask_parent global model-call limit exceeded");
    }

    if (this.askParentClaims.has(request.id))
      throw new Error("Duplicate trusted ask_parent request id");
    if (
      this.askParentActive >= this.askParentLimits.maxConcurrent &&
      this.askParentQueue.length >= this.askParentLimits.maxQueued
    ) throw new Error("ask_parent queue is full");

    let resolve!: (answer: AskParentAnswer) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<AskParentAnswer>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const work: AskParentQueuedWork = {
      caller: { ...caller },
      request,
      dispatch,
      signal,
      resolve,
      reject,
      started: false,
    };
    if (signal) {
      const onAbort = () => {
        if (work.started) return;
        const index = this.askParentQueue.indexOf(work);
        if (index >= 0) this.askParentQueue.splice(index, 1);
        work.removeAbort?.();
        reject(abortError("ask_parent request aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      work.removeAbort = () => signal.removeEventListener("abort", onAbort);
    }
    const claim: AskParentClaim = {
      callerPath: caller.path,
      callerGeneration: caller.connectionGeneration!,
      promise,
    };
    this.askParentClaims.set(request.id, claim);
    trimOldestMap(this.askParentClaims, this.askParentLimits.claimCacheLimit);
    this.askParentQueue.push(work);
    this.pumpAskParentQueue();
    try {
      const answer = await promise;
      claim.answer = answer;
      return answer;
    } catch (error) {
      this.askParentClaims.delete(request.id);
      throw error;
    }
  }

  private pumpAskParentQueue(): void {
    while (
      !this.closing &&
      this.askParentActive < this.askParentLimits.maxConcurrent &&
      this.askParentQueue.length > 0
    ) {
      const work = this.askParentQueue.shift()!;
      if (work.signal?.aborted) {
        work.removeAbort?.();
        work.reject(abortError("ask_parent request aborted"));
        continue;
      }
      work.started = true;
      this.askParentActive += 1;
      void this.runAskParentWork(work).then(work.resolve, work.reject).finally(() => {
        work.removeAbort?.();
        this.askParentActive -= 1;
        this.pumpAskParentQueue();
      });
    }
  }

  private async runAskParentWork(
    work: AskParentQueuedWork,
  ): Promise<AskParentAnswer> {
    throwIfAborted(work.signal);
    if (this.closing) throw new Error("Broker server closed");
    const child = this.registry.get(work.caller.path);
    const parent = this.registry.get(work.request.parentPath);
    if (
      !child ||
      child.connectionGeneration !== work.caller.connectionGeneration ||
      child.parentPath !== work.request.parentPath ||
      !parent ||
      !parent.resident ||
      !parent.registered
    ) throw new Error("ask_parent request epoch is stale");
    const result = await this.dispatchToIdentity(
      parent.path,
      work.dispatch,
      work.signal,
    );
    return validateAskParentDispatchResponse(
      result,
      work.request,
      this.askParentLimits.answerMaxBytes,
    );
  }

  private resolveTarget(caller: BrokerIdentity, rawTarget: unknown): BrokerAgent {
    if (typeof rawTarget !== "string" || rawTarget.length === 0)
      throw new Error("target must be a non-empty agent reference");
    return this.registry.resolveTarget(caller, rawTarget);
  }

  private async reload(
    target: BrokerAgent,
    signal?: AbortSignal,
  ): Promise<void> {
    const staleConnection = this.connections.get(target.path);
    if (staleConnection && !staleConnection.closed) {
      staleConnection.socket.destroy();
      const deadline = Date.now() + this.limits.dispatchDrainTimeoutMs;
      while (this.connections.get(target.path) === staleConnection) {
        throwIfAborted(signal);
        if (Date.now() >= deadline)
          throw new Error(`Timed out awaiting stale disconnect for ${target.path}`);
        await delayWithAbort(5, signal);
      }
    }
    if (target.controllerPath !== "/root") {
      const controllerRecord = this.registry.get(target.controllerPath);
      if (!controllerRecord)
        throw new Error(`Reload controller '${target.controllerPath}' is unknown`);
      if (!controllerRecord.resident || !controllerRecord.registered)
        await this.reload(controllerRecord, signal);
    }
    const controller = this.registry.identity(target.controllerPath);
    let effect;
    try {
      effect = this.registry.beginControllerEffect(
        controller,
        target.path,
        "reload",
      );
    } catch (error) {
      if (!asError(error).message.includes("resident-agent capacity")) throw error;
      const candidate = this.registry.safeUnloadCandidates().find(
        (record) => !isAgentPathWithin(target.path, record.path),
      );
      if (!candidate) throw error;
      await this.unloadSafely(candidate, signal);
      effect = this.registry.beginControllerEffect(
        controller,
        target.path,
        "reload",
      );
    }
    const reloaded = this.registry.commitControllerEffect(effect);
    const capability = crypto.randomBytes(32).toString("hex");
    const generation = reloaded.connectionGeneration + 1;
    this.capabilitiesByPath.set(target.path, {
      capability,
      generation,
      transactional: false,
    });
    try {
      await this.dispatchToController(
        target,
        {
          op: "reload",
          payload: {
            targetId: target.id,
            targetPath: target.path,
            broker: { socketPath: this.socketPath, capability, generation },
          },
        },
        signal,
      );
      const connected = this.registry.get(target.path);
      if (
        !connected?.registered ||
        connected.connectionGeneration !== generation
      ) throw new Error("Reloaded agent did not register its rotated generation");
      this.registry.updateController(controller, target.path, {
        status: target.status,
        lastTaskMessage: target.lastTaskMessage,
        lastOutput: target.lastOutput,
        mailboxPending: target.mailboxPending,
        outboxPending: target.outboxPending,
        questionPending: target.questionPending,
      }, undefined, true);
    } catch (error) {
      this.capabilitiesByPath.delete(target.path);
      const current = this.registry.get(target.path);
      if (current?.registered) this.connections.get(target.path)?.socket.destroy();
      const rollbackTarget = this.registry.get(target.path);
      if (rollbackTarget?.resident && rollbackTarget.activeEpoch === null) {
        if (rollbackTarget.registered) {
          const rollback = this.registry.beginControllerEffect(
            controller,
            target.path,
            "unload",
            rollbackTarget.connectionGeneration,
          );
          this.registry.commitControllerEffect(rollback);
        } else {
          this.registry.rollbackFailedReload(target.path);
        }
      }
      throw error;
    }
  }

  private dispatchToController(
    target: BrokerAgent,
    dispatch: BrokerDispatch,
    signal?: AbortSignal,
  ): Promise<any> {
    return this.dispatchToIdentity(target.controllerPath, dispatch, signal);
  }

  private dispatchToIdentity(
    identityPath: string,
    dispatch: BrokerDispatch,
    signal?: AbortSignal,
  ): Promise<any> {
    throwIfAborted(signal);
    if (identityPath === "/root") return this.options.dispatch(dispatch, signal);
    const connection = this.connections.get(identityPath);
    if (!connection || connection.closed)
      return Promise.reject(new Error(`Owning agent '${identityPath}' is unavailable`));
    if (connection.outboundDispatches.size >= this.limits.maxOutstandingRequests)
      return Promise.reject(new Error("Broker dispatch queue is full"));
    const id = validateFrameId(
      `dispatch_${++this.dispatchCounter}_${crypto.randomBytes(4).toString("hex")}`,
      "broker dispatch id",
    );
    const op = validateOperation(dispatch.op);
    const sequence = connection.nextDispatchSequence++;
    const operationToken = randomBrokerToken();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => beginCancel("Broker dispatch timed out"), REQUEST_TIMEOUT_MS * (op === "ask_parent" ? 10 : 1));
      const pending: ServerDispatchPending = {
        id,
        op,
        sequence,
        operationToken,
        connection,
        identityPath,
        generation: connection.generation!,
        resolve,
        reject,
        timer,
        canceling: false,
      };
      const beginCancel = (message = "Broker dispatch aborted") => {
        if (this.dispatchPending.get(id) !== pending || pending.canceling) return;
        pending.canceling = true;
        pending.cancelError = abortError(message);
        clearTimeout(pending.timer);
        void this.send(connection, {
          kind: "dispatch_cancel",
          id,
          op,
          sequence,
          ...connectionBinding(connection, operationToken),
        }).catch((error) => {
          const failure = asError(error);
          connection.socket.destroy();
          this.finishDispatch(pending, failure);
        });
        pending.timer = setTimeout(() => {
          connection.socket.destroy();
          this.finishDispatch(pending, abortError(message));
        }, this.limits.dispatchDrainTimeoutMs);
      };
      const onAbort = () => beginCancel();
      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
        pending.removeAbort = () => signal.removeEventListener("abort", onAbort);
      }
      this.dispatchPending.set(id, pending);
      connection.outboundDispatches.add(id);
      if (signal?.aborted) {
        beginCancel();
        return;
      }
      void this.send(connection, {
        kind: "dispatch",
        id,
        op,
        sequence,
        payload: dispatch.payload,
        ...connectionBinding(connection, operationToken),
      }).catch((error) => this.finishDispatch(pending, asError(error)));
    });
  }

  private finishDispatch(
    pending: ServerDispatchPending,
    error?: Error,
    value?: any,
  ): void {
    if (this.dispatchPending.get(pending.id) !== pending) return;
    this.dispatchPending.delete(pending.id);
    pending.connection.outboundDispatches.delete(pending.id);
    clearTimeout(pending.timer);
    pending.removeAbort?.();
    rememberBounded(
      this.dispatchTombstones,
      pending.id,
      this.serverFrameTombstone(pending.connection, pending),
      512,
    );
    if (error) pending.reject(error);
    else pending.resolve(value);
  }

  private issueCapability(
    targetPath: string,
    transactional = false,
  ): BrokerConnectionGrant {
    const target = this.registry.get(targetPath);
    if (!target) throw new Error(`Unknown agent '${targetPath}'`);
    const grant = {
      capability: crypto.randomBytes(32).toString("hex"),
      generation: target.connectionGeneration + 1,
    };
    this.capabilitiesByPath.set(target.path, { ...grant, transactional });
    return { path: target.path, ...grant };
  }

  private send(connection: Connection, frame: unknown): Promise<void> {
    return connection.writer.send(frame);
  }

  private dropConnection(connection: Connection): void {
    if (connection.closed) return;
    connection.closed = true;
    clearTimeout(connection.authTimer);
    this.acceptedConnections.delete(connection);
    connection.writer.fail(new Error("Broker connection closed"));
    for (const job of connection.requestJobs.values()) job.abort.abort();
    connection.requestJobs.clear();
    for (const pending of [...this.dispatchPending.values()]) {
      if (pending.connection === connection)
        this.finishDispatch(pending, new Error("Broker dispatch owner disconnected"));
    }
    for (const [id, tombstone] of this.dispatchTombstones) {
      if (tombstone.connection === connection) this.dispatchTombstones.delete(id);
    }
    connection.requestTombstones.clear();
    const identity = connection.identity;
    if (!identity) return;
    const outstandingGrant = this.capabilitiesByPath.get(identity.path);
    if (!outstandingGrant || outstandingGrant.generation <= connection.generation!)
      this.capabilitiesByPath.delete(identity.path);
    if (this.connections.get(identity.path) !== connection) return;
    this.connections.delete(identity.path);
    const agent = this.registry.get(identity.path);
    if (connection.provisionalRegistration && agent?.reservationLease) {
      try {
        const controller = this.registry.identity(agent.controllerPath);
        this.registry.rollbackReservationForController(controller, agent.path);
      } catch {
        // A concurrent controller rollback already owns the result.
      }
      this.transactionalReservations.delete(identity.path);
      return;
    }
    if (
      !agent ||
      identity.path === "/root" ||
      !agent.registered ||
      agent.connectionGeneration !== connection.generation
    )
      return;

    // A controller that disappears cannot retain provisional descendant slots.
    for (const [childPath, controllerPath] of [
      ...this.transactionalReservations.entries(),
    ]) {
      if (controllerPath !== identity.path) continue;
      try {
        this.registry.rollbackReservationForController(identity, childPath);
      } catch {
        // The child may have disconnected and rolled itself back first.
      }
      this.transactionalReservations.delete(childPath);
      this.capabilitiesByPath.delete(childPath);
      this.connections.get(childPath)?.socket.destroy();
    }
    // A disconnected controller cannot leave a live-but-unroutable subtree.
    // Closing descendant broker links recursively converts each stale resident
    // into an unloaded reloadable record or an explicit not_found record.
    for (const [descendantPath, descendant] of [...this.connections.entries()]) {
      if (
        descendantPath !== identity.path &&
        isAgentPathWithin(descendantPath, identity.path)
      ) descendant.socket.destroy();
    }
    this.scheduleDisconnectReconciliation(identity.path, connection.generation!);
  }

  private scheduleDisconnectReconciliation(
    targetPath: string,
    generation: number,
  ): void {
    const key = `${targetPath}\0${generation}`;
    if (this.disconnectReconciliations.has(key)) return;
    const reconciliation = this.reconcileDisconnectedAgent(targetPath, generation)
      .finally(() => {
        if (this.disconnectReconciliations.get(key) === reconciliation)
          this.disconnectReconciliations.delete(key);
      });
    this.disconnectReconciliations.set(key, reconciliation);
    void reconciliation.catch(() => undefined);
  }

  private async reconcileDisconnectedAgent(
    targetPath: string,
    generation: number,
  ): Promise<void> {
    let effect: ReturnType<RootTreeRegistry["beginControllerEffect"]> | undefined;
    while (true) {
      const agent = this.registry.get(targetPath);
      if (
        !agent ||
        agent.connectionGeneration !== generation ||
        this.connections.has(targetPath)
      ) return;
      if (agent.registered && !effect) {
        try {
          const controller = this.registry.identity(agent.controllerPath);
          effect = this.registry.beginControllerEffect(
            controller,
            agent.path,
            "disconnect",
            generation,
          );
        } catch (error) {
          if (!errorMessage(error).includes("pending registry effect")) return;
          await new Promise((resolve) => setTimeout(resolve, 10));
          continue;
        }
      }
      const controllerRecord = this.registry.get(agent.controllerPath);
      if (effect && controllerRecord && !controllerRecord.registered) {
        const disconnected = this.registry.commitControllerEffect(effect);
        if (
          !this.closing &&
          disconnected.reloadable &&
          disconnected.outboxPending > 0
        ) this.scheduleOutboxRecovery(disconnected.path, true);
        return;
      }

      try {
        const cleanup = await this.dispatchToController(
          agent,
          {
            op: "disconnect_cleanup",
            payload: {
              targetId: agent.id,
              targetPath,
              connectionGeneration: generation,
            },
          },
        );
        if (
          cleanup?.closed !== true ||
          Number(cleanup?.connectionGeneration) !== generation
        ) throw new Error("Controller did not acknowledge exact disconnect cleanup");
        if (effect) {
          const disconnected = this.registry.commitControllerEffect(effect);
          if (
            !this.closing &&
            disconnected.reloadable &&
            disconnected.outboxPending > 0
          ) this.scheduleOutboxRecovery(disconnected.path, true);
        }
        return;
      } catch {
        if (this.closing) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }
}

function validateIdentity(
  value: any,
  requireConnectionGeneration = false,
): BrokerIdentity {
  const pathValue = parseAgentPath(value?.path);
  const depth = Number(value?.depth);
  const maxDepth = Number(value?.maxDepth);
  if (
    !Number.isInteger(depth) ||
    !Number.isInteger(maxDepth) ||
    depth !== agentPathDepth(pathValue) ||
    depth < 0 ||
    maxDepth < depth ||
    maxDepth > 20
  )
    throw new Error("Invalid broker depth metadata");
  const identity: BrokerIdentity = {
    id: validateSafeBasename(value?.id, "agent id"),
    path: pathValue,
    depth,
    maxDepth,
  };
  if (requireConnectionGeneration)
    identity.connectionGeneration = validateGeneration(value?.connectionGeneration);
  if (depth > 0) {
    identity.parentId = validateSafeBasename(value?.parentId, "parent id");
    identity.parentPath = parseAgentPath(value?.parentPath);
    if (pathValue.split("/").slice(0, -1).join("/") !== identity.parentPath)
      throw new Error("Broker parent path does not own child path");
  }
  return identity;
}

export function askParentTrustedDispatchBytes(
  dispatch: BrokerDispatch,
  identityPath: string,
): number {
  // Conservative full transport frame: maximum legal correlation/binding fields
  // ensure the ask-specific limit covers trusted metadata and protocol wrapping.
  const frame = {
    kind: "dispatch",
    id: "d".repeat(160),
    op: dispatch.op,
    sequence: Number.MAX_SAFE_INTEGER,
    payload: dispatch.payload,
    identity: identityPath,
    generation: Number.MAX_SAFE_INTEGER,
    connectionToken: "f".repeat(128),
    operationToken: "f".repeat(128),
  };
  return Buffer.byteLength(JSON.stringify(frame), "utf8") + 1;
}

function validateAskParentInput(value: any): AskParentInput {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid ask_parent request");
  assertExactKeys(
    value,
    ["message", "reason", "blocking", "question", "options", "recommendation"],
    "ask_parent request",
  );
  const message = requireBoundedMessage(
    value.message,
    "ask_parent message",
    16 * 1024,
  );
  const reasons = new Set([
    "need_decision",
    "need_clarification",
    "blocked",
    "risk_detected",
    "course_change",
  ]);
  if (typeof value.reason !== "string" || !reasons.has(value.reason))
    throw new Error("Invalid ask_parent reason");
  if (value.blocking !== undefined && typeof value.blocking !== "boolean")
    throw new Error("Invalid ask_parent blocking value");
  const result: AskParentInput = {
    message,
    reason: value.reason as AskParentInput["reason"],
    blocking: value.blocking === undefined ? true : value.blocking,
  };
  for (const field of ["question", "recommendation"] as const)
    if (value[field] !== undefined)
      result[field] = requireBoundedMessage(value[field], field, 8 * 1024);
  if (value.options !== undefined) {
    if (!Array.isArray(value.options) || value.options.length > 20)
      throw new Error("Invalid ask_parent options");
    result.options = value.options.map((item: unknown) =>
      requireBoundedMessage(item, "option", 1_024),
    );
  }
  return result;
}

function validateAskParentDispatchResponse(
  value: any,
  request: AskParentRequest,
  answerMaxBytes: number,
): AskParentAnswer {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid ask_parent answer envelope");
  assertExactKeys(
    value,
    ["requestId", "answer", "answeredAt", "modelCalls"],
    "ask_parent answer envelope",
  );
  if (value.requestId !== request.id)
    throw new Error("ask_parent answer id does not match its request");
  const answer = requireBoundedMessage(value.answer, "ask_parent answer", answerMaxBytes);
  const answeredAt = Number(value.answeredAt);
  const modelCalls = Number(value.modelCalls);
  if (!Number.isSafeInteger(answeredAt) || answeredAt < request.createdAt)
    throw new Error("Invalid ask_parent answer timestamp");
  if (!Number.isSafeInteger(modelCalls) || modelCalls < 0 || modelCalls > 1)
    throw new Error("Invalid ask_parent model-call count");
  if (!request.blocking && modelCalls !== 0)
    throw new Error("Nonblocking ask_parent cannot invoke the parent model");
  return {
    id: request.id,
    answer,
    answeredAt,
  };
}

function assertExactKeys(
  value: unknown,
  allowedKeys: readonly string[],
  field: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid ${field}`);
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value))
    if (!allowed.has(key)) throw new Error(`Unknown ${field} field '${key}'`);
}

function askParentBrokerLimits(
  overrides?: Partial<AskParentBrokerLimits>,
): Readonly<AskParentBrokerLimits> {
  const limits: AskParentBrokerLimits = {
    requestFrameMaxBytes: ASK_PARENT_REQUEST_FRAME_MAX_BYTES,
    answerMaxBytes: ASK_PARENT_ANSWER_MAX_BYTES,
    rateWindowMs: ASK_PARENT_RATE_WINDOW_MS,
    perChildRequestsPerWindow: ASK_PARENT_PER_CHILD_REQUESTS_PER_WINDOW,
    globalRequestsPerWindow: ASK_PARENT_GLOBAL_REQUESTS_PER_WINDOW,
    perChildModelCallsPerWindow: ASK_PARENT_PER_CHILD_MODEL_CALLS_PER_WINDOW,
    globalModelCallsPerWindow: ASK_PARENT_GLOBAL_MODEL_CALLS_PER_WINDOW,
    maxQueued: ASK_PARENT_MAX_QUEUED,
    maxConcurrent: ASK_PARENT_MAX_CONCURRENT,
    deliveryAttempts: ASK_PARENT_DELIVERY_ATTEMPTS,
    deliveryRetryMs: ASK_PARENT_DELIVERY_RETRY_MS,
    claimCacheLimit: ASK_PARENT_CLAIM_CACHE_LIMIT,
    ...overrides,
  };
  for (const [name, limit] of Object.entries(limits))
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new Error(`Invalid ask_parent broker limit '${name}'`);
  if (limits.answerMaxBytes > ASK_PARENT_ANSWER_MAX_BYTES)
    throw new Error(`ask_parent answer limit cannot exceed ${ASK_PARENT_ANSWER_MAX_BYTES} bytes`);
  if (limits.answerMaxBytes >= limits.requestFrameMaxBytes)
    throw new Error("ask_parent answer limit must be smaller than its frame limit");
  return Object.freeze(limits);
}

function getRateLimiter(
  rates: Map<string, BrokerRateLimiter>,
  key: string,
  maximum: number,
  windowMs: number,
  maximumEntries: number,
): BrokerRateLimiter {
  let rate = rates.get(key);
  if (!rate) {
    rate = new BrokerRateLimiter(maximum, windowMs);
    rates.set(key, rate);
    trimOldestMap(rates, maximumEntries);
  }
  return rate;
}

function trimOldestMap<K, V>(map: Map<K, V>, maximum: number): void {
  while (map.size > maximum) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function validateCompletionEventId(value: unknown): string {
  const eventId = String(value ?? "");
  if (!/^completion_[a-f0-9]{32}$/.test(eventId))
    throw new Error("Invalid completion event id");
  return eventId;
}

function completionEpochFromPayload(
  caller: BrokerIdentity,
  payload: any,
  eventId: string,
): number {
  const lifecycleToken = payload?.details?.turn_id;
  if (typeof lifecycleToken !== "string")
    throw new Error("Completion delivery must include its lifecycle turn token");
  const prefix = `${caller.id}.`;
  if (!lifecycleToken.startsWith(prefix))
    throw new Error("Completion lifecycle token does not match authenticated child");
  const epoch = Number(lifecycleToken.slice(prefix.length));
  if (!Number.isSafeInteger(epoch) || epoch < 1)
    throw new Error("Completion lifecycle token has an invalid epoch");
  const expectedEventId = `completion_${crypto
    .createHash("sha256")
    .update(`${caller.path}\0${lifecycleToken}`)
    .digest("hex")
    .slice(0, 32)}`;
  if (eventId !== expectedEventId)
    throw new Error("Completion event id does not match its authenticated lifecycle token");
  return epoch;
}

function serializedMailboxBytes(items: readonly BrokerMailboxItem[]): number {
  return Buffer.byteLength(JSON.stringify(items), "utf8");
}

function requireBoundedCompletionDetails(value: unknown): unknown {
  if (value === undefined) return undefined;
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error("Completion details must be JSON-serializable");
  }
  if (Buffer.byteLength(encoded, "utf8") > 32 * 1024)
    throw new Error("Completion details exceed 32768 bytes");
  return value;
}

function requireBoundedMessage(
  value: unknown,
  field: string,
  maxBytes = 64 * 1024,
): string {
  const message = requireNonEmptyString(value, field);
  if (Buffer.byteLength(message, "utf8") > maxBytes)
    throw new Error(`${field} exceeds ${maxBytes} bytes`);
  return message;
}

function connectionBinding(
  connection: Connection,
  operationToken: string,
): Record<string, unknown> {
  return {
    identity: connection.identity!.path,
    generation: connection.generation,
    connectionToken: connection.connectionToken,
    operationToken,
  };
}

function safeEqual(left: string, right: string): boolean {
  if (!CAPABILITY_RE.test(left) || !CAPABILITY_RE.test(right)) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function boundedError(error: unknown): string {
  return oneLine(errorMessage(error), 2_000);
}

function onceConnected(socket: net.Socket): Promise<void> {
  if (socket.readyState === "open") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off("connect", onConnect);
      socket.off("error", onError);
    };
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

async function boundedDrain(
  work: Promise<void>[],
  timeoutMs: number,
): Promise<void> {
  if (work.length === 0) return;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.allSettled(work).then(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
}

async function boundedServerClose(server: net.Server, timeoutMs: number): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("Broker server shutdown timed out"));
    }, timeoutMs);
    server.close((error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    });
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError("Broker request aborted");
}

function delayWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError("Broker request aborted"));
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError("Broker request aborted"));
    };
    function finish() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function rememberBounded<T>(
  map: Map<string, T>,
  key: string,
  value: T,
  limit: number,
): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value!);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}
