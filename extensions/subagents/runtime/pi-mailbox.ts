import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEDUP_LIMIT = 4_096;

export interface PiMailboxInsert {
  eventId: string;
  customType: string;
  content: string;
  details?: unknown;
  triggerTurn: boolean;
  deliverAs?: "steer" | "followUp" | "nextTurn";
  signal?: AbortSignal;
}

/**
 * Extension-only custom-message adapter.
 *
 * Pi's public extension API intentionally exposes `sendMessage()` as a
 * fire-and-forget handoff. Stable event IDs provide local deduplication; the
 * broker remains responsible for durable retry and recipient-side dedupe.
 */
export class PiMailbox {
  private readonly acceptedEventIds = new Set<string>();
  private readonly inFlightByEventId = new Map<string, Promise<void>>();

  constructor(private readonly pi: ExtensionAPI) {}

  insert(input: PiMailboxInsert): Promise<void> {
    if (this.acceptedEventIds.has(input.eventId)) return Promise.resolve();
    const inFlight = this.inFlightByEventId.get(input.eventId);
    if (inFlight) return inFlight;
    if (input.signal?.aborted) return Promise.reject(mailboxAbortError());
    if (typeof input.eventId !== "string" || input.eventId.trim().length === 0)
      return Promise.reject(new Error("Pi mailbox eventId must be a non-empty string"));

    let handoff: unknown;
    try {
      handoff = (this.pi.sendMessage as (...args: any[]) => unknown).call(
        this.pi,
        {
          customType: input.customType,
          content: input.content,
          display: true,
          details: input.details,
        },
        {
          deliverAs: input.deliverAs ?? "steer",
          triggerTurn: input.triggerTurn,
        },
      );
    } catch (error) {
      return Promise.reject(error);
    }

    let operation!: Promise<void>;
    operation = Promise.resolve(handoff).then(() => {
      this.rememberAccepted(input.eventId);
    }).finally(() => {
      if (this.inFlightByEventId.get(input.eventId) === operation)
        this.inFlightByEventId.delete(input.eventId);
    });
    this.inFlightByEventId.set(input.eventId, operation);
    return operation;
  }

  private rememberAccepted(eventId: string): void {
    this.acceptedEventIds.add(eventId);
    while (this.acceptedEventIds.size > DEDUP_LIMIT) {
      const oldest = this.acceptedEventIds.values().next().value as string | undefined;
      if (!oldest) break;
      this.acceptedEventIds.delete(oldest);
    }
  }
}

function mailboxAbortError(): Error {
  const error = new Error("Pi mailbox insertion aborted before ownership acceptance");
  error.name = "AbortError";
  return error;
}
