import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { RpcProcess } from "../rpc-process.ts";
import { CollaborationManager } from "../runtime/collaboration-manager.ts";
import { RootTreeBroker } from "../runtime/root-tree-broker.ts";
import { RootTreeRegistry } from "../runtime/root-tree-registry.ts";
import { createSubagentRuntimeState } from "../runtime/state.ts";
import { DEFAULT_SETTINGS } from "../settings.ts";
import type { RootTreeIdentity } from "../types.ts";

const brokers: RootTreeBroker[] = [];
const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.allSettled(brokers.splice(0).map((broker) => broker.close()));
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tree(capacity = 8): RootTreeRegistry {
  return new RootTreeRegistry({
    root: { id: "root-id", path: "/root", depth: 0, maxDepth: 3 },
    maxResidentAgents: capacity,
    maxActiveAgents: capacity,
  });
}

function reserve(
  registry: RootTreeRegistry,
  parent: string,
  name: string,
  id = `id-${name}`,
): RootTreeIdentity {
  const reservation = registry.reserveChild(registry.identity(parent), {
    id,
    taskName: name,
    maxDepth: 3,
    lastTaskMessage: `task ${name}`,
    reloadable: true,
  });
  registry.commitReservation(reservation.effect);
  return registry.identity(reservation.path);
}

function idle(registry: RootTreeRegistry, identity: RootTreeIdentity): void {
  registry.commitControllerEffect(registry.beginControllerEffect(
    registry.identity(identity.parentPath!),
    identity.path,
    "deactivate",
  ));
}

describe("root-tree residency authority", () => {
  test("root-plus-fifteen capacity cannot be bypassed by descendants", () => {
    const registry = new RootTreeRegistry({
      root: { id: "root-id", path: "/root", depth: 0, maxDepth: 3 },
    });
    const alpha = reserve(registry, "/root", "alpha");
    for (let index = 1; index < 15; index += 1)
      reserve(registry, "/root", `worker_${index}`);
    expect(() => reserve(registry, alpha.path, "grand", "id-grand"))
      .toThrow("capacity (16) is full");
  });

  test("safe unload requires an idle leaf with empty mailbox, outbox, and question state", () => {
    const registry = tree();
    const parent = reserve(registry, "/root", "parent");
    idle(registry, parent);
    const child = reserve(registry, parent.path, "child");
    idle(registry, child);
    expect(() => registry.beginControllerEffect(
      registry.identity("/root"), parent.path, "unload",
    )).toThrow("canonical descendants");

    const controller = registry.identity(parent.path);
    registry.updateController(controller, child.path, { mailboxPending: 1 });
    expect(() => registry.beginControllerEffect(controller, child.path, "unload"))
      .toThrow("pending mailbox");
    registry.updateController(controller, child.path, { mailboxPending: 0, outboxPending: 1 });
    expect(() => registry.beginControllerEffect(controller, child.path, "unload"))
      .toThrow("completion outbox");
    registry.updateController(controller, child.path, {
      outboxPending: 0,
      questionPending: true,
    });
    expect(() => registry.beginControllerEffect(controller, child.path, "unload"))
      .toThrow("pending question");
    registry.updateController(controller, child.path, { questionPending: false });
    const effect = registry.beginControllerEffect(controller, child.path, "unload");
    expect(registry.commitControllerEffect(effect)).toMatchObject({
      id: child.id,
      path: child.path,
      resident: false,
      registered: false,
    });
    expect(registry.safeUnloadCandidates().map((candidate) => candidate.path))
      .not.toContain(parent.path);
    expect(() => registry.beginControllerEffect(
      registry.identity("/root"), parent.path, "unload",
    )).toThrow("canonical descendants");
  });

  test("reload pruning never retires disconnected records with pending work", () => {
    const registry = new RootTreeRegistry({
      root: { id: "root-id", path: "/root", depth: 0, maxDepth: 3 },
      maxResidentAgents: 2,
      maxActiveAgents: 2,
    });
    const root = registry.identity("/root");
    const protectedPaths: string[] = [];
    for (const [name, update] of [
      ["pending_mail", { mailboxPending: 1 }],
      ["pending_outbox", { outboxPending: 1 }],
      ["pending_question", { questionPending: true }],
    ] as const) {
      const child = reserve(registry, "/root", name);
      registry.updateController(root, child.path, update);
      registry.commitControllerEffect(
        registry.beginControllerEffect(root, child.path, "disconnect"),
      );
      protectedPaths.push(child.path);
    }

    for (let index = 0; index < 1_028; index++) {
      const child = reserve(registry, "/root", `retirable_${index}`);
      idle(registry, child);
      registry.commitControllerEffect(
        registry.beginControllerEffect(root, child.path, "unload"),
      );
    }

    for (const protectedPath of protectedPaths)
      expect(registry.get(protectedPath)).toMatchObject({ resident: false });
    expect(registry.get("/root/retirable_0")).toBeUndefined();
    const pruned = registry.takePrunedPaths();
    expect(pruned.length).toBeGreaterThan(0);
    expect(pruned.some((path) => protectedPaths.includes(path))).toBe(false);
  });

  test("lazy reload preserves identity and metadata while rotating connection generation", () => {
    const registry = tree();
    const child = reserve(registry, "/root", "worker", "opaque-worker");
    const controller = registry.identity("/root");
    registry.updateController(controller, child.path, {
      status: { completed: "prior result" },
      lastTaskMessage: "prior task",
      lastOutput: "full prior history",
    });
    idle(registry, child);
    registry.commitControllerEffect(
      registry.beginControllerEffect(controller, child.path, "unload"),
    );
    const before = registry.get(child.path)!;
    registry.commitControllerEffect(
      registry.beginControllerEffect(controller, child.path, "reload"),
    );
    const connected = registry.commitControllerEffect(
      registry.beginControllerEffect(
        controller,
        child.path,
        "connect",
        before.connectionGeneration,
      ),
    );
    expect(connected).toMatchObject({
      id: "opaque-worker",
      path: "/root/worker",
      lastTaskMessage: "prior task",
      lastOutput: "full prior history",
      resident: true,
      registered: true,
    });
    expect(connected.connectionGeneration).toBeGreaterThan(before.connectionGeneration);
  });

  test("capacity lowering evicts the full safe set or rejects without mutation", () => {
    const registry = tree(5);
    const a = reserve(registry, "/root", "a");
    const b = reserve(registry, "/root", "b");
    const c = reserve(registry, "/root", "c");
    const d = reserve(registry, "/root", "d");
    for (const child of [a, b, c, d]) idle(registry, child);
    registry.updateController(registry.identity("/root"), a.path, { mailboxPending: 1 });
    const lowered = registry.setCapacities(3, 5);
    expect(lowered.unloaded).toHaveLength(2);
    expect(registry.maxResidentAgents).toBe(3);
    expect(registry.get(a.path)?.resident).toBe(true);

    const before = [a, b, c, d].map((child) => registry.get(child.path)?.resident);
    expect(() => registry.setCapacities(1, 1)).toThrow("safe leaf eviction");
    expect([a, b, c, d].map((child) => registry.get(child.path)?.resident)).toEqual(before);
    expect(registry.maxResidentAgents).toBe(3);
  });

  test("broker capacity lowering reloads closed agents when an unload I/O effect fails", async () => {
    const children = new Map<string, RootTreeBroker>();
    let failPath = "/root/b";
    let root!: RootTreeBroker;
    const dispatch = async (message: any) => {
      const targetPath = String(message.payload?.targetPath ?? "");
      if (message.op === "prepare_unload") return {};
      if (message.op === "unload") {
        if (targetPath === failPath) throw new Error("fixture unload I/O failed");
        await children.get(targetPath)?.close();
        return {};
      }
      if (message.op === "reload") {
        const prior = targetPath === "/root/a"
          ? { id: "id-a", taskName: "a" }
          : { id: "id-b", taskName: "b" };
        const grant = message.payload.broker;
        const child = await RootTreeBroker.connectChild({
          identity: {
            id: prior.id,
            path: targetPath,
            parentId: "root-id",
            parentPath: "/root",
            depth: 1,
            maxDepth: 2,
            connectionGeneration: grant.generation,
          },
          maxResidentAgents: 3,
          maxActiveAgents: 3,
          socketPath: grant.socketPath,
          capability: grant.capability,
          dispatch: async () => ({}),
        });
        children.set(targetPath, child);
        brokers.push(child);
        return {};
      }
      return {};
    };
    root = await RootTreeBroker.createRoot({
      identity: { id: "root-id", path: "/root", depth: 0, maxDepth: 2 },
      maxResidentAgents: 3,
      maxActiveAgents: 3,
      dispatch,
    });
    brokers.push(root);
    for (const [taskName, id] of [["a", "id-a"], ["b", "id-b"]] as const) {
      const grant = await root.reserveChild({
        id,
        taskName,
        maxDepth: 2,
        lastTaskMessage: taskName,
        reloadable: true,
      });
      const child = await RootTreeBroker.connectChild({
        identity: {
          id,
          path: grant.path,
          parentId: "root-id",
          parentPath: "/root",
          depth: 1,
          maxDepth: 2,
          connectionGeneration: grant.generation,
        },
        maxResidentAgents: 3,
        maxActiveAgents: 3,
        socketPath: root.endpoint!.socketPath,
        capability: grant.capability,
        dispatch: async () => ({}),
      });
      children.set(grant.path, child);
      brokers.push(child);
      await root.updateAgent(grant.path, { active: false, status: { completed: taskName } }, 1);
    }
    await expect(root.setCapacities(1, 3)).rejects.toThrow(
      "every closed agent was reloaded",
    );
    expect((await root.list()).agents.map((agent) => agent.agent_name)).toEqual([
      "/root", "/root/a", "/root/b",
    ]);
    failPath = "";
    expect((await root.setCapacities(1, 3)).unloaded.sort()).toEqual([
      "/root/a", "/root/b",
    ]);
    expect((await root.list()).agents.map((agent) => agent.agent_name)).toEqual(["/root"]);
  });

  test("reload recursively restores an unloaded controller chain before target dispatch", async () => {
    let root!: RootTreeBroker;
    let parent!: RootTreeBroker;
    let grand!: RootTreeBroker;
    const parentDispatch = async (message: any) => {
      if (message.op === "disconnect_cleanup") return {
        closed: true,
        connectionGeneration: message.payload.connectionGeneration,
      };
      if (message.op === "reload") {
        const grant = message.payload.broker;
        grand = await RootTreeBroker.connectChild({
          identity: {
            id: "grand-id",
            path: "/root/parent/grand",
            parentId: "parent-id",
            parentPath: "/root/parent",
            depth: 2,
            maxDepth: 3,
            connectionGeneration: grant.generation,
          },
          maxResidentAgents: 4,
          maxActiveAgents: 4,
          socketPath: grant.socketPath,
          capability: grant.capability,
          dispatch: async () => ({}),
        });
        brokers.push(grand);
      }
      return {};
    };
    const rootDispatch = async (message: any) => {
      if (message.op === "disconnect_cleanup") return {
        closed: true,
        connectionGeneration: message.payload.connectionGeneration,
      };
      if (message.op === "reload") {
        const grant = message.payload.broker;
        parent = await RootTreeBroker.connectChild({
          identity: {
            id: "parent-id",
            path: "/root/parent",
            parentId: "root-id",
            parentPath: "/root",
            depth: 1,
            maxDepth: 3,
            connectionGeneration: grant.generation,
          },
          maxResidentAgents: 4,
          maxActiveAgents: 4,
          socketPath: grant.socketPath,
          capability: grant.capability,
          dispatch: parentDispatch,
        });
        brokers.push(parent);
      }
      return {};
    };
    root = await RootTreeBroker.createRoot({
      identity: { id: "root-id", path: "/root", depth: 0, maxDepth: 3 },
      maxResidentAgents: 4,
      maxActiveAgents: 4,
      dispatch: rootDispatch,
    });
    brokers.push(root);
    const parentGrant = await root.reserveChild({
      id: "parent-id", taskName: "parent", maxDepth: 3,
      lastTaskMessage: "parent", reloadable: true,
    });
    parent = await RootTreeBroker.connectChild({
      identity: {
        id: "parent-id", path: parentGrant.path, parentId: "root-id",
        parentPath: "/root", depth: 1, maxDepth: 3,
        connectionGeneration: parentGrant.generation,
      },
      maxResidentAgents: 4,
      maxActiveAgents: 4,
      socketPath: root.endpoint!.socketPath,
      capability: parentGrant.capability,
      dispatch: parentDispatch,
    });
    brokers.push(parent);
    const grandGrant = await parent.reserveChild({
      id: "grand-id", taskName: "grand", maxDepth: 3,
      lastTaskMessage: "grand", reloadable: true,
    });
    grand = await RootTreeBroker.connectChild({
      identity: {
        id: "grand-id", path: grandGrant.path, parentId: "parent-id",
        parentPath: parentGrant.path, depth: 2, maxDepth: 3,
        connectionGeneration: grandGrant.generation,
      },
      maxResidentAgents: 4,
      maxActiveAgents: 4,
      socketPath: root.endpoint!.socketPath,
      capability: grandGrant.capability,
      dispatch: async () => ({}),
    });
    brokers.push(grand);
    await parent.updateAgent(grandGrant.path, { active: false }, 1);
    await root.updateAgent(parentGrant.path, { active: false }, 1);
    await parent.close();
    await Bun.sleep(30);
    expect((await root.list()).agents.map((agent) => agent.agent_name)).toEqual(["/root"]);
    await root.route("send", grandGrant.path, "restore the chain");
    expect((await root.list()).agents.map((agent) => agent.agent_name)).toEqual([
      "/root", "/root/parent", "/root/parent/grand",
    ]);
  });

  test("real manager/broker lazy reload preserves session and opaque identity with a rotated capability", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-residency-reload-"));
    tempDirs.push(cwd);
    fs.mkdirSync(path.join(cwd, ".pi"));
    fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify({
      subagents: {
        maxPersistentAgents: 2,
        maxConcurrentAgents: 2,
        statusHistoryLimit: 0,
        sessionDir: path.join(cwd, "sessions"),
        rpcStartupTimeoutMs: 2_000,
        rpcRequestTimeoutMs: 2_000,
      },
    }));
    const session = SessionManager.inMemory(cwd);
    session.appendMessage({ role: "user", content: "parent" } as any);
    const ctx = {
      cwd,
      isProjectTrusted: () => true,
      hasUI: false,
      mode: "rpc",
      model: undefined,
      sessionManager: session,
    } as any;
    const pi = {
      getActiveTools: () => [],
      getAllTools: () => [],
      getThinkingLevel: () => "off",
      sendMessage: () => undefined,
      appendEntry: () => undefined,
    } as any;
    const state = createSubagentRuntimeState({
      pi,
      settings: {
        ...DEFAULT_SETTINGS,
        sessionDir: path.join(cwd, "sessions"),
        maxPersistentAgents: 2,
        maxConcurrentAgents: 2,
        statusHistoryLimit: 0,
        rpcStartupTimeoutMs: 2_000,
        rpcRequestTimeoutMs: 2_000,
      },
      currentDepth: 0,
      envMaxDepth: 2,
      extensionPath: "/extension/index.ts",
      currentPath: "/root",
      guardToken: {},
      invocationBase: { command: process.execPath, prefixArgs: [] },
    });
    state.latestCtx = ctx;
    const fixture = fileURLToPath(new URL("./fixtures/fake-rpc-child.mjs", import.meta.url));
    const manager = new CollaborationManager(state, (_command, args, options) => {
      const sessionIndex = args.indexOf("--session");
      return new RpcProcess(process.execPath, [fixture], {
        ...options,
        env: {
          ...options.env,
          FAKE_CONNECT_BROKER: "1",
          FAKE_SETTLE_DELAY_MS: "10",
          ...(sessionIndex >= 0 ? { FAKE_SESSION_FILE: args[sessionIndex + 1] } : {}),
        },
      });
    });
    state.manager = manager;
    await manager.initializeBroker(ctx);
    const first = await manager.spawnAgent(
      { task_name: "first", message: "first turn", fork_turns: "none" },
      undefined,
      ctx,
    );
    await waitUntil(() => state.active.get(first.agent_id)?.turnState === "idle");
    const original = state.active.get(first.agent_id)!;
    const originalSession = original.sessionFile;
    const originalGeneration = original.brokerGeneration!;

    const second = await manager.spawnAgent(
      { task_name: "second", message: "second turn", fork_turns: "none" },
      undefined,
      ctx,
    );
    await waitUntil(() => state.active.get(second.agent_id)?.turnState === "idle");
    expect(state.history.size).toBe(0);
    expect(state.reloadRecords.get(first.agent_id)?.sessionFile).toBe(originalSession);

    await state.broker!.route("send", first.agent_name, "reload the first agent");
    const reloaded = state.active.get(first.agent_id)!;
    expect(reloaded.id).toBe(first.agent_id);
    expect(reloaded.agentName).toBe(first.agent_name);
    expect(reloaded.sessionFile).toBe(originalSession);
    expect(reloaded.brokerGeneration).toBeGreaterThan(originalGeneration);

    const startsBefore = reloaded.events.filter((event) => event.type === "agent_start").length;
    const turnBefore = reloaded.turnCount;
    await manager.sendMessage(first.agent_name, "MESSAGE A");
    await manager.sendMessage(first.agent_name, "MESSAGE B");
    await manager.followupTask(first.agent_name, "NEW_TASK C");
    await waitUntil(() => reloaded.turnCount === turnBefore + 1 && reloaded.turnState === "idle");
    expect(reloaded.events.filter((event) => event.type === "agent_start")).toHaveLength(
      startsBefore + 1,
    );
    await manager.shutdown();
  }, 15_000);

  test("disconnected agents become unloaded and interrupt returns canonical not_found", async () => {
    let child: RootTreeBroker | undefined;
    const root = await RootTreeBroker.createRoot({
      identity: { id: "root-id", path: "/root", depth: 0, maxDepth: 2 },
      maxResidentAgents: 3,
      maxActiveAgents: 3,
      dispatch: async (message) => message.op === "disconnect_cleanup"
        ? {
            closed: true,
            connectionGeneration: message.payload.connectionGeneration,
          }
        : {},
    });
    brokers.push(root);
    const grant = await root.reserveChild({
      id: "child-id",
      taskName: "child",
      maxDepth: 2,
      lastTaskMessage: "child task",
      reloadable: true,
    });
    child = await RootTreeBroker.connectChild({
      identity: {
        id: "child-id",
        path: grant.path,
        parentId: "root-id",
        parentPath: "/root",
        depth: 1,
        maxDepth: 2,
        connectionGeneration: grant.generation,
      },
      maxResidentAgents: 3,
      maxActiveAgents: 3,
      socketPath: root.endpoint!.socketPath,
      capability: grant.capability,
      dispatch: async () => ({}),
    });
    brokers.push(child);
    await child.close();
    await Bun.sleep(20);
    expect((await root.list()).agents.map((agent) => agent.agent_name)).toEqual(["/root"]);
    expect(await root.route("interrupt", grant.path)).toEqual({
      previous_status: "not_found",
    });
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for residency state");
    await Bun.sleep(10);
  }
}
