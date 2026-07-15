import { createHash } from "node:crypto";
import type { RpcEvent } from "../types.ts";

export const LIFECYCLE_STATUS_KEY = "subagents_lifecycle_v2";
const PREFIX = "<!-- pi-subagent-lifecycle:";
const SUFFIX = " -->\n";

export interface LifecycleMarker {
  v: 2;
  token: string;
  event: string;
  sequence: number;
  fingerprint: string;
  completionEventId?: string;
}

/** Child-side causal owner for exactly one queued prompt and one active turn. */
export class ChildLifecycleTokenController {
  private pendingPromptToken?: string;
  private activeTurn?: { token: string; sequence: number };
  private readonly closedTokens = new Set<string>();

  queuePrompt(token: string): void {
    if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(token))
      throw new Error("Invalid child lifecycle prompt token");
    if (this.pendingPromptToken || this.activeTurn)
      throw new Error("Lifecycle prompt token arrived while another child turn boundary is pending or active");
    if (this.closedTokens.has(token))
      throw new Error(`Lifecycle prompt token ${token} was already closed`);
    this.pendingPromptToken = token;
  }

  promotePending(): void {
    if (!this.pendingPromptToken || this.activeTurn)
      throw new Error("Child turn start has no unique pending lifecycle prompt token");
    this.activeTurn = { token: this.pendingPromptToken, sequence: 0 };
    this.pendingPromptToken = undefined;
  }

  get activeToken(): string | undefined {
    return this.activeTurn?.token;
  }

  marker(
    event: RpcEvent,
    eventName = event.type,
    completionEventId?: string,
  ): LifecycleMarker {
    if (!eventName || !this.activeTurn)
      throw new Error(`Child ${eventName ?? "lifecycle event"} has no uniquely active lifecycle token`);
    if (
      completionEventId !== undefined &&
      (eventName !== "agent_settled" || !/^completion_[a-f0-9]{32}$/.test(completionEventId))
    ) throw new Error("Invalid lifecycle completion event id");
    return {
      v: 2,
      token: this.activeTurn.token,
      event: eventName,
      sequence: ++this.activeTurn.sequence,
      fingerprint: lifecycleEventFingerprint(event, eventName),
      ...(completionEventId ? { completionEventId } : {}),
    };
  }

  closeActive(): void {
    if (!this.activeTurn)
      throw new Error("Cannot close a child lifecycle token without an active turn");
    this.closedTokens.add(this.activeTurn.token);
    this.activeTurn = undefined;
    while (this.closedTokens.size > 128) {
      const oldest = this.closedTokens.values().next().value as string | undefined;
      if (oldest === undefined) break;
      this.closedTokens.delete(oldest);
    }
  }
}

export function addLifecycleToken(message: string, token: string): string {
  return `${PREFIX}${token}${SUFFIX}${message}`;
}

export function removeLifecycleToken(message: string): {
  message: string;
  token?: string;
} {
  if (!message.startsWith(PREFIX)) return { message };
  const end = message.indexOf(SUFFIX, PREFIX.length);
  if (end < 0) return { message };
  const token = message.slice(PREFIX.length, end);
  if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(token)) return { message };
  return { token, message: message.slice(end + SUFFIX.length) };
}

/**
 * Hash only fields shared by Pi's extension hook and its subsequent RPC event.
 * The marker/event stream boundary supplies ordering; this digest prevents a
 * marker from being paired with a different lifecycle payload at that boundary.
 */
export function lifecycleEventFingerprint(
  event: RpcEvent,
  eventName = event.type,
): string {
  const message = event.message;
  const messages = Array.isArray(event.messages) ? event.messages : undefined;
  const lastMessage = messages?.at(-1);
  const identity = eventName === "message_end" || eventName === "turn_end"
    ? {
        type: eventName,
        role: message?.role,
        timestamp: message?.timestamp,
        stopReason: message?.stopReason,
        errorMessage: message?.errorMessage,
      }
    : eventName === "agent_end"
      ? {
          type: eventName,
          count: messages?.length,
          lastRole: lastMessage?.role,
          lastTimestamp: lastMessage?.timestamp,
          lastStopReason: lastMessage?.stopReason,
        }
      : eventName === "extension_error"
        ? {
            type: eventName,
            extensionPath: event.extensionPath,
            event: event.event,
            error: event.error,
          }
        : { type: eventName };
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

export function encodeLifecycleMarker(marker: LifecycleMarker): string {
  return JSON.stringify(marker);
}

export function decodeLifecycleMarker(event: RpcEvent): LifecycleMarker | undefined {
  if (
    event.type !== "extension_ui_request" ||
    event.method !== "setStatus" ||
    event.statusKey !== LIFECYCLE_STATUS_KEY ||
    typeof event.statusText !== "string"
  ) return undefined;
  try {
    const value = JSON.parse(event.statusText);
    if (
      value?.v !== 2 ||
      typeof value.token !== "string" ||
      !/^[A-Za-z0-9_.:-]{1,200}$/.test(value.token) ||
      typeof value.event !== "string" ||
      ![
        "agent_start",
        "message_end",
        "turn_end",
        "agent_end",
        "agent_settled",
        "extension_error",
      ].includes(value.event) ||
      !Number.isSafeInteger(value.sequence) ||
      value.sequence < 1 ||
      typeof value.fingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.fingerprint) ||
      (value.completionEventId !== undefined &&
        (value.event !== "agent_settled" ||
          typeof value.completionEventId !== "string" ||
          !/^completion_[a-f0-9]{32}$/.test(value.completionEventId)))
    ) return undefined;
    return value as LifecycleMarker;
  } catch {
    return undefined;
  }
}

export function isTurnLifecycleEvent(event: RpcEvent): boolean {
  return event.type === "agent_start" ||
    event.type === "agent_end" ||
    event.type === "agent_settled" ||
    event.type === "extension_error" ||
    ((event.type === "message_end" || event.type === "turn_end") &&
      event.message?.role === "assistant");
}
