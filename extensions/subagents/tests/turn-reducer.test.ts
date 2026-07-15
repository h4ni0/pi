import { describe, expect, test } from "bun:test";
import type { SubagentRecord } from "../types.ts";
import {
  createLiveSubagentRecord,
  reduceTurnLifecycle,
  rememberSettledTurnId,
} from "../runtime/turn-controller.ts";

function record(): SubagentRecord {
  const value = createLiveSubagentRecord({
    id: "sa_reducer",
    generatedLabel: "reducer",
    taskName: "reducer",
    agentName: "/root/reducer",
    mode: "v2",
    forkTurns: "none",
    parentId: "root",
    rootId: "root",
    depth: 1,
    maxDepth: 2,
    message: "first",
    sessionDir: "/tmp/reducer",
    createdAt: 1,
  });
  value.processState = "alive";
  value.status = "running";
  value.committed = true;
  value.reusable = true;
  value.activeSlotHeld = true;
  return value;
}

function event(
  target: SubagentRecord,
  value: Record<string, unknown>,
  timestamp = 2,
  epoch = target.activeTurn!.epoch,
) {
  const token = epoch === target.activeTurn?.epoch
    ? target.activeTurn.token
    : `${target.id}.${epoch}`;
  return reduceTurnLifecycle(target, {
    type: "rpc_event",
    epoch,
    token,
    event: value,
    timestamp,
  });
}

function assistant(text: string, stopReason = "stop", errorMessage?: string) {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: text ? [{ type: "text", text }] : [],
      stopReason,
      errorMessage,
    },
  };
}

describe("target-owned turn lifecycle reducer", () => {
  test("refuses a new epoch until the prior authoritative settlement", () => {
    const target = record();
    expect(() =>
      reduceTurnLifecycle(target, { type: "install", message: "too soon", timestamp: 2 }),
    ).toThrow("still owns active turn epoch 1");

    event(target, { type: "agent_start" });
    const completionEventId = "completion_0123456789abcdef0123456789abcdef";
    const old = event(target, {
      type: "agent_settled",
      completion_event_id: completionEventId,
    }, 3).settled!;
    expect(old.completionEventId).toBe(completionEventId);
    const next = reduceTurnLifecycle(target, {
      type: "install",
      message: "next",
      timestamp: 4,
    }).installed!;
    expect(next.epoch).toBeGreaterThan(old.epoch);

    const delayedOld = event(
      target,
      { type: "agent_settled" },
      5,
      old.epoch,
    );
    expect(delayedOld.ignored).toBe(true);
    expect(
      reduceTurnLifecycle(target, {
        type: "prompt_accepted",
        epoch: old.epoch,
      }).ignored,
    ).toBe(true);
    expect(event(target, { type: "agent_start" }, 6, old.epoch).ignored).toBe(true);
    expect(event(target, assistant("stale"), 7, old.epoch).ignored).toBe(true);
    expect(event(target, { type: "agent_end", willRetry: false }, 8, old.epoch).ignored).toBe(true);
    expect(target.activeTurn).toBe(next);
    expect(target.activeTurn!.acceptance).toBe("submitting");
    expect(target.turnState).toBe("running");
  });

  test("accepts a fresh agent_start after a provider retry without admitting same-attempt duplicates", () => {
    const target = record();
    expect(event(target, { type: "agent_start" }).protocolViolation).toBeUndefined();
    expect(event(target, { type: "agent_start" }).protocolViolation).toContain(
      "Duplicate agent_start",
    );

    const retried = record();
    event(retried, { type: "agent_start" });
    event(retried, assistant("transient", "error", "transport failed"));
    event(retried, { type: "agent_end", willRetry: true });
    expect(event(retried, { type: "agent_start" }).protocolViolation).toBeUndefined();
    event(retried, assistant("recovered"));
    event(retried, { type: "agent_end", willRetry: false });
    expect(event(retried, { type: "agent_settled" }).settled).toMatchObject({
      outcome: "completed",
      output: "recovered",
    });
  });

  test("natural assistant completion wins before or after interrupt intent", () => {
    for (const terminalFirst of [true, false]) {
      const target = record();
      event(target, { type: "agent_start" });
      const epoch = target.activeTurn!.epoch;
      if (terminalFirst) event(target, assistant("done"));
      reduceTurnLifecycle(target, { type: "interrupt_requested", epoch });
      if (!terminalFirst) event(target, assistant("done"));
      expect(event(target, { type: "agent_settled" }, 3).pendingSettlement).toBe(true);
      const result = reduceTurnLifecycle(target, {
        type: "interrupt_rejected",
        epoch,
        acceptance: "rejected",
        timestamp: 4,
      });
      expect(result.settled?.outcome).toBe("completed");
      expect(target.status).toBe("completed");
    }
  });

  test("correlated abort settlement without a terminal assistant is interrupted in either order", () => {
    for (const settlementFirst of [false, true]) {
      const target = record();
      event(target, { type: "agent_start" });
      const epoch = target.activeTurn!.epoch;
      reduceTurnLifecycle(target, { type: "interrupt_requested", epoch });
      let result;
      if (settlementFirst) {
        expect(event(target, { type: "agent_settled" }).pendingSettlement).toBe(true);
        result = reduceTurnLifecycle(target, { type: "interrupt_accepted", epoch });
      } else {
        reduceTurnLifecycle(target, { type: "interrupt_accepted", epoch });
        result = event(target, { type: "agent_settled" });
      }
      expect(result.settled?.outcome).toBe("interrupted");
      expect(target.reusable).toBe(true);
    }
  });

  test("empty natural agent_end wins over an accepted interrupt", () => {
    const target = record();
    event(target, { type: "agent_start" });
    const epoch = target.activeTurn!.epoch;
    reduceTurnLifecycle(target, { type: "interrupt_requested", epoch });
    reduceTurnLifecycle(target, { type: "interrupt_accepted", epoch });
    event(target, { type: "agent_end", messages: [], willRetry: false });
    const result = event(target, { type: "agent_settled" });
    expect(result.settled?.outcome).toBe("completed");
    expect(result.settled?.output).toBe("");
  });

  test("a rejected interrupt intent alone cannot manufacture interruption", () => {
    const target = record();
    event(target, { type: "agent_start" });
    const epoch = target.activeTurn!.epoch;
    reduceTurnLifecycle(target, { type: "interrupt_requested", epoch });
    expect(event(target, { type: "agent_settled" }).pendingSettlement).toBe(true);
    const result = reduceTurnLifecycle(target, {
      type: "interrupt_rejected",
      epoch,
      acceptance: "rejected",
      timestamp: 3,
    });
    expect(result.settled?.outcome).toBe("completed");
  });

  test("consumes settlement and active capacity exactly once", () => {
    const target = record();
    event(target, { type: "agent_start" });
    const first = event(target, { type: "agent_settled" });
    const duplicate = event(target, { type: "agent_settled" }, 3);
    expect(first.releasedActiveSlot).toBe(true);
    expect(duplicate).toMatchObject({ duplicateSettlement: true, ignored: true });
    expect(target.activeSlotHeld).toBe(false);
    expect(target.settledTurnIds.size).toBe(1);
  });

  test("rejects unsolicited start and settlement-before-start without taking capacity", () => {
    const target = record();
    event(target, { type: "agent_start" });
    event(target, { type: "agent_settled" });
    const lateStart = event(target, { type: "agent_start" });
    expect(lateStart.ignored).toBe(true);
    expect(target.activeSlotHeld).toBe(false);

    const second = record();
    const earlySettlement = event(second, { type: "agent_settled" });
    expect(earlySettlement.protocolViolation).toContain("before agent_start");
    expect(second.transportTainted).toBe(true);
    expect(second.activeSlotHeld).toBe(true);
  });

  test("latest empty successful terminal clears stale text and transient error", () => {
    const target = record();
    event(target, { type: "agent_start" });
    event(target, assistant("stale intermediate"));
    event(target, assistant("", "error", "transient"));
    event(target, assistant(""));
    const result = event(target, { type: "agent_settled" });
    expect(result.settled).toMatchObject({ outcome: "completed", output: "" });
    expect(target.finalOutput).toBe("");
    expect(target.assistantError).toBeUndefined();
  });

  test("crash is terminal in both settlement orders and releases capacity once", () => {
    for (const crashFirst of [true, false]) {
      const target = record();
      event(target, { type: "agent_start" });
      let settlementRelease = false;
      if (crashFirst) {
        reduceTurnLifecycle(target, {
          type: "crash",
          error: "transport crashed",
          timestamp: 3,
        });
      } else {
        settlementRelease = event(target, { type: "agent_settled" }, 3)
          .releasedActiveSlot === true;
        reduceTurnLifecycle(target, {
          type: "crash",
          error: "transport crashed",
          timestamp: 4,
        });
      }

      const lateSettlement = event(target, { type: "agent_settled" }, 5);
      expect(lateSettlement.ignored).toBe(true);
      expect(target.status).toBe("failed");
      expect(target.turnOutcome).toBe("errored");
      expect(target.reusable).toBe(false);
      expect(target.processState).toBe("stopping");
      expect(target.activeSlotHeld).toBe(!settlementRelease);

      const cleanup = reduceTurnLifecycle(target, {
        type: "crash_cleanup_completed",
        lifecycleEpoch: target.lifecycleEpoch,
        timestamp: 6,
      });
      expect(cleanup.releasedActiveSlot).toBe(!settlementRelease);
      expect(target.status).toBe("failed");
      expect(target.turnOutcome).toBe("errored");
      expect(target.activeSlotHeld).toBe(false);
      expect(target.persistentSlotHeld).toBe(false);
    }
  });

  test("unknown abort settlement without a natural terminal is quarantined in both orders under stress", () => {
    for (let iteration = 0; iteration < 500; iteration += 1) {
      const settlementFirst = iteration % 2 === 0;
      const target = record();
      event(target, { type: "agent_start" });
      const epoch = target.activeTurn!.epoch;
      reduceTurnLifecycle(target, { type: "interrupt_requested", epoch });
      let result;
      if (settlementFirst) {
        expect(event(target, { type: "agent_settled" }, 3).pendingSettlement).toBe(true);
        result = reduceTurnLifecycle(target, {
          type: "interrupt_rejected",
          epoch,
          acceptance: "unknown",
          timestamp: 4,
        });
      } else {
        reduceTurnLifecycle(target, {
          type: "interrupt_rejected",
          epoch,
          acceptance: "unknown",
          timestamp: 3,
        });
        result = event(target, { type: "agent_settled" }, 4);
      }
      expect(result.settled).toBeUndefined();
      expect(result.pendingSettlement).toBe(true);
      expect(target.activeTurn!.state).toBe("active");
      expect(target.transportTainted).toBe(true);
      expect(target.reusable).toBe(false);
      expect(target.turnOutcome).toBe("none");

      reduceTurnLifecycle(target, {
        type: "crash",
        error: "uncertain abort transport",
        timestamp: 5,
      });
      expect(event(target, { type: "agent_settled" }, 6).ignored).toBe(true);
      expect(target.status).toBe("failed");
      expect(target.turnOutcome).toBe("errored");
    }
  });

  test("bounds settled-turn replay history across long-lived reuse", () => {
    const target = record();
    for (let index = 1; index <= 10_000; index++)
      rememberSettledTurnId(target, `turn_${index.toString().padStart(5, "0")}`);
    expect(target.settledTurnIds.size).toBe(256);
    expect(target.settledTurnIds.has("turn_00001")).toBe(false);
    expect(target.settledTurnIds.has("turn_10000")).toBe(true);
  });

  test("close and settlement order is deterministic", () => {
    const closeFirst = record();
    event(closeFirst, { type: "agent_start" });
    reduceTurnLifecycle(closeFirst, { type: "close", reason: "close", timestamp: 3 });
    expect(closeFirst.activeSlotHeld).toBe(true);
    expect(closeFirst.persistentSlotHeld).toBe(true);
    expect(event(closeFirst, { type: "agent_settled" }, 4).ignored).toBe(true);
    expect(closeFirst.settledTurnIds.size).toBe(0);

    const settleFirst = record();
    event(settleFirst, { type: "agent_start" });
    const settlement = event(settleFirst, { type: "agent_settled" }, 3);
    expect(settlement.settled?.id).toBe("turn_0001");
    reduceTurnLifecycle(settleFirst, { type: "close", reason: "close", timestamp: 4 });
    expect(settleFirst.settledTurnIds).toContain("turn_0001");
  });
});
