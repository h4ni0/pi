import { describe, expect, test } from "bun:test";
import { RootTreeRegistry } from "../runtime/root-tree-registry.ts";
import type { RootTreeEffectToken, RootTreeIdentity } from "../types.ts";

function registry(maxDepth = 3, capacity = 8) {
  return new RootTreeRegistry({
    root: { id: "root-id", path: "/root", depth: 0, maxDepth },
    maxResidentAgents: capacity,
    maxActiveAgents: capacity,
    now: (() => {
      let value = 0;
      return () => ++value;
    })(),
  });
}

function reserve(
  tree: RootTreeRegistry,
  parentPath: string,
  taskName: string,
  id = `uuid-${taskName}`,
) {
  const reservation = tree.reserveChild(tree.identity(parentPath), {
    id,
    taskName,
    maxDepth: tree.identity(parentPath).maxDepth,
    lastTaskMessage: `task ${taskName}`,
    reloadable: true,
  });
  tree.commitReservation(reservation.effect);
  return tree.identity(reservation.path);
}

function idle(tree: RootTreeRegistry, child: RootTreeIdentity) {
  const effect = tree.beginControllerEffect(
    tree.identity(child.parentPath!),
    child.path,
    "deactivate",
  );
  tree.commitControllerEffect(effect);
}

describe("pure root-tree registry identity and resolution", () => {
  test("resolves root, siblings, descendants, UUIDs, local, relative, absolute, and cross-branch paths", () => {
    const tree = registry();
    const a = reserve(tree, "/root", "a", "uuid-a");
    const b = reserve(tree, "/root", "b", "uuid-b");
    const child = reserve(tree, a.path, "child", "uuid-child");
    expect(tree.resolveTarget(child, "/root").path).toBe("/root");
    expect(tree.resolveTarget(tree.identity("/root"), "a").path).toBe(a.path);
    expect(tree.resolveTarget(a, "child").path).toBe(child.path);
    expect(tree.resolveTarget(b, "uuid-child").path).toBe(child.path);
    expect(tree.resolveTarget(child, "/root/b").path).toBe(b.path);
    expect(tree.resolveTarget(b, "/root/a/child").path).toBe(child.path);
  });

  test("rejects cross-root references and preserves tree-wide path/ID uniqueness", () => {
    const tree = registry();
    reserve(tree, "/root", "a", "uuid-a");
    expect(() => tree.resolveTarget(tree.identity("/root"), "/other/a")).toThrow();
    expect(() => reserve(tree, "/root", "a", "uuid-other")).toThrow("already reserved");
    expect(() => reserve(tree, "/root", "b", "uuid-a")).toThrow("already reserved");
  });

  test("keeps opaque aliases disjoint and rejects every ambiguous bare alias", () => {
    const tree = registry();
    reserve(tree, "/root", "worker", "uuid-worker");
    expect(() => reserve(tree, "/root", "other", "worker")).toThrow("ambiguous");

    const second = registry();
    reserve(second, "/root", "first", "opaque");
    expect(() => reserve(second, "/root", "opaque", "uuid-second")).toThrow(
      "ambiguous",
    );
    expect(() => reserve(second, "/root", "same", "same")).toThrow("ambiguous");
  });

  test("lists segment-aware prefixes in stable code-point path order", () => {
    const tree = registry();
    reserve(tree, "/root", "z", "uuid-z");
    const a = reserve(tree, "/root", "a", "uuid-a");
    reserve(tree, a.path, "z", "uuid-az");
    reserve(tree, a.path, "a", "uuid-aa");
    reserve(tree, "/root", "a2", "uuid-a2");
    expect(tree.list(tree.identity("/root")).agents.map((item) => item.agent_name))
      .toEqual(["/root", "/root/a", "/root/a/a", "/root/a/z", "/root/a2", "/root/z"]);
    expect(tree.list(tree.identity("/root"), "a").agents.map((item) => item.agent_name))
      .toEqual(["/root/a", "/root/a/a", "/root/a/z"]);
  });
});

describe("root-tree depth, capacity, and leases", () => {
  test("rejects Pi depth independently in the root registry", () => {
    const tree = registry(1);
    const child = reserve(tree, "/root", "child");
    expect(() => tree.reserveChild(child, {
      id: "uuid-grandchild",
      taskName: "grandchild",
      maxDepth: 1,
      lastTaskMessage: "no",
      reloadable: true,
    })).toThrow("maxDepth 1 reached at depth 1");
    const forged = { ...child, depth: 0 };
    expect(() => tree.reserveChild(forged, {
      id: "uuid-forged",
      taskName: "forged",
      maxDepth: 1,
      lastTaskMessage: "no",
      reloadable: true,
    })).toThrow("depth/parent metadata");
  });

  test("defaults to root plus fifteen resident/executing workers", () => {
    const tree = new RootTreeRegistry({
      root: { id: "root-id", path: "/root", depth: 0, maxDepth: 2 },
    });
    for (let index = 0; index < 15; index += 1)
      reserve(tree, "/root", `worker_${index}`);
    expect(() => reserve(tree, "/root", "worker_15"))
      .toThrow("capacity (16) is full");
  });

  test("reservation rollback is transactional and stale effect tokens cannot commit", () => {
    const tree = registry();
    const pending = tree.reserveChild(tree.identity("/root"), {
      id: "uuid-pending",
      taskName: "pending",
      maxDepth: 3,
      lastTaskMessage: "pending",
      reloadable: true,
    });
    expect(tree.get(pending.path)?.reservationLease?.id).toBe(pending.effect.id);
    tree.rollbackReservation(pending.effect);
    expect(tree.get(pending.path)).toBeUndefined();
    expect(() => tree.commitReservation(pending.effect)).toThrow("stale");
    expect(() => reserve(tree, "/root", "pending", "uuid-pending")).not.toThrow();
  });

  test("keeps committed canonical paths and opaque ids reserved after reload pruning", () => {
    const tree = registry(2, 3);
    const root = tree.identity("/root");
    for (let index = 0; index < 1_030; index++) {
      const child = reserve(
        tree,
        "/root",
        `retained_${index}`,
        `opaque-${index}`,
      );
      idle(tree, child);
      tree.commitControllerEffect(
        tree.beginControllerEffect(root, child.path, "unload"),
      );
    }
    expect(tree.get("/root/retained_0")).toBeUndefined();
    expect(tree.takePrunedPaths()).toEqual([
      "/root/retained_0",
      "/root/retained_1",
      "/root/retained_2",
      "/root/retained_3",
      "/root/retained_4",
      "/root/retained_5",
    ]);
    expect(tree.takePrunedPaths()).toEqual([]);
    expect(tree.resolveTarget(root, "/root/retained_0")).toMatchObject({
      id: "opaque-0",
      path: "/root/retained_0",
      status: "not_found",
      resident: false,
      registered: false,
      retired: true,
    });
    expect(tree.resolveTarget(root, "opaque-0")).toMatchObject({
      path: "/root/retained_0",
      retired: true,
    });
    expect(tree.list(root, "/root/retained_0")).toEqual({ agents: [] });
    expect(() => reserve(tree, "/root", "retained_0", "new-opaque"))
      .toThrow("already reserved");
    expect(() => reserve(tree, "/root", "new_name", "opaque-0"))
      .toThrow("already reserved");
  });

  test("pending controller unload blocks a racing descendant reservation", () => {
    const tree = registry();
    const parent = reserve(tree, "/root", "parent", "uuid-parent");
    const controller = tree.identity("/root");
    tree.commitControllerEffect(
      tree.beginControllerEffect(controller, parent.path, "deactivate"),
    );
    const unload = tree.beginControllerEffect(
      controller,
      parent.path,
      "unload",
    );
    expect(() => tree.reserveChild(parent, {
      id: "uuid-racing-child",
      taskName: "racing_child",
      maxDepth: parent.maxDepth,
      lastTaskMessage: "must not orphan",
      reloadable: true,
    })).toThrow("controller /root/parent is unloading");
    tree.rollbackEffect(unload);
    expect(reserve(tree, parent.path, "safe_child", "uuid-safe-child").path)
      .toBe("/root/parent/safe_child");
  });

  test("concurrent capacity claims include uncommitted reservation leases", () => {
    const tree = registry(2, 2);
    const first = tree.reserveChild(tree.identity("/root"), {
      id: "uuid-first",
      taskName: "first",
      maxDepth: 2,
      lastTaskMessage: "first",
      reloadable: true,
    });
    expect(() => tree.reserveChild(tree.identity("/root"), {
      id: "uuid-second",
      taskName: "second",
      maxDepth: 2,
      lastTaskMessage: "second",
      reloadable: true,
    })).toThrow("capacity (2) is full");
    tree.rollbackReservation(first.effect);
    expect(() => reserve(tree, "/root", "second", "uuid-second")).not.toThrow();
  });

  test("later validation failure never destructively evicts an idle resident", () => {
    const tree = registry(2, 3);
    const a = reserve(tree, "/root", "a");
    reserve(tree, "/root", "b");
    idle(tree, a);
    expect(() => tree.reserveChild(tree.identity("/root"), {
      id: "uuid-c",
      taskName: "c",
      maxDepth: 99,
      lastTaskMessage: "invalid inherited depth",
      reloadable: true,
    })).toThrow("inherited");
    expect(tree.get(a.path)).toMatchObject({ resident: true, registered: true });
  });

  test("pending activation claims reserve the final active slot until commit or rollback", () => {
    const tree = new RootTreeRegistry({
      root: { id: "root-id", path: "/root", depth: 0, maxDepth: 2 },
      maxResidentAgents: 3,
      maxActiveAgents: 2,
    });
    const a = reserve(tree, "/root", "a");
    idle(tree, a);
    const b = reserve(tree, "/root", "b");
    idle(tree, b);

    const first = tree.beginControllerEffect(tree.identity("/root"), a.path, "activate");
    expect(() =>
      tree.beginControllerEffect(tree.identity("/root"), b.path, "activate"),
    ).toThrow("active-agent capacity (2) is full");
    tree.rollbackEffect(first);

    const second = tree.beginControllerEffect(tree.identity("/root"), b.path, "activate");
    expect(tree.commitControllerEffect(second).activeEpoch).toBe(2);
  });

  test("pending reload claims reserve the final resident slot until commit or rollback", () => {
    const tree = registry(2, 2);
    const controller = tree.identity("/root");
    const a = reserve(tree, "/root", "a");
    idle(tree, a);
    tree.commitControllerEffect(tree.beginControllerEffect(controller, a.path, "unload"));
    const b = reserve(tree, "/root", "b");
    idle(tree, b);
    tree.commitControllerEffect(tree.beginControllerEffect(controller, b.path, "unload"));

    const first = tree.beginControllerEffect(controller, a.path, "reload");
    expect(() => tree.beginControllerEffect(controller, b.path, "reload")).toThrow(
      "resident-agent capacity (2) is full",
    );
    tree.rollbackEffect(first);

    const second = tree.beginControllerEffect(controller, b.path, "reload");
    expect(tree.commitControllerEffect(second)).toMatchObject({
      resident: true,
      status: "pending_init",
    });
  });
});

describe("controller-correlated reducer effects", () => {
  test("only the controller can mutate resources and self reports require the active epoch", () => {
    const tree = registry();
    const a = reserve(tree, "/root", "a");
    const b = reserve(tree, "/root", "b");
    expect(() => tree.beginControllerEffect(b, a.path, "deactivate")).toThrow(
      "owning controller",
    );
    expect(() => tree.reportSelf(a, 999, { status: "interrupted" })).toThrow(
      "epoch is stale",
    );
    expect(() => tree.reportSelf(a, 1, { mailboxPending: 8 } as any)).toThrow(
      "resource field",
    );
    expect(tree.reportSelf(a, 1, { status: { completed: "done" }, lastOutput: "done" }))
      .toMatchObject({ resident: true, registered: true, activeEpoch: 1 });
    expect(tree.retainedTerminalEventCount).toBe(1);
    expect(tree.reportSelf(a, 1, { status: { completed: "done" }, lastOutput: "same" }))
      .toMatchObject({ lastOutput: "same" });
    expect(tree.retainedTerminalEventCount).toBe(1);
    expect(() => tree.reportSelf(a, 1, { status: "running" })).toThrow(
      "already reported its terminal status",
    );
    expect(() => tree.reportSelf(a, 1, { status: { errored: "changed" } })).toThrow(
      "already reported its terminal status",
    );
    tree.updateController(tree.identity("/root"), a.path, { status: "running" }, 1);
    expect(() => tree.reportSelf(a, 1, { status: "interrupted" })).toThrow(
      "already reported its terminal status",
    );
    tree.updateController(
      tree.identity("/root"),
      a.path,
      { status: { completed: "done" } },
      1,
    );
    expect(tree.retainedTerminalEventCount).toBe(1);
    idle(tree, a);
    expect(() => tree.reportSelf(a, null as any, { status: "shutdown" })).toThrow(
      "Idle agents cannot report",
    );
    expect(tree.get(a.path)?.status).toEqual({ completed: "done" });

    tree.commitControllerEffect(
      tree.beginControllerEffect(tree.identity("/root"), a.path, "activate"),
    );
    expect(() => tree.reportSelf(a, 2, { status: "shutdown" })).toThrow(
      "cannot claim process or registry terminal status",
    );
    expect(tree.reportSelf(a, 2, { status: "interrupted" })).toMatchObject({
      status: "interrupted",
      activeEpoch: 2,
    });
    expect(tree.retainedTerminalEventCount).toBe(2);
  });

  test("controller update validation is atomic and rolls back all metadata", () => {
    const tree = registry();
    const child = reserve(tree, "/root", "child");
    const controller = tree.identity("/root");

    expect(() => tree.updateControllerAtomic(
      controller,
      child.path,
      {
        status: "interrupted",
        lastTaskMessage: "must roll back",
        lastOutput: "must roll back",
        mailboxPending: 8,
        outboxPending: 9,
        reloadable: false,
      },
      { resident: false },
    )).toThrow("reloadable idle resident");
    expect(tree.get(child.path)).toMatchObject({
      status: "pending_init",
      lastTaskMessage: "task child",
      lastOutput: null,
      mailboxPending: 0,
      outboxPending: 0,
      reloadable: true,
      resident: true,
      activeEpoch: 1,
    });

    expect(() => tree.updateControllerAtomic(
      controller,
      child.path,
      { status: "interrupted" },
      { active: "yes" } as any,
    )).toThrow("must be boolean");
    expect(tree.get(child.path)?.status).toBe("pending_init");
  });

  test("effect tokens commit only at the reserved resource/connection epoch", () => {
    const tree = registry();
    const child = reserve(tree, "/root", "child");
    const controller = tree.identity("/root");
    const effect = tree.beginControllerEffect(controller, child.path, "deactivate");
    const forged = { ...effect } as RootTreeEffectToken;
    expect(() => tree.commitControllerEffect(forged)).toThrow("unknown or stale");
    expect(tree.commitControllerEffect(effect).activeEpoch).toBeNull();
    expect(() => tree.commitControllerEffect(effect)).toThrow("unknown or stale");
  });

  test("a simulated I/O effect may re-enter list/reserve without broker deadlock", async () => {
    const tree = registry(3, 6);
    const child = reserve(tree, "/root", "child");
    idle(tree, child);
    const effect = tree.beginControllerEffect(
      tree.identity("/root"),
      child.path,
      "activate",
    );
    const simulatedIo = Promise.resolve().then(() => {
      expect(tree.list(tree.identity("/root")).agents.length).toBe(2);
      reserve(tree, "/root", "sibling");
      return "ack";
    });
    expect(await simulatedIo).toBe("ack");
    expect(tree.commitControllerEffect(effect).activeEpoch).toBe(2);
  });
});
