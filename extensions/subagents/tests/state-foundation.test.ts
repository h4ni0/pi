import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { taskEnvelope } from "../prompts.ts";
import { pushEventSummary } from "../runtime/records.ts";
import { createSubagentRuntimeState } from "../runtime/state.ts";
import {
  createHistoricalSubagentRecord,
  createLiveSubagentRecord,
  createMailboxItem,
} from "../runtime/turn-controller.ts";
import { DEFAULT_SETTINGS } from "../settings.ts";
import type { AgentSnapshot, MailboxItem } from "../types.ts";

const baseRecord = {
  id: "sa_test",
  generatedLabel: "worker",
  taskName: "worker",
  agentName: "/root/worker",
  parentId: "root-session",
  rootId: "root-session",
  depth: 1,
  maxDepth: 2,
  message: "initial task",
  sessionDir: "/tmp/subagents-state-test",
  createdAt: 123,
} as const;

describe("runtime state factory", () => {
  test("initializes every process-local foundation field and pins invocation", () => {
    const invocationBase = {
      command: "/trusted/pi",
      prefixArgs: ["--fixed"],
    };
    const state = createSubagentRuntimeState({
      pi: {} as ExtensionAPI,
      settings: { ...DEFAULT_SETTINGS },
      currentDepth: 1,
      envMaxDepth: 2,
      extensionPath: "/extension/index.ts",
      currentPath: "/root/worker",
      guardToken: {},
      invocationBase,
    });

    expect(state.active).toBeInstanceOf(Map);
    expect(state.active.size).toBe(0);
    expect(state.invocationBase).toBe(invocationBase);
    expect(state.parentAnswerQueue).toBeInstanceOf(Promise);
    expect(state.selfInboxChain).toBeInstanceOf(Promise);
    expect(state.completionBurstBytes).toBe(0);
    expect(state.completionBurstEpoch).toBe(0);
    expect(state.shutdownPromise).toBeUndefined();
    expect(state.currentDepth).toBe(1);
    expect(state.envMaxDepth).toBe(2);
    expect(state.envMaxDepthExplicit).toBe(true);
    expect(state.isChild).toBe(true);
    expect(state.projectTrusted).toBe(false);
    expect(state.closing).toBe(false);
  });
});

describe("record factories", () => {
  test("constructs v2 and legacy live records with mode-specific invariants", () => {
    const v2 = createLiveSubagentRecord({
      ...baseRecord,
      mode: "v2",
      forkTurns: "all",
    });
    const legacy = createLiveSubagentRecord({
      ...baseRecord,
      id: "sa_legacy",
      taskName: "legacy_test",
      agentName: "/root/legacy_test",
      mode: "legacy",
      contextMode: "compact",
    });

    for (const record of [v2, legacy]) {
      expect(record.lifecycleEpoch).toBe(1);
      expect(record.nextMailboxSeq).toBe(1);
      expect(record.nextTurnEpoch).toBe(2);
      expect(record.currentTurnId).toBe("turn_0001");
      expect(record.turnCount).toBe(1);
      expect(record.mailbox).toEqual([]);
      expect(record.completionOutbox).toBeInstanceOf(Map);
      expect(record.completionOutbox.size).toBe(0);
      expect(record.operationChain).toBeInstanceOf(Promise);
      expect(record.turnCompletion?.promise).toBeInstanceOf(Promise);
      expect(record.settlementAck?.promise).toBeInstanceOf(Promise);
      expect(record.shutdownPromise).toBeUndefined();
      expect(record.lifecycleAbort.signal.aborted).toBe(false);
    }

    expect(v2.mode).toBe("v2");
    expect(v2.forkTurns).toBe("all");
    expect(v2.contextMode).toBe("fresh");
    expect(v2.persistentSlotHeld).toBe(true);
    expect(legacy.mode).toBe("legacy");
    expect(legacy.forkTurns).toBeUndefined();
    expect(legacy.contextMode).toBe("compact");
    expect(legacy.persistentSlotHeld).toBe(false);
    expect(v2.completionOutbox).not.toBe(legacy.completionOutbox);
  });

  test("constructs historical records as inert, closed history", () => {
    const snapshot: AgentSnapshot = {
      agent_id: "sa_history",
      agent_name: "/root/history",
      task_name: "history",
      agent_status: { completed: null },
      depth: 1,
      max_depth: 2,
      context: "fresh",
      reusable: true,
      turn_id: "turn_0007",
      turn_count: 7,
      pending_messages: 3,
      created_at: 100,
      updated_at: 200,
      last_task_message: "last historical task",
      session_file: "/tmp/history.jsonl",
      session_dir: "/tmp/history",
    };
    const historical = createHistoricalSubagentRecord({
      snapshot,
      rootId: "root-session",
      timestamp: 250,
    });

    expect(historical.mode).toBe("historical");
    expect(historical.status).toBe("shutdown");
    expect(historical.processState).toBe("closed");
    expect(historical.turnState).toBe("idle");
    expect(historical.reusable).toBe(false);
    expect(historical.lifecycleAbort.signal.aborted).toBe(true);
    expect(historical.mailbox).toEqual([]);
    expect(historical.nextMailboxSeq).toBe(1);
    expect(historical.nextTurnEpoch).toBe(8);
    expect(historical.completionOutbox.size).toBe(0);
    expect(historical.activeSlotHeld).toBe(false);
    expect(historical.persistentSlotHeld).toBe(false);
    expect(historical.shutdownPromise).toBeUndefined();
  });
});

describe("bounded local record history", () => {
  test("central summary insertion caps ask-parent and compatibility events", () => {
    const record = createLiveSubagentRecord({
      ...baseRecord,
      mode: "v2",
      forkTurns: "all",
    });
    for (let index = 0; index < 1_000; index++)
      pushEventSummary(record, { type: "parent_answer", timestamp: index, text: `${index}` });
    expect(record.events).toHaveLength(240);
    expect(record.events[0]?.text).toBe("760");
    expect(record.events.at(-1)?.text).toBe("999");
  });
});

describe("typed mailbox foundation", () => {
  test("assigns FIFO sequence/event ids and preserves original message bytes", () => {
    const record = createLiveSubagentRecord({
      ...baseRecord,
      mode: "v2",
      forkTurns: "none",
    });
    const original = " \n  preserve\tthese bytes  \n";
    const first = createMailboxItem(record, {
      sender: "/root",
      kind: "MESSAGE",
      message: original,
      triggerTurn: false,
    });
    const second = createMailboxItem(record, {
      sender: "/root",
      kind: "NEW_TASK",
      message: "next task",
      triggerTurn: true,
    });
    const queue: MailboxItem[] = [first, second];

    expect(queue.map((item) => item.seq)).toEqual([1, 2]);
    expect(queue.map((item) => item.eventId)).toEqual([
      "mail_sa_test_00000001",
      "mail_sa_test_00000002",
    ]);
    expect(first.message).toBe(original);
    expect(first.envelope).toBe(
      [
        "Message Type: MESSAGE",
        "Task name: /root/worker",
        "Sender: /root",
        "Payload:",
        original,
      ].join("\n"),
    );
    expect(queue.map((item) => item.envelope)).toEqual([
      first.envelope,
      second.envelope,
    ]);
    expect(record.nextMailboxSeq).toBe(3);
  });

  test("rejects semantic emptiness before consuming a sequence", () => {
    const record = createLiveSubagentRecord({
      ...baseRecord,
      mode: "v2",
      forkTurns: "1",
    });
    expect(() =>
      createMailboxItem(record, {
        sender: "/root",
        kind: "MESSAGE",
        message: " \n\t ",
        triggerTurn: false,
      }),
    ).toThrow("message must be a non-empty string");
    expect(record.nextMailboxSeq).toBe(1);
  });

  test("task envelopes validate without trimming the payload", () => {
    const payload = "  exact payload  \n";
    expect(taskEnvelope("NEW_TASK", "/root/worker", "/root", payload)).toEndWith(
      `Payload:\n${payload}`,
    );
  });
});
