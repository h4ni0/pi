import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { RpcProcess } from "../rpc-process.ts";
import { COMPLETION_MESSAGE_TYPE } from "../constants.ts";
import { taskEnvelope } from "../prompts.ts";
import {
  collaborationToolsForRole,
  isSubagentsTool,
  parseToolListEnv,
} from "../runtime/tool-list.ts";
import { DEFAULT_SETTINGS, loadSettings } from "../settings.ts";
import { Value } from "typebox/value";
import {
  FollowupTaskParams,
  InterruptAgentParams,
  ListAgentsParams,
  SendMessageParams,
  SpawnAgentParams,
  WaitAgentParams,
} from "../schemas.ts";
import {
  createSubagentRuntimeState,
  type SubagentRuntimeState,
} from "../runtime/state.ts";
import { parseSubagentStatusCount } from "../status.ts";
import { createLiveSubagentRecord } from "../runtime/turn-controller.ts";
import { ChildLifecycleTokenController } from "../runtime/lifecycle-protocol.ts";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/fake-rpc-child.mjs",
);
const processes: RpcProcess[] = [];

function fakeProcess(
  env: Record<string, string | undefined> = {},
  requestTimeoutMs = 500,
) {
  const client = new RpcProcess(process.execPath, [fixture], {
    cwd: process.cwd(),
    env,
    startupTimeoutMs: 1_000,
    requestTimeoutMs,
    shutdownTimeoutMs: 250,
  });
  processes.push(client);
  return client;
}

afterEach(async () => {
  await Promise.allSettled(processes.splice(0).map((process) => process.stop()));
});

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("waitUntil timed out");
    await Bun.sleep(10);
  }
}

describe("ChildLifecycleTokenController", () => {
  test("keeps pending and active tokens causally scoped and sequences one turn", () => {
    const controller = new ChildLifecycleTokenController();
    controller.queuePrompt("sa_child.1");
    expect(() => controller.queuePrompt("sa_child.2")).toThrow("pending or active");
    controller.promotePending();
    expect(controller.marker({ type: "agent_start" })).toMatchObject({
      token: "sa_child.1",
      event: "agent_start",
      sequence: 1,
    });
    expect(controller.marker({ type: "agent_settled" })).toMatchObject({
      token: "sa_child.1",
      sequence: 2,
    });
    controller.closeActive();
    expect(() => controller.queuePrompt("sa_child.1")).toThrow("already closed");
    controller.queuePrompt("sa_child.2");
    controller.promotePending();
    expect(controller.marker({ type: "agent_start" }).sequence).toBe(1);
  });
});

async function nextEvent(
  process: RpcProcess,
  type: string,
  timeoutMs = 2_000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timed out waiting for ${type}`));
    }, timeoutMs);
    const off = process.onEvent((event) => {
      if (event.type !== type) return;
      clearTimeout(timer);
      off();
      resolve(event);
    });
  });
}

describe("RpcProcess", () => {
  test("uses a readiness handshake and parses fragmented Unicode LF JSONL", async () => {
    const client = fakeProcess({ FAKE_FRAGMENT: "1" });
    await client.start();
    const settled = nextEvent(client, "agent_settled");
    const message = nextEvent(client, "message_end");
    await client.prompt("fragmented");
    expect((await message).message.content[0].text).toContain("unicode");
    await settled;
    const state = await client.getState();
    expect(state.sessionId).toStartWith("fake-");
  });

  test("prompt acknowledgment precedes authoritative agent_settled", async () => {
    const client = fakeProcess({ FAKE_SETTLE_DELAY_MS: "80" });
    await client.start();
    let settled = false;
    const done = nextEvent(client, "agent_settled").then(() => {
      settled = true;
    });
    await client.prompt("async");
    expect(settled).toBe(false);
    await done;
    expect(settled).toBe(true);
  });

  test("times out stalled requests and reports process crashes", async () => {
    const client = fakeProcess({}, 40);
    await client.start();
    await expect(client.prompt("__stall__")).rejects.toThrow("timed out");
    const exited = nextEvent(client, "process_exit");
    await client.prompt("__crash__");
    expect((await exited).code).toBe(19);
  });

  test("keeps one process/session across multiple prompt turns", async () => {
    const client = fakeProcess();
    await client.start();
    const pid = client.pid;
    const sessionId = (await client.getState()).sessionId;
    let settled = nextEvent(client, "agent_settled");
    await client.prompt("one");
    await settled;
    settled = nextEvent(client, "agent_settled");
    await client.prompt("two");
    await settled;
    expect(client.pid).toBe(pid);
    expect((await client.getState()).sessionId).toBe(sessionId);
  });
});

describe("CollaborationManager fake-RPC lifecycle", () => {
  test("spawns asynchronously, reuses one session, queues idle mail, notifies, and interrupts softly", async () => {
    const { CollaborationManager } = await import(
      "../runtime/collaboration-manager.ts"
    );
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-manager-"));
    const sessionDir = path.join(cwd, "artifacts");
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".pi", "settings.json"),
      JSON.stringify({
        subagents: {
          sessionDir,
          maxDepth: 2,
          maxPersistentAgents: 4,
          maxConcurrentAgents: 1,
          rpcStartupTimeoutMs: 1_000,
          rpcRequestTimeoutMs: 1_000,
          rpcShutdownTimeoutMs: 250,
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
      settings: { ...DEFAULT_SETTINGS, sessionDir },
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
      reserveChild: async (input: any) => {
        if ([...state.active.values()].some((record) => record.activeSlotHeld))
          throw new Error("Root-tree active-agent capacity (2) is full");
        return {
          path: `/root/${input.taskName}`,
          capability: "a".repeat(64),
          generation: 1,
        };
      },
      awaitChildRegistration: async () => undefined,
      commitChildRegistration: async () => undefined,
      abortChildRegistration: async () => undefined,
      releaseReservation: async () => undefined,
      updateAgent: async () => undefined,
      reportCrash: async (input: any) => {
        messages.push({
          message: { customType: COMPLETION_MESSAGE_TYPE, details: input.details },
          options: { deliverAs: "steer", triggerTurn: false },
        });
        return { accepted: true, observed: true };
      },
      list: async () => ({
        agents: [
          { agent_name: "/root", agent_status: "running", last_task_message: "Main thread" },
          ...[...state.active.values()].map((record) => ({
            agent_name: record.agentName,
            agent_status: "running",
            last_task_message: record.lastTaskMessage,
          })),
        ],
      }),
      close: async () => undefined,
    } as any;
    const manager = new CollaborationManager(
      state,
      (_command, _args, options) => {
        const client = new RpcProcess(process.execPath, [fixture], {
          ...options,
          env: { ...options.env, FAKE_SETTLE_DELAY_MS: "120" },
        });
        processes.push(client);
        return client;
      },
    );
    state.manager = manager;

    const closingSpawn = manager.spawnAgent(
      { task_name: "startup_close", message: "must not resurrect", fork_turns: "none" },
      undefined,
      ctx,
    );
    await waitUntil(() =>
      [...state.active.values()].some(
        (item) => item.taskName === "startup_close",
      ),
    );
    const provisional = [...state.active.values()].find(
      (item) => item.taskName === "startup_close",
    )!;
    await manager.closeAgent(provisional, "startup close race", true);
    await expect(closingSpawn).rejects.toThrow();
    expect([...state.active.values()].some((item) => item.taskName === "startup_close")).toBe(false);
    expect(messages).toHaveLength(0);

    await expect(
      manager.spawnAgent(
        {
          task_name: "precommit_crash",
          message: "__crash_before_ack__",
          fork_turns: "none",
        },
        undefined,
        ctx,
      ),
    ).rejects.toThrow("exited");
    await Bun.sleep(20);
    expect(messages).toHaveLength(0);
    expect([...state.active.values()].some((item) => item.taskName === "precommit_crash")).toBe(false);

    await expect(
      manager.spawnAgent(
        {
          task_name: "precommit_late_ack",
          message: "__late_ack__",
          fork_turns: "none",
        },
        undefined,
        ctx,
      ),
    ).rejects.toThrow("timed out");
    await Bun.sleep(20);
    expect(messages).toHaveLength(0);
    expect(
      [...state.active.values()].some(
        (item) => item.taskName === "precommit_late_ack",
      ),
    ).toBe(false);

    const spawned = await manager.spawnAgent(
      { task_name: "worker", message: "first", fork_turns: "none" },
      undefined,
      ctx,
    );
    expect(spawned.fork_turns).toBe("none");
    const record = state.active.get(spawned.agent_id)!;
    expect(record.forkTurns).toBe("none");
    const pid = record.client!.pid;
    expect(record.turnState).toBe("running");
    await expect(
      manager.spawnAgent(
        { task_name: "capacity_race", message: "should reject", fork_turns: "none" },
        undefined,
        ctx,
      ),
    ).rejects.toThrow("active-agent capacity");
    expect([...state.active.values()].some((item) => item.taskName === "capacity_race")).toBe(false);
    await waitUntil(() => record.status === "completed");
    expect(messages).toHaveLength(0);

    const queuedFirst = "queued context";
    const queuedSecond = "  queued second \nline  ";
    expect(await manager.sendMessage(record.id, queuedFirst)).toMatchObject({
      delivery: "queued",
      pending_messages: 1,
    });
    expect(await manager.sendMessage(record.id, queuedSecond)).toMatchObject({
      delivery: "queued",
      pending_messages: 2,
    });
    const followupMessage = "second";
    const followup = await manager.followupTask(record.id, followupMessage);
    expect(followup.delivery).toBe("prompt");
    expect(record.client!.pid).toBe(pid);
    await waitUntil(() => record.turnCount === 2 && record.status === "completed");
    const drainedPrompt = [
      taskEnvelope("MESSAGE", record.agentName, "/root", queuedFirst),
      taskEnvelope("MESSAGE", record.agentName, "/root", queuedSecond),
      taskEnvelope("NEW_TASK", record.agentName, "/root", followupMessage),
    ].join("\n\n");
    expect(record.finalOutput).toContain(drainedPrompt);
    expect(messages).toHaveLength(0);
    expect(fs.existsSync(path.join(record.sessionDir!, "turns", "0001-final.md"))).toBe(false);
    expect(fs.existsSync(path.join(record.sessionDir!, "turns", "0002-final.md"))).toBe(false);

    await manager.followupTask(record.id, "__error__");
    await waitUntil(() => record.turnCount === 3 && record.status === "failed");
    expect(messages).toHaveLength(0);
    expect(fs.existsSync(path.join(record.sessionDir!, "turns", "0003-final.md"))).toBe(false);

    await manager.followupTask(record.id, "__retry_success__");
    await waitUntil(() => record.turnCount === 4 && record.status === "completed");
    expect(messages).toHaveLength(0);

    await expect(
      manager.followupTask(record.id, "__late_ack__"),
    ).rejects.toThrow("activity is still tracked");
    await waitUntil(() => record.turnCount === 5 && record.status === "completed");
    expect(record.activeSlotHeld).toBe(false);
    expect(messages).toHaveLength(0);

    const crashedSpawn = await manager.spawnAgent(
      { task_name: "crasher", message: "__crash__", fork_turns: "none" },
      undefined,
      ctx,
    );
    const crashed = state.active.get(crashedSpawn.agent_id)!;
    await waitUntil(() => crashed.processState === "crashed");
    await Bun.sleep(30);
    expect(messages).toHaveLength(1);
    expect(messages.at(-1)?.message?.details?.outcome).toBe("errored");

    const interruptedSpawn = await manager.spawnAgent(
      { task_name: "long_worker", message: "long", fork_turns: "none" },
      undefined,
      ctx,
    );
    const interrupted = state.active.get(interruptedSpawn.agent_id)!;
    const interruptedPid = interrupted.client!.pid;
    const result = await manager.interruptAgent(interrupted.id);
    expect(result.previous_status).toBe("running");
    await waitUntil(() => interrupted.status === "interrupted");
    expect(interrupted.client!.pid).toBe(interruptedPid);
    expect(interrupted.reusable).toBe(true);
    const listed = await manager.listAgents();
    expect(listed.agents[0]?.agent_name).toBe("/root");
    expect(listed.agents[0]?.last_task_message).toBe("Main thread");
    expect(entries.length).toBeGreaterThan(0);

    const closeOnce = manager.closeAgent(
      interrupted,
      "shared close promise test",
      true,
    );
    const closeTwice = manager.closeAgent(
      interrupted,
      "shared close promise test",
      true,
    );
    expect(closeTwice).toBe(closeOnce);
    await closeOnce;

    const shutdownOnce = manager.shutdown();
    const shutdownTwice = manager.shutdown();
    expect(shutdownTwice).toBe(shutdownOnce);
    await shutdownOnce;
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

describe("bounded legacy completion", () => {
  test("hard-bounds metadata-heavy delegate payloads by UTF-8 bytes", async () => {
    const { makeCompletionPayload } = await import("../summaries/completion.ts");
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-payload-"));
    const record = createLiveSubagentRecord({
      id: "sa_test",
      generatedLabel: "legacy",
      taskName: "legacy_test",
      agentName: "/root/legacy_test",
      mode: "legacy",
      parentId: "root-session",
      rootId: "root-session",
      depth: 1,
      maxDepth: 2,
      message: "界".repeat(2_000),
      contextMode: "compact",
      sessionDir: cwd,
    });
    record.status = "completed";
    record.finalOutput = "output ".repeat(2_000);
    const payload = await makeCompletionPayload(
      record,
      undefined,
      { ...DEFAULT_SETTINGS, returnMaxBytes: 1_000 },
    );
    expect(Buffer.byteLength(payload.payload, "utf8")).toBeLessThanOrEqual(1_000);
    expect(fs.existsSync(path.join(cwd, "final-output.md"))).toBe(true);
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

describe("strict collaboration schemas", () => {
  test("reject unknown fields and invalid task/wait shapes", () => {
    expect(
      Value.Check(SpawnAgentParams, {
        task_name: "worker",
        message: "do work",
        extra: true,
      }),
    ).toBe(false);
    expect(
      Value.Check(SpawnAgentParams, {
        task_name: "Not-A-Segment",
        message: "do work",
      }),
    ).toBe(false);
    expect(Value.Check(SendMessageParams, { target: "a", message: "x" })).toBe(true);
    expect(Value.Check(FollowupTaskParams, { target: "a", message: "x" })).toBe(true);
    expect(Value.Check(InterruptAgentParams, { target: "a" })).toBe(true);
    expect(
      Value.Check(WaitAgentParams, { timeout_ms: 9_999 }),
    ).toBe(false);
    expect(Value.Check(ListAgentsParams, { target: "not-allowed" })).toBe(false);
  });
});

describe("depth roles and configuration trust", () => {
  function roleState(depth: number, maxDepth: number): SubagentRuntimeState {
    const state = createSubagentRuntimeState({
      pi: {} as any,
      settings: { ...DEFAULT_SETTINGS, maxDepth },
      currentDepth: depth,
      envMaxDepth: maxDepth,
      extensionPath: "/extension/index.ts",
      currentPath: depth ? "/root/child" : "/root",
      guardToken: {},
      invocationBase: { command: process.execPath, prefixArgs: [] },
    });
    state.projectTrusted = true;
    return state;
  }

  test("preserves Pi depth gate while management remains available", () => {
    expect(collaborationToolsForRole(roleState(0, 2))).toEqual([
      "send_message",
      "followup_task",
      "wait_agent",
      "interrupt_agent",
      "list_agents",
      "spawn_agent",
      "delegate",
    ]);
    expect(collaborationToolsForRole(roleState(2, 2))).toEqual([
      "send_message",
      "followup_task",
      "wait_agent",
      "interrupt_agent",
      "list_agents",
      "ask_parent",
    ]);
  });

  test("retained idle children do not inflate nested active counts", () => {
    expect(
      parseSubagentStatusCount("agents 0/3 running · 3 idle · 2 nested"),
    ).toBe(2);
    expect(parseSubagentStatusCount("agents 1/3 running · 2 idle")).toBe(1);
  });

  test("recognizes all eight collaboration tool names and exact empty env", () => {
    for (const name of [
      "spawn_agent",
      "send_message",
      "followup_task",
      "wait_agent",
      "interrupt_agent",
      "list_agents",
      "delegate",
      "ask_parent",
    ])
      expect(isSubagentsTool(name)).toBe(true);
    expect(parseToolListEnv("[]")).toEqual([]);
  });

  test("ignores project settings until trust is established", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-settings-"));
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".pi", "settings.json"),
      JSON.stringify({ subagents: { maxDepth: 17, maxPersistentAgents: 3 } }),
    );
    expect(loadSettings(cwd, true).maxDepth).toBe(17);
    expect(loadSettings(cwd, true).maxPersistentAgents).toBe(3);
    expect(loadSettings(cwd, false).maxDepth).not.toBe(17);
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});
