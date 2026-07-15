import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  COMPLETION_RECOVERY_MAX_ENTRIES,
  COMPLETION_RECOVERY_RAW_SCAN_MAX_ENTRIES,
  COMPLETION_RECOVERY_SIDECAR_MAX_BYTES,
} from "../constants.ts";
import {
  canonicalCompletionPayload,
  taskEnvelope,
} from "../prompts.ts";
import type {
  SelfCompletionOutboxEvent,
} from "../types.ts";
import {
  currentProcessAgentId,
  currentRootId,
  errorMessage,
  oneLine,
  resolveContained,
  safeWriteJson,
  safeWriteText,
  truncateUtf8,
} from "../utils.ts";
import type { SubagentRuntimeState } from "./state.ts";

interface TerminalCapture {
  output: string;
  error?: string;
  ended: boolean;
}

/** Child-self completion authority. Parent managers never create normal v2 completions. */
export class SelfTurnReporter {
  private readonly captures = new Map<string, TerminalCapture>();
  private readonly outbox = new Map<string, Readonly<SelfCompletionOutboxEvent>>();
  private retryTimer?: NodeJS.Timeout;
  private retryContext?: ExtensionContext;
  private recoveryContinuationScheduled = false;
  private deliveryChain: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(private readonly state: SubagentRuntimeState) {}

  captureMessage(lifecycleToken: string, message: any): void {
    if (this.stopped || message?.role !== "assistant") return;
    const output = Array.isArray(message.content)
      ? message.content
          .filter((part: any) => part?.type === "text")
          .map((part: any) => String(part.text ?? ""))
          .join("\n")
      : "";
    const error = message.stopReason === "error"
      ? String(message.errorMessage ?? "Child turn failed without an error message.")
      : undefined;
    // Always overwrite, including with empty text, so intermediate output never
    // leaks into a later empty final response or successful retry.
    this.captures.set(lifecycleToken, { output, error, ended: false });
  }

  captureAgentEnd(lifecycleToken: string, event: any): void {
    if (this.stopped || event?.willRetry === true) return;
    const capture = this.captures.get(lifecycleToken) ?? { output: "", ended: false };
    this.captures.set(lifecycleToken, { ...capture, ended: true });
  }

  captureExtensionError(lifecycleToken: string, event: any): void {
    if (this.stopped) return;
    const capture = this.captures.get(lifecycleToken) ?? { output: "", ended: false };
    this.captures.set(lifecycleToken, {
      ...capture,
      error: oneLine(String(event?.error ?? "child extension error"), 2_000),
    });
  }

  /**
   * Close the terminal capture and durably prepare its immutable outbox event.
   * This is deliberately synchronous so the lifecycle hook can return before
   * Pi serializes the matching raw agent_settled event.
   */
  captureSettled(
    lifecycleToken: string,
    ctx: ExtensionContext,
  ): Readonly<SelfCompletionOutboxEvent> | undefined {
    const capture = this.captures.get(lifecycleToken);
    this.captures.delete(lifecycleToken);
    // An accepted interrupt has no natural terminal/agent_end and emits nothing.
    if (!capture?.ended || this.state.closing || this.stopped) return;
    const turnEpoch = parseTurnEpoch(lifecycleToken);
    const eventId = stableCompletionEventId(this.state.currentPath, lifecycleToken);
    const existing = this.outbox.get(eventId);
    if (existing) return existing.stage === "observed" ? undefined : existing;
    const artifactPath = path.join(
      completionOutboxDirectory(this.state, ctx),
      `${eventId}.md`,
    );
    const outcome = capture.error ? "errored" : "completed";
    const initial = freezeEvent({
      eventId,
      lifecycleToken,
      turnEpoch,
      senderPath: this.state.currentPath,
      parentPath: process.env.PI_SUBAGENT_PARENT_PATH ?? "/root",
      outcome,
      output: capture.output,
      error: capture.error,
      artifactPath,
      payload: "",
      envelope: "",
      stage: "processing",
      attempts: 0,
      createdAt: Date.now(),
    });
    // Journal bounded recovery intent before writing the full artifact. A crash
    // between these synchronous writes can still deliver a bounded result.
    this.install(initial);
    return this.prepare(initial);
  }

  /** Compatibility helper for callers outside the lifecycle hook. */
  async settled(lifecycleToken: string, ctx: ExtensionContext): Promise<void> {
    const event = this.captureSettled(lifecycleToken, ctx);
    if (event) await this.deliverPrepared(event.eventId, ctx);
  }

  async deliverPrepared(eventId: string, ctx: ExtensionContext): Promise<void> {
    if (this.stopped) return;
    const event = this.outbox.get(eventId);
    if (!event || event.stage === "observed") return;
    try {
      await this.enqueueDelivery(ctx);
    } catch (error) {
      this.scheduleRetry(ctx, event.attempts + 1);
      throw error;
    }
  }

  async retryPending(ctx: ExtensionContext): Promise<void> {
    if (this.stopped) return;
    try {
      await this.enqueueDelivery(ctx);
    } catch (error) {
      this.scheduleRetry(
        ctx,
        Math.max(1, ...[...this.outbox.values()].map((event) => event.attempts)),
      );
      throw error;
    }
  }

  private enqueueDelivery(ctx: ExtensionContext): Promise<void> {
    const run = this.deliveryChain.then(
      () => this.drainPendingInOrder(ctx),
      () => this.drainPendingInOrder(ctx),
    );
    this.deliveryChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async drainPendingInOrder(ctx: ExtensionContext): Promise<void> {
    for (const event of this.pendingEvents()) {
      const current = this.outbox.get(event.eventId);
      if (!current || current.stage === "observed") continue;
      // Stop at the first failure. A later final can never overtake an older
      // stalled/retryable event on either the direct or retry path.
      await this.advance(current, ctx);
    }
  }

  pendingEvents(): Readonly<SelfCompletionOutboxEvent>[] {
    return [...this.outbox.values()]
      .filter((event) => event.stage !== "observed")
      .sort(compareCompletionOrder);
  }

  pendingEventIds(): string[] {
    return this.pendingEvents().map((event) => event.eventId);
  }

  eventIdForToken(lifecycleToken: string): string | undefined {
    const eventId = stableCompletionEventId(this.state.currentPath, lifecycleToken);
    return this.outbox.get(eventId)?.stage === "observed" ? undefined : eventId;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.retryContext = undefined;
    this.captures.clear();
  }

  /** Restore only retryable, authenticated completion injections for this child. */
  restorePending(ctx: ExtensionContext): number {
    if (this.stopped) return 0;
    const artifactDirectory = completionOutboxDirectory(this.state, ctx);
    const directory = completionSidecarDirectory(artifactDirectory);
    let handle: fs.Dir | undefined;
    const restored: Readonly<SelfCompletionOutboxEvent>[] = [];
    let removedStale = false;
    let reachedDirectoryEnd = false;
    try {
      handle = fs.opendirSync(directory);
      for (
        let inspected = 0;
        inspected < COMPLETION_RECOVERY_RAW_SCAN_MAX_ENTRIES &&
          restored.length < COMPLETION_RECOVERY_MAX_ENTRIES;
        inspected++
      ) {
        const entry = handle.readSync();
        if (!entry) {
          reachedDirectoryEnd = true;
          break;
        }
        const sidecarPath = path.join(directory, entry.name);
        if (
          !entry.isFile() ||
          !/^completion_[a-f0-9]{32}\.md\.json$/.test(entry.name)
        ) {
          if (entry.isFile() || entry.isSymbolicLink()) {
            try {
              fs.unlinkSync(sidecarPath);
              removedStale = true;
            } catch { /* stale entry remains bounded */ }
          }
          continue;
        }
        try {
          const stat = fs.lstatSync(sidecarPath);
          if (!stat.isFile() || stat.size > COMPLETION_RECOVERY_SIDECAR_MAX_BYTES) {
            fs.unlinkSync(sidecarPath);
            removedStale = true;
            continue;
          }
          const value = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
          if (value?.stage === "observed") {
            fs.unlinkSync(sidecarPath);
            removedStale = true;
            continue;
          }
          const event = restoredPendingEvent(
            value,
            artifactDirectory,
            this.state.currentPath,
            process.env.PI_SUBAGENT_PARENT_PATH ?? "/root",
            this.state.settings.completionMessageMaxBytes,
          );
          if (event) restored.push(event);
          else {
            fs.unlinkSync(sidecarPath);
            removedStale = true;
          }
        } catch {
          // Dedicated sidecar state contains only extension-owned retry data.
          try {
            fs.unlinkSync(sidecarPath);
            removedStale = true;
          } catch { /* already absent */ }
        }
      }
      handle.closeSync();
    } catch (error: any) {
      if (handle) {
        try { handle.closeSync(); } catch { /* already closed */ }
      }
      if (error?.code === "ENOENT") return 0;
      return 0;
    }
    restored.sort(compareCompletionOrder);
    // The configured limit is activation backpressure, never a reason to drop
    // a durable pending final answer during recovery.
    for (const event of restored) this.outbox.set(event.eventId, event);
    if (
      !reachedDirectoryEnd &&
      removedStale &&
      !this.recoveryContinuationScheduled
    ) {
      this.recoveryContinuationScheduled = true;
      queueMicrotask(() => {
        this.recoveryContinuationScheduled = false;
        if (this.stopped || this.state.closing) return;
        const count = this.restorePending(ctx);
        if (count > 0) void this.retryPending(ctx).catch(() => undefined);
      });
    }
    return restored.length;
  }

  snapshot(): Readonly<SelfCompletionOutboxEvent>[] {
    return [...this.outbox.values()];
  }

  private prepare(
    source: Readonly<SelfCompletionOutboxEvent>,
  ): Readonly<SelfCompletionOutboxEvent> {
    let event = source;
    const lifecycleEpoch = event.turnEpoch;
    if (!this.isCurrent(event, lifecycleEpoch)) return event;
    if (event.stage === "processing") {
      safeWriteText(event.artifactPath, event.output);
      if (!this.isCurrent(event, lifecycleEpoch)) return event;
      const payload = boundedPayload(event, this.state.settings.completionMessageMaxBytes);
      const envelope = taskEnvelope(
        "FINAL_ANSWER",
        event.parentPath,
        event.senderPath,
        payload,
      );
      event = this.transition(event, {
        payload,
        envelope: truncateUtf8(envelope, this.state.settings.completionMessageMaxBytes),
        stage: "artifact_ready",
      });
    }
    if (this.isCurrent(event, lifecycleEpoch) && event.stage === "artifact_ready")
      event = this.transition(event, { stage: "injection_pending" });
    return event;
  }

  private async advance(
    source: Readonly<SelfCompletionOutboxEvent>,
    ctx: ExtensionContext,
  ): Promise<void> {
    let event = this.prepare(source);
    const lifecycleEpoch = event.turnEpoch;
    if (event.stage === "accepted")
      event = this.transition(event, { stage: "injection_pending" });
    if (event.stage !== "injection_pending" || !this.isCurrent(event, lifecycleEpoch)) return;
    event = this.transition(event, { attempts: event.attempts + 1 });
    try {
      const result = await this.state.broker!.deliverCompletion({
        targetPath: event.parentPath,
        eventId: event.eventId,
        sender: event.senderPath,
        content: event.envelope,
        details: {
          event_id: event.eventId,
          agent_id: process.env.PI_SUBAGENT_ID,
          agent_name: event.senderPath,
          turn_id: event.lifecycleToken,
          outcome: event.outcome,
          // Full output is already durable in output_path. Keep transport
          // metadata bounded so details cannot exceed the broker frame.
          output: event.payload,
          output_path: event.artifactPath,
          timestamp: event.createdAt,
        },
      });
      if (!this.isCurrent(event, lifecycleEpoch)) return;
      event = this.transition(event, { stage: "accepted" });
      if (result?.observed === true && this.isCurrent(event, lifecycleEpoch))
        this.transition(event, { stage: "observed" });
    } catch (error) {
      if (!this.isCurrent(event, lifecycleEpoch)) return;
      // Stable event ID and immutable artifact remain injection_pending for retry.
      this.transition(event, {
        stage: "injection_pending",
        error: event.error ?? (event.outcome === "errored" ? errorMessage(error) : undefined),
      });
      throw error;
    }
  }

  private isCurrent(
    event: Readonly<SelfCompletionOutboxEvent>,
    lifecycleEpoch: number,
  ): boolean {
    return !this.stopped &&
      !this.state.closing &&
      event.turnEpoch === lifecycleEpoch &&
      this.outbox.get(event.eventId)?.lifecycleToken === event.lifecycleToken;
  }

  private scheduleRetry(ctx: ExtensionContext, attempts: number): void {
    if (this.stopped || this.state.closing || this.retryTimer) return;
    this.retryContext = ctx;
    const delay = Math.min(5_000, 100 * 2 ** Math.min(6, Math.max(0, attempts - 1)));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      const current = this.retryContext;
      if (!current || this.stopped || this.state.closing) return;
      void this.retryPending(current).catch(() => undefined);
    }, delay);
    this.retryTimer.unref?.();
  }

  private transition(
    event: Readonly<SelfCompletionOutboxEvent>,
    update: Partial<SelfCompletionOutboxEvent>,
  ): Readonly<SelfCompletionOutboxEvent> {
    const next = freezeEvent({ ...event, ...update });
    this.install(next);
    return next;
  }

  private install(event: Readonly<SelfCompletionOutboxEvent>): void {
    this.outbox.set(event.eventId, event);
    while (this.outbox.size > this.state.settings.completionOutboxLimit) {
      const observed = [...this.outbox.values()].find(
        (candidate) => candidate.stage === "observed" && candidate.eventId !== event.eventId,
      );
      if (!observed) break;
      this.outbox.delete(observed.eventId);
      try {
        fs.unlinkSync(completionSidecarPath(observed.artifactPath));
      } catch {
        // An already-removed observed sidecar is harmless.
      }
    }
    const sidecarPath = completionSidecarPath(event.artifactPath);
    if (event.stage === "observed") {
      try {
        fs.unlinkSync(sidecarPath);
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
      }
      return;
    }
    const durable = event.stage === "processing"
      ? {
          ...event,
          output: truncateUtf8(
            event.output,
            this.state.settings.completionMessageMaxBytes,
          ),
        }
      : { ...event, output: event.payload };
    safeWriteJson(sidecarPath, durable);
  }
}

function completionSidecarDirectory(artifactDirectory: string): string {
  return resolveContained(artifactDirectory, "state");
}

function completionSidecarPath(artifactPath: string): string {
  return resolveContained(
    path.dirname(artifactPath),
    "state",
    `${path.basename(artifactPath)}.json`,
  );
}

function parseTurnEpoch(token: string): number {
  const epoch = Number(token.split(".").at(-1));
  if (!Number.isSafeInteger(epoch) || epoch < 1)
    throw new Error("Completion lifecycle token has no valid turn epoch");
  return epoch;
}

/** The persisted turn epoch is the authoritative FIFO sequence across reloads. */
function compareCompletionOrder(
  left: Readonly<SelfCompletionOutboxEvent>,
  right: Readonly<SelfCompletionOutboxEvent>,
): number {
  return left.turnEpoch - right.turnEpoch ||
    left.createdAt - right.createdAt ||
    (left.eventId < right.eventId ? -1 : left.eventId > right.eventId ? 1 : 0);
}

export function stableCompletionEventId(senderPath: string, token: string): string {
  return `completion_${crypto.createHash("sha256").update(`${senderPath}\0${token}`).digest("hex").slice(0, 32)}`;
}

export function completionOutboxDirectory(
  state: SubagentRuntimeState,
  ctx: ExtensionContext,
): string {
  const sessionDir = ctx.sessionManager.getSessionDir();
  if (typeof sessionDir === "string" && sessionDir.trim() && path.isAbsolute(sessionDir))
    return resolveContained(sessionDir, "completion-outbox");
  const rootId = currentRootId(ctx);
  const agentId = currentProcessAgentId(ctx);
  return resolveContained(
    state.settings.sessionDir,
    rootId,
    agentId,
    "completion-outbox",
  );
}

function restoredPendingEvent(
  value: any,
  directory: string,
  senderPath: string,
  parentPath: string,
  maxBytes: number,
): Readonly<SelfCompletionOutboxEvent> | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    !["processing", "artifact_ready", "injection_pending", "accepted"].includes(value.stage)
  ) return;
  if (
    typeof value.eventId !== "string" ||
    typeof value.lifecycleToken !== "string" ||
    value.senderPath !== senderPath ||
    value.parentPath !== parentPath ||
    (value.outcome !== "completed" && value.outcome !== "errored") ||
    typeof value.output !== "string" ||
    (value.error !== undefined && typeof value.error !== "string") ||
    typeof value.artifactPath !== "string" ||
    typeof value.payload !== "string" ||
    typeof value.envelope !== "string" ||
    !Number.isSafeInteger(value.attempts) ||
    value.attempts < 0 ||
    !Number.isSafeInteger(value.createdAt) ||
    value.createdAt < 0
  ) return;
  const turnEpoch = parseTurnEpoch(value.lifecycleToken);
  if (value.turnEpoch !== turnEpoch) return;
  const eventId = stableCompletionEventId(senderPath, value.lifecycleToken);
  if (value.eventId !== eventId) return;
  const artifactPath = path.join(directory, `${eventId}.md`);
  if (path.resolve(value.artifactPath) !== path.resolve(artifactPath)) return;
  const event = freezeEvent({
    eventId,
    lifecycleToken: value.lifecycleToken,
    turnEpoch,
    senderPath,
    parentPath,
    outcome: value.outcome,
    output: value.output,
    error: value.error,
    artifactPath,
    payload: value.payload,
    envelope: value.envelope,
    stage: value.stage,
    attempts: value.attempts,
    createdAt: value.createdAt,
  });
  if (event.stage === "processing") {
    if (event.payload !== "" || event.envelope !== "") return;
    return event;
  }
  const expectedPayload = boundedPayload(event, maxBytes);
  const expectedEnvelope = truncateUtf8(
    taskEnvelope("FINAL_ANSWER", parentPath, senderPath, expectedPayload),
    maxBytes,
  );
  if (event.payload !== expectedPayload || event.envelope !== expectedEnvelope) return;
  return event;
}

function boundedPayload(
  event: Readonly<SelfCompletionOutboxEvent>,
  maxBytes: number,
): string {
  if (event.outcome === "errored")
    return canonicalCompletionPayload("errored", oneLine(event.error ?? "", 2_000));
  const reference = `\n[Full output: ${event.artifactPath}]`;
  if (Buffer.byteLength(event.output, "utf8") <= Math.max(0, maxBytes - 256))
    return canonicalCompletionPayload("completed", event.output);
  return canonicalCompletionPayload(
    "completed",
    `${truncateUtf8(event.output, Math.max(0, maxBytes - Buffer.byteLength(reference) - 256))}${reference}`,
  );
}

function freezeEvent(
  event: SelfCompletionOutboxEvent,
): Readonly<SelfCompletionOutboxEvent> {
  return Object.freeze({ ...event });
}
