import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";
import { RpcProcess } from "../rpc-process.ts";
import { DelegateParams } from "../schemas.ts";
import { DEFAULT_SETTINGS } from "../settings.ts";
import { createSubagentRuntimeState } from "../runtime/state.ts";
import { createLiveSubagentRecord } from "../runtime/turn-controller.ts";
import { makeCompletionPayload } from "../summaries/completion.ts";
import {
  CollaborationManager,
  type CollaborationManagerDependencies,
} from "../runtime/collaboration-manager.ts";
import { registerSubagentTools } from "../tools/register-tools.ts";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/fake-rpc-child.mjs",
);
const processes: RpcProcess[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.allSettled(processes.splice(0).map((process) => process.stop()));
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function waitUntil(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("condition not reached");
    await Bun.sleep(5);
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => { resolve = yes; });
  return { promise, resolve };
}

function harness(
  dependencies: CollaborationManagerDependencies = {},
  settleDelayMs = 100,
) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-legacy-"));
  tempDirs.push(cwd);
  const sessionDir = path.join(cwd, "artifacts");
  const tools: any[] = [];
  const pi = {
    getActiveTools: () => [],
    getAllTools: () => [],
    getThinkingLevel: () => "off",
    sendMessage: () => undefined,
    appendEntry: () => undefined,
    registerTool: (tool: any) => tools.push(tool),
  } as any;
  const ctx = {
    cwd,
    isProjectTrusted: () => true,
    hasUI: false,
    mode: "rpc",
    model: undefined,
    signal: new AbortController().signal,
    sessionManager: {
      getSessionId: () => "legacy-root-session",
      getSessionFile: () => undefined,
      getSessionDir: () => sessionDir,
      getEntries: () => [],
      getBranch: () => [],
    },
  } as any;
  const state = createSubagentRuntimeState({
    pi,
    settings: {
      ...DEFAULT_SETTINGS,
      sessionDir,
      rpcStartupTimeoutMs: 1_000,
      rpcRequestTimeoutMs: 1_000,
      rpcShutdownTimeoutMs: 250,
    },
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
  let sequence = 0;
  const released: string[] = [];
  state.broker = {
    endpoint: { socketPath: "/tmp/fake-legacy-broker.sock" },
    reserveChild: async (input: any) => ({
      path: `/root/${input.taskName}`,
      capability: "a".repeat(64),
      generation: 1,
    }),
    awaitChildRegistration: async () => undefined,
    commitChildRegistration: async () => undefined,
    abortChildRegistration: async (target: string) => { released.push(target); },
    releaseReservation: async (target: string) => { released.push(target); },
    updateAgent: async () => undefined,
    list: async () => ({ agents: [] }),
    close: async () => undefined,
  } as any;
  let rpcFactoryCalls = 0;
  const manager = new CollaborationManager(
    state,
    (_command, _args, options) => {
      rpcFactoryCalls += 1;
      const client = new RpcProcess(process.execPath, [fixture], {
        ...options,
        env: {
          ...options.env,
          FAKE_SETTLE_DELAY_MS: String(settleDelayMs),
          FAKE_SESSION_SUFFIX: String(++sequence),
        },
      });
      processes.push(client);
      return client;
    },
    dependencies,
  );
  state.manager = manager;
  return {
    state,
    manager,
    ctx,
    tools,
    released,
    rpcFactoryCalls: () => rpcFactoryCalls,
  };
}

const theme = {
  fg: (_color: string, text: string) => String(text),
  bold: (text: string) => String(text),
} as any;

describe("M14 legacy delegate compatibility", () => {
  test("locks params/details/rendering and preserves normal output beyond 220 characters", async () => {
    expect(Object.keys(DelegateParams.properties).sort()).toEqual([
      "context",
      "task",
      "title",
    ]);
    expect(Value.Check(DelegateParams, {
      title: "Legacy title",
      task: "work",
      context: "fresh",
    })).toBe(true);
    expect(Value.Check(DelegateParams, { task: "work", extra: true })).toBe(false);

    const h = harness({}, 120);
    registerSubagentTools(h.state);
    const delegateTool = h.tools.find((tool) => tool.name === "delegate");
    const tail = "LEGACY_OUTPUT_TAIL_MUST_SURVIVE";
    const task = `LEGACY_OUTPUT_HEAD_${"x".repeat(400)}_${tail}`;
    let resolved = false;
    const pending = h.manager.delegate(
      { title: "Legacy title", task, context: "fresh" },
      undefined,
      undefined,
      h.ctx,
    ).then((result) => {
      resolved = true;
      return result;
    });
    await waitUntil(() => h.state.active.size === 1);
    await Bun.sleep(30);
    expect(resolved).toBe(false); // prompt ACK/agent_end are not settlement
    const legacyId = [...h.state.active.keys()][0]!;
    await expect(h.manager.sendMessage(legacyId, "during")).rejects.toThrow("Unknown");
    await expect(h.manager.followupTask(legacyId, "during")).rejects.toThrow("Unknown");
    await expect(h.manager.interruptAgent(legacyId)).rejects.toThrow("Unknown");
    const result = await pending;
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text.length).toBeGreaterThan(220);
    expect(text).toContain(tail);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(
      h.state.settings.returnMaxBytes,
    );
    expect(Object.keys(result.details!).sort()).toEqual([
      "contextMode",
      "depth",
      "error",
      "events",
      "finalOutput",
      "id",
      "label",
      "lastMessageSnippet",
      "maxDepth",
      "model",
      "sessionDir",
      "sessionFile",
      "status",
      "task",
      "thinkingLevel",
      "usage",
    ]);
    expect(h.state.active.has(legacyId)).toBe(false);
    expect(h.state.history.has(legacyId)).toBe(false);
    expect(h.state.reloadRecords.has(legacyId)).toBe(false);
    await expect(h.manager.sendMessage(legacyId, "late")).rejects.toThrow("Unknown");
    await expect(h.manager.followupTask(legacyId, "late")).rejects.toThrow("Unknown");
    await expect(h.manager.interruptAgent(legacyId)).rejects.toThrow("Unknown");

    const expanded = delegateTool.renderResult(result, { expanded: true }, theme);
    expect(expanded.render(10_000).join("\n")).toContain(tail);
  });

  test("cancellation aborts blocked compact handoff without fallback and confirms teardown", async () => {
    const summaryStarted = deferred();
    let summaryCalls = 0;
    let fallbackCompletionCalls = 0;
    const h = harness({
      generateHandoffSummary: async (_ctx, _settings, signal) => {
        summaryCalls += 1;
        summaryStarted.resolve();
        return new Promise<string>((_resolve, reject) => {
          const abort = () => {
            const error = new Error("blocked handoff aborted");
            error.name = "AbortError";
            reject(error);
          };
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        });
      },
      makeCompletionPayload: async (..._args: any[]) => {
        fallbackCompletionCalls += 1;
        throw new Error("fallback completion must not run");
      },
    });
    const controller = new AbortController();
    const pending = h.manager.delegate(
      { task: "blocked summary", context: "compact" },
      controller.signal,
      undefined,
      h.ctx,
    );
    await summaryStarted.promise;
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
    expect(summaryCalls).toBe(1);
    expect(fallbackCompletionCalls).toBe(0);
    expect(h.rpcFactoryCalls()).toBe(0);
    expect(h.state.active.size).toBe(0);
  });

  test("cancellation aborts blocked completion work, stops RPC, and removes the delegate", async () => {
    const completionStarted = deferred();
    let completionCalls = 0;
    const h = harness({
      makeCompletionPayload: async (_record, _ctx, _settings, signal) => {
        completionCalls += 1;
        completionStarted.resolve();
        return new Promise<any>((_resolve, reject) => {
          const abort = () => {
            const error = new Error("blocked completion aborted");
            error.name = "AbortError";
            reject(error);
          };
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        });
      },
    }, 20);
    const controller = new AbortController();
    const pending = h.manager.delegate(
      { task: "block completion", context: "fresh" },
      controller.signal,
      undefined,
      h.ctx,
    );
    await completionStarted.promise;
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
    expect(completionCalls).toBe(1);
    expect(h.rpcFactoryCalls()).toBe(1);
    expect(h.state.active.size).toBe(0);
    expect(processes.at(-1)?.pid).toBeUndefined();
  });

  test("an already-cancelled artifact path writes nothing and never falls back", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-artifact-abort-"));
    tempDirs.push(dir);
    const item = createLiveSubagentRecord({
      id: "legacy_artifact",
      generatedLabel: "legacy",
      taskName: "legacy_artifact",
      agentName: "/root/legacy_artifact",
      mode: "legacy",
      contextMode: "fresh",
      parentId: "root",
      rootId: "root",
      depth: 1,
      maxDepth: 2,
      message: "artifact",
      sessionDir: dir,
    });
    item.finalOutput = "must not write";
    const controller = new AbortController();
    controller.abort();
    await expect(makeCompletionPayload(
      item,
      undefined,
      DEFAULT_SETTINGS,
      controller.signal,
    )).rejects.toThrow("aborted");
    expect(fs.existsSync(path.join(dir, "final-output.md"))).toBe(false);
  });

  test("persistent spawn remains reusable after disposable delegate removal", async () => {
    const h = harness({}, 30);
    await h.manager.delegate(
      { task: "one shot", context: "fresh" },
      undefined,
      undefined,
      h.ctx,
    );
    const spawned = await h.manager.spawnAgent(
      { task_name: "persistent", message: "first", fork_turns: "none" },
      undefined,
      h.ctx,
    );
    const persistent = h.state.active.get(spawned.agent_id)!;
    await waitUntil(() => persistent.status === "completed");
    const pid = persistent.client!.pid;
    const followup = await h.manager.followupTask(spawned.agent_id, "second");
    expect(followup.delivery).toBe("prompt");
    await waitUntil(() => persistent.turnCount === 2 && persistent.status === "completed");
    expect(persistent.client!.pid).toBe(pid);
    expect(persistent.reusable).toBe(true);
    await h.manager.shutdown();
  });
});
