import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { COLLABORATION_GUARD } from "../constants.ts";
import subagentsExtension from "../extension.ts";
import { AgentsOverlay } from "../ui/agents-overlay.ts";
import { CollaborationManager } from "../runtime/collaboration-manager.ts";
import {
  applyRoleActiveTools,
  childToolsForSpawn,
  collaborationToolsForRole,
} from "../runtime/tool-list.ts";
import { createSubagentRuntimeState } from "../runtime/state.ts";
import { createLiveSubagentRecord } from "../runtime/turn-controller.ts";
import { DEFAULT_SETTINGS } from "../settings.ts";
import { canonicalCollaborationResult } from "../tools/register-collaboration-tools.ts";

const originalActiveTools = process.env.PI_SUBAGENT_ACTIVE_TOOLS;
afterEach(() => {
  if (originalActiveTools === undefined) delete process.env.PI_SUBAGENT_ACTIVE_TOOLS;
  else process.env.PI_SUBAGENT_ACTIVE_TOOLS = originalActiveTools;
  delete (globalThis as Record<PropertyKey, unknown>)[COLLABORATION_GUARD];
});

function roleState(depth: number, maxDepth: number, pi: any = {}): any {
  return createSubagentRuntimeState({
    pi,
    settings: { ...DEFAULT_SETTINGS, maxDepth },
    currentDepth: depth,
    envMaxDepth: maxDepth,
    extensionPath: "/extension/index.ts",
    currentPath: depth ? "/root/child" : "/root",
    guardToken: {},
    invocationBase: { command: process.execPath, prefixArgs: [] },
  });
}

function record(id: string, updatedAt: number) {
  const item = createLiveSubagentRecord({
    id,
    generatedLabel: id,
    taskName: id,
    agentName: `/root/${id}`,
    mode: "v2",
    forkTurns: "none",
    parentId: "root",
    rootId: "root",
    depth: 1,
    maxDepth: 2,
    message: `task ${id}`,
    sessionDir: `/tmp/${id}`,
    createdAt: updatedAt,
  });
  item.updatedAt = updatedAt;
  item.status = "completed";
  item.processState = "closed";
  return item;
}

const theme = {
  fg: (_color: string, text: string) => String(text),
  bold: (text: string) => String(text),
} as any;

describe("M14 tool visibility and inheritance", () => {
  test("locks the depth visibility matrix", () => {
    const management = [
      "send_message",
      "followup_task",
      "wait_agent",
      "interrupt_agent",
      "list_agents",
    ];
    expect(collaborationToolsForRole(roleState(0, 2))).toEqual([
      ...management,
      "spawn_agent",
      "delegate",
    ]);
    expect(collaborationToolsForRole(roleState(1, 2))).toEqual([
      ...management,
      "ask_parent",
      "spawn_agent",
      "delegate",
    ]);
    expect(collaborationToolsForRole(roleState(2, 2))).toEqual([
      ...management,
      "ask_parent",
    ]);
    expect(collaborationToolsForRole(roleState(0, 0))).toEqual(management);
  });

  test("preserves an explicit empty active-tool list apart from permitted controls", () => {
    const allNames = [
      "read",
      "bash",
      "spawn_agent",
      "send_message",
      "followup_task",
      "wait_agent",
      "interrupt_agent",
      "list_agents",
      "delegate",
      "ask_parent",
    ];
    let activated: string[] = [];
    const pi = {
      getAllTools: () => allNames.map((name) => ({ name })),
      getActiveTools: () => [],
      setActiveTools: (tools: string[]) => { activated = tools; },
    };
    process.env.PI_SUBAGENT_ACTIVE_TOOLS = "[]";
    const child = roleState(1, 2, pi);
    applyRoleActiveTools(child);
    expect(activated).toEqual(collaborationToolsForRole(child));
    expect(activated).not.toContain("read");
    expect(activated).not.toContain("bash");
  });

  test("inherits exact non-collaboration tools and adds only the next-depth controls", () => {
    const pi = {
      getActiveTools: () => ["read", "custom", "send_message", "delegate"],
    };
    const root = roleState(0, 2, pi);
    expect(childToolsForSpawn(root)).toEqual([
      "read",
      "custom",
      "send_message",
      "followup_task",
      "wait_agent",
      "interrupt_agent",
      "list_agents",
      "ask_parent",
      "spawn_agent",
      "delegate",
    ]);
  });

  test("explicit root PI_SUBAGENT_MAX_DEPTH=0 survives trusted refresh and gates tools/runtime", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-root-env-depth-"));
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".pi", "settings.json"),
      JSON.stringify({ subagents: { maxDepth: 17 } }),
    );
    let activated: string[] = [];
    const allNames = [
      "read",
      "spawn_agent",
      "delegate",
      "send_message",
      "followup_task",
      "wait_agent",
      "interrupt_agent",
      "list_agents",
    ];
    const pi = {
      getAllTools: () => allNames.map((name) => ({ name })),
      getActiveTools: () => ["read", "spawn_agent", "delegate"],
      setActiveTools: (tools: string[]) => { activated = tools; },
    } as any;
    const state = createSubagentRuntimeState({
      pi,
      settings: { ...DEFAULT_SETTINGS, maxDepth: 0 },
      currentDepth: 0,
      envMaxDepth: 0,
      envMaxDepthExplicit: true,
      extensionPath: "/extension/index.ts",
      currentPath: "/root",
      guardToken: {},
      invocationBase: { command: process.execPath, prefixArgs: [] },
    });
    const manager = new CollaborationManager(state);
    const ctx = {
      cwd,
      isProjectTrusted: () => true,
    } as any;
    manager.refreshSettings(ctx);
    expect(state.settings.maxDepth).toBe(0);
    applyRoleActiveTools(state);
    expect(activated).not.toContain("spawn_agent");
    expect(activated).not.toContain("delegate");
    expect(activated).toEqual([
      "read",
      "send_message",
      "followup_task",
      "wait_agent",
      "interrupt_agent",
      "list_agents",
    ]);
    await expect(manager.spawnAgent(
      { task_name: "blocked", message: "must reject", fork_turns: "none" },
      undefined,
      ctx,
    )).rejects.toThrow("maxDepth 0 reached at depth 0");
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  test("duplicate manager initialization fails loudly", () => {
    const pi = new Proxy({} as any, {
      get: () => () => undefined,
    });
    subagentsExtension(pi);
    expect(() => subagentsExtension(pi)).toThrow("Duplicate subagents collaboration manager");
  });
});

describe("M14 local UI history versus canonical live listing", () => {
  test("caps lowered local history while canonical listing remains broker-live-only", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-ui-contract-"));
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".pi", "settings.json"),
      JSON.stringify({ subagents: { statusHistoryLimit: 1 } }),
    );
    const pi = {
      getActiveTools: () => [],
      getAllTools: () => [],
      appendEntry: () => undefined,
    } as any;
    const state = roleState(0, 2, pi);
    state.settings = { ...DEFAULT_SETTINGS, statusHistoryLimit: 2 };
    state.broker = {
      list: async () => ({
        agents: [
          { agent_name: "/root", agent_status: "running", last_task_message: "Main thread" },
          { agent_name: "/root/live", agent_status: "running", last_task_message: "live" },
        ],
      }),
    } as any;
    const manager = new CollaborationManager(state);
    (manager as any).archiveRecord(record("history_a", 1));
    (manager as any).archiveRecord(record("history_b", 2));
    (manager as any).archiveRecord(record("history_c", 3));
    expect([...state.history.keys()]).toEqual(["history_b", "history_c"]);

    manager.refreshSettings({
      cwd,
      isProjectTrusted: () => true,
    } as any);
    expect(state.settings.statusHistoryLimit).toBe(1);
    expect([...state.history.keys()]).toEqual(["history_c"]);

    const details = await manager.listAgents();
    expect(details).toEqual({
      scope: "root_tree",
      shared_workspace: true,
      agents: [
        { agent_name: "/root", agent_status: "running", last_task_message: "Main thread" },
        { agent_name: "/root/live", agent_status: "running", last_task_message: "live" },
      ],
    });
    const projected = canonicalCollaborationResult("list_agents", details);
    expect(projected.content[0]).toEqual({
      type: "text",
      text: '{"agents":[{"agent_name":"/root","agent_status":"running","last_task_message":"Main thread"},{"agent_name":"/root/live","agent_status":"running","last_task_message":"live"}]}',
    });
    expect(JSON.stringify(projected.content)).not.toContain("history_c");
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  test("renders the shared-workspace and session-runtime warning", () => {
    const current = record("ui_worker", Date.now());
    current.processState = "alive";
    const overlay = new AgentsOverlay(
      theme,
      () => [current],
      () => undefined,
      () => undefined,
      () => 16,
    );
    try {
      const rendered = overlay.render(120).join("\n");
      expect(rendered).toContain("Session-runtime UI history");
      expect(rendered).toContain("shared cwd/filesystem");
      expect(rendered).toContain("locally owned child");
    } finally {
      overlay.dispose();
    }
  });

  test("README claims match executable defaults and completed architecture", () => {
    const readme = fs.readFileSync("extensions/subagents/README.md", "utf8");
    for (const claim of [
      "| `statusHistoryLimit` | `100` |",
      "| `maxConcurrentAgents` | `16` |",
      "| `maxPersistentAgents` | `16` |",
      "| `returnMaxBytes` | `50000` |",
      "two explicit intentional behavioral divergences",
      "user-requested `wait_agent` contract",
    ]) expect(readme).toContain(claim);
    expect(readme).not.toContain("sole intentional behavioral divergence");
    expect(readme).toContain("`childEnvAllowlist`");
    expect(DEFAULT_SETTINGS.statusHistoryLimit).toBe(100);
    expect(DEFAULT_SETTINGS.maxConcurrentAgents).toBe(16);
    expect(DEFAULT_SETTINGS.maxPersistentAgents).toBe(16);
  });
});
