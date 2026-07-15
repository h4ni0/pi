import { afterEach, describe, expect, test } from "bun:test";
import { PiMailbox } from "../runtime/pi-mailbox.ts";
import { RootTreeBroker } from "../runtime/root-tree-broker.ts";

const brokers: RootTreeBroker[] = [];
afterEach(async () => {
  await Promise.allSettled(brokers.splice(0).map((broker) => broker.close()));
});

async function child(
  root: RootTreeBroker,
  name: string,
  id: string,
  dispatch: (message: any) => Promise<any> = async () => ({}),
): Promise<RootTreeBroker> {
  const grant = await root.reserveChild({
    id,
    taskName: name,
    maxDepth: 3,
    lastTaskMessage: name,
    reloadable: true,
  });
  const broker = await RootTreeBroker.connectChild({
    identity: {
      id,
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
    dispatch,
  });
  brokers.push(broker);
  return broker;
}

describe("broker-owned mailbox routing", () => {
  test("idle MESSAGE A/B stay queued and NEW_TASK C drains one monotonic FIFO turn", async () => {
    const deliveries: any[] = [];
    let root!: RootTreeBroker;
    root = await RootTreeBroker.createRoot({
      identity: { id: "root-id", path: "/root", depth: 0, maxDepth: 3 },
      maxResidentAgents: 8,
      maxActiveAgents: 8,
      dispatch: async (dispatch) => {
        if (dispatch.op === "prepare_followup") return {};
        if (dispatch.op === "deliver_mailbox") {
          deliveries.push(dispatch.payload);
          return {};
        }
        return {};
      },
    });
    brokers.push(root);
    await child(root, "target", "target-id");
    await root.updateAgent("/root/target", { active: false }, 1);

    const a = await root.route("send", "target", "  MESSAGE A  ");
    const b = await root.route("send", "/root/target", "MESSAGE B");
    expect(a.delivery).toBe("queued");
    expect(b.delivery).toBe("queued");
    expect(deliveries).toHaveLength(0);

    const c = await root.route("followup", "target-id", "NEW_TASK C");
    expect(c.sequence).toBe(3);
    expect(c.started_turn).toBe(true);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].triggerTurn).toBe(true);
    expect(deliveries[0].items.map((item: any) => [item.seq, item.kind, item.message])).toEqual([
      [1, "MESSAGE", "  MESSAGE A  "],
      [2, "MESSAGE", "MESSAGE B"],
      [3, "NEW_TASK", "NEW_TASK C"],
    ]);

    const running = await root.route("followup", "target", "join running");
    expect(running.started_turn).toBe(false);
    expect(deliveries[1].triggerTurn).toBe(false);
    expect(deliveries[1].items).toHaveLength(1);
  });

  test("settlement before pump reclassifies follow-up and concurrent idle follow-ups activate exactly once", async () => {
    const deliveries: any[] = [];
    let preparations = 0;
    const root = await RootTreeBroker.createRoot({
      identity: { id: "root-id", path: "/root", depth: 0, maxDepth: 3 },
      maxResidentAgents: 8,
      maxActiveAgents: 8,
      dispatch: async (dispatch) => {
        if (dispatch.op === "prepare_followup") preparations += 1;
        if (dispatch.op === "deliver_mailbox") deliveries.push(dispatch.payload);
        return {};
      },
    });
    brokers.push(root);
    await child(root, "target", "target-id");

    const settlingRoute = root.route("followup", "/root/target", "after settle");
    await root.updateAgent("/root/target", { active: false }, 1);
    const settled = await settlingRoute;
    expect(settled.started_turn).toBe(true);
    expect(deliveries.at(-1).triggerTurn).toBe(true);
    await root.updateAgent("/root/target", { active: false }, 2);

    preparations = 0;
    deliveries.length = 0;
    const [first, second] = await Promise.all([
      root.route("followup", "/root/target", "first idle follow-up"),
      root.route("followup", "/root/target", "second idle follow-up"),
    ]);
    expect([first.delivery, second.delivery]).toEqual(["accepted", "accepted"]);
    expect(preparations).toBe(1);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].triggerTurn).toBe(true);
    expect(deliveries[0].items.map((item: any) => item.message)).toEqual([
      "first idle follow-up", "second idle follow-up",
    ]);
  });

  test("controller settlement lag reclassifies one queued follow-up without false failure or duplicate", async () => {
    const deliveries: any[] = [];
    let root!: RootTreeBroker;
    root = await RootTreeBroker.createRoot({
      identity: { id: "root-id", path: "/root", depth: 0, maxDepth: 3 },
      maxResidentAgents: 4,
      maxActiveAgents: 4,
      dispatch: async (dispatch) => {
        if (dispatch.op === "prepare_followup") return {};
        if (dispatch.op === "deliver_mailbox") {
          deliveries.push(dispatch.payload);
          if (deliveries.length === 1) {
            await root.updateAgent(
              "/root/target",
              { active: false, status: { completed: "natural" } },
              1,
            );
            return { disposition: "retry", reason: "target_settled" };
          }
          return { disposition: "accepted" };
        }
        return {};
      },
    });
    brokers.push(root);
    await child(root, "target", "target-id");
    const routed = await root.route("followup", "/root/target", "after natural settle");
    expect(routed.delivery).toBe("accepted");
    expect(routed.started_turn).toBe(true);
    expect(deliveries).toHaveLength(2);
    expect(deliveries[0].triggerTurn).toBe(false);
    expect(deliveries[1].triggerTurn).toBe(true);
    expect(deliveries[1].items.map((item: any) => item.eventId)).toEqual(
      deliveries[0].items.map((item: any) => item.eventId),
    );
  });

  test("new global active capacity wakes an already-owned follow-up pump", async () => {
    const deliveries: any[] = [];
    const root = await RootTreeBroker.createRoot({
      identity: { id: "root-id", path: "/root", depth: 0, maxDepth: 3 },
      maxResidentAgents: 4,
      maxActiveAgents: 2,
      dispatch: async (dispatch) => {
        if (dispatch.op === "deliver_mailbox") deliveries.push(dispatch.payload);
        return { disposition: "accepted" };
      },
    });
    brokers.push(root);
    await child(root, "capacity_target", "capacity-target-id");
    await root.updateAgent("/root/capacity_target", { active: false }, 1);
    await child(root, "capacity_blocker", "capacity-blocker-id");

    const owned = await root.route(
      "followup",
      "/root/capacity_target",
      "wake when capacity clears",
    );
    expect(owned.delivery).toBe("queued");
    expect(deliveries).toHaveLength(0);
    await root.updateAgent("/root/capacity_blocker", { active: false }, 1);
    const deadline = Date.now() + 2_000;
    while (deliveries.length === 0) {
      if (Date.now() >= deadline) throw new Error("capacity wake timed out");
      await Bun.sleep(10);
    }
    expect(deliveries[0].triggerTurn).toBe(true);
    expect(deliveries[0].items[0].message).toBe("wake when capacity clears");
  });

  test("delivery retries the same event IDs when active epoch changes before second-phase commit", async () => {
    const deliveries: any[] = [];
    let root!: RootTreeBroker;
    root = await RootTreeBroker.createRoot({
      identity: { id: "root-id", path: "/root", depth: 0, maxDepth: 3 },
      maxResidentAgents: 4,
      maxActiveAgents: 4,
      dispatch: async (dispatch) => {
        if (dispatch.op === "deliver_mailbox") {
          deliveries.push(dispatch.payload);
          if (deliveries.length === 1)
            await root.updateAgent("/root/target", { active: false }, 1);
        }
        return {};
      },
    });
    brokers.push(root);
    await child(root, "target", "target-id");
    const routed = await root.route("send", "/root/target", "epoch barrier");
    expect(routed.delivery).toBe("accepted");
    expect(deliveries).toHaveLength(2);
    expect(deliveries[1].items.map((item: any) => item.eventId)).toEqual(
      deliveries[0].items.map((item: any) => item.eventId),
    );
    expect(deliveries[1].triggerTurn).toBe(false);
  });

  test("child-to-root, sibling, cousin, descendant, absolute, relative, UUID routes work while root follow-up and cross-root fail", async () => {
    const targets: string[] = [];
    const root = await RootTreeBroker.createRoot({
      identity: { id: "root-id", path: "/root", depth: 0, maxDepth: 3 },
      maxResidentAgents: 8,
      maxActiveAgents: 8,
      dispatch: async (dispatch) => {
        if (dispatch.op === "deliver_mailbox") targets.push(dispatch.payload.targetPath);
        return {};
      },
    });
    brokers.push(root);
    const controllerDispatch = async (dispatch: any) => {
      if (dispatch.op === "deliver_mailbox") targets.push(dispatch.payload.targetPath);
      return {};
    };
    const alpha = await child(root, "alpha", "alpha-id", controllerDispatch);
    const beta = await child(root, "beta", "beta-id", controllerDispatch);
    const leafGrant = await alpha.reserveChild({
      id: "leaf-id", taskName: "leaf", maxDepth: 3,
      lastTaskMessage: "leaf", reloadable: true,
    });
    const leaf = await RootTreeBroker.connectChild({
      identity: {
        id: "leaf-id", path: leafGrant.path, parentId: "alpha-id",
        parentPath: "/root/alpha", depth: 2, maxDepth: 3,
        connectionGeneration: leafGrant.generation,
      },
      maxResidentAgents: 8,
      maxActiveAgents: 8,
      socketPath: root.endpoint!.socketPath,
      capability: leafGrant.capability,
      dispatch: async () => ({}),
    });
    brokers.push(leaf);
    const cousinGrant = await beta.reserveChild({
      id: "cousin-id", taskName: "cousin", maxDepth: 3,
      lastTaskMessage: "cousin", reloadable: true,
    });
    const cousin = await RootTreeBroker.connectChild({
      identity: {
        id: "cousin-id", path: cousinGrant.path, parentId: "beta-id",
        parentPath: "/root/beta", depth: 2, maxDepth: 3,
        connectionGeneration: cousinGrant.generation,
      },
      maxResidentAgents: 8,
      maxActiveAgents: 8,
      socketPath: root.endpoint!.socketPath,
      capability: cousinGrant.capability,
      dispatch: async () => ({}),
    });
    brokers.push(cousin);
    await alpha.route("send", "/root", "child to root");
    await alpha.route("send", "/root/beta", "sibling absolute");
    await root.route("send", "beta-id", "opaque alias");
    await alpha.route("send", "leaf", "relative descendant");
    await leaf.route("send", "/root/beta/cousin", "cousin route");
    expect(targets).toEqual([
      "/root", "/root/beta", "/root/beta", "/root/alpha/leaf",
      "/root/beta/cousin",
    ]);
    await expect(root.route("followup", "/root", "forbidden")).rejects.toThrow(
      "can't target the root",
    );
    await expect(root.route("send", "/other/root", "cross root")).rejects.toThrow();
  });

  test("hands off through sendMessage for idle, streaming, and nextTurn delivery", async () => {
    const submissions: any[] = [];
    const mailbox = new PiMailbox({
      sendMessage(message: any, options: any) {
        submissions.push({ message, options });
      },
    } as any);
    for (const input of [
      { eventId: "idle", triggerTurn: false, deliverAs: "steer" as const },
      { eventId: "streaming", triggerTurn: true, deliverAs: "followUp" as const },
      { eventId: "next", triggerTurn: false, deliverAs: "nextTurn" as const },
    ]) {
      await mailbox.insert({
        ...input,
        customType: "notice",
        content: input.eventId,
        details: { mode: input.eventId },
      });
    }
    expect(submissions.map((item) => item.options)).toEqual([
      { deliverAs: "steer", triggerTurn: false },
      { deliverAs: "followUp", triggerTurn: true },
      { deliverAs: "nextTurn", triggerTurn: false },
    ]);
    expect(submissions[0].message.details).toEqual({ mode: "idle" });
  });

  test("deduplicates stable event IDs and retries a synchronous handoff failure", async () => {
    let calls = 0;
    const mailbox = new PiMailbox({
      sendMessage() {
        calls += 1;
        if (calls === 1) throw new Error("handoff failed");
      },
    } as any);
    const input = {
      eventId: "stable", customType: "notice", content: "message", triggerTurn: false,
    };
    await expect(mailbox.insert(input)).rejects.toThrow("handoff failed");
    await mailbox.insert(input);
    await mailbox.insert(input);
    expect(calls).toBe(2);
  });

  test("rejects mailbox overflow before mutation", async () => {
    const root = await RootTreeBroker.createRoot({
      identity: { id: "root-id", path: "/root", depth: 0, maxDepth: 3 },
      maxResidentAgents: 4,
      maxActiveAgents: 4,
      dispatch: async () => ({}),
    });
    brokers.push(root);
    await child(root, "bounded", "bounded-id");
    const targetPath = "/root/bounded";
    await root.updateAgent(targetPath, { active: false, status: { completed: "idle" } }, 1);
    for (let index = 0; index < 64; index++)
      await root.route("send", targetPath, `queued-${index}`);
    await expect(root.route("send", targetPath, "overflow")).rejects.toThrow(
      "mailbox item limit",
    );
    expect((root as any).server.mailboxByPath.get(targetPath)).toHaveLength(64);
    expect((root as any).server.registry.get(targetPath)).toMatchObject({
      mailboxPending: 64,
      activeEpoch: null,
    });
  });

  test("follow-up retries its committed activation epoch after a pre-accept failure", async () => {
    const deliveries: any[] = [];
    const root = await RootTreeBroker.createRoot({
      identity: { id: "root-id", path: "/root", depth: 0, maxDepth: 3 },
      maxResidentAgents: 4,
      maxActiveAgents: 4,
      dispatch: async (dispatch) => {
        if (dispatch.op === "prepare_followup") return {};
        if (dispatch.op !== "deliver_mailbox") return {};
        deliveries.push(dispatch.payload);
        if (deliveries.length === 1) throw new Error("pre-accept failure");
        return { disposition: "accepted" };
      },
    });
    brokers.push(root);
    await child(root, "activation", "activation-id");
    const targetPath = "/root/activation";
    await root.updateAgent(targetPath, { active: false, status: { completed: "idle" } }, 1);

    const result = await root.route("followup", targetPath, "again");
    expect(result.delivery).toBe("queued");
    expect((root as any).server.registry.get(targetPath)).toMatchObject({ activeEpoch: 2 });
    const deadline = Date.now() + 2_000;
    while (deliveries.length < 2) {
      if (Date.now() >= deadline) throw new Error("activation retry timed out");
      await Bun.sleep(10);
    }
    expect(deliveries.map((delivery) => delivery.triggerTurn)).toEqual([true, true]);
    expect(deliveries[1].items[0].eventId).toBe(deliveries[0].items[0].eventId);
    expect((root as any).server.registry.get(targetPath)).toMatchObject({
      activeEpoch: 2,
      mailboxPending: 0,
    });
  });

  test("lost delivery ACK after fast settlement does not allocate a phantom epoch", async () => {
    let root!: RootTreeBroker;
    const deliveries: any[] = [];
    root = await RootTreeBroker.createRoot({
      identity: { id: "root-id", path: "/root", depth: 0, maxDepth: 3 },
      maxResidentAgents: 4,
      maxActiveAgents: 4,
      dispatch: async (dispatch) => {
        if (dispatch.op === "prepare_followup") return {};
        if (dispatch.op !== "deliver_mailbox") return {};
        deliveries.push(dispatch.payload);
        if (deliveries.length === 1) {
          await root.updateAgent(
            "/root/lost_ack",
            { active: false, status: { completed: "fast" } },
            dispatch.payload.activeEpoch,
          );
          throw new Error("delivery ACK lost after acceptance");
        }
        return { disposition: "accepted" };
      },
    });
    brokers.push(root);
    await child(root, "lost_ack", "lost-ack-id");
    await root.updateAgent("/root/lost_ack", { active: false }, 1);

    const result = await root.route("followup", "/root/lost_ack", "once");
    expect(result.delivery).toBe("queued");
    const deadline = Date.now() + 2_000;
    while (deliveries.length < 2) {
      if (Date.now() >= deadline) throw new Error("lost ACK retry timed out");
      await Bun.sleep(5);
    }
    expect(deliveries.map((delivery) => [delivery.triggerTurn, delivery.activeEpoch]))
      .toEqual([[true, 2], [false, 2]]);
    expect((root as any).server.registry.get("/root/lost_ack")).toMatchObject({
      activeEpoch: null,
      nextActiveEpoch: 3,
      mailboxPending: 0,
      status: { completed: "fast" },
    });
  });

  test("retains lost-ACK activation ownership across target disconnect", async () => {
    let root!: RootTreeBroker;
    let target!: RootTreeBroker;
    let delivered = false;
    root = await RootTreeBroker.createRoot({
      identity: { id: "root-id", path: "/root", depth: 0, maxDepth: 3 },
      maxResidentAgents: 4,
      maxActiveAgents: 4,
      dispatch: async (dispatch) => {
        if (dispatch.op === "prepare_followup") return {};
        if (dispatch.op === "disconnect_cleanup") return {
          closed: true,
          connectionGeneration: dispatch.payload.connectionGeneration,
        };
        if (dispatch.op !== "deliver_mailbox") return {};
        if (!delivered) {
          delivered = true;
          await root.updateAgent(
            "/root/disconnected_ack",
            { active: false, status: { completed: "fast" } },
            dispatch.payload.activeEpoch,
          );
          await target.close();
          throw new Error("delivery ACK and target connection lost");
        }
        return { disposition: "accepted" };
      },
    });
    brokers.push(root);
    target = await child(root, "disconnected_ack", "disconnected-ack-id");
    await root.updateAgent("/root/disconnected_ack", { active: false }, 1);
    await root.route("followup", "/root/disconnected_ack", "once");

    const deadline = Date.now() + 2_000;
    while ((root as any).server.registry.get("/root/disconnected_ack")?.registered) {
      if (Date.now() >= deadline) throw new Error("disconnect reconciliation timed out");
      await Bun.sleep(5);
    }
    expect(
      (root as any).server.pendingMailboxActivationEpochs.get(
        "/root/disconnected_ack",
      ),
    ).toBe(2);
    expect((root as any).server.registry.get("/root/disconnected_ack")).toMatchObject({
      activeEpoch: null,
      nextActiveEpoch: 3,
      mailboxPending: 1,
      registered: false,
    });
  });

  test("retains activation ownership when accepted ACK races disconnect", async () => {
    let root!: RootTreeBroker;
    let target!: RootTreeBroker;
    root = await RootTreeBroker.createRoot({
      identity: { id: "root-id", path: "/root", depth: 0, maxDepth: 3 },
      maxResidentAgents: 4,
      maxActiveAgents: 4,
      dispatch: async (dispatch) => {
        if (dispatch.op === "prepare_followup") return {};
        if (dispatch.op === "disconnect_cleanup") return {
          closed: true,
          connectionGeneration: dispatch.payload.connectionGeneration,
        };
        if (dispatch.op === "deliver_mailbox") {
          await root.updateAgent(
            "/root/accepted_disconnect",
            { active: false, status: { completed: "fast" } },
            dispatch.payload.activeEpoch,
          );
          await target.close();
          return { disposition: "accepted" };
        }
        return {};
      },
    });
    brokers.push(root);
    target = await child(root, "accepted_disconnect", "accepted-disconnect-id");
    await root.updateAgent("/root/accepted_disconnect", { active: false }, 1);
    await root.route("followup", "/root/accepted_disconnect", "once");

    const deadline = Date.now() + 2_000;
    while ((root as any).server.registry.get("/root/accepted_disconnect")?.registered) {
      if (Date.now() >= deadline) throw new Error("disconnect reconciliation timed out");
      await Bun.sleep(5);
    }
    expect(
      (root as any).server.pendingMailboxActivationEpochs.get(
        "/root/accepted_disconnect",
      ),
    ).toBe(2);
    expect((root as any).server.registry.get("/root/accepted_disconnect"))
      .toMatchObject({ activeEpoch: null, nextActiveEpoch: 3, mailboxPending: 1 });
  });

  test("holds canonical capacity until exact disconnect cleanup is acknowledged", async () => {
    let releaseCleanup!: () => void;
    let cleanupSeen = false;
    const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    const root = await RootTreeBroker.createRoot({
      identity: { id: "root-id", path: "/root", depth: 0, maxDepth: 3 },
      maxResidentAgents: 2,
      maxActiveAgents: 2,
      dispatch: async (dispatch) => {
        if (dispatch.op === "disconnect_cleanup") {
          cleanupSeen = true;
          await cleanupGate;
          return {
            closed: true,
            connectionGeneration: dispatch.payload.connectionGeneration,
          };
        }
        return {};
      },
    });
    brokers.push(root);
    const target = await child(root, "cleanup_gate", "cleanup-gate-id");
    await target.close();
    const deadline = Date.now() + 2_000;
    while (!cleanupSeen) {
      if (Date.now() >= deadline) throw new Error("disconnect cleanup was not observed");
      await Bun.sleep(5);
    }
    expect((root as any).server.registry.get("/root/cleanup_gate")).toMatchObject({
      registered: true,
      resident: true,
    });
    releaseCleanup();
    while ((root as any).server.registry.get("/root/cleanup_gate")?.registered) {
      if (Date.now() >= deadline) throw new Error("disconnect cleanup did not commit");
      await Bun.sleep(5);
    }
  });

  test("reconciles a target disconnect that races a pending activation effect", async () => {
    let releasePrepare!: () => void;
    const prepareGate = new Promise<void>((resolve) => { releasePrepare = resolve; });
    let prepareSeen = false;
    const operations: string[] = [];
    const root = await RootTreeBroker.createRoot({
      identity: { id: "root-id", path: "/root", depth: 0, maxDepth: 3 },
      maxResidentAgents: 4,
      maxActiveAgents: 4,
      dispatch: async (dispatch) => {
        operations.push(dispatch.op);
        if (dispatch.op === "prepare_followup") {
          prepareSeen = true;
          await prepareGate;
        }
        if (dispatch.op === "disconnect_cleanup") return {
          closed: true,
          connectionGeneration: dispatch.payload.connectionGeneration,
        };
        return { disposition: "accepted" };
      },
    });
    brokers.push(root);
    const target = await child(root, "disconnecting", "disconnecting-id");
    await root.updateAgent(
      "/root/disconnecting",
      { active: false, status: { completed: "idle" } },
      1,
    );
    const route = root.route("followup", "/root/disconnecting", "wake");
    const deadline = Date.now() + 2_000;
    while (!prepareSeen) {
      if (Date.now() >= deadline) throw new Error("prepare_followup was not observed");
      await Bun.sleep(5);
    }
    await target.close();
    releasePrepare();
    await route;
    while ((root as any).server.registry.get("/root/disconnecting")?.registered) {
      if (Date.now() >= deadline) throw new Error("disconnect reconciliation timed out");
      await Bun.sleep(5);
    }
    expect((root as any).server.registry.get("/root/disconnecting")).toMatchObject({
      registered: false,
      resident: false,
      activeEpoch: null,
    });
    expect(operations).toContain("disconnect_cleanup");
  });

  test("fast settlement observes the committed activation epoch before delivery returns", async () => {
    let root!: RootTreeBroker;
    const deliveries: any[] = [];
    root = await RootTreeBroker.createRoot({
      identity: { id: "root-id", path: "/root", depth: 0, maxDepth: 3 },
      maxResidentAgents: 4,
      maxActiveAgents: 4,
      dispatch: async (dispatch) => {
        if (dispatch.op === "prepare_followup") return {};
        if (dispatch.op !== "deliver_mailbox") return {};
        deliveries.push(dispatch.payload);
        if (dispatch.payload.triggerTurn) {
          await root.updateAgent(
            "/root/fast",
            { active: false, status: { completed: "fast" } },
            dispatch.payload.activeEpoch,
          );
        }
        return { disposition: "accepted" };
      },
    });
    brokers.push(root);
    await child(root, "fast", "fast-id");
    await root.updateAgent("/root/fast", { active: false, status: { completed: "idle" } }, 1);

    const result = await root.route("followup", "/root/fast", "fast turn");
    expect(result.delivery).toBe("accepted");
    expect(deliveries.map((delivery) => delivery.triggerTurn)).toEqual([true, false]);
    expect((root as any).server.registry.get("/root/fast")).toMatchObject({
      activeEpoch: null,
      mailboxPending: 0,
      status: { completed: "fast" },
    });
  });

  test("pre-accept pump failure returns owned success and retries the same item without caller duplication", async () => {
    const deliveries: any[] = [];
    let attempts = 0;
    const mailbox = new PiMailbox({
      sendMessage() {
        attempts += 1;
        if (attempts === 1) throw new Error("handoff rejected");
      },
    } as any);
    const root = await RootTreeBroker.createRoot({
      identity: { id: "root-id", path: "/root", depth: 0, maxDepth: 3 },
      maxResidentAgents: 4,
      maxActiveAgents: 4,
      dispatch: async (dispatch) => {
        if (dispatch.op !== "deliver_mailbox") return {};
        deliveries.push(dispatch.payload);
        await mailbox.insert({
          eventId: `batch_${dispatch.payload.items[0].eventId}_${dispatch.payload.items.at(-1).eventId}`,
          customType: "notice",
          content: "batch",
          triggerTurn: dispatch.payload.triggerTurn,
        });
        return { disposition: "accepted" };
      },
    });
    brokers.push(root);
    await child(root, "ownership", "ownership-id");
    const owned = await root.route("send", "/root/ownership", "first");
    expect(owned.delivery).toBe("queued");
    const deadline = Date.now() + 2_000;
    while (deliveries.length < 2) {
      if (Date.now() >= deadline) throw new Error("owned mailbox retry timed out");
      await Bun.sleep(10);
    }
    expect(deliveries[0].items).toHaveLength(1);
    expect(deliveries[1].items).toHaveLength(1);
    expect(deliveries[1].items[0].eventId).toBe(deliveries[0].items[0].eventId);
    expect(deliveries[1].items[0].message).toBe("first");
    expect(attempts).toBe(2);
  });
});
