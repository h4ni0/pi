import { describe, expect, test } from "bun:test";
import {
  RootTreeBroker,
  type BrokerDispatch,
  type BrokerDispatchHandler,
} from "../runtime/root-tree-broker.ts";

interface BrokerPair {
  root: RootTreeBroker;
  child: RootTreeBroker;
  childPath: string;
}

async function createPair(options: {
  maxDepth?: number;
  maxActiveAgents?: number;
  rootDispatch?: BrokerDispatchHandler;
  childDispatch?: BrokerDispatchHandler;
} = {}): Promise<BrokerPair> {
  const maxDepth = options.maxDepth ?? 2;
  const maxActiveAgents = options.maxActiveAgents ?? 6;
  const root = await RootTreeBroker.createRoot({
    identity: { id: "root-id", path: "/root", depth: 0, maxDepth },
    maxResidentAgents: 6,
    maxActiveAgents,
    dispatch: options.rootDispatch ?? (async () => ({})),
  });
  try {
    const reservation = await root.reserveChild({
      id: "child-id",
      taskName: "child",
      maxDepth,
      lastTaskMessage: "child task",
      reloadable: true,
    });
    const endpoint = root.endpoint!;
    const child = await RootTreeBroker.connectChild({
      identity: {
        id: "child-id",
        path: reservation.path,
        parentId: "root-id",
        parentPath: "/root",
        depth: 1,
        maxDepth,
      },
      maxResidentAgents: 6,
      maxActiveAgents,
      socketPath: endpoint.socketPath,
      capability: reservation.capability,
      dispatch: options.childDispatch ?? (async () => ({})),
    });
    return { root, child, childPath: reservation.path };
  } catch (error) {
    await root.close();
    throw error;
  }
}

async function closePair(pair: BrokerPair): Promise<void> {
  await pair.child.close().catch(() => undefined);
  await pair.root.close().catch(() => undefined);
}

async function within<T>(promise: Promise<T>, timeoutMs = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("broker operation timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe("root-tree broker reducer integration", () => {
  test("reserveChild enforces the caller depth gate before issuing a request", async () => {
    const pair = await createPair({ maxDepth: 1 });
    try {
      let requests = 0;
      const original = (pair.child as any).request;
      (pair.child as any).request = () => {
        requests += 1;
        throw new Error("request I/O reached");
      };
      try {
        await expect(pair.child.reserveChild({
          id: "grandchild-id",
          taskName: "grandchild",
          maxDepth: 1,
          lastTaskMessage: "must not spawn",
          reloadable: true,
        })).rejects.toThrow("maxDepth 1 reached at depth 1");
        expect(requests).toBe(0);
      } finally {
        (pair.child as any).request = original;
      }
    } finally {
      await closePair(pair);
    }
  });

  test("self reports carry their epoch and idle self reports cannot mutate state", async () => {
    const pair = await createPair();
    try {
      await expect(pair.child.updateAgent(pair.childPath, {
        status: "interrupted",
      })).rejects.toThrow("carry a valid active turn epoch");
      expect((await pair.root.list()).agents.find(
        (agent) => agent.agent_name === pair.childPath,
      )?.agent_status).toBe("pending_init");

      await pair.child.updateAgent(pair.childPath, {
        status: "interrupted",
        lastOutput: "accepted",
      }, 1);
      await pair.root.updateAgent(pair.childPath, { active: false });
      await expect(pair.child.updateAgent(pair.childPath, {
        status: "shutdown",
        lastOutput: "must not apply",
      }, 1)).rejects.toThrow("Idle agents cannot report");
      expect((await pair.root.list()).agents.find(
        (agent) => agent.agent_name === pair.childPath,
      )?.agent_status).toBe("interrupted");
    } finally {
      await closePair(pair);
    }
  });

  test("a stale controller epoch cannot mutate, deactivate, or release active capacity", async () => {
    const pair = await createPair({ maxActiveAgents: 2 });
    try {
      await pair.root.updateAgent(pair.childPath, { active: false }, 1);
      await pair.root.updateAgent(pair.childPath, { active: true });

      await expect(pair.root.updateAgent(pair.childPath, {
        status: { completed: "stale settlement" },
        lastTaskMessage: "stale task",
        lastOutput: "stale output",
        active: false,
      }, 1)).rejects.toThrow("Active turn epoch is stale");
      expect((await pair.root.list()).agents.find(
        (agent) => agent.agent_name === pair.childPath,
      )).toEqual({
        agent_name: pair.childPath,
        agent_status: "running",
        last_task_message: "child task",
      });
      await expect(pair.root.reserveChild({
        id: "capacity-proof-id",
        taskName: "capacity_proof",
        maxDepth: 2,
        lastTaskMessage: "must remain full",
        reloadable: true,
      })).rejects.toThrow("active-agent capacity (2) is full");

      await pair.root.updateAgent(pair.childPath, {
        status: { completed: "current settlement" },
        active: false,
      }, 2);
      const reservation = await pair.root.reserveChild({
        id: "capacity-proof-id",
        taskName: "capacity_proof",
        maxDepth: 2,
        lastTaskMessage: "capacity released by epoch 2",
        reloadable: true,
      });
      await pair.root.releaseReservation(reservation.path);
    } finally {
      await closePair(pair);
    }
  });

  test("a failed resource transition rolls back every controller metadata field", async () => {
    const pair = await createPair();
    try {
      await expect(pair.root.updateAgent(pair.childPath, {
        status: "interrupted",
        lastTaskMessage: "must not apply",
        lastOutput: "must not apply",
        reloadable: false,
        mailboxPending: 8,
        outboxPending: 9,
        resident: false,
      })).rejects.toThrow("reloadable idle resident");
      const child = (await pair.root.list()).agents.find(
        (agent) => agent.agent_name === pair.childPath,
      );
      expect(child).toEqual({
        agent_name: pair.childPath,
        agent_status: "pending_init",
        last_task_message: "child task",
      });
      // A later unload proves the rejected update did not partially clear reloadability.
      await pair.root.updateAgent(pair.childPath, { active: false });
      await pair.root.updateAgent(pair.childPath, { resident: false });
    } finally {
      await closePair(pair);
    }
  });

  test("cleans per-target mailbox state when compact committed tombstones retire", async () => {
    const root = await RootTreeBroker.createRoot({
      identity: { id: "root-id", path: "/root", depth: 0, maxDepth: 2 },
      maxResidentAgents: 2,
      maxActiveAgents: 2,
      dispatch: async () => ({}),
    });
    try {
      const server = (root as any).server;
      const registry = server.registry;
      const controller = registry.identity("/root");
      for (let index = 0; index < 1_030; index++) {
        const reservation = registry.reserveChild(controller, {
          id: `mailbox-id-${index}`,
          taskName: `mailbox_${index}`,
          maxDepth: 2,
          lastTaskMessage: "mailbox",
          reloadable: true,
        });
        registry.commitReservation(reservation.effect);
        registry.commitControllerEffect(
          registry.beginControllerEffect(controller, reservation.path, "deactivate"),
        );
        server.mailboxByPath.set(reservation.path, []);
        server.nextMailboxSequence.set(reservation.path, 2);
        server.deliveredMailboxEventIds.set(reservation.path, new Set([`event-${index}`]));
        registry.commitControllerEffect(
          registry.beginControllerEffect(controller, reservation.path, "unload"),
        );
      }
      server.cleanupPrunedTargetState();
      expect(root.serverSecurityCounts).toMatchObject({
        mailboxTargets: 1_024,
        mailboxSequences: 1_024,
        mailboxDedupeTargets: 1_024,
      });
    } finally {
      await root.close();
    }
  });

  test("retries broker close after one transient server cleanup failure", async () => {
    const root = await RootTreeBroker.createRoot({
      identity: { id: "root-id", path: "/root", depth: 0, maxDepth: 2 },
      maxResidentAgents: 2,
      maxActiveAgents: 2,
      dispatch: async () => ({}),
    });
    const server = (root as any).server;
    const realClose = server.close.bind(server);
    let attempts = 0;
    server.close = async () => {
      if (attempts++ === 0) throw new Error("transient close failure");
      await realClose();
    };
    await expect(root.close()).rejects.toThrow("close was incomplete");
    await root.close();
    expect(attempts).toBe(2);
  });

  test("an effect dispatch can re-enter real broker list/reserve requests without deadlock", async () => {
    let root!: RootTreeBroker;
    let nestedPath: string | undefined;
    const childDispatches: BrokerDispatch[] = [];
    const rootDispatches: BrokerDispatch[] = [];
    const rootDispatch: BrokerDispatchHandler = async (dispatch) => {
      rootDispatches.push(dispatch);
      if (dispatch.op === "prepare_followup") {
        expect((await root.list()).agents.map((agent) => agent.agent_name)).toContain(
          "/root/child",
        );
        const nested = await root.reserveChild({
          id: "sibling-id",
          taskName: "sibling",
          maxDepth: 2,
          lastTaskMessage: "nested reservation",
          reloadable: true,
        });
        nestedPath = nested.path;
      }
      return {};
    };
    const pair = await createPair({
      rootDispatch,
      childDispatch: async (dispatch) => {
        childDispatches.push(dispatch);
        return {};
      },
    });
    root = pair.root;
    try {
      await pair.root.updateAgent(pair.childPath, { active: false });
      const routed = await within(
        pair.root.route("followup", pair.childPath, "wake up"),
      );
      expect(routed).toMatchObject({ target: pair.childPath, trigger_turn: true });
      expect(nestedPath).toBe("/root/sibling");
      expect(rootDispatches.some((dispatch) => dispatch.op === "deliver_mailbox")).toBe(true);
      expect(childDispatches).toHaveLength(0);
      await pair.root.releaseReservation(nestedPath!);
    } finally {
      await closePair(pair);
    }
  });
});
