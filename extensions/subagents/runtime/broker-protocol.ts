import * as crypto from "node:crypto";
import type * as net from "node:net";
import { StringDecoder } from "node:string_decoder";
import {
  BROKER_AUTH_DEADLINE_MS,
  BROKER_DISPATCH_DRAIN_TIMEOUT_MS,
  BROKER_FRAME_MAX_BYTES,
  BROKER_MAX_ACCEPTED_CONNECTIONS,
  BROKER_MAX_OUTBOUND_QUEUE_BYTES,
  BROKER_MAX_OUTBOUND_QUEUE_FRAMES,
  BROKER_MAX_OUTSTANDING_REQUESTS,
  BROKER_MAX_REQUESTS_PER_WINDOW,
  BROKER_RATE_WINDOW_MS,
  BROKER_SHUTDOWN_TIMEOUT_MS,
} from "../constants.ts";

export const BROKER_PROTOCOL_VERSION = 2;
const FRAME_ID_RE = /^[A-Za-z0-9_-]{1,160}$/;
const OP_RE = /^[a-z][a-z0-9_]{0,63}$/;
const TOKEN_RE = /^[a-f0-9]{32,128}$/;

export interface BrokerProtocolLimits {
  frameMaxBytes: number;
  authenticationDeadlineMs: number;
  shutdownTimeoutMs: number;
  dispatchDrainTimeoutMs: number;
  maxAcceptedConnections: number;
  maxOutstandingRequests: number;
  maxRequestsPerWindow: number;
  rateWindowMs: number;
  maxOutboundQueueFrames: number;
  maxOutboundQueueBytes: number;
}

export const DEFAULT_BROKER_PROTOCOL_LIMITS: Readonly<BrokerProtocolLimits> =
  Object.freeze({
    frameMaxBytes: BROKER_FRAME_MAX_BYTES,
    authenticationDeadlineMs: BROKER_AUTH_DEADLINE_MS,
    shutdownTimeoutMs: BROKER_SHUTDOWN_TIMEOUT_MS,
    dispatchDrainTimeoutMs: BROKER_DISPATCH_DRAIN_TIMEOUT_MS,
    maxAcceptedConnections: BROKER_MAX_ACCEPTED_CONNECTIONS,
    maxOutstandingRequests: BROKER_MAX_OUTSTANDING_REQUESTS,
    maxRequestsPerWindow: BROKER_MAX_REQUESTS_PER_WINDOW,
    rateWindowMs: BROKER_RATE_WINDOW_MS,
    maxOutboundQueueFrames: BROKER_MAX_OUTBOUND_QUEUE_FRAMES,
    maxOutboundQueueBytes: BROKER_MAX_OUTBOUND_QUEUE_BYTES,
  });

export function brokerProtocolLimits(
  overrides?: Partial<BrokerProtocolLimits>,
): Readonly<BrokerProtocolLimits> {
  const result = { ...DEFAULT_BROKER_PROTOCOL_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error(`Invalid broker protocol limit '${name}'`);
  }
  if (result.maxOutboundQueueBytes < result.frameMaxBytes)
    throw new Error("Broker outbound byte limit must fit at least one frame");
  return Object.freeze(result);
}

export interface BrokerFrameBinding {
  identity: string;
  generation: number;
  connectionToken: string;
  operationToken: string;
}

export function randomBrokerToken(bytes = 24): string {
  return crypto.randomBytes(bytes).toString("hex");
}

export function validateFrameId(value: unknown, field = "broker frame id"): string {
  if (typeof value !== "string" || !FRAME_ID_RE.test(value))
    throw new Error(`Invalid ${field}`);
  return value;
}

export function validateOperation(value: unknown): string {
  if (typeof value !== "string" || !OP_RE.test(value))
    throw new Error("Invalid broker operation");
  return value;
}

export function validateOperationToken(value: unknown): string {
  if (typeof value !== "string" || !TOKEN_RE.test(value))
    throw new Error("Invalid broker operation token");
  return value;
}

export function validateGeneration(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    throw new Error("Invalid broker connection generation");
  return Number(value);
}

export function validateSequence(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    throw new Error("Invalid broker frame sequence");
  return Number(value);
}

/**
 * Stateful UTF-8 JSONL decoder. Limits are applied to each LF-delimited frame,
 * never to an aggregate chunk containing several independently valid frames.
 */
export class BrokerFrameDecoder {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";

  constructor(private readonly maxBytes: number) {}

  push(chunk: Buffer | Uint8Array): unknown[] {
    this.buffer += this.decoder.write(Buffer.from(chunk));
    const frames: unknown[] = [];
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (Buffer.byteLength(line, "utf8") + 1 > this.maxBytes)
        throw new Error("Oversized broker frame");
      if (!line) continue;
      try {
        frames.push(JSON.parse(line));
      } catch {
        throw new Error("Invalid broker JSON frame");
      }
    }
    if (Buffer.byteLength(this.buffer, "utf8") > this.maxBytes)
      throw new Error("Oversized broker frame");
    return frames;
  }

  finish(): unknown[] {
    this.buffer += this.decoder.end();
    if (!this.buffer) return [];
    if (Buffer.byteLength(this.buffer, "utf8") > this.maxBytes)
      throw new Error("Oversized broker frame");
    const line = this.buffer;
    this.buffer = "";
    try {
      return [JSON.parse(line)];
    } catch {
      throw new Error("Invalid broker JSON frame");
    }
  }
}

interface WritableSocket {
  destroyed?: boolean;
  write(
    data: string,
    callback?: (error?: Error | null) => void,
  ): boolean;
}

interface QueuedWrite {
  text: string;
  bytes: number;
  resolve(): void;
  reject(error: Error): void;
}

/** Serializes writes and applies an explicit memory bound while the socket drains. */
export class BoundedSocketWriter {
  private readonly queue: QueuedWrite[] = [];
  private queuedBytes = 0;
  private writing = false;
  private failure?: Error;

  constructor(
    private readonly socket: WritableSocket,
    private readonly limits: Pick<
      BrokerProtocolLimits,
      | "frameMaxBytes"
      | "maxOutboundQueueFrames"
      | "maxOutboundQueueBytes"
    >,
  ) {}

  get pendingFrames(): number {
    return this.queue.length;
  }

  get pendingBytes(): number {
    return this.queuedBytes;
  }

  send(frame: unknown): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    let text: string;
    try {
      text = `${JSON.stringify(frame)}\n`;
    } catch {
      return Promise.reject(new Error("Broker frame is not serializable"));
    }
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > this.limits.frameMaxBytes)
      return Promise.reject(new Error("Broker frame exceeds maximum size"));
    if (
      this.queue.length >= this.limits.maxOutboundQueueFrames ||
      this.queuedBytes + bytes > this.limits.maxOutboundQueueBytes
    )
      return Promise.reject(new Error("Broker outbound queue is full"));
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ text, bytes, resolve, reject });
      this.queuedBytes += bytes;
      this.pump();
    });
  }

  fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    const pending = this.queue.splice(0);
    this.queuedBytes = 0;
    this.writing = false;
    for (const item of pending) item.reject(error);
  }

  private pump(): void {
    if (this.writing || this.failure) return;
    const item = this.queue[0];
    if (!item) return;
    if (this.socket.destroyed) {
      this.fail(new Error("Broker socket is closed"));
      return;
    }
    this.writing = true;
    let callbackCalled = false;
    try {
      this.socket.write(item.text, (error?: Error | null) => {
        if (callbackCalled) return;
        callbackCalled = true;
        this.writing = false;
        if (this.queue[0] === item) this.queue.shift();
        else {
          const index = this.queue.indexOf(item);
          if (index >= 0) this.queue.splice(index, 1);
        }
        this.queuedBytes = Math.max(0, this.queuedBytes - item.bytes);
        if (error) {
          item.reject(error);
          this.fail(error);
          return;
        }
        item.resolve();
        this.pump();
      });
    } catch (error) {
      this.writing = false;
      if (this.queue[0] === item) this.queue.shift();
      this.queuedBytes = Math.max(0, this.queuedBytes - item.bytes);
      const failure = error instanceof Error ? error : new Error(String(error));
      item.reject(failure);
      this.fail(failure);
    }
  }
}

export class BrokerRateLimiter {
  private windowStartedAt?: number;
  private count = 0;

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  take(): boolean {
    const timestamp = this.now();
    if (
      this.windowStartedAt === undefined ||
      timestamp - this.windowStartedAt >= this.windowMs
    ) {
      this.windowStartedAt = timestamp;
      this.count = 0;
    }
    if (this.count >= this.maxRequests) return false;
    this.count += 1;
    return true;
  }
}

export function isSocket(value: unknown): value is net.Socket {
  return !!value && typeof (value as net.Socket).write === "function";
}
