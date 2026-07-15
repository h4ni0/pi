import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CollaborationManager } from "../runtime/collaboration-manager.ts";
import { RpcProcess } from "../rpc-process.ts";
import { createSubagentRuntimeState } from "../runtime/state.ts";
import { createLiveSubagentRecord } from "../runtime/turn-controller.ts";
import { DEFAULT_SETTINGS } from "../settings.ts";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/fake-rpc-child.mjs",
);
const processes: RpcProcess[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(processes.splice(0).map((client) => client.stop()));
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("waitUntil timed out");
    await Bun.sleep(5);
  }
}

function setup(
  childEnv: Record<string, string> = {},
  rpcRequestTimeoutMs = 250,
) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-races-"));
  directories.push(cwd);
  const sessionDir = path.join(cwd, "artifacts");
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".pi", "settings.json"),
    JSON.stringify({
      subagents: {
        sessionDir,
        maxDepth: 2,
        maxPersistentAgents: 4,
        maxConcurrentAgents: 2,
        rpcStartupTimeoutMs: 1_000,
        rpcRequestTimeoutMs,
        rpcShutdownTimeoutMs: 100,
      },
    }),
  );
  const messages: any[] = [];
  const entries: any[] = [];
  const pi = {
    getActiveTools: () => [],
    getAllTools: () => [],
    getThinkingLevel: () => "off",
    sendMessage: (message: any, options: any) => messages.push({ message, options }),
    appendEntry: (customType: string, data: any) => entries.push({ customType, data }),
  } as any;
  const ctx = {
    cwd,
    isProjectTrusted: () => true,
    hasUI: false,
    mode: "rpc",
    model: undefined,
    sessionManager: {
      getSessionId: () => "root-session",
      getSessionFile: () => undefined,
      getSessionDir: () => sessionDir,
      getEntries: () => [],
    },
  } as any;
  const state = createSubagentRuntimeState({
    pi,
    settings: { ...DEFAULT_SETTINGS, sessionDir, rpcRequestTimeoutMs },
    currentDepth: 0,
    envMaxDepth: 2,
    extensionPath: "/extension/index.ts",
    currentPath: "/root",
    guardToken: {},
    invocationBase: { command: process.execPath, prefixArgs: [] },
  });
  state.latestCtx = ctx;
  state.projectTrusted = true;
  state.treeMaxResidentAgents = 4;
  state.treeMaxActiveAgents = 2;
  state.broker = {
    endpoint: { socketPath: "/tmp/fake-broker.sock" },
    reserveChild: async (input: any) => ({
      path: `/root/${input.taskName}`,
      capability: "a".repeat(64),
      generation: 1,
    }),
    awaitChildRegistration: async () => undefined,
    commitChildRegistration: async () => undefined,
    abortChildRegistration: async () => undefined,
    releaseReservation: async () => undefined,
    updateAgent: async () => undefined,
    list: async () => ({
      agents: [
        { agent_name: "/root", agent_status: "running", last_task_message: "Main thread" },
        ...[...state.active.values()].map((record) => ({
          agent_name: record.agentName,
          agent_status: record.status === "completed"
            ? { completed: record.finalOutput || null }
            : "running",
          last_task_message: record.lastTaskMessage,
        })),
      ],
    }),
    close: async () => undefined,
  } as any;
  const manager = new CollaborationManager(state, (_command, _args, options) => {
    const client = new RpcProcess(process.execPath, [fixture], {
      ...options,
      env: { ...options.env, ...childEnv },
    });
    const stopRejectCount = Number(childEnv.TEST_STOP_REJECT_COUNT ??
      (childEnv.TEST_STOP_REJECT_ONCE === "1" ? "1" : "0"));
    if (stopRejectCount > 0) {
      const realStop = client.stop.bind(client);
      let attempts = 0;
      client.stop = (() => {
        if (attempts++ < stopRejectCount)
          return Promise.reject(new Error("fixture process survived SIGKILL"));
        return realStop();
      }) as typeof client.stop;
    }
    processes.push(client);
    return client;
  });
  state.manager = manager;
  return { manager, state, ctx, messages, entries };
}

describe("CollaborationManager lifecycle races", () => {
  test("broker disconnect cleanup closes and archives the exact live generation", async () => {
    const { manager, state, ctx } = setup();
    const spawned = await manager.spawnAgent(
      { task_name: "disconnected", message: "normal", fork_turns: "none" },
      undefined,
      ctx,
    );
    const record = state.active.get(spawned.agent_id)!;
    await manager.handleBrokerDispatch({
      op: "disconnect_cleanup",
      payload: {
        targetId: record.id,
        targetPath: record.agentName,
        connectionGeneration: record.brokerGeneration,
      },
    });
    expect(record.processState).toBe("closed");
    expect(state.active.has(record.id)).toBe(false);
    expect(state.reloadRecords.get(record.id)).toBe(record);
    await manager.shutdown();
  });

  test("bounds broker status output while retaining the full local turn output", async () => {
    const { manager, state } = setup();
    let update: any;
    (state.broker as any).updateAgent = async (_target: string, value: any) => {
      update = value;
    };
    const record = createLiveSubagentRecord({
      id: "sa_large_output",
      generatedLabel: "large_output",
      taskName: "large_output",
      agentName: "/root/large_output",
      mode: "v2",
      forkTurns: "none",
      parentId: "root-session",
      rootId: "root-session",
      depth: 1,
      maxDepth: 2,
      message: "large",
      sessionDir: "/tmp/large_output",
      createdAt: 1,
    });
    record.committed = true;
    record.processState = "alive";
    record.finalOutput = "x".repeat(100_000);
    await (manager as any).syncBrokerRecord(record, false);
    expect(Buffer.byteLength(update.lastOutput, "utf8")).toBeLessThanOrEqual(24 * 1024);
    expect(record.finalOutput).toHaveLength(100_000);
    await manager.shutdown();
  });

  test("retains controller reload metadata until broker outbox clearance", async () => {
    const { manager, state } = setup();
    const makeRecord = (index: number, pending = false) => {
      const record = createLiveSubagentRecord({
        id: `sa_retained_${index}`,
        generatedLabel: `retained_${index}`,
        taskName: `retained_${index}`,
        agentName: `/root/retained_${index}`,
        mode: "v2",
        forkTurns: "none",
        parentId: "root-session",
        rootId: "root-session",
        depth: 1,
        maxDepth: 2,
        message: "retained",
        sessionDir: `/tmp/retained_${index}`,
        createdAt: index,
      });
      record.committed = true;
      record.processState = "closed";
      record.updatedAt = index;
      if (pending) record.brokerPendingCompletionEventIds.add("completion_pending");
      return record;
    };
    const protectedRecord = makeRecord(0, true);
    (manager as any).archiveRecord(protectedRecord);
    for (let index = 1; index <= 1_024; index++)
      (manager as any).archiveRecord(makeRecord(index));
    expect(state.reloadRecords.has(protectedRecord.id)).toBe(true);
    expect(state.reloadRecords.size).toBe(1_024);

    await manager.handleBrokerDispatch({
      op: "outbox_cleared",
      payload: {
        targetId: protectedRecord.id,
        targetPath: protectedRecord.agentName,
        eventId: "completion_pending",
      },
    });
    (manager as any).archiveRecord(makeRecord(1_025));
    expect(state.reloadRecords.has(protectedRecord.id)).toBe(false);
    expect(state.reloadRecords.size).toBe(1_024);
    await manager.shutdown();
  });

  test("settlement status/publication is visible before stalled diagnostics", async () => {
    const { manager, state, ctx, messages } = setup();
    const spawned = await manager.spawnAgent(
      {
        task_name: "diagnostics",
        message: "__stall_diagnostics__",
        fork_turns: "none",
      },
      undefined,
      ctx,
    );
    const record = state.active.get(spawned.agent_id)!;
    await waitUntil(() => record.status === "completed", 300);
    expect(record.status).toBe("completed");
    expect(record.activeSlotHeld).toBe(false);
    expect(record.reusable).toBe(true);
    expect(messages).toHaveLength(0);
    await manager.shutdown();
  });

  test("a later empty successful terminal cannot reuse intermediate text", async () => {
    const { manager, state, ctx, messages } = setup();
    const spawned = await manager.spawnAgent(
      {
        task_name: "empty",
        message: "__empty_terminal__",
        fork_turns: "none",
      },
      undefined,
      ctx,
    );
    const record = state.active.get(spawned.agent_id)!;
    await waitUntil(() => record.status === "completed");
    expect(record.finalOutput).toBe("");
    expect((await manager.listAgents()).agents.find((item) => item.agent_name === record.agentName)?.agent_status)
      .toEqual({ completed: null });
    expect(messages).toHaveLength(0);
    expect(fs.existsSync(path.join(record.sessionDir!, "turns", "0001-final.md"))).toBe(false);
    await manager.shutdown();
  });

  test("interrupt returns on abort acceptance and delayed old settlement cannot settle a follow-up", async () => {
    const { manager, state, ctx } = setup({
      FAKE_SETTLE_DELAY_MS: "500",
      FAKE_ABORT_SETTLE_DELAY_MS: "120",
    }, 300);
    const spawned = await manager.spawnAgent(
      { task_name: "interrupt_race", message: "long", fork_turns: "none" },
      undefined,
      ctx,
    );
    const record = state.active.get(spawned.agent_id)!;
    const started = Date.now();
    const interrupted = await manager.interruptAgent(record.id);
    expect(Date.now() - started).toBeLessThan(100);
    expect(interrupted.previous_status).toBe("running");

    const steered = await manager.followupTask(record.id, "must remain old epoch");
    expect(steered.delivery).toBe("steer");
    expect(steered.turn_id).toBe("turn_0001");
    expect(record.turnCount).toBe(1);
    await waitUntil(() => record.status === "interrupted");

    const next = await manager.followupTask(record.id, "new epoch");
    expect(next.delivery).toBe("prompt");
    expect(next.turn_id).toBe("turn_0002");
    expect(record.turnState).toBe("running");
    await waitUntil(() => record.status === "completed", 1_000);
    expect(record.turnCount).toBe(2);
    await manager.shutdown();
  });

  test("missing abort settlement taints and closes instead of reusing isStreaming false", async () => {
    const { manager, state, ctx } = setup({
      FAKE_SETTLE_DELAY_MS: "500",
      FAKE_DROP_ABORT_SETTLEMENT: "1",
    }, 80);
    const spawned = await manager.spawnAgent(
      { task_name: "missing", message: "long", fork_turns: "none" },
      undefined,
      ctx,
    );
    const record = state.active.get(spawned.agent_id)!;
    await manager.interruptAgent(record.id);
    await waitUntil(() => record.processState === "crashed", 2_500);
    expect(record.transportTainted).toBe(true);
    expect(record.reusable).toBe(false);
    expect(record.activeSlotHeld).toBe(false);
    await manager.shutdown();
  });

  test("production marker ingress quarantines stale lifecycle replay without settling a newer turn", async () => {
    const { manager, state, ctx, messages } = setup({
      FAKE_LIFECYCLE_MARKERS: "1",
      FAKE_STALE_REPLAY_DELAY_MS: "80",
      FAKE_CURRENT_TERMINAL_DELAY_MS: "35",
      FAKE_CURRENT_SETTLE_DELAY_MS: "180",
    });
    const spawned = await manager.spawnAgent(
      { task_name: "replay", message: "__stale_replay__ __duplicate_settlement__", fork_turns: "none" },
      undefined,
      ctx,
    );
    const record = state.active.get(spawned.agent_id)!;
    await waitUntil(() => record.status === "completed");
    await Bun.sleep(15);
    expect(messages).toHaveLength(0);
    expect(record.settledTurnIds.size).toBe(1);
    const oldToken = record.activeTurn!.token;
    const followup = await manager.followupTask(record.id, "__slow_settlement__");
    expect(followup.turn_id).toBe("turn_0002");
    expect(record.activeTurn!.token).not.toBe(oldToken);
    await Bun.sleep(115);
    expect(record.turnState).toBe("running");
    expect(record.activeSlotHeld).toBe(true);
    expect(record.activeTurn!.terminalSeen).toBe(true);
    expect(record.activeTurn!.naturalEndSeen).toBe(true);
    expect(record.activeTurn!.output).toBe("current turn output");
    expect(record.finalOutput).toBe("current turn output");
    expect(record.transportTainted).toBe(false);
    expect(record.lifecycleSequences.size).toBeLessThanOrEqual(2);
    expect(messages).toHaveLength(0);
    await waitUntil(() => record.status === "completed");
    expect(messages).toHaveLength(0);
    await manager.shutdown();
  });

  test("abort acceptance is not speculative and natural completion wins delayed success", async () => {
    const { manager, state, ctx } = setup({
      FAKE_SETTLE_DELAY_MS: "25",
      FAKE_ABORT_RESPONSE_DELAY_MS: "100",
    }, 250);
    const spawned = await manager.spawnAgent(
      { task_name: "abort_order", message: "natural", fork_turns: "none" },
      undefined,
      ctx,
    );
    const record = state.active.get(spawned.agent_id)!;
    const interrupt = manager.interruptAgent(record.id);
    await Bun.sleep(50);
    expect(record.activeTurn!.abortAccepted).toBe(false);
    expect(record.activeTurn!.pendingSettlementAt).toBeNumber();
    await interrupt;
    await waitUntil(() => record.status === "completed");
    expect(record.turnOutcome).toBe("completed");
    await manager.shutdown();
  });

  test("abort rejection and timeout never manufacture interruption", async () => {
    const childEnvs: Record<string, string>[] = [
      { FAKE_SETTLE_DELAY_MS: "20", FAKE_ABORT_RESPONSE_DELAY_MS: "70", FAKE_ABORT_FAIL: "1" },
      { FAKE_SETTLE_DELAY_MS: "20", FAKE_ABORT_STALL: "1" },
    ];
    for (const childEnv of childEnvs) {
      const { manager, state, ctx } = setup(childEnv, 80);
      const spawned = await manager.spawnAgent(
        { task_name: `abort_${childEnv.FAKE_ABORT_FAIL ? "fail" : "timeout"}`, message: "natural", fork_turns: "none" },
        undefined,
        ctx,
      );
      const record = state.active.get(spawned.agent_id)!;
      await expect(manager.interruptAgent(record.id)).rejects.toThrow("Interrupt failed");
      expect(record.activeTurn!.abortAccepted).toBe(false);
      expect(record.turnOutcome).toBe("completed");
      expect(record.processState).toBe("alive");
      await manager.shutdown();
    }
  });

  test("unknown abort plus settlement-only evidence is tainted in both parser orders", async () => {
    // Project settings clamp request timeouts to 1s, so keep the fixture's
    // natural terminal well beyond that boundary and place settlement-only
    // evidence decisively on each side of the timeout.
    for (const settlementDelayMs of [20, 1300]) {
      const { manager, state, ctx } = setup({
        FAKE_SETTLE_DELAY_MS: "5000",
        FAKE_ABORT_STALL: "1",
        FAKE_ABORT_SETTLEMENT_ONLY_DELAY_MS: String(settlementDelayMs),
      }, 50);
      const spawned = await manager.spawnAgent(
        {
          task_name: `unknown_abort_${settlementDelayMs}`,
          message: "no natural terminal",
          fork_turns: "none",
        },
        undefined,
        ctx,
      );
      const record = state.active.get(spawned.agent_id)!;
      await expect(manager.interruptAgent(record.id)).rejects.toThrow("Interrupt failed");
      await waitUntil(() => record.processState === "crashed").catch((error) => {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}: delay=${settlementDelayMs}, process=${record.processState}, status=${record.status}, crashHandled=${record.crashHandled}, cleanup=${record.cleanupError ?? "none"}`,
        );
      });
      expect(record.activeTurn!.abortAccepted).toBe(false);
      expect(record.transportTainted).toBe(true);
      expect(record.reusable).toBe(false);
      expect(record.status).toBe("failed");
      expect(record.turnOutcome).toBe("errored");
      expect(record.activeSlotHeld).toBe(false);
      expect(record.persistentSlotHeld).toBe(false);
      await manager.shutdown();
    }
  });

  test("final agent_end without settlement taints and closes", async () => {
    const { manager, state, ctx } = setup();
    const spawned = await manager.spawnAgent(
      { task_name: "missing_natural", message: "__no_output__ __missing_settlement__", fork_turns: "none" },
      undefined,
      ctx,
    );
    const record = state.active.get(spawned.agent_id)!;
    await waitUntil(() => record.processState === "crashed", 2_500);
    expect(record.transportTainted).toBe(true);
    expect(record.reusable).toBe(false);
    expect(record.persistentSlotHeld).toBe(false);
    await manager.shutdown();
  });

  test("duplicate start is fatal before commit and deterministic around prompt acknowledgement", async () => {
    {
      const { manager, state, ctx } = setup();
      await expect(manager.spawnAgent(
        { task_name: "bad_startup", message: "__duplicate_start_precommit__", fork_turns: "none" },
        undefined,
        ctx,
      )).rejects.toThrow("Duplicate agent_start");
      expect(state.active.size).toBe(0);
    }

    // The old fixture wrote response/start/start back-to-back, so pipe chunking
    // nondeterministically decided whether followupTask observed acceptance or
    // the fatal event first. Exercise each wire order explicitly and repeatedly.
    for (let iteration = 0; iteration < 8; iteration += 1) {
      const beforeAck = iteration % 2 === 0;
      const { manager, state, ctx } = setup({
        FAKE_POST_ACK_EVENT_DELAY_MS: "15",
      });
      const spawned = await manager.spawnAgent(
        {
          task_name: `bad_committed_${iteration}`,
          message: "normal",
          fork_turns: "none",
        },
        undefined,
        ctx,
      );
      const record = state.active.get(spawned.agent_id)!;
      await waitUntil(() => record.status === "completed");
      const followup = manager.followupTask(
        record.id,
        beforeAck
          ? "__duplicate_start_before_ack__"
          : "__duplicate_start_after_ack__",
      );
      if (beforeAck) await expect(followup).rejects.toThrow();
      else expect((await followup).delivery).toBe("prompt");
      await waitUntil(() => record.processState === "crashed");
      expect(record.transportTainted).toBe(true);
      expect(record.status).toBe("failed");
      expect(record.activeSlotHeld).toBe(false);
      await manager.shutdown();
    }
  });

  test("retry boundary clears transient assistant and extension errors", async () => {
    const { manager, state, ctx, messages } = setup();
    const spawned = await manager.spawnAgent(
      { task_name: "retry", message: "__retry_success__", fork_turns: "none" },
      undefined,
      ctx,
    );
    const record = state.active.get(spawned.agent_id)!;
    await waitUntil(() => record.status === "completed");
    expect(record.finalOutput).toBe("recovered answer");
    expect(record.error).toBeUndefined();
    expect(record.activeTurn!.retryAttempt).toBe(1);
    expect(record.activeTurn!.transientErrors).toHaveLength(1);
    expect(messages).toHaveLength(0);
    await manager.shutdown();
  });

  test("successful empty retry terminal clears every transient error", async () => {
    const { manager, state, ctx } = setup();
    const spawned = await manager.spawnAgent(
      { task_name: "retry_empty", message: "__retry_empty_success__", fork_turns: "none" },
      undefined,
      ctx,
    );
    const record = state.active.get(spawned.agent_id)!;
    await waitUntil(() => record.status === "completed");
    expect(record.finalOutput).toBe("");
    expect(record.error).toBeUndefined();
    expect((await manager.listAgents()).agents.find((item) => item.agent_name === record.agentName)?.agent_status)
      .toEqual({ completed: null });
    await manager.shutdown();
  });

  test("close suppresses blocked prompt and abort commits", async () => {
    {
      const { manager, state, ctx } = setup({ FAKE_LATE_RESPONSE_MS: "120" }, 250);
      const spawned = await manager.spawnAgent(
        { task_name: "blocked_prompt", message: "normal", fork_turns: "none" },
        undefined,
        ctx,
      );
      const record = state.active.get(spawned.agent_id)!;
      await waitUntil(() => record.status === "completed");
      const prompt = manager.followupTask(record.id, "__late_response__");
      await Bun.sleep(20);
      const close = manager.closeAgent(record, "close blocked prompt", true);
      await expect(prompt).rejects.toThrow();
      await close;
      expect(record.processState).toBe("closed");
      expect(record.turnCount).toBe(2);
    }
    {
      const { manager, state, ctx } = setup({
        FAKE_SETTLE_DELAY_MS: "500",
        FAKE_ABORT_RESPONSE_DELAY_MS: "120",
      }, 250);
      const spawned = await manager.spawnAgent(
        { task_name: "blocked_abort", message: "long", fork_turns: "none" },
        undefined,
        ctx,
      );
      const record = state.active.get(spawned.agent_id)!;
      const interrupt = manager.interruptAgent(record.id);
      await Bun.sleep(20);
      const close = manager.closeAgent(record, "close blocked abort", true);
      await expect(interrupt).rejects.toThrow();
      await close;
      expect(record.processState).toBe("closed");
      expect(record.activeTurn!.abortAccepted).toBe(false);
    }
  });

  test("close suppresses a blocked steer commit and false success", async () => {
    const { manager, state, ctx } = setup({
      FAKE_SETTLE_DELAY_MS: "500",
      FAKE_STEER_RESPONSE_DELAY_MS: "120",
    }, 250);
    const spawned = await manager.spawnAgent(
      { task_name: "blocked_steer", message: "long", fork_turns: "none" },
      undefined,
      ctx,
    );
    const record = state.active.get(spawned.agent_id)!;
    const send = manager.sendMessage(record.id, "blocked message");
    await Bun.sleep(20);
    const close = manager.closeAgent(record, "test close", true);
    await expect(send).rejects.toThrow("stale");
    await close;
    expect(record.events.some((event) => event.type === "parent_message")).toBe(false);
    expect(record.processState).toBe("closed");
  });

  test("provisional rollback retains its reservation when stop is unconfirmed", async () => {
    const { manager, state, ctx } = setup({ TEST_STOP_REJECT_COUNT: "2" });
    await expect(manager.spawnAgent(
      { task_name: "rollback_survivor", message: "__duplicate_start_precommit__", fork_turns: "none" },
      undefined,
      ctx,
    )).rejects.toThrow("cleanup is unconfirmed");
    expect(state.active.size).toBe(1);
    const record = [...state.active.values()][0];
    expect(record.processState).toBe("stopping");
    expect(record.pid).toBeNumber();
    expect(record.persistentSlotHeld).toBe(true);
    expect(record.activeSlotHeld).toBe(true);
  });

  test("unconfirmed stop keeps ownership until an idempotent shutdown retry succeeds", async () => {
    const { manager, state, ctx } = setup({ TEST_STOP_REJECT_ONCE: "1" });
    const spawned = await manager.spawnAgent(
      { task_name: "survivor", message: "normal", fork_turns: "none" },
      undefined,
      ctx,
    );
    const record = state.active.get(spawned.agent_id)!;
    const pid = record.pid;
    const first = manager.closeAgent(record, "cannot stop", true);
    const second = manager.closeAgent(record, "cannot stop", true);
    expect(second).toBe(first);
    await expect(first).rejects.toThrow("survived SIGKILL");
    expect(record.processState).toBe("stopping");
    expect(record.pid).toBe(pid);
    expect(record.persistentSlotHeld).toBe(true);
    expect(record.activeSlotHeld).toBe(true);
    expect(state.active.get(record.id)).toBe(record);
    const shutdown = manager.shutdown();
    expect(manager.shutdown()).toBe(shutdown);
    await shutdown;
    expect(state.active.has(record.id)).toBe(false);
    expect(record.processState).toBe("closed");
    expect(record.persistentSlotHeld).toBe(false);
    expect(record.activeSlotHeld).toBe(false);
  });

  test("close wins before settlement, concurrent shutdown shares one promise, and late events cannot publish", async () => {
    const { manager, state, ctx, messages, entries } = setup({
      FAKE_SETTLE_DELAY_MS: "200",
      FAKE_ABORT_SETTLE_DELAY_MS: "50",
    });
    const spawned = await manager.spawnAgent(
      { task_name: "closing", message: "long", fork_turns: "none" },
      undefined,
      ctx,
    );
    const record = state.active.get(spawned.agent_id)!;
    const beforeEntries = entries.length;
    const first = manager.shutdown();
    const second = manager.shutdown();
    expect(second).toBe(first);
    await first;
    const afterEntries = entries.length;
    await Bun.sleep(250);
    expect(messages).toHaveLength(0);
    expect(record.status).toBe("shutdown");
    expect(fs.existsSync(path.join(record.sessionDir!, "turns"))).toBe(false);
    expect(entries.length).toBe(afterEntries);
    expect(entries.length).toBeGreaterThanOrEqual(beforeEntries);
    expect(state.active.size).toBe(0);
  });
});
