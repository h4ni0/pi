interface EpochRange {
  start: number;
  end: number;
}

interface AgentCompletionLedger {
  /** Every epoch at or below this watermark has a final disposition. */
  contiguousThrough: number;
  /** Resolved epochs above a still-pending gap, stored as merged ranges. */
  resolvedRanges: EpochRange[];
  /** Queue acceptance won before the controller's terminal registration. */
  acceptedBeforeTerminal: Map<number, string>;
  /** Terminal registration won before queue acceptance. */
  expectedAfterTerminal: Map<number, string>;
}

export type CompletionReplayDisposition = "new" | "duplicate";

/**
 * Permanent, compact completion replay authority for one root-tree runtime.
 *
 * Finalized epochs collapse into a watermark/ranges instead of retaining every
 * event ID. Pending exceptions are bounded by the child completion outbox.
 */
export class CompletionDedupeLedger {
  private readonly byAgentPath = new Map<string, AgentCompletionLedger>();

  check(
    agentPath: string,
    epoch: number,
    eventId: string,
  ): CompletionReplayDisposition {
    const state = this.state(agentPath);
    if (this.isResolved(state, epoch)) return "duplicate";
    const accepted = state.acceptedBeforeTerminal.get(epoch);
    if (accepted !== undefined) {
      if (accepted !== eventId)
        throw new Error(`Completion epoch ${epoch} replayed with a different event id`);
      return "duplicate";
    }
    const expected = state.expectedAfterTerminal.get(epoch);
    if (expected !== undefined && expected !== eventId)
      throw new Error(`Completion epoch ${epoch} does not match its terminal event id`);
    return "new";
  }

  pendingAfterTerminalEventId(
    agentPath: string,
    epoch: number,
  ): string | undefined {
    return this.state(agentPath).expectedAfterTerminal.get(epoch);
  }

  /** Record acknowledged recipient queue ownership. */
  accept(agentPath: string, epoch: number, eventId: string): void {
    const state = this.state(agentPath);
    if (this.isResolved(state, epoch)) return;
    const accepted = state.acceptedBeforeTerminal.get(epoch);
    if (accepted !== undefined && accepted !== eventId)
      throw new Error(`Completion epoch ${epoch} was accepted with conflicting event ids`);
    const expected = state.expectedAfterTerminal.get(epoch);
    if (expected !== undefined && expected !== eventId)
      throw new Error(`Completion epoch ${epoch} acceptance mismatches terminal registration`);
    if (expected !== undefined) {
      state.expectedAfterTerminal.delete(epoch);
      this.resolve(state, epoch);
      return;
    }
    state.acceptedBeforeTerminal.set(epoch, eventId);
  }

  /**
   * Record the authoritative terminal controller transition. An omitted event
   * ID means this epoch intentionally publishes no completion (for example an
   * interrupted turn).
   */
  terminal(agentPath: string, epoch: number, expectedEventId?: string): void {
    const state = this.state(agentPath);
    if (this.isResolved(state, epoch)) return;
    const accepted = state.acceptedBeforeTerminal.get(epoch);
    if (expectedEventId === undefined) {
      state.acceptedBeforeTerminal.delete(epoch);
      state.expectedAfterTerminal.delete(epoch);
      this.resolve(state, epoch);
      return;
    }
    if (accepted !== undefined) {
      if (accepted !== expectedEventId)
        throw new Error(`Completion epoch ${epoch} terminal registration conflicts with accepted event`);
      state.acceptedBeforeTerminal.delete(epoch);
      this.resolve(state, epoch);
      return;
    }
    const previous = state.expectedAfterTerminal.get(epoch);
    if (previous !== undefined && previous !== expectedEventId)
      throw new Error(`Completion epoch ${epoch} registered conflicting event ids`);
    state.expectedAfterTerminal.set(epoch, expectedEventId);
  }

  /** Crash delivery is both terminal authority and acknowledged completion. */
  acceptTerminal(agentPath: string, epoch: number, eventId: string): void {
    if (this.check(agentPath, epoch, eventId) === "duplicate") return;
    const state = this.state(agentPath);
    state.acceptedBeforeTerminal.delete(epoch);
    state.expectedAfterTerminal.delete(epoch);
    this.resolve(state, epoch);
  }

  snapshot(agentPath: string): {
    contiguousThrough: number;
    rangeCount: number;
    pendingCount: number;
  } {
    const state = this.state(agentPath);
    return {
      contiguousThrough: state.contiguousThrough,
      rangeCount: state.resolvedRanges.length,
      pendingCount:
        state.acceptedBeforeTerminal.size + state.expectedAfterTerminal.size,
    };
  }

  private state(agentPath: string): AgentCompletionLedger {
    let state = this.byAgentPath.get(agentPath);
    if (!state) {
      state = {
        contiguousThrough: 0,
        resolvedRanges: [],
        acceptedBeforeTerminal: new Map(),
        expectedAfterTerminal: new Map(),
      };
      this.byAgentPath.set(agentPath, state);
    }
    return state;
  }

  private isResolved(state: AgentCompletionLedger, epoch: number): boolean {
    if (!Number.isSafeInteger(epoch) || epoch < 1)
      throw new Error("Completion epoch must be a positive integer");
    if (epoch <= state.contiguousThrough) return true;
    return state.resolvedRanges.some(
      (range) => epoch >= range.start && epoch <= range.end,
    );
  }

  private resolve(state: AgentCompletionLedger, epoch: number): void {
    if (epoch <= state.contiguousThrough) return;
    let start = epoch;
    let end = epoch;
    const retained: EpochRange[] = [];
    for (const range of state.resolvedRanges) {
      if (range.end + 1 < start || range.start - 1 > end) {
        retained.push(range);
        continue;
      }
      start = Math.min(start, range.start);
      end = Math.max(end, range.end);
    }
    retained.push({ start, end });
    retained.sort((left, right) => left.start - right.start);
    state.resolvedRanges = retained;
    while (
      state.resolvedRanges.length > 0 &&
      state.resolvedRanges[0]!.start <= state.contiguousThrough + 1
    ) {
      const first = state.resolvedRanges.shift()!;
      state.contiguousThrough = Math.max(state.contiguousThrough, first.end);
    }
  }
}
