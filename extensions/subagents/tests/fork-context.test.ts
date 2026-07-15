import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SessionManager,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { RpcProcess } from "../rpc-process.ts";
import {
  prepareForkSeedSession,
  selectForkContextEntries,
} from "../runtime/fork-context.ts";
import { CollaborationManager } from "../runtime/collaboration-manager.ts";
import { createSubagentRuntimeState } from "../runtime/state.ts";
import { applyRoleActiveTools } from "../runtime/tool-list.ts";
import { DEFAULT_SETTINGS } from "../settings.ts";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/fake-rpc-child.mjs",
);
const processes: RpcProcess[] = [];
const tempDirs: string[] = [];

function tempDir(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-fork-"));
  tempDirs.push(value);
  return value;
}

function user(text: string): any {
  return { role: "user", content: text, timestamp: Date.now() };
}

function assistant(content: any[], model = "parent-model"): any {
  return {
    role: "assistant",
    content,
    api: "fake-api",
    provider: "fake-provider",
    model,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: content.some((block) => block.type === "toolCall")
      ? "toolUse"
      : "stop",
    timestamp: Date.now(),
  };
}

function contextRoles(entries: ReturnType<typeof selectForkContextEntries>) {
  return entries.flatMap(sessionEntryToContextMessages).map((message) => message.role);
}

function textMessages(entries: ReturnType<typeof selectForkContextEntries>) {
  return entries
    .flatMap(sessionEntryToContextMessages)
    .filter((message: any) => message.role === "user" || message.role === "assistant")
    .map((message: any) => {
      if (typeof message.content === "string") return message.content;
      return message.content
        .filter((block: any) => block.type === "text")
        .map((block: any) => block.text)
        .join("");
    });
}

function spawnIdentity() {
  return { taskName: "worker", message: "do child work" };
}

function appendCurrentSpawn(parent: SessionManager): void {
  parent.appendMessage(
    assistant([
      {
        type: "toolCall",
        id: "call_spawn_current",
        name: "spawn_agent",
        arguments: {
          task_name: "worker",
          message: "do child work",
          fork_turns: "all",
        },
      },
    ]),
  );
}

function makeMultiTurnParent(): SessionManager {
  const parent = SessionManager.inMemory("/tmp/project");
  parent.appendMessage(user("turn one"));
  parent.appendMessage(assistant([{ type: "text", text: "answer one" }]));
  parent.appendMessage(user("turn two"));
  parent.appendMessage(assistant([{ type: "text", text: "answer two" }]));
  parent.appendMessage(user("spawn now"));
  appendCurrentSpawn(parent);
  return parent;
}

afterEach(async () => {
  await Promise.allSettled(processes.splice(0).map((process) => process.stop()));
  for (const dir of tempDirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("fork_turns context selection", () => {
  test("none is empty; all and omitted-default fixtures preserve exact role order", () => {
    const parent = makeMultiTurnParent();
    expect(selectForkContextEntries(parent, "none", spawnIdentity())).toEqual([]);

    const all = selectForkContextEntries(parent, "all", spawnIdentity());
    expect(contextRoles(all)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
    expect(textMessages(all)).toEqual([
      "turn one",
      "answer one",
      "turn two",
      "answer two",
      "spawn now",
    ]);
    expect(JSON.stringify(all)).not.toContain("call_spawn_current");
  });

  test("1 and multi-turn N count real user/trigger boundaries", () => {
    const parent = makeMultiTurnParent();
    expect(textMessages(selectForkContextEntries(parent, "1", spawnIdentity())))
      .toEqual(["spawn now"]);
    expect(textMessages(selectForkContextEntries(parent, "2", spawnIdentity())))
      .toEqual(["turn two", "answer two", "spawn now"]);
    expect(textMessages(selectForkContextEntries(parent, "99", spawnIdentity())))
      .toEqual(["turn one", "answer one", "turn two", "answer two", "spawn now"]);

    const interAgent = SessionManager.inMemory("/tmp/project");
    interAgent.appendCustomMessageEntry(
      "subagents_message",
      "Message Type: NEW_TASK\nTask name: /root\nSender: /root/parent\nPayload:\nfollow up",
      true,
      { triggerTurn: true },
    );
    interAgent.appendMessage(assistant([{ type: "text", text: "followed" }]));
    expect(contextRoles(selectForkContextEntries(interAgent, "1", spawnIdentity())))
      .toEqual(["custom", "assistant"]);

    const steered = SessionManager.inMemory("/tmp/project");
    steered.appendMessage(user("real prior turn"));
    steered.appendMessage(assistant([{ type: "text", text: "prior answer" }]));
    steered.appendMessage(user(
      "Message Type: MESSAGE\nTask name: /root\nSender: /root/peer\nPayload:\nnon-trigger steer",
    ));
    steered.appendMessage(assistant([{ type: "text", text: "steer continuation" }]));
    steered.appendMessage(user("spawn now"));
    appendCurrentSpawn(steered);
    expect(textMessages(selectForkContextEntries(steered, "2", spawnIdentity())))
      .toEqual([
        "real prior turn",
        "prior answer",
        "Message Type: MESSAGE\nTask name: /root\nSender: /root/peer\nPayload:\nnon-trigger steer",
        "steer continuation",
        "spawn now",
      ]);
  });

  test("keeps complete tool pairs and removes current spawn call/result only", () => {
    const parent = SessionManager.inMemory("/tmp/project");
    parent.appendMessage(user("inspect then spawn"));
    parent.appendMessage(
      assistant([
        { type: "text", text: "checking" },
        { type: "toolCall", id: "call_read", name: "read", arguments: { path: "x" } },
      ]),
    );
    parent.appendMessage({
      role: "toolResult",
      toolCallId: "call_read",
      toolName: "read",
      content: [{ type: "text", text: "contents" }],
      isError: false,
      timestamp: Date.now(),
    } as any);
    appendCurrentSpawn(parent);
    parent.appendMessage({
      role: "toolResult",
      toolCallId: "call_spawn_current",
      toolName: "spawn_agent",
      content: [{ type: "text", text: "not yet visible" }],
      isError: false,
      timestamp: Date.now(),
    } as any);

    const selected = selectForkContextEntries(parent, "all", {
      taskName: "intentionally_mismatched",
      message: "exact id is authoritative",
      toolCallId: "call_spawn_current",
    });
    expect(contextRoles(selected)).toEqual(["user", "assistant", "toolResult"]);
    expect(JSON.stringify(selected)).toContain("call_read");
    expect(JSON.stringify(selected)).not.toContain("call_spawn_current");

    const textAndSpawn = SessionManager.inMemory("/tmp/project");
    textAndSpawn.appendMessage(user("spawn"));
    textAndSpawn.appendMessage(assistant([
      { type: "text", text: "launching now" },
      {
        type: "toolCall",
        id: "call_spawn_current",
        name: "spawn_agent",
        arguments: { task_name: "worker", message: "do child work" },
      },
    ]));
    const sanitized = selectForkContextEntries(textAndSpawn, "all", {
      ...spawnIdentity(),
      toolCallId: "call_spawn_current",
    });
    const terminalAssistant = sanitized.find(
      (entry) => entry.type === "message" && entry.message.role === "assistant",
    ) as any;
    expect(terminalAssistant.message.stopReason).toBe("stop");

    const crossedTurn = SessionManager.inMemory("/tmp/project");
    crossedTurn.appendMessage(user("first"));
    crossedTurn.appendMessage(assistant([
      { type: "text", text: "started" },
      { type: "toolCall", id: "crossed", name: "read", arguments: {} },
    ]));
    crossedTurn.appendMessage(user("new real turn"));
    crossedTurn.appendMessage({
      role: "toolResult",
      toolCallId: "crossed",
      toolName: "read",
      content: [{ type: "text", text: "late" }],
      isError: false,
      timestamp: Date.now(),
    } as any);
    const crossed = selectForkContextEntries(crossedTurn, "all", spawnIdentity());
    expect(JSON.stringify(crossed)).not.toContain("crossed");
    expect((crossed[1] as any).message.stopReason).toBe("stop");
  });

  test("preserves compaction/branch summaries plus model and thinking state", () => {
    const parent = SessionManager.inMemory("/tmp/project");
    parent.appendModelChange("fake-provider", "old-model");
    parent.appendThinkingLevelChange("high");
    parent.appendMessage(user("old turn"));
    parent.appendMessage(assistant([{ type: "text", text: "old answer" }]));
    const kept = parent.appendMessage(user("kept turn"));
    parent.appendMessage(assistant([{ type: "text", text: "kept answer" }]));
    const compaction = parent.appendCompaction(
      "summary of old context",
      kept,
      42_000,
      { readFiles: ["a.ts"] },
    );
    parent.branchWithSummary(
      compaction,
      "summary of abandoned branch",
      { modifiedFiles: ["b.ts"] },
    );

    const dir = tempDir();
    const prepared = prepareForkSeedSession({
      source: parent,
      forkTurns: "all",
      spawnCall: spawnIdentity(),
      cwd: dir,
      sessionDir: path.join(dir, "seed"),
      model: { provider: "fake-provider", id: "active-model" },
      thinkingLevel: "medium",
    });
    const child = SessionManager.open(prepared.sessionFile);
    const context = child.buildSessionContext();
    expect(context.messages.map((message) => message.role)).toEqual([
      "compactionSummary",
      "user",
      "assistant",
      "branchSummary",
    ]);
    expect((context.messages[0] as any).summary).toBe("summary of old context");
    expect((context.messages.at(-1) as any).summary).toBe(
      "summary of abandoned branch",
    );
    expect(context.model).toEqual({
      provider: "fake-provider",
      modelId: "active-model",
    });
    expect(context.thinkingLevel).toBe("medium");
  });
});

describe("fail-closed inherited tool activation", () => {
  test("a child rejects inherited tools that its loaded providers did not register", () => {
    const previous = process.env.PI_SUBAGENT_ACTIVE_TOOLS;
    process.env.PI_SUBAGENT_ACTIVE_TOOLS = JSON.stringify([
      "read",
      "unregistered_extension_tool",
      "ask_parent",
    ]);
    let activated: string[] | undefined;
    const state = createSubagentRuntimeState({
      pi: {
        getAllTools: () => [
          { name: "read", sourceInfo: { source: "builtin" } },
          { name: "ask_parent", sourceInfo: { source: "extension" } },
        ],
        getActiveTools: () => [],
        setActiveTools: (tools: string[]) => {
          activated = tools;
        },
      } as any,
      settings: { ...DEFAULT_SETTINGS, maxDepth: 2 },
      currentDepth: 1,
      envMaxDepth: 2,
      extensionPath: "/extension/index.ts",
      currentPath: "/root/worker",
      guardToken: {},
    });
    try {
      expect(() => applyRoleActiveTools(state)).toThrow(
        "unregistered_extension_tool",
      );
      expect(activated).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.PI_SUBAGENT_ACTIVE_TOOLS;
      else process.env.PI_SUBAGENT_ACTIVE_TOOLS = previous;
    }
  });
});

describe("CollaborationManager fork integration", () => {
  function makeManager(options?: {
    activeTools?: string[];
    allTools?: any[];
    defaultContext?: "compact" | "fresh";
    fakeStartupExtensionError?: boolean;
  }) {
    const cwd = tempDir();
    const sessionDir = path.join(cwd, "artifacts");
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".pi", "settings.json"),
      JSON.stringify({
        subagents: {
          sessionDir,
          maxDepth: 2,
          defaultContext: options?.defaultContext ?? "compact",
          rpcStartupTimeoutMs: 1_000,
          rpcRequestTimeoutMs: 1_000,
          rpcShutdownTimeoutMs: 250,
        },
      }),
    );
    const parent = SessionManager.inMemory(cwd);
    parent.appendMessage(user("parent input"));
    appendCurrentSpawn(parent);
    const pi = {
      getActiveTools: () => options?.activeTools ?? [],
      getAllTools: () => options?.allTools ?? [],
      getThinkingLevel: () => "off",
      sendMessage: () => undefined,
      appendEntry: () => undefined,
    } as any;
    const ctx = {
      cwd,
      isProjectTrusted: () => true,
      hasUI: false,
      mode: "rpc",
      model: undefined,
      sessionManager: parent,
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
    state.treeMaxActiveAgents = 4;
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
      list: async () => ({ agents: [] }),
      close: async () => undefined,
    } as any;
    const launches: Array<{ args: string[]; env: Record<string, string | undefined> }> = [];
    const manager = new CollaborationManager(
      state,
      (_command, args, rpcOptions) => {
        if (options?.fakeStartupExtensionError)
          rpcOptions.env.FAKE_STARTUP_EXTENSION_ERROR = "1";
        launches.push({ args, env: rpcOptions.env });
        const process = new RpcProcess(processExec(), [fixture], rpcOptions);
        processes.push(process);
        return process;
      },
    );
    state.manager = manager;
    return { manager, state, ctx, launches };
  }

  test("invalid selectors and SDK-only tools fail before any reservation/process", async () => {
    const invalid = makeManager();
    await expect(
      invalid.manager.spawnAgent(
        { task_name: "worker", message: "do child work", fork_turns: "0" } as any,
        undefined,
        invalid.ctx,
      ),
    ).rejects.toThrow("fork_turns");
    expect(invalid.state.active.size).toBe(0);
    expect(invalid.launches).toHaveLength(0);

    const sdkOnly = makeManager({
      activeTools: ["sdk_tool"],
      allTools: [
        { name: "sdk_tool", sourceInfo: { source: "sdk", path: "<sdk>" } },
      ],
    });
    await expect(
      sdkOnly.manager.spawnAgent(
        { task_name: "worker", message: "do child work", fork_turns: "none" },
        undefined,
        sdkOnly.ctx,
      ),
    ).rejects.toThrow("sdk_tool");
    expect(sdkOnly.state.active.size).toBe(0);
    expect((sdkOnly.manager as any).reservedNames.size).toBe(0);
    expect(sdkOnly.launches).toHaveLength(0);

    const missing = makeManager({ activeTools: ["missing_tool"], allTools: [] });
    await expect(
      missing.manager.spawnAgent(
        { task_name: "worker", message: "do child work", fork_turns: "none" },
        undefined,
        missing.ctx,
      ),
    ).rejects.toThrow("missing_tool");
    expect(missing.state.active.size).toBe(0);
    expect((missing.manager as any).reservedNames.size).toBe(0);
    expect(missing.launches).toHaveLength(0);
  });

  test("child reconstructability errors roll back the process and reservation", async () => {
    const providerDir = tempDir();
    const providerPath = path.join(providerDir, "tools.ts");
    fs.writeFileSync(providerPath, "export default function () {}\n");
    const harness = makeManager({
      activeTools: ["unregistered_extension_tool"],
      allTools: [
        {
          name: "unregistered_extension_tool",
          sourceInfo: { source: "extension", path: providerPath },
        },
      ],
      fakeStartupExtensionError: true,
    });
    await expect(
      harness.manager.spawnAgent(
        { task_name: "worker", message: "do child work", fork_turns: "none" },
        undefined,
        harness.ctx,
      ),
    ).rejects.toThrow("unregistered_extension_tool");
    expect(harness.launches).toHaveLength(1);
    expect(harness.state.active.size).toBe(0);
    expect((harness.manager as any).reservedNames.size).toBe(0);
    expect(processes.at(-1)?.exited).toBe(true);
  });

  test("launches none against a seed with empty message history", async () => {
    const harness = makeManager();
    const spawned = await harness.manager.spawnAgent(
      { task_name: "worker", message: "do child work", fork_turns: "none" },
      undefined,
      harness.ctx,
      "call_spawn_current",
    );
    const record = harness.state.active.get(spawned.agent_id)!;
    expect(SessionManager.open(record.forkSessionFile!).buildSessionContext().messages)
      .toEqual([]);
    expect(harness.launches[0]!.args).toContain(record.forkSessionFile!);
    await waitUntil(() => record.status === "completed");
    await harness.manager.shutdown();
  });

  test("omitted fork defaults to all despite legacy fresh and submits one NEW_TASK", async () => {
    const providerDir = tempDir();
    const providerPath = path.join(providerDir, "tools.ts");
    fs.writeFileSync(providerPath, "export default function () {}\n");
    const harness = makeManager({
      activeTools: ["read", "extension_tool"],
      allTools: [
        { name: "read", sourceInfo: { source: "builtin" } },
        {
          name: "extension_tool",
          sourceInfo: { source: "extension", path: providerPath },
        },
      ],
      defaultContext: "fresh",
    });
    const spawned = await harness.manager.spawnAgent(
      { task_name: "worker", message: "do child work" },
      undefined,
      harness.ctx,
      "call_spawn_current",
    );
    const record = harness.state.active.get(spawned.agent_id)!;
    expect(spawned.fork_turns).toBe("all");
    expect(record.forkTurns).toBe("all");
    expect(record.contextMode).toBe("fresh");
    expect(harness.launches).toHaveLength(1);
    const launch = harness.launches[0]!;
    expect(launch.args).toContain("--session");
    expect(launch.args[launch.args.indexOf("--tools") + 1]!.split(","))
      .toEqual(JSON.parse(launch.env.PI_SUBAGENT_ACTIVE_TOOLS!));
    expect(JSON.parse(launch.env.PI_SUBAGENT_ACTIVE_TOOLS!)).toContain("read");
    expect(JSON.parse(launch.env.PI_SUBAGENT_ACTIVE_TOOLS!)).toContain(
      "extension_tool",
    );
    expect(launch.args).toContain(fs.realpathSync(providerPath));

    const seeded = SessionManager.open(record.forkSessionFile!);
    expect(seeded.buildSessionContext().messages.map((message) => message.role))
      .toEqual(["user"]);
    await waitUntil(() => record.status === "completed");
    expect(record.finalOutput!.match(/Message Type: NEW_TASK/g)).toHaveLength(1);

    const delegated = await harness.manager.delegate(
      { task: "legacy work" },
      undefined,
      undefined,
      harness.ctx,
    );
    const delegatedText = delegated.content[0];
    expect(delegatedText?.type).toBe("text");
    expect(delegatedText?.type === "text" ? delegatedText.text : "").toContain(
      "Fresh context mode: no parent transcript",
    );
    await harness.manager.shutdown();
  });
});

function processExec(): string {
  return process.execPath;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("waitUntil timed out");
    await Bun.sleep(10);
  }
}
