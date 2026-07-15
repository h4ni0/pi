import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
} from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  CHILD_RPC_RECORD_MAX_BYTES,
  DEFAULT_CHILD_ENV_ALLOWLIST,
  DEFAULT_LIFECYCLE_CORRELATION_TIMEOUT_MS,
  DEFAULT_RPC_REQUEST_TIMEOUT_MS,
  DEFAULT_RPC_SHUTDOWN_TIMEOUT_MS,
  DEFAULT_RPC_STARTUP_TIMEOUT_MS,
  STDERR_TAIL_MAX_BYTES,
} from "./constants.ts";
import type { RpcEvent } from "./types.ts";
import { createDeferred, errorMessage } from "./utils.ts";
import {
  addLifecycleToken,
  decodeLifecycleMarker,
  isTurnLifecycleEvent,
  lifecycleEventFingerprint,
  LIFECYCLE_STATUS_KEY,
  type LifecycleMarker,
} from "./runtime/lifecycle-protocol.ts";

const DEFAULT_PENDING_REQUEST_LIMIT = 1_024;
const DEFAULT_TOMBSTONE_LIMIT = 1_024;
const DEFAULT_UI_CANCEL_LIMIT = 1_024;
const BWRAP_PATH = "/usr/bin/bwrap";

const CGROUP_WRAPPER_SOURCE = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const [cgroupPath, command, ...args] = process.argv.slice(1);
try {
  fs.writeFileSync(path.join(cgroupPath, "cgroup.procs"), String(process.pid));
} catch (error) {
  console.error("RPC cgroup join failed:", error?.message ?? String(error));
  process.exit(126);
}
const child = spawn("/usr/bin/bwrap", [
  "--die-with-parent",
  "--bind", "/", "/",
  "--proc", "/proc",
  "--dev-bind", "/dev", "/dev",
  "--ro-bind", "/sys/fs/cgroup", "/sys/fs/cgroup",
  "--bind", cgroupPath, cgroupPath,
  "--info-fd", "3",
  "--",
  command,
  ...args,
], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["inherit", "inherit", "inherit", "pipe"],
  shell: false,
});
let sandboxPid;
let sandboxInfo = "";
child.stdio[3].on("data", (chunk) => {
  sandboxInfo += chunk.toString("utf8");
  try { sandboxPid = JSON.parse(sandboxInfo)["child-pid"]; } catch { /* partial */ }
});
process.on("SIGTERM", () => {
  try {
    if (Number.isSafeInteger(sandboxPid)) process.kill(sandboxPid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch { /* child already exited */ }
});
child.once("error", (error) => {
  console.error("RPC child spawn failed:", error?.message ?? String(error));
  process.exit(127);
});
child.once("exit", (code, signal) => {
  try {
    fs.writeFileSync(
      path.join(path.dirname(cgroupPath), "cgroup.procs"),
      String(process.pid),
    );
    fs.writeFileSync(path.join(cgroupPath, "cgroup.kill"), "1");
  } catch { /* Parent-side teardown retains the same cgroup handle. */ }
  if (signal) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  } else process.exit(code ?? 1);
});
`;

export function attachJsonlReader(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
  onError?: (error: Error) => void,
  maxRecordBytes = CHILD_RPC_RECORD_MAX_BYTES,
  onDrain?: () => void,
): () => void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let detached = false;
  let drained = false;

  const reportOversize = (): boolean => {
    if (Buffer.byteLength(buffer, "utf8") <= maxRecordBytes) return false;
    buffer = "";
    onError?.(new Error(`JSONL record exceeds ${maxRecordBytes} bytes`));
    return true;
  };
  const emitCompleteLines = () => {
    while (true) {
      const index = buffer.indexOf("\n");
      if (index === -1) break;
      let line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (Buffer.byteLength(line, "utf8") > maxRecordBytes) {
        onError?.(new Error(`JSONL record exceeds ${maxRecordBytes} bytes`));
        continue;
      }
      if (line.endsWith("\r")) line = line.slice(0, -1);
      onLine(line);
    }
    reportOversize();
  };
  const onData = (chunk: Buffer | string) => {
    if (detached || drained) return;
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    emitCompleteLines();
  };
  const finish = () => {
    if (detached || drained) return;
    drained = true;
    buffer += decoder.end();
    emitCompleteLines();
    if (buffer.length > 0) {
      const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
      if (Buffer.byteLength(line, "utf8") <= maxRecordBytes) onLine(line);
      else onError?.(new Error(`JSONL record exceeds ${maxRecordBytes} bytes`));
    }
    buffer = "";
    onDrain?.();
  };
  const onStreamError = (error: Error) => onError?.(error);

  stream.on("data", onData);
  stream.on("end", finish);
  stream.on("close", finish);
  stream.on("error", onStreamError);
  return () => {
    if (detached) return;
    detached = true;
    buffer = "";
    stream.off("data", onData);
    stream.off("end", finish);
    stream.off("close", finish);
    stream.off("error", onStreamError);
  };
}

export class RpcRequestTimeoutError extends Error {
  readonly acceptance = "unknown" as const;

  constructor(
    readonly commandType: string,
    readonly timeoutMs: number,
    readonly requestId: string,
  ) {
    super(`RPC ${commandType} request ${requestId} timed out after ${timeoutMs}ms; acceptance is unknown`);
    this.name = "RpcRequestTimeoutError";
  }
}

export interface RpcCommandAcceptance {
  requestId: string;
  commandType: string;
}

export type RpcSpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcessWithoutNullStreams;

export interface RpcProcessOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  envAllowlist?: string[];
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  stderrTailMaxBytes?: number;
  drainTimeoutMs?: number;
  pendingRequestLimit?: number;
  tombstoneLimit?: number;
  uiCancelLimit?: number;
  lifecycleCorrelationTimeoutMs?: number;
  spawnProcess?: RpcSpawnProcess;
}

interface PendingRequest {
  resolve(value: SentResponse): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  commandType: string;
}

interface ExitStatus {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface SentResponse {
  response: any;
  acceptance: RpcCommandAcceptance;
}

export class RpcProcess {
  private proc?: ChildProcessWithoutNullStreams;
  private stopReader?: () => void;
  private readonly cleanupListeners: Array<() => void> = [];
  private stderr = "";
  private readonly stderrDecoder = new StringDecoder("utf8");
  private requestId = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly tombstones = new Set<string>();
  private readonly uiCancelIds = new Set<string>();
  private readonly uiCancelQueue: string[] = [];
  private uiCancelWriteActive = false;
  private readonly listeners = new Set<(event: RpcEvent) => void>();
  private lifecycleProtocolEnabled = false;
  private pendingLifecycleBoundary?: { marker: LifecycleMarker; replay: boolean };
  private readonly lifecycleSequences = new Map<string, number>();
  private readonly lifecycleReplayFingerprints = new Map<
    string,
    { event: string; fingerprint: string; completionEventId?: string }
  >();
  private readonly closedLifecycleTokens = new Set<string>();
  private activeLifecycleToken?: string;
  private lifecycleCorrelationTimer?: NodeJS.Timeout;
  private transportError?: Error;
  private transportFailureEmitted = false;
  private terminalEventEmitted = false;
  private terminalEventScheduled = false;
  private stopPromise?: Promise<void>;
  private ownsProcessGroup = false;
  private ownsOsProcessTree = false;
  private ownedCgroupPath?: string;
  private leaderStartTime?: string;
  private readonly ownedDescendantPids = new Map<number, string>();
  private stopping = false;
  private stopRequested = false;
  private cleanupOnLateTermination = false;
  private started = false;
  private exitStatus?: ExitStatus;
  private terminationIntentional = false;
  private terminal = createDeferred<ExitStatus>();
  private closed = createDeferred<void>();
  private stdoutDrained = createDeferred<void>();
  private terminalEventDone = createDeferred<void>();

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly options: RpcProcessOptions,
  ) {
    this.ignoreDeferredRejections();
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  get exited(): boolean {
    const proc = this.proc;
    return (
      !proc ||
      proc.exitCode !== null ||
      proc.signalCode !== null ||
      this.exitStatus !== undefined
    );
  }

  getStderr(): string {
    return this.stderr;
  }

  onEvent(listener: (event: RpcEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.stopRequested)
      throw new Error("RPC process cannot start after stop was requested");
    if (this.started) throw new Error("RPC process already started");
    this.started = true;
    this.terminal = createDeferred<ExitStatus>();
    this.closed = createDeferred<void>();
    this.stdoutDrained = createDeferred<void>();
    this.terminalEventDone = createDeferred<void>();
    this.ignoreDeferredRejections();

    let proc: ChildProcessWithoutNullStreams;
    try {
      const spawnProcess = this.options.spawnProcess ?? defaultSpawnProcess;
      const detached = !this.options.spawnProcess && process.platform !== "win32";
      const requiresOwnedTree = !this.options.spawnProcess &&
        canLaunchThroughWrapper(this.command);
      if (requiresOwnedTree && process.platform !== "linux")
        throw new Error(
          "Persistent RPC process-tree ownership requires Linux cgroup v2",
        );
      if (requiresOwnedTree) {
        try {
          accessSync(BWRAP_PATH, fsConstants.X_OK);
        } catch {
          throw new Error(
            "Persistent RPC process-tree ownership requires executable /usr/bin/bwrap",
          );
        }
      }
      this.ownedCgroupPath = requiresOwnedTree ? createOwnedCgroup() : undefined;
      if (requiresOwnedTree && !this.ownedCgroupPath)
        throw new Error(
          "Persistent RPC process-tree ownership requires a writable delegated cgroup v2 with cgroup.kill",
        );
      const command = this.ownedCgroupPath ? process.execPath : this.command;
      const args = this.ownedCgroupPath
        ? ["-e", CGROUP_WRAPPER_SOURCE, this.ownedCgroupPath, this.command, ...this.args]
        : this.args;
      proc = spawnProcess(command, args, {
        cwd: this.options.cwd,
        env: buildChildEnvironment(this.options.env, this.options.envAllowlist),
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        detached,
      });
      this.ownsProcessGroup = detached && Number.isSafeInteger(proc.pid);
      this.ownsOsProcessTree = !this.options.spawnProcess && process.platform === "linux";
      this.leaderStartTime = proc.pid ? readProcessStartTime(proc.pid) : undefined;
    } catch (error) {
      this.cleanupOwnedCgroup();
      const failure = new Error(`child pi spawn failed: ${errorMessage(error)}`);
      this.failTransportOnce(failure, "process_error");
      throw failure;
    }
    this.proc = proc;
    this.attachProcess(proc);

    try {
      await this.getState(
        this.options.startupTimeoutMs ?? DEFAULT_RPC_STARTUP_TIMEOUT_MS,
      );
      if (this.transportError) throw this.transportError;
      if (this.isTerminated(proc))
        throw new Error("RPC process terminated during startup handshake");
      if (this.ownsOsProcessTree && proc.pid) {
        this.captureOwnedDescendants(proc.pid);
        this.captureOwnedProcessGroupMembers(proc.pid);
      }
    } catch (error) {
      await this.stop().catch(() => undefined);
      throw error;
    }
  }

  stop(): Promise<void> {
    this.stopRequested = true;
    if (this.stopPromise) return this.stopPromise;
    const operation = this.stopInternal();
    const stop = operation.catch((error) => {
      if (this.stopPromise === stop) this.stopPromise = undefined;
      throw error;
    });
    this.stopPromise = stop;
    return stop;
  }

  private async stopInternal(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    this.stopping = true;
    this.rejectPending(new Error("RPC process stopped"), true);
    const grace =
      this.options.shutdownTimeoutMs ?? DEFAULT_RPC_SHUTDOWN_TIMEOUT_MS;
    let confirmed = this.confirmTerminationFromFields(proc);
    let processTreeConfirmed = !this.ownsOsProcessTree;
    if (this.ownsOsProcessTree && proc.pid) {
      this.captureOwnedDescendants(proc.pid);
      this.captureOwnedProcessGroupMembers(proc.pid);
    }
    try {
      if (!confirmed) {
        try {
          this.signalProcess(proc, "SIGTERM");
        } catch {
          // Confirmed process events/fields below remain authoritative.
        }
        confirmed = await this.awaitTermination(grace);
      }
      if (!confirmed) {
        try {
          this.signalProcess(proc, "SIGKILL");
        } catch {
          // Confirmed process events/fields below remain authoritative.
        }
        confirmed = await this.awaitTermination(grace);
      }
      if (!confirmed)
        throw new Error(
          `Child process ${proc.pid ?? "?"} did not terminate after SIGKILL`,
        );
      if (this.ownsOsProcessTree && proc.pid) {
        this.signalProcess(proc, "SIGKILL");
        await this.awaitProcessTreeTermination(proc.pid, grace);
        processTreeConfirmed = true;
      }

      this.scheduleTerminalAfterDrain(proc);
      // emitTerminalAfterDrain owns the bounded fallback. Waiting for its
      // completion here prevents cleanup from removing the terminal listener
      // at the same deadline that the event is being emitted.
      await this.terminalEventDone.promise;
    } finally {
      if (
        (confirmed || this.confirmTerminationFromFields(proc)) &&
        processTreeConfirmed
      ) {
        this.cleanupTransport();
        this.proc = undefined;
      } else {
        // Keep the process and its terminal listeners so later OS termination
        // remains observable; only bounded request-side state is discarded.
        this.rejectPending(new Error("RPC process termination is unconfirmed"), false);
        this.tombstones.clear();
        this.uiCancelIds.clear();
        this.uiCancelQueue.length = 0;
        this.uiCancelWriteActive = false;
        this.cleanupOnLateTermination = true;
      }
    }
  }

  async prompt(message: string, lifecycleToken?: string): Promise<RpcCommandAcceptance> {
    if (lifecycleToken) this.lifecycleProtocolEnabled = true;
    const sent = await this.send({
      type: "prompt",
      message: lifecycleToken ? addLifecycleToken(message, lifecycleToken) : message,
    });
    this.assertSuccess(sent.response);
    return sent.acceptance;
  }

  async steer(message: string): Promise<RpcCommandAcceptance> {
    const sent = await this.send({ type: "steer", message });
    this.assertSuccess(sent.response);
    return sent.acceptance;
  }

  async followUp(message: string): Promise<RpcCommandAcceptance> {
    const sent = await this.send({ type: "follow_up", message });
    this.assertSuccess(sent.response);
    return sent.acceptance;
  }

  async abort(timeoutMs?: number): Promise<RpcCommandAcceptance> {
    const sent = await this.send({ type: "abort" }, timeoutMs);
    this.assertSuccess(sent.response);
    return sent.acceptance;
  }

  async getState(timeoutMs?: number): Promise<any> {
    return this.getData((await this.send({ type: "get_state" }, timeoutMs)).response);
  }

  async getMessages(): Promise<AgentMessage[]> {
    return (
      this.getData((await this.send({ type: "get_messages" })).response).messages ?? []
    );
  }

  async getLastAssistantText(): Promise<string | null> {
    return (
      this.getData((await this.send({ type: "get_last_assistant_text" })).response)
        .text ?? null
    );
  }

  async getSessionStats(timeoutMs?: number): Promise<any> {
    return this.getData(
      (await this.send({ type: "get_session_stats" }, timeoutMs)).response,
    );
  }

  async compact(customInstructions?: string): Promise<any> {
    return this.getData(
      (await this.send({ type: "compact", customInstructions })).response,
    );
  }

  async setSessionName(name: string): Promise<void> {
    this.assertSuccess((await this.send({ type: "set_session_name", name })).response);
  }

  private attachProcess(proc: ChildProcessWithoutNullStreams): void {
    const stderrLimit = Math.max(
      0,
      this.options.stderrTailMaxBytes ?? STDERR_TAIL_MAX_BYTES,
    );
    const onStderrData = (data: Buffer | string) => {
      const decoded =
        typeof data === "string" ? data : this.stderrDecoder.write(data);
      this.stderr = boundedUtf8Tail(this.stderr + decoded, stderrLimit);
    };
    const onStderrEnd = () => {
      this.stderr = boundedUtf8Tail(
        this.stderr + this.stderrDecoder.end(),
        stderrLimit,
      );
    };
    const onStdinError = (error: Error) => {
      this.failTransportOnce(
        new Error(`child pi stdin error: ${error.message}`),
        "process_stdin_error",
      );
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      this.noteTermination(proc, { code, signal });
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      this.closed.resolve(undefined);
      this.noteTermination(proc, {
        code: code ?? proc.exitCode,
        signal: signal ?? proc.signalCode,
      });
    };
    const onProcessError = (error: Error) => {
      const suffix = this.stderr.trim();
      this.failTransportOnce(
        new Error(
          `child pi process error: ${error.message}${suffix ? `. ${suffix}` : ""}`,
        ),
        "process_error",
      );
      // An error event is transport failure, not proof that an assigned PID
      // terminated. Node follows spawn failures with close, which confirms it.
    };

    proc.stderr.on("data", onStderrData);
    proc.stderr.once("end", onStderrEnd);
    proc.stdin.on("error", onStdinError);
    proc.once("exit", onExit);
    proc.once("close", onClose);
    proc.once("error", onProcessError);
    this.cleanupListeners.push(
      () => proc.stderr.off("data", onStderrData),
      () => proc.stderr.off("end", onStderrEnd),
      () => proc.stdin.off("error", onStdinError),
      () => proc.off("exit", onExit),
      () => proc.off("close", onClose),
      () => proc.off("error", onProcessError),
    );

    this.stopReader = attachJsonlReader(
      proc.stdout,
      (line) => this.handleLine(line),
      (error) =>
        this.failTransportOnce(
          new Error(`child pi stdout/protocol error: ${error.message}`),
          "rpc_protocol_error",
        ),
      CHILD_RPC_RECORD_MAX_BYTES,
      () => this.stdoutDrained.resolve(undefined),
    );
  }

  private noteTermination(
    proc: ChildProcessWithoutNullStreams,
    status: ExitStatus,
  ): void {
    if (this.ownsOsProcessTree && proc.pid) {
      this.captureOwnedDescendants(proc.pid);
      this.captureOwnedProcessGroupMembers(proc.pid);
    }
    if (!this.exitStatus) {
      this.exitStatus = status;
      this.terminationIntentional = this.stopping;
      this.terminal.resolve(status);
      const suffix = this.stderr.trim();
      const error = new Error(
        `child pi exited (code=${status.code} signal=${status.signal})${suffix ? `. ${suffix}` : ""}`,
      );
      if (!this.terminationIntentional)
        this.failTransportOnce(error, "process_exit", false);
      else this.rejectPending(error, true);
    }
    this.scheduleTerminalAfterDrain(proc);
    if (this.cleanupOnLateTermination)
      void this.cleanupAfterLateTermination(proc).catch(() => undefined);
  }

  private async cleanupAfterLateTermination(
    proc: ChildProcessWithoutNullStreams,
  ): Promise<void> {
    if (this.proc !== proc) return;
    const grace = this.options.shutdownTimeoutMs ?? DEFAULT_RPC_SHUTDOWN_TIMEOUT_MS;
    if (this.ownsOsProcessTree && proc.pid) {
      this.captureOwnedDescendants(proc.pid);
      this.signalProcess(proc, "SIGKILL");
      await this.awaitProcessTreeTermination(proc.pid, grace);
    }
    await this.terminalEventDone.promise;
    if (this.proc !== proc) return;
    this.cleanupTransport();
    this.proc = undefined;
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    if (this.ownsOsProcessTree && this.proc?.pid)
      this.captureOwnedDescendants(this.proc.pid);
    let data: any;
    try {
      data = JSON.parse(line);
    } catch (error) {
      this.failTransportOnce(
        new Error(`Invalid child JSONL record: ${errorMessage(error)}`),
        "rpc_protocol_error",
      );
      return;
    }
    if (data && typeof data === "object" && data.type === "response") {
      const id = typeof data.id === "string" ? data.id : "";
      const pending = id ? this.pending.get(id) : undefined;
      if (pending) {
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.resolve({
          response: data,
          acceptance: { requestId: id, commandType: pending.commandType },
        });
      } else {
        const late = Boolean(id && this.tombstones.delete(id));
        this.emit({
          type: "rpc_response_diagnostic",
          response_id: id || undefined,
          late,
          error: late
            ? "Late response consumed after request completion was unknown"
            : "Unknown response id consumed",
        });
      }
      return;
    }
    if (!data || typeof data !== "object" || typeof data.type !== "string") {
      this.failTransportOnce(
        new Error("Invalid child JSONL record: expected an object with string type"),
        "rpc_protocol_error",
      );
      return;
    }
    const marker = decodeLifecycleMarker(data);
    if (marker) {
      this.openLifecycleBoundary(marker);
      return;
    }
    if (
      data.type === "extension_ui_request" &&
      data.method === "setStatus" &&
      data.statusKey === LIFECYCLE_STATUS_KEY
    ) {
      this.failTransportOnce(
        new Error("Malformed child lifecycle correlation marker"),
        "rpc_protocol_error",
      );
      return;
    }
    if (
      data.type === "extension_ui_request" &&
      typeof data.id === "string" &&
      isDialogUiRequest(data)
    )
      this.sendUiCancel(data.id);
    if (isTurnLifecycleEvent(data)) {
      if (typeof data.turn_token === "string") {
        if (this.pendingLifecycleBoundary) {
          this.failTransportOnce(
            new Error("Tagged lifecycle event crossed an open child correlation boundary"),
            "rpc_protocol_error",
          );
          return;
        }
        this.emit(data);
        return;
      }
      // Startup extension errors occur before any prompt token exists and must
      // remain visible so provisional startup fails closed.
      if (!this.lifecycleProtocolEnabled) {
        this.emit(data);
        return;
      }
      this.closeLifecycleBoundary(data);
      return;
    }
    this.emit(data);
  }

  private openLifecycleBoundary(marker: LifecycleMarker): void {
    if (!this.lifecycleProtocolEnabled) {
      this.failTransportOnce(
        new Error("Child lifecycle marker arrived before a tokenized prompt"),
        "rpc_protocol_error",
      );
      return;
    }
    if (this.pendingLifecycleBoundary) {
      this.failTransportOnce(
        new Error("A second lifecycle marker made the child correlation boundary ambiguous"),
        "rpc_protocol_error",
      );
      return;
    }
    const previous = this.lifecycleSequences.get(marker.token);
    const closed = this.closedLifecycleTokens.has(marker.token);
    let replay = false;
    if (closed) {
      const replayIdentity = this.lifecycleReplayFingerprints.get(
        `${marker.token}\0${marker.sequence}`,
      );
      if (
        previous === undefined ||
        marker.sequence > previous ||
        !replayIdentity ||
        replayIdentity.event !== marker.event ||
        replayIdentity.fingerprint !== marker.fingerprint ||
        replayIdentity.completionEventId !== marker.completionEventId
      ) {
        this.failTransportOnce(
          new Error(`Closed lifecycle token ${marker.token} has an unknown or altered sequence ${marker.sequence}`),
          "rpc_protocol_error",
        );
        return;
      }
      replay = true;
    } else {
      if (this.activeLifecycleToken && this.activeLifecycleToken !== marker.token) {
        this.failTransportOnce(
          new Error(`Lifecycle token ${marker.token} overlapped active token ${this.activeLifecycleToken}`),
          "rpc_protocol_error",
        );
        return;
      }
      const expected = (previous ?? 0) + 1;
      if (marker.sequence !== expected) {
        this.failTransportOnce(
          new Error(`Lifecycle token ${marker.token} sequence ${marker.sequence} did not equal ${expected}`),
          "rpc_protocol_error",
        );
        return;
      }
    }
    this.pendingLifecycleBoundary = { marker, replay };
    const timeoutMs = Math.max(
      25,
      this.options.lifecycleCorrelationTimeoutMs ??
        Math.min(
          DEFAULT_LIFECYCLE_CORRELATION_TIMEOUT_MS,
          Math.floor((this.options.requestTimeoutMs ?? DEFAULT_RPC_REQUEST_TIMEOUT_MS) / 4),
        ),
    );
    this.lifecycleCorrelationTimer = setTimeout(() => {
      this.lifecycleCorrelationTimer = undefined;
      if (!this.pendingLifecycleBoundary) return;
      const marker = this.pendingLifecycleBoundary.marker;
      this.failTransportOnce(
        new Error(`Child lifecycle ${marker.event} marker ${marker.token}#${marker.sequence} had no next lifecycle event`),
        "rpc_protocol_error",
      );
    }, timeoutMs);
    this.lifecycleCorrelationTimer.unref?.();
  }

  private closeLifecycleBoundary(event: RpcEvent): void {
    const boundary = this.pendingLifecycleBoundary;
    if (!boundary) {
      this.failTransportOnce(
        new Error(`Bare ${event.type} event had no preceding lifecycle marker`),
        "rpc_protocol_error",
      );
      return;
    }
    this.pendingLifecycleBoundary = undefined;
    clearTimeout(this.lifecycleCorrelationTimer);
    this.lifecycleCorrelationTimer = undefined;
    const { marker, replay } = boundary;
    const fingerprint = lifecycleEventFingerprint(event);
    if (event.type !== marker.event || fingerprint !== marker.fingerprint) {
      this.failTransportOnce(
        new Error(`Lifecycle marker/event identity mismatch (${marker.event} vs ${event.type})`),
        "rpc_protocol_error",
      );
      return;
    }
    if (replay) return;
    this.lifecycleSequences.set(marker.token, marker.sequence);
    this.lifecycleReplayFingerprints.set(
      `${marker.token}\0${marker.sequence}`,
      {
        event: marker.event,
        fingerprint: marker.fingerprint,
        completionEventId: marker.completionEventId,
      },
    );
    while (this.lifecycleReplayFingerprints.size > 512) {
      const oldest = this.lifecycleReplayFingerprints.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.lifecycleReplayFingerprints.delete(oldest);
    }
    this.activeLifecycleToken ??= marker.token;
    this.emit({
      ...event,
      turn_token: marker.token,
      turn_sequence: marker.sequence,
      ...(marker.completionEventId
        ? { completion_event_id: marker.completionEventId }
        : {}),
    });
    if (event.type === "agent_settled") {
      this.closedLifecycleTokens.add(marker.token);
      if (this.activeLifecycleToken === marker.token) this.activeLifecycleToken = undefined;
      while (this.closedLifecycleTokens.size > 128) {
        const oldest = this.closedLifecycleTokens.values().next().value as string | undefined;
        if (oldest === undefined) break;
        this.closedLifecycleTokens.delete(oldest);
        this.lifecycleSequences.delete(oldest);
        for (const key of this.lifecycleReplayFingerprints.keys()) {
          if (key.startsWith(`${oldest}\0`))
            this.lifecycleReplayFingerprints.delete(key);
        }
      }
    }
  }

  private emit(event: RpcEvent): void {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(event);
      } catch {
        // A consumer must not break transport dispatch for other consumers.
      }
    }
  }

  private sendUiCancel(id: string): void {
    if (this.uiCancelIds.has(id)) return;
    const limit = Math.max(
      0,
      this.options.uiCancelLimit ?? DEFAULT_UI_CANCEL_LIMIT,
    );
    if (limit === 0) return;
    // Count the active write as one outstanding cancel. New dialogs beyond the
    // bound remain model-visible but cannot grow Node's writable buffer without
    // limit while the child is stalled.
    if (this.uiCancelQueue.length + (this.uiCancelWriteActive ? 1 : 0) >= limit)
      return;
    this.uiCancelIds.add(id);
    while (this.uiCancelIds.size > limit) {
      const oldest = this.uiCancelIds.values().next().value as string | undefined;
      if (oldest === undefined) break;
      this.uiCancelIds.delete(oldest);
    }
    this.uiCancelQueue.push(id);
    this.flushUiCancels();
  }

  private flushUiCancels(): void {
    if (this.uiCancelWriteActive) return;
    const id = this.uiCancelQueue.shift();
    if (id === undefined) return;
    const proc = this.proc;
    if (
      !proc ||
      !proc.stdin.writable ||
      this.isTerminated(proc) ||
      this.transportError ||
      this.stopping
    ) {
      this.uiCancelQueue.length = 0;
      return;
    }
    this.uiCancelWriteActive = true;
    const complete = (error?: Error | null) => {
      this.uiCancelWriteActive = false;
      if (error) {
        this.uiCancelQueue.length = 0;
        this.failTransportOnce(
          new Error(`child pi RPC write failed: ${error.message}`),
          "process_stdin_error",
        );
        return;
      }
      this.flushUiCancels();
    };
    try {
      proc.stdin.write(
        `${JSON.stringify({
          type: "extension_ui_response",
          id,
          cancelled: true,
        })}\n`,
        complete,
      );
    } catch (error) {
      complete(new Error(errorMessage(error)));
    }
  }

  private send(
    command: Record<string, any>,
    timeoutMs?: number,
  ): Promise<SentResponse> {
    const proc = this.proc;
    if (!proc) return Promise.reject(new Error("RPC process not started"));
    if (this.transportError) return Promise.reject(this.transportError);
    if (!proc.stdin.writable)
      return Promise.reject(new Error("RPC process stdin is not writable"));
    if (this.isTerminated(proc))
      return Promise.reject(
        new Error(`RPC process already exited. ${this.stderr.trim()}`),
      );
    if (this.stopping) return Promise.reject(new Error("RPC process is stopping"));
    const pendingLimit =
      this.options.pendingRequestLimit ?? DEFAULT_PENDING_REQUEST_LIMIT;
    if (this.pending.size >= pendingLimit)
      return Promise.reject(
        new Error(`RPC pending request limit ${pendingLimit} exceeded`),
      );

    const id = `req_${++this.requestId}`;
    const commandType = String(command.type);
    const fullCommand = { ...command, id };
    const limit =
      timeoutMs ??
      this.options.requestTimeoutMs ??
      DEFAULT_RPC_REQUEST_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        this.addTombstone(id);
        reject(new RpcRequestTimeoutError(commandType, limit, id));
      }, limit);
      this.pending.set(id, { resolve, reject, timer, commandType });
      try {
        proc.stdin.write(`${JSON.stringify(fullCommand)}\n`, (error) => {
          if (!error) return;
          this.failTransportOnce(
            new Error(`child pi RPC write failed: ${error.message}`),
            "process_stdin_error",
          );
        });
      } catch (error) {
        this.failTransportOnce(
          new Error(`child pi RPC write failed: ${errorMessage(error)}`),
          "process_stdin_error",
        );
      }
    });
  }

  private failTransportOnce(
    error: Error,
    eventType: string,
    emitImmediately = true,
  ): void {
    if (this.transportError) return;
    this.transportError = error;
    this.rejectPending(error, true);
    if (!emitImmediately || this.transportFailureEmitted) return;
    this.transportFailureEmitted = true;
    this.emit({ type: eventType, error: error.message });
  }

  private scheduleTerminalAfterDrain(
    proc: ChildProcessWithoutNullStreams,
  ): void {
    if (this.terminalEventScheduled) return;
    this.terminalEventScheduled = true;
    void this.emitTerminalAfterDrain(proc);
  }

  private async emitTerminalAfterDrain(
    proc: ChildProcessWithoutNullStreams,
  ): Promise<void> {
    try {
      await Promise.race([
        Promise.allSettled([this.stdoutDrained.promise, this.closed.promise]),
        delay(this.options.drainTimeoutMs ?? 500),
      ]);
      if (this.terminalEventEmitted) return;
      this.terminalEventEmitted = true;
      const status = this.exitStatus ?? {
        code: proc.exitCode,
        signal: proc.signalCode,
      };
      const fallback = new Error(
        `child pi exited (code=${status.code} signal=${status.signal})`,
      );
      this.emit({
        type: "process_exit",
        code: status.code,
        signal: status.signal,
        intentional: this.terminationIntentional,
        transport_failure_reported: this.transportFailureEmitted,
        error: (this.transportError ?? fallback).message,
      });
    } finally {
      this.terminalEventDone.resolve(undefined);
    }
  }

  private async awaitTermination(timeoutMs: number): Promise<boolean> {
    const proc = this.proc;
    if (!proc || this.confirmTerminationFromFields(proc)) return true;
    await Promise.race([this.terminal.promise, delay(timeoutMs)]);
    return this.confirmTerminationFromFields(proc);
  }

  private confirmTerminationFromFields(
    proc: ChildProcessWithoutNullStreams,
  ): boolean {
    if (this.exitStatus !== undefined) return true;
    if (proc.exitCode === null && proc.signalCode === null) return false;
    this.noteTermination(proc, {
      code: proc.exitCode,
      signal: proc.signalCode,
    });
    return true;
  }

  private isTerminated(proc: ChildProcessWithoutNullStreams): boolean {
    return (
      this.exitStatus !== undefined ||
      proc.exitCode !== null ||
      proc.signalCode !== null
    );
  }

  private addTombstone(id: string): void {
    this.tombstones.add(id);
    const limit = this.options.tombstoneLimit ?? DEFAULT_TOMBSTONE_LIMIT;
    while (this.tombstones.size > limit) {
      const oldest = this.tombstones.values().next().value as string | undefined;
      if (oldest === undefined) break;
      this.tombstones.delete(oldest);
    }
  }

  private assertSuccess(response: any): void {
    if (!response?.success)
      throw new Error(response?.error || "RPC command failed");
  }

  private getData(response: any): any {
    this.assertSuccess(response);
    return response.data;
  }

  private rejectPending(error: Error, tombstone: boolean): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      if (tombstone) this.addTombstone(id);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private cleanupTransport(): void {
    this.cleanupOwnedCgroup(true);
    this.stopReader?.();
    this.stopReader = undefined;
    for (const cleanup of this.cleanupListeners.splice(0)) cleanup();
    this.listeners.clear();
    this.rejectPending(new Error("RPC process stopped"), false);
    this.tombstones.clear();
    this.uiCancelIds.clear();
    this.uiCancelQueue.length = 0;
    this.uiCancelWriteActive = false;
    this.pendingLifecycleBoundary = undefined;
    this.lifecycleSequences.clear();
    this.lifecycleReplayFingerprints.clear();
    this.closedLifecycleTokens.clear();
    this.activeLifecycleToken = undefined;
    this.leaderStartTime = undefined;
    this.ownedDescendantPids.clear();
    clearTimeout(this.lifecycleCorrelationTimer);
    this.lifecycleCorrelationTimer = undefined;
  }

  private signalProcess(
    proc: ChildProcessWithoutNullStreams,
    signal: NodeJS.Signals,
  ): void {
    if (this.ownedCgroupPath) {
      if (signal === "SIGTERM") {
        proc.kill(signal);
        return;
      }
      if (signal === "SIGKILL") {
        try {
          writeFileSync(path.join(this.ownedCgroupPath, "cgroup.kill"), "1");
          return;
        } catch {
          // Fall back to identity-bound PID/process-group teardown.
        }
      }
    }
    if (this.ownsOsProcessTree && proc.pid) {
      this.captureOwnedDescendants(proc.pid);
      this.captureOwnedProcessGroupMembers(proc.pid);
    }
    let leaderSignaled = false;
    const leaderIdentityMatches = !this.ownsOsProcessTree || (
      !!proc.pid &&
      !!this.leaderStartTime &&
      readProcessStartTime(proc.pid) === this.leaderStartTime
    );
    if (this.ownsProcessGroup && proc.pid && leaderIdentityMatches) {
      try {
        process.kill(-proc.pid, signal);
        leaderSignaled = true;
      } catch (error: any) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
    if (!leaderSignaled && leaderIdentityMatches) proc.kill(signal);
    for (const [pid, startTime] of this.ownedDescendantPids) {
      if (readProcessStartTime(pid) !== startTime) {
        this.ownedDescendantPids.delete(pid);
        continue;
      }
      try {
        process.kill(pid, signal);
      } catch (error: any) {
        if (error?.code === "ESRCH") this.ownedDescendantPids.delete(pid);
        else throw error;
      }
    }
  }

  private captureOwnedDescendants(parentPid: number): void {
    const pending: number[] = [];
    if (
      this.leaderStartTime &&
      readProcessStartTime(parentPid) === this.leaderStartTime
    ) pending.push(parentPid);
    for (const [pid, startTime] of this.ownedDescendantPids) {
      if (readProcessStartTime(pid) === startTime) pending.push(pid);
      else this.ownedDescendantPids.delete(pid);
    }
    const seen = new Set<number>();
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);
      let children = "";
      try {
        children = readFileSync(
          `/proc/${current}/task/${current}/children`,
          "utf8",
        );
      } catch {
        continue;
      }
      for (const value of children.trim().split(/\s+/)) {
        if (!value) continue;
        const child = Number(value);
        if (!Number.isSafeInteger(child) || child < 2) continue;
        const startTime = readProcessStartTime(child);
        if (!startTime) continue;
        this.ownedDescendantPids.set(child, startTime);
        pending.push(child);
      }
    }
  }

  private captureOwnedProcessGroupMembers(groupPid: number): void {
    if (!this.ownsProcessGroup) return;
    const leaderMatches = !!this.leaderStartTime &&
      readProcessStartTime(groupPid) === this.leaderStartTime;
    // The first exit callback runs before exitStatus is committed. At that
    // point this numeric process group still belongs to the exiting leader.
    if (!leaderMatches && this.exitStatus !== undefined) return;
    let entries: string[];
    try {
      entries = readdirSync("/proc");
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      if (pid === groupPid || !Number.isSafeInteger(pid)) continue;
      const identity = readProcessIdentity(pid);
      if (identity?.processGroup === groupPid)
        this.ownedDescendantPids.set(pid, identity.startTime);
    }
  }

  private async awaitProcessTreeTermination(
    groupPid: number,
    timeoutMs: number,
  ): Promise<void> {
    const deadline = Date.now() + Math.max(100, timeoutMs);
    while (Date.now() < deadline) {
      if (this.ownedCgroupPath) {
        try {
          const events = readFileSync(
            path.join(this.ownedCgroupPath, "cgroup.events"),
            "utf8",
          );
          if (/^populated 0$/m.test(events)) return;
        } catch {
          // A removed owned cgroup is necessarily empty.
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
        continue;
      }
      this.captureOwnedDescendants(groupPid);
      let alive = false;
      if (
        this.ownsProcessGroup &&
        this.leaderStartTime &&
        readProcessStartTime(groupPid) === this.leaderStartTime
      ) {
        try {
          process.kill(-groupPid, 0);
          alive = true;
        } catch (error: any) {
          if (error?.code !== "ESRCH") throw error;
        }
      }
      for (const [pid, startTime] of this.ownedDescendantPids) {
        if (readProcessStartTime(pid) === startTime) alive = true;
        else this.ownedDescendantPids.delete(pid);
      }
      if (!alive) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Child process tree ${groupPid} did not terminate after SIGKILL`);
  }

  private cleanupOwnedCgroup(required = false): void {
    const cgroupPath = this.ownedCgroupPath;
    if (!cgroupPath) return;
    try {
      removeEmptyCgroupTree(cgroupPath);
      this.ownedCgroupPath = undefined;
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        this.ownedCgroupPath = undefined;
        return;
      }
      if (required)
        throw new Error(`Owned RPC cgroup cleanup failed: ${errorMessage(error)}`);
    }
  }

  private ignoreDeferredRejections(): void {
    void this.terminal.promise.catch(() => undefined);
    void this.closed.promise.catch(() => undefined);
    void this.stdoutDrained.promise.catch(() => undefined);
    void this.terminalEventDone.promise.catch(() => undefined);
  }
}

const defaultSpawnProcess: RpcSpawnProcess = (command, args, options) =>
  spawn(command, args, options) as ChildProcessWithoutNullStreams;

export function buildChildEnvironment(
  overrides: Record<string, string | undefined>,
  allowlist = DEFAULT_CHILD_ENV_ALLOWLIST,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const forbidden = /^(NODE_OPTIONS|NODE_PATH|BUN_OPTIONS|DENO_OPTIONS|LD_.+|DYLD_.+|PI_SUBAGENT_.+)$/;
  for (const name of allowlist) {
    if (forbidden.test(name)) continue;
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (!/^PI_SUBAGENT_[A-Z0-9_]+$/.test(name) && forbidden.test(name)) continue;
    if (value !== undefined) env[name] = value;
  }
  return env;
}

let cgroupSequence = 0;

function canLaunchThroughWrapper(command: string): boolean {
  if (!path.isAbsolute(command)) return true;
  try {
    accessSync(command, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function removeEmptyCgroupTree(cgroupPath: string): void {
  for (const entry of readdirSync(cgroupPath, { withFileTypes: true })) {
    if (entry.isDirectory())
      removeEmptyCgroupTree(path.join(cgroupPath, entry.name));
  }
  rmdirSync(cgroupPath);
}

function createOwnedCgroup(): string | undefined {
  let cgroupPath: string | undefined;
  try {
    const membership = readFileSync("/proc/self/cgroup", "utf8")
      .split(/\r?\n/)
      .find((line) => line.startsWith("0::"))
      ?.slice(3);
    if (!membership?.startsWith("/")) return undefined;
    const cgroupRoot = "/sys/fs/cgroup";
    const parent = path.resolve(cgroupRoot, `.${membership}`);
    if (parent !== cgroupRoot && !parent.startsWith(`${cgroupRoot}${path.sep}`))
      return undefined;
    const name = `.pi-subagent-rpc-${process.pid}-${Date.now()}-${++cgroupSequence}`;
    cgroupPath = path.join(parent, name);
    mkdirSync(cgroupPath, { mode: 0o700 });
    readFileSync(path.join(cgroupPath, "cgroup.events"), "utf8");
    writeFileSync(path.join(cgroupPath, "cgroup.kill"), "1");
    return cgroupPath;
  } catch {
    if (cgroupPath) {
      try { rmdirSync(cgroupPath); } catch { /* unavailable or already populated */ }
    }
    return undefined;
  }
}

function readProcessIdentity(
  pid: number,
): { startTime: string; processGroup: number } | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const suffix = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/);
    // suffix[0] is field 3 (state); pgrp is field 5 and starttime field 22.
    const processGroup = Number(suffix[2]);
    const startTime = suffix[19];
    if (
      !Number.isSafeInteger(processGroup) ||
      processGroup < 1 ||
      !/^\d+$/.test(startTime ?? "")
    ) return undefined;
    return { startTime, processGroup };
  } catch {
    return undefined;
  }
}

function readProcessStartTime(pid: number): string | undefined {
  return readProcessIdentity(pid)?.startTime;
}

function boundedUtf8Tail(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const tail: string[] = [];
  let bytes = 0;
  const characters = Array.from(value);
  for (let index = characters.length - 1; index >= 0; index--) {
    const character = characters[index]!;
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    tail.push(character);
    bytes += size;
  }
  return tail.reverse().join("");
}

function isDialogUiRequest(request: any): boolean {
  return (
    request.method === "select" ||
    request.method === "confirm" ||
    request.method === "input" ||
    request.method === "editor"
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
