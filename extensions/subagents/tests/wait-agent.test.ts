import { afterEach, describe, expect, test } from "bun:test";
import { RootTreeBroker } from "../runtime/root-tree-broker.ts";
import { CollaborationManager } from "../runtime/collaboration-manager.ts";
import { RootTreeRegistry } from "../runtime/root-tree-registry.ts";
import type {
  RootTreeIdentity,
  TerminalAgentStatus,
} from "../types.ts";

function registry() {
  return new RootTreeRegistry({
    root: { id: "root-id", path: "/root", depth: 0, maxDepth: 4 },
    maxResidentAgents: 16,
    maxActiveAgents: 16,
  });
}

function reserve(
  tree: RootTreeRegistry,
  parentPath: string,
  taskName: string,
  id = `id-${taskName}`,
  reloadable = true,
): RootTreeIdentity {
  const reservation = tree.reserveChild(tree.identity(parentPath), {
    id,
    taskName,
    maxDepth: 4,
    lastTaskMessage: taskName,
    reloadable,
  });
  tree.commitReservation(reservation.effect);
  return tree.identity(reservation.path);
}

function finish(
  tree: RootTreeRegistry,
  child: RootTreeIdentity,
  status: TerminalAgentStatus,
): void {
  const current = tree.get(child.path)!;
  tree.updateControllerAtomic(
    tree.identity(child.parentPath!),
    child.path,
    { status },
    { active: false },
    current.activeEpoch,
  );
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("standalone wait_agent clock delay", () => {
  test("delays locally without touching the broker and cancels independently", async () => {
    let brokerCalls = 0;
    const manager = Object.create(CollaborationManager.prototype) as CollaborationManager;
    (manager as any).state = {
      closing: false,
      broker: { waitAgent: () => { brokerCalls += 1; throw new Error("unexpected broker call"); } },
    };
    const startedAt = Date.now();
    expect(await manager.waitAgent({ seconds: 1 })).toMatchObject({
      message: "Waited 1 second.",
      completed: [],
      pending: [],
    });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
    expect(brokerCalls).toBe(0);

    const controller = new AbortController();
    const pending = manager.waitAgent({ seconds: 1 }, controller.signal);
    controller.abort();
    expect(await pending).toMatchObject({
      message: "Wait interrupted by new input.",
      completed: [],
      pending: [],
    });
    expect(brokerCalls).toBe(0);
  });
});

describe("registry wait_agent snapshots", () => {
  test("ANY consumes exactly one oldest descendant notification per caller", async () => {
    const tree = registry();
    const a = reserve(tree, "/root", "a");
    const b = reserve(tree, "/root", "b");
    finish(tree, b, { completed: "b" });
    finish(tree, a, { errored: "a failed" });

    const first = await tree.wait(tree.identity("/root"), {});
    const second = await tree.wait(tree.identity("/root"), {});
    const empty = await tree.wait(tree.identity("/root"), {});
    expect(first.completed.map((item) => item.agent_name)).toEqual([b.path]);
    expect(second.completed.map((item) => item.agent_name)).toEqual([a.path]);
    expect(empty).toMatchObject({
      message: "No agents to wait for.",
      timed_out: false,
      completed: [],
      pending: [],
    });
  });

  test("prunes consumed terminal revisions across long persistent reuse", async () => {
    const tree = registry();
    const root = tree.identity("/root");
    const child = reserve(tree, "/root", "reused");
    for (let epoch = 1; epoch <= 2_000; epoch++) {
      finish(tree, child, { completed: `turn ${epoch}` });
      expect((await tree.wait(root, {})).completed).toHaveLength(1);
      if (epoch < 2_000) {
        tree.commitControllerEffect(
          tree.beginControllerEffect(root, child.path, "activate"),
        );
      }
    }
    expect(tree.retainedTerminalEventCount).toBeLessThanOrEqual(1);
  });

  test("self terminal reports convert one active claim per epoch without bypassing the ANY backlog bound", async () => {
    const tree = new RootTreeRegistry({
      root: { id: "root-id", path: "/root", depth: 0, maxDepth: 4 },
      maxResidentAgents: 2,
      maxActiveAgents: 2,
      maxPendingTerminalNotificationsPerCaller: 2,
    });
    const root = tree.identity("/root");
    const child = reserve(tree, "/root", "bounded_self");

    tree.reportSelf(child, 1, { status: { completed: "first" } });
    tree.commitControllerEffect(
      tree.beginControllerEffect(root, child.path, "deactivate"),
    );
    tree.commitControllerEffect(
      tree.beginControllerEffect(root, child.path, "activate"),
    );
    tree.reportSelf(child, 2, { status: { completed: "second" } });
    expect(tree.retainedTerminalEventCount).toBe(2);
    tree.commitControllerEffect(
      tree.beginControllerEffect(root, child.path, "deactivate"),
    );

    expect(() => tree.beginControllerEffect(root, child.path, "activate"))
      .toThrow("notification backlog is full");
    expect((await tree.wait(root, {})).completed[0]).toMatchObject({
      agent_name: child.path,
      agent_status: { completed: "first" },
    });
    expect(() => tree.beginControllerEffect(root, child.path, "activate"))
      .not.toThrow();
  });

  test("ANY is caller-subtree scoped and excludes agents spawned after its snapshot", async () => {
    const tree = registry();
    const branch = reserve(tree, "/root", "branch");
    const captured = reserve(tree, branch.path, "captured", "id-captured");
    const outside = reserve(tree, "/root", "outside", "id-outside");
    const waiting = tree.wait(branch, {});
    const late = reserve(tree, branch.path, "late", "id-late");
    finish(tree, outside, { completed: "outside" });
    finish(tree, late, { completed: "late" });
    expect(await Promise.race([waiting.then(() => "done"), delay(15).then(() => "pending")]))
      .toBe("pending");
    finish(tree, captured, { completed: "captured" });
    expect((await waiting).completed[0]?.agent_name).toBe(captured.path);
  });

  test("target accepts same-tree references, rejects self, and observes terminal state immediately without consuming ANY", async () => {
    const tree = registry();
    const a = reserve(tree, "/root", "a", "opaque-a");
    const b = reserve(tree, "/root", "b", "opaque-b");
    finish(tree, b, "interrupted");

    const targeted = await tree.wait(a, { target: "opaque-b" });
    expect(targeted.completed[0]).toMatchObject({
      agent_name: b.path,
      agent_status: "interrupted",
    });
    expect((await tree.wait(tree.identity("/root"), {})).completed[0]?.agent_name)
      .toBe(b.path);
    expect(() => tree.wait(a, { target: a.path })).toThrow("wait on itself");
  });

  test("target keeps the captured epoch across completion followed immediately by follow-up", async () => {
    const tree = registry();
    const child = reserve(tree, "/root", "worker");
    const waiting = tree.wait(tree.identity("/root"), { target: child.path });
    finish(tree, child, { completed: "epoch one" });
    const activate = tree.beginControllerEffect(
      tree.identity("/root"),
      child.path,
      "activate",
    );
    tree.commitControllerEffect(activate);
    const result = await waiting;
    expect(result.completed[0]).toMatchObject({
      agent_name: child.path,
      active_epoch: 1,
      agent_status: { completed: "epoch one" },
    });
    expect(tree.get(child.path)?.activeEpoch).toBe(2);
  });

  test("all:true waits indefinitely for only its captured nonterminal descendants", async () => {
    const tree = registry();
    const a = reserve(tree, "/root", "a");
    const b = reserve(tree, "/root", "b");
    const waiting = tree.wait(tree.identity("/root"), { all: true });
    const late = reserve(tree, "/root", "late");
    finish(tree, a, "shutdown");
    finish(tree, late, { completed: "excluded" });
    expect(await Promise.race([
      waiting.then(() => "done"),
      delay(15).then(() => "pending"),
    ])).toBe("pending");
    finish(tree, b, { completed: "b" });
    const result = await waiting;
    expect(result.timed_out).toBe(false);
    expect(result.completed.map((item) => item.agent_name).sort()).toEqual(
      [a.path, b.path].sort(),
    );
  });

  test("publishes all terminal status forms including reservation not_found", async () => {
    const statuses: TerminalAgentStatus[] = [
      { completed: null },
      { errored: "boom" },
      "interrupted",
      "shutdown",
    ];
    for (const [index, status] of statuses.entries()) {
      const tree = registry();
      const child = reserve(tree, "/root", `s${index}`);
      const waiting = tree.wait(tree.identity("/root"), {});
      finish(tree, child, status);
      expect((await waiting).completed[0]?.agent_status).toEqual(status);
    }

    const tree = registry();
    const reservation = tree.reserveChild(tree.identity("/root"), {
      id: "id-pending",
      taskName: "pending",
      maxDepth: 4,
      lastTaskMessage: "pending",
      reloadable: true,
    });
    const waiting = tree.wait(tree.identity("/root"), {});
    tree.rollbackReservation(reservation.effect);
    expect((await waiting).completed[0]).toMatchObject({
      agent_name: "/root/pending",
      agent_status: "not_found",
    });
  });

  test("cancellation removes the waiter without consuming a later notification", async () => {
    const tree = registry();
    const child = reserve(tree, "/root", "worker");
    const controller = new AbortController();
    const waiting = tree.wait(tree.identity("/root"), {}, controller.signal);
    expect(tree.pendingWaiterCount).toBe(1);
    controller.abort();
    expect(await waiting).toMatchObject({
      message: "Wait interrupted by new input.",
      completed: [],
      pending: [child.path],
    });
    expect(tree.pendingWaiterCount).toBe(0);
    finish(tree, child, { completed: "still visible" });
    expect((await tree.wait(tree.identity("/root"), {})).completed[0]?.agent_name)
      .toBe(child.path);
  });

  test("target and all ignore a prior-generation pending_init shutdown", async () => {
    const tree = registry();
    const root = tree.identity("/root");
    const child = reserve(tree, "/root", "worker");
    finish(tree, child, { completed: "epoch one" });
    tree.commitControllerEffect(
      tree.beginControllerEffect(root, child.path, "unload"),
    );
    tree.commitControllerEffect(
      tree.beginControllerEffect(root, child.path, "reload"),
    );
    tree.commitControllerEffect(
      tree.beginControllerEffect(root, child.path, "connect", 1),
    );
    tree.commitControllerEffect(
      tree.beginControllerEffect(root, child.path, "disconnect", 2),
    );

    const priorShutdown = await tree.wait(root, { target: child.path });
    expect(priorShutdown.completed[0]).toMatchObject({
      agent_status: "shutdown",
      active_epoch: 2,
      connection_generation: 2,
    });

    tree.commitControllerEffect(
      tree.beginControllerEffect(root, child.path, "reload"),
    );
    tree.commitControllerEffect(
      tree.beginControllerEffect(root, child.path, "connect", 2),
    );
    expect(tree.get(child.path)).toMatchObject({
      status: "pending_init",
      activeEpoch: null,
      nextActiveEpoch: 2,
      connectionGeneration: 3,
    });

    const targeted = tree.wait(root, { target: child.path });
    const all = tree.wait(root, { all: true });
    expect(tree.pendingWaiterCount).toBe(2);

    tree.updateController(root, child.path, { status: "shutdown" });
    for (const result of [await targeted, await all]) {
      expect(result.completed[0]).toMatchObject({
        agent_status: "shutdown",
        active_epoch: 2,
        connection_generation: 3,
      });
    }
  });

  test("target fast path reports current shutdown after completed is unloaded", async () => {
    const tree = registry();
    const root = tree.identity("/root");
    const child = reserve(tree, "/root", "worker");
    finish(tree, child, { completed: "epoch one" });
    tree.commitControllerEffect(
      tree.beginControllerEffect(root, child.path, "unload"),
    );

    expect((await tree.wait(root, { target: child.path })).completed[0])
      .toMatchObject({
        agent_status: "shutdown",
        terminal_revision: 2,
        active_epoch: 1,
        connection_generation: 1,
      });
    expect((await tree.wait(root, {})).completed[0]).toMatchObject({
      agent_status: { completed: "epoch one" },
      active_epoch: 1,
      connection_generation: 1,
    });
    expect(await tree.wait(root, {})).toMatchObject({
      message: "No agents to wait for.",
      completed: [],
    });
  });

  test("waiters observe reload restoration without queuing duplicate ANY notification", async () => {
    const tree = registry();
    const root = tree.identity("/root");
    const child = reserve(tree, "/root", "worker");
    finish(tree, child, { completed: "first" });
    const first = await tree.wait(root, {});
    tree.commitControllerEffect(
      tree.beginControllerEffect(root, child.path, "unload"),
    );
    tree.commitControllerEffect(
      tree.beginControllerEffect(root, child.path, "reload"),
    );
    tree.commitControllerEffect(
      tree.beginControllerEffect(root, child.path, "connect", 1),
    );

    const targeted = tree.wait(root, { target: child.path });
    const all = tree.wait(root, { all: true });
    tree.updateController(
      root,
      child.path,
      { status: { completed: "first" } },
      undefined,
      true,
    );

    expect(first.completed[0]?.terminal_revision).toBe(1);
    for (const result of [await targeted, await all]) {
      expect(result.completed[0]).toMatchObject({
        agent_status: { completed: "first" },
        active_epoch: 2,
        connection_generation: 2,
      });
    }
    expect(await tree.wait(root, {})).toMatchObject({
      message: "No agents to wait for.",
      completed: [],
    });
  });
});

const brokers: RootTreeBroker[] = [];
afterEach(async () => {
  await Promise.allSettled(brokers.splice(0).map((broker) => broker.close()));
});

describe("broker wait_agent cleanup", () => {
  test("remote cancellation removes the broker waiter", async () => {
    const root = await RootTreeBroker.createRoot({
      identity: { id: "root-id", path: "/root", depth: 0, maxDepth: 3 },
      maxResidentAgents: 8,
      maxActiveAgents: 8,
      dispatch: async () => ({}),
    });
    brokers.push(root);
    const grant = await root.reserveChild({
      id: "child-id",
      taskName: "child",
      maxDepth: 3,
      lastTaskMessage: "child",
      reloadable: true,
    });
    const child = await RootTreeBroker.connectChild({
      identity: {
        id: "child-id",
        path: grant.path,
        parentId: "root-id",
        parentPath: "/root",
        depth: 1,
        maxDepth: 3,
        connectionGeneration: grant.generation,
      },
      maxResidentAgents: 8,
      maxActiveAgents: 8,
      socketPath: root.endpoint!.socketPath,
      capability: grant.capability,
      dispatch: async () => ({}),
    });
    brokers.push(child);
    const pending = await child.reserveChild({
      id: "grand-id",
      taskName: "grand",
      maxDepth: 3,
      lastTaskMessage: "grand",
      reloadable: true,
    });
    const controller = new AbortController();
    const waiting = child.waitAgent({ all: true }, controller.signal);
    await delay(10);
    controller.abort();
    expect(await waiting).toMatchObject({
      message: "Wait interrupted by new input.",
      completed: [],
      pending: [pending.path],
    });
    for (let attempt = 0; attempt < 50 && (root.serverSecurityCounts?.waiters ?? 0) !== 0; attempt++)
      await delay(2);
    expect(root.serverSecurityCounts?.waiters).toBe(0);
    await child.releaseReservation(pending.path);

    for (const invalid of [
      { seconds: 1 },
      { target: "grand", all: true },
      { all: false },
    ]) await expect(child.waitAgent(invalid as any)).rejects.toThrow();

    const targetGrant = await child.reserveChild({
      id: "target-id",
      taskName: "target_wait",
      maxDepth: 3,
      lastTaskMessage: "target",
      reloadable: true,
    });
    const targetWait = child.waitAgent({ target: "target_wait" });
    await delay(10);
    await child.releaseReservation(targetGrant.path);
    expect(await targetWait).toMatchObject({
      timed_out: false,
      completed: [{ agent_name: targetGrant.path, agent_status: "not_found" }],
    });

  });
});
