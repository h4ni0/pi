import { afterEach, describe, expect, test } from "bun:test";
import { RootTreeBroker } from "../runtime/root-tree-broker.ts";

const brokers: RootTreeBroker[] = [];
afterEach(async () => {
  await Promise.allSettled(brokers.splice(0).map((broker) => broker.close()));
});

describe("routed interrupt races", () => {
  test("captures prior status, is non-cascading, and natural completion may win dispatch", async () => {
    const interrupted: string[] = [];
    let root!: RootTreeBroker;
    root = await RootTreeBroker.createRoot({
      identity: { id: "root-id", path: "/root", depth: 0, maxDepth: 2 },
      maxResidentAgents: 4,
      maxActiveAgents: 4,
      dispatch: async (dispatch) => {
        if (dispatch.op === "interrupt") {
          interrupted.push(dispatch.payload.targetPath);
          await root.updateAgent(
            dispatch.payload.targetPath,
            { active: false, status: { completed: "natural completion" } },
            1,
          );
        }
        return {};
      },
    });
    brokers.push(root);
    const grant = await root.reserveChild({
      id: "child-id",
      taskName: "child",
      maxDepth: 2,
      lastTaskMessage: "running",
      reloadable: true,
    });
    const child = await RootTreeBroker.connectChild({
      identity: {
        id: "child-id",
        path: grant.path,
        parentId: "root-id",
        parentPath: "/root",
        depth: 1,
        maxDepth: 2,
        connectionGeneration: grant.generation,
      },
      maxResidentAgents: 4,
      maxActiveAgents: 4,
      socketPath: root.endpoint!.socketPath,
      capability: grant.capability,
      dispatch: async () => ({}),
    });
    brokers.push(child);

    expect(await root.route("interrupt", grant.path)).toEqual({
      previous_status: "pending_init",
    });
    expect(interrupted).toEqual([grant.path]);
    expect((await root.list()).agents.find((agent) => agent.agent_name === grant.path)?.agent_status)
      .toEqual({ completed: "natural completion" });
    await expect(root.route("interrupt", "/root")).rejects.toThrow("not a spawned agent");
    const selfError = await child.route("interrupt", grant.path).catch((error) => error);
    expect(selfError.message).toContain("cannot interrupt itself");
  });

  test("an old active epoch cannot settle a newly activated mailbox task", async () => {
    let deliveries = 0;
    const root = await RootTreeBroker.createRoot({
      identity: { id: "root-id", path: "/root", depth: 0, maxDepth: 2 },
      maxResidentAgents: 4,
      maxActiveAgents: 4,
      dispatch: async (dispatch) => {
        if (dispatch.op === "deliver_mailbox") deliveries += 1;
        return {};
      },
    });
    brokers.push(root);
    const grant = await root.reserveChild({
      id: "child-id",
      taskName: "child",
      maxDepth: 2,
      lastTaskMessage: "first",
      reloadable: true,
    });
    const child = await RootTreeBroker.connectChild({
      identity: {
        id: "child-id", path: grant.path, parentId: "root-id", parentPath: "/root",
        depth: 1, maxDepth: 2, connectionGeneration: grant.generation,
      },
      maxResidentAgents: 4,
      maxActiveAgents: 4,
      socketPath: root.endpoint!.socketPath,
      capability: grant.capability,
      dispatch: async () => ({}),
    });
    brokers.push(child);
    await root.updateAgent(grant.path, { active: false }, 1);
    await root.route("followup", grant.path, "second turn");
    expect(deliveries).toBe(1);
    await expect(root.updateAgent(grant.path, { active: false }, 1)).rejects.toThrow(
      "epoch is stale",
    );
    expect((await root.list()).agents.find((agent) => agent.agent_name === grant.path)?.agent_status)
      .toBe("running");
  });
});
