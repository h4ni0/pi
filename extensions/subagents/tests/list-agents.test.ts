import { afterEach, describe, expect, test } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { CollaborationManager } from "../runtime/collaboration-manager.ts";
import { RootTreeBroker } from "../runtime/root-tree-broker.ts";
import { createSubagentRuntimeState } from "../runtime/state.ts";
import { DEFAULT_SETTINGS } from "../settings.ts";
import type { AgentSnapshot } from "../types.ts";

const brokers: RootTreeBroker[] = [];
afterEach(async () => {
  await Promise.allSettled(brokers.splice(0).map((broker) => broker.close()));
});

async function connectedChild(
  root: RootTreeBroker,
  parent: RootTreeBroker,
  input: {
    id: string;
    taskName: string;
    parentId: string;
    parentPath: string;
    depth: number;
  },
): Promise<RootTreeBroker> {
  const grant = await parent.reserveChild({
    id: input.id,
    taskName: input.taskName,
    maxDepth: 3,
    lastTaskMessage: `task ${input.taskName}`,
    reloadable: true,
  });
  const child = await RootTreeBroker.connectChild({
    identity: {
      id: input.id,
      path: grant.path,
      parentId: input.parentId,
      parentPath: input.parentPath,
      depth: input.depth,
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
  return child;
}

describe("canonical live list_agents", () => {
  test("returns the exact sorted live tree and segment-aware prefixes", async () => {
    const root = await RootTreeBroker.createRoot({
      identity: { id: "root-id", path: "/root", depth: 0, maxDepth: 3 },
      maxResidentAgents: 8,
      maxActiveAgents: 8,
      dispatch: async () => ({}),
    });
    brokers.push(root);
    const z = await connectedChild(root, root, {
      id: "id-z", taskName: "z", parentId: "root-id", parentPath: "/root", depth: 1,
    });
    const a = await connectedChild(root, root, {
      id: "id-a", taskName: "a", parentId: "root-id", parentPath: "/root", depth: 1,
    });
    await connectedChild(root, a, {
      id: "id-grand", taskName: "grand", parentId: "id-a", parentPath: "/root/a", depth: 2,
    });
    await connectedChild(root, root, {
      id: "id-a2", taskName: "a2", parentId: "root-id", parentPath: "/root", depth: 1,
    });

    const listed = await z.list();
    expect(listed.agents.map((agent) => Object.keys(agent).sort())).toEqual(
      listed.agents.map(() => ["agent_name", "agent_status", "last_task_message"]),
    );
    expect(listed.agents.map((agent) => agent.agent_name)).toEqual([
      "/root", "/root/a", "/root/a/grand", "/root/a2", "/root/z",
    ]);
    expect(listed.agents[0]).toEqual({
      agent_name: "/root",
      agent_status: "running",
      last_task_message: "Main thread",
    });
    expect((await z.list("/root/a")).agents.map((agent) => agent.agent_name)).toEqual([
      "/root/a", "/root/a/grand",
    ]);
    expect((await z.list("/root/a2")).agents.map((agent) => agent.agent_name)).toEqual([
      "/root/a2",
    ]);
  });

  test("thousands of terminal UI snapshots stay bounded while broker live listing stays complete", async () => {
    const cwd = "/tmp/list-agents-history";
    const history = Array.from({ length: 2_000 }, (_, index): AgentSnapshot => ({
      agent_id: `history-${index}`,
      agent_name: `/root/history_${index}`,
      task_name: `history_${index}`,
      agent_status: "shutdown",
      depth: 1,
      max_depth: 2,
      context: "fresh",
      reusable: false,
      turn_id: null,
      turn_count: 1,
      pending_messages: 0,
      created_at: index + 1,
      updated_at: index + 1,
      last_task_message: `history ${index}`,
    }));
    const session = SessionManager.inMemory(cwd);
    const ctx = {
      cwd,
      isProjectTrusted: () => true,
      hasUI: false,
      sessionManager: {
        ...session,
        getEntries: () => [{
          type: "custom",
          customType: "subagents-v2-state",
          data: { agents: history },
        }],
      },
    } as any;
    const canonical = Array.from({ length: 1_000 }, (_, index) => ({
      agent_name: index === 0 ? "/root" : `/root/live_${index}`,
      agent_status: "running" as const,
      last_task_message: index === 0 ? "Main thread" : `live ${index}`,
    }));
    const state = createSubagentRuntimeState({
      pi: { appendEntry: () => undefined } as any,
      settings: {
        ...DEFAULT_SETTINGS,
        showInNormalResume: true,
        statusHistoryLimit: 25,
      },
      currentDepth: 0,
      envMaxDepth: 2,
      extensionPath: "/extension/index.ts",
      currentPath: "/root",
      guardToken: {},
      invocationBase: { command: "/trusted/pi", prefixArgs: [] },
    });
    state.broker = {
      list: async () => ({ agents: canonical }),
    } as any;
    const manager = new CollaborationManager(state);
    state.manager = manager;
    manager.restoreHistorical(ctx);
    expect(state.active.size).toBe(0);
    expect(state.history.size).toBe(25);
    expect((await manager.listAgents()).agents).toHaveLength(1_000);
  });
});
