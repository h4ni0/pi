import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import {
  canonicalCompletionPayload,
  taskEnvelope,
  buildSubagentSystemPrompt,
} from "../prompts.ts";
import {
  FollowupTaskParams,
  InterruptAgentParams,
  ListAgentsParams,
  SendMessageParams,
  SpawnAgentParams,
  WaitAgentParams,
  parseForkTurns,
} from "../schemas.ts";
import { CollaborationManager } from "../runtime/collaboration-manager.ts";
import { RootTreeBroker } from "../runtime/root-tree-broker.ts";
import { createSubagentRuntimeState } from "../runtime/state.ts";
import { createLiveSubagentRecord } from "../runtime/turn-controller.ts";
import { DEFAULT_SETTINGS } from "../settings.ts";
import {
  canonicalCollaborationResult,
  registerCollaborationTools,
} from "../tools/register-collaboration-tools.ts";
import { registerSubagentTools } from "../tools/register-tools.ts";

function modelText(
  result: ReturnType<typeof canonicalCollaborationResult>,
): string {
  const part = result.content[0];
  if (!part || part.type !== "text") throw new Error("missing model text");
  return part.text;
}

function generatedPublicStatus(
  outcome: "completed" | "errored",
  text: string,
) {
  const state = createSubagentRuntimeState({
    pi: {} as ExtensionAPI,
    settings: { ...DEFAULT_SETTINGS },
    currentDepth: 0,
    envMaxDepth: 2,
    extensionPath: "/extension/index.ts",
    currentPath: "/root",
    guardToken: {},
    invocationBase: { command: "/trusted/pi", prefixArgs: [] },
  });
  const manager = new CollaborationManager(state);
  const record = createLiveSubagentRecord({
    id: `status-${outcome}`,
    generatedLabel: `${outcome} status`,
    taskName: `${outcome}_status`,
    agentName: `/root/${outcome}_status`,
    mode: "v2",
    forkTurns: "none",
    parentId: "root-id",
    rootId: "root-id",
    depth: 1,
    maxDepth: 2,
    message: `${outcome} task`,
    sessionDir: `/tmp/${outcome}-status`,
    createdAt: 1,
  });
  record.processState = "alive";
  record.turnState = "idle";
  record.turnOutcome = outcome;
  if (outcome === "completed") {
    record.status = "completed";
    record.finalOutput = text;
  } else {
    record.status = "failed";
    record.error = text;
  }
  return (manager as any).publicStatus(record);
}

describe("canonical six-tool model projections", () => {
  test("keeps rich spawn metadata only in details", () => {
    const details = {
      agent_id: "sa_opaque",
      agent_name: "/root/research",
      status: "running",
      depth: 1,
      max_depth: 2,
      fork_turns: "all",
      session_file: "/secret/session.jsonl",
      shared_workspace: true,
    };
    const result = canonicalCollaborationResult("spawn_agent", details);
    expect(modelText(result)).toBe('{"task_name":"/root/research"}');
    expect(result.details).toBe(details);
  });

  test("returns empty model text for send and follow-up acknowledgments", () => {
    const sendDetails = {
      target: "/root/research",
      delivery: "queued",
      event_id: "evt_send",
      pending_messages: 3,
    };
    const followupDetails = {
      target: "/root/research",
      delivery: "prompt",
      event_id: "evt_followup",
      turn_id: "turn_0002",
    };
    const sent = canonicalCollaborationResult("send_message", sendDetails);
    const followed = canonicalCollaborationResult(
      "followup_task",
      followupDetails,
    );

    expect(modelText(sent)).toBe("");
    expect(modelText(followed)).toBe("");
    expect(sent.details).toBe(sendDetails);
    expect(followed.details).toBe(followupDetails);
  });

  test("projects only canonical wait and interrupt fields", () => {
    const waitDetails = {
      message: "Wait completed.",
      timed_out: false,
      completed: [{
        agent_id: "opaque-worker",
        agent_name: "/root/research",
        agent_status: { completed: "done" },
        terminal_revision: 7,
        active_epoch: 2,
        connection_generation: 1,
      }],
      pending: ["/root/other"],
    };
    const interruptDetails = {
      target: "/root/research",
      previous_status: { completed: null },
      current_status: "interrupted",
      pid: 1234,
    };
    const waited = canonicalCollaborationResult("wait_agent", waitDetails);
    const interrupted = canonicalCollaborationResult(
      "interrupt_agent",
      interruptDetails,
    );

    expect(modelText(waited)).toBe(
      '{"message":"Wait completed.","timed_out":false,"completed":[{"agent_name":"/root/research","agent_status":{"completed":"done"}}],"pending":["/root/other"]}',
    );
    expect(modelText(interrupted)).toBe(
      '{"previous_status":{"completed":null}}',
    );
    expect(waited.details).toBe(waitDetails);
    expect(interrupted.details).toBe(interruptDetails);
    expect(
      modelText(
        canonicalCollaborationResult("interrupt_agent", {
          previous_status: "not_found",
        }),
      ),
    ).toBe('{"previous_status":"not_found"}');
  });

  test("projects exact three-field live list items", () => {
    const details = {
      scope: "root_tree",
      shared_workspace: true,
      agents: [
        {
          agent_id: "root-id",
          agent_name: "/root",
          agent_status: "running" as const,
          last_task_message: "Main thread",
          depth: 0,
        },
        {
          agent_id: "sa_worker",
          agent_name: "/root/worker",
          agent_status: { completed: null },
          last_task_message: null,
          session_dir: "/secret/worker",
        },
      ],
    };
    const result = canonicalCollaborationResult("list_agents", details);

    expect(modelText(result)).toBe(
      '{"agents":[{"agent_name":"/root","agent_status":"running","last_task_message":"Main thread"},{"agent_name":"/root/worker","agent_status":{"completed":null},"last_task_message":null}]}',
    );
    expect(result.details).toBe(details);
  });

  test("preserves generated multiline and long completed/error statuses through list, wait, and interrupt", async () => {
    const completedText = `  completed line one\n${"c".repeat(400)}\ncompleted tail  `;
    const errorText = `  error line one\n${"e".repeat(400)}\nerror tail  `;
    const completedStatus = generatedPublicStatus("completed", completedText);
    const errorStatus = generatedPublicStatus("errored", errorText);
    expect(completedStatus).toEqual({ completed: completedText });
    expect(errorStatus).toEqual({ errored: errorText });

    const brokers: RootTreeBroker[] = [];
    const root = await RootTreeBroker.createRoot({
      identity: { id: "root-id", path: "/root", depth: 0, maxDepth: 2 },
      maxResidentAgents: 4,
      maxActiveAgents: 4,
      dispatch: async () => ({}),
    });
    brokers.push(root);
    try {
      const register = async (
        id: string,
        taskName: string,
        status: any,
      ): Promise<string> => {
        const grant = await root.reserveChild({
          id,
          taskName,
          maxDepth: 2,
          lastTaskMessage: `${taskName} task`,
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
          maxResidentAgents: 4,
          maxActiveAgents: 4,
          socketPath: root.endpoint!.socketPath,
          capability: grant.capability,
          dispatch: async () => ({}),
        });
        brokers.push(child);
        await root.updateAgent(
          grant.path,
          { status, active: false },
          1,
        );
        return grant.path;
      };

      const completedPath = await register(
        "completed-id",
        "completed_status",
        completedStatus,
      );
      const errorPath = await register(
        "error-id",
        "error_status",
        errorStatus,
      );
      const expected = new Map([
        [completedPath, completedStatus],
        [errorPath, errorStatus],
      ]);

      const listed = await root.list();
      for (const [agentPath, status] of expected) {
        expect(listed.agents.find((agent) => agent.agent_name === agentPath)?.agent_status)
          .toEqual(status);
      }
      const listedModel = JSON.parse(modelText(canonicalCollaborationResult(
        "list_agents",
        { agents: listed.agents },
      )));
      for (const [agentPath, status] of expected) {
        expect(listedModel.agents.find((agent: any) => agent.agent_name === agentPath)?.agent_status)
          .toEqual(status);

        const waited = await root.waitAgent({ target: agentPath });
        expect(waited.completed[0]?.agent_status).toEqual(status);
        expect(JSON.parse(modelText(canonicalCollaborationResult("wait_agent", waited)))
          .completed[0]?.agent_status).toEqual(status);

        const interrupted = await root.route("interrupt", agentPath);
        expect(interrupted.previous_status).toEqual(status);
        expect(JSON.parse(modelText(canonicalCollaborationResult(
          "interrupt_agent",
          { previous_status: interrupted.previous_status },
        ))).previous_status).toEqual(status);
      }
    } finally {
      for (const broker of brokers.reverse()) await broker.close().catch(() => undefined);
    }
  });
});

describe("strict hidden-metadata schemas", () => {
  test("locks spawn to task_name, message, and fork_turns with no name cap", () => {
    expect(Object.keys(SpawnAgentParams.properties).sort()).toEqual([
      "fork_turns",
      "message",
      "task_name",
    ]);
    expect(
      Value.Check(SpawnAgentParams, {
        task_name: "a".repeat(256),
        message: "work",
      }),
    ).toBe(true);
    expect(
      Value.Check(SpawnAgentParams, {
        task_name: "worker",
        message: "work",
        context: "compact",
      }),
    ).toBe(false);
    for (const metadata of [
      { agent_type: "worker" },
      { model: "provider/model" },
      { reasoning_effort: "high" },
      { service_tier: "priority" },
      { nickname: "worker" },
    ]) {
      expect(
        Value.Check(SpawnAgentParams, {
          task_name: "worker",
          message: "work",
          ...metadata,
        }),
      ).toBe(false);
    }
    expect(
      Value.Check(SpawnAgentParams, {
        task_name: "root",
        message: "work",
      }),
    ).toBe(false);
  });

  test("normalizes only omitted/all/none/positive integer fork values", () => {
    expect(parseForkTurns(undefined)).toBe("all");
    expect(parseForkTurns("all")).toBe("all");
    expect(parseForkTurns("none")).toBe("none");
    expect(parseForkTurns("1")).toBe("1");
    expect(parseForkTurns("999999999999999999999999")).toBe(
      "999999999999999999999999",
    );
    for (const invalid of ["", "0", "01", "-1", "+1", "1.0", " all", "all ", 1])
      expect(() => parseForkTurns(invalid)).toThrow("fork_turns");
  });

  test("keeps agent waits indefinite and clock delay separate", () => {
    for (const valid of [
      {},
      { seconds: 300 },
      { target: "worker" },
      { all: true },
    ]) expect(Value.Check(WaitAgentParams, valid)).toBe(true);
    for (const invalid of [
      { target: "worker", all: true },
      { target: "worker", seconds: 1 },
      { all: true, seconds: 3_600 },
      { all: false },
      { timeout_ms: 30_000 },
      { timeout_seconds: 30 },
      { seconds: 0 },
      { seconds: 3_601 },
      { seconds: 1.5 },
    ]) expect(Value.Check(WaitAgentParams, invalid)).toBe(false);
  });

  test("rejects unknown fields across all six canonical tools", () => {
    const cases: Array<[unknown, Record<string, unknown>]> = [
      [SpawnAgentParams, { task_name: "worker", message: "x", extra: true }],
      [SendMessageParams, { target: "worker", message: "x", extra: true }],
      [FollowupTaskParams, { target: "worker", message: "x", extra: true }],
      [WaitAgentParams, { extra: true }],
      [InterruptAgentParams, { target: "worker", extra: true }],
      [ListAgentsParams, { path_prefix: "/root", extra: true }],
    ];
    for (const [schema, input] of cases)
      expect(Value.Check(schema as never, input)).toBe(false);
  });
});

describe("canonical inter-agent envelopes", () => {
  test("locks the completed-empty fixture to exactly four fields", () => {
    const envelope = taskEnvelope(
      "FINAL_ANSWER",
      "/root",
      "/root/worker",
      "",
    );
    expect(envelope).toBe(
      [
        "Message Type: FINAL_ANSWER",
        "Task name: /root",
        "Sender: /root/worker",
        "Payload:",
        "",
      ].join("\n"),
    );
    expect(envelope).not.toContain("Turn:");
    expect(envelope).not.toContain("Status:");
    expect(envelope).not.toContain("Full output:");
  });

  test("locks the canonical error payload and envelope", () => {
    const payload = canonicalCompletionPayload("errored", "fixture failed");
    expect(payload).toBe(
      "Agent errored: fixture failed\n\nThis agent's turn failed. If you still need this agent, use the available collaboration tools to give it another task.",
    );
    expect(
      taskEnvelope(
        "FINAL_ANSWER",
        "/root",
        "/root/worker",
        payload,
      ),
    ).toBe(
      [
        "Message Type: FINAL_ANSWER",
        "Task name: /root",
        "Sender: /root/worker",
        "Payload:",
        payload,
      ].join("\n"),
    );
  });
});

describe("tool descriptions and prompt guidance", () => {
  function registeredTools(includeDelegate: boolean): any[] {
    const tools: any[] = [];
    const pi = {
      registerTool: (tool: any) => tools.push(tool),
    } as unknown as ExtensionAPI;
    const state = createSubagentRuntimeState({
      pi,
      settings: { ...DEFAULT_SETTINGS },
      currentDepth: 0,
      envMaxDepth: 2,
      extensionPath: "/extension/index.ts",
      currentPath: "/root",
      guardToken: {},
      invocationBase: { command: "/trusted/pi", prefixArgs: [] },
    });
    if (includeDelegate) registerSubagentTools(state);
    else registerCollaborationTools(state);
    return tools;
  }

  test("snapshots all six canonical descriptions", () => {
    const tools = registeredTools(false);
    expect(
      Object.fromEntries(
        tools.map((tool) => [tool.name, tool.description]),
      ),
    ).toEqual({
      spawn_agent:
        "Spawns a persistent agent for a concrete task. Relative task names become canonical descendants of the caller. The agent is reusable, receives fork_turns context, and returns its final answer separately. Pi depth limits are enforced.",
      send_message:
        "Send a message to an existing same-tree agent. The message is delivered promptly and does not trigger a new turn.",
      followup_task:
        "Send a follow-up task to an existing non-root same-tree agent. Reuse its session and trigger a turn if idle; deliver promptly if already running.",
      wait_agent:
        "Wait indefinitely for any, one, or all selected agents to reach terminal status. Agent waits never take a time limit. The separate `{seconds}` mode is only a clock delay and does not inspect agents.",
      interrupt_agent:
        "Interrupt a same-tree agent's current turn, if any, and return its previous status. The request is non-cascading and the agent remains reusable.",
      list_agents:
        "List live agents in the current root agent tree, optionally filtered by a strict canonical or caller-relative path prefix.",
    });
  });

  test("locks sparse wait guidance and delegate/spawn distinction", () => {
    const tools = registeredTools(true);
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect(byName.get("wait_agent")?.promptGuidelines).toEqual([
      "For agent completion, use {} for ANY, target for one agent, or all:true for ALL; these modes have no time limit.",
      "Never use seconds to poll or wait for agents. `{seconds}` is a standalone clock delay only.",
      "Later spawns are never added to an existing agent wait.",
      "The user-requested terminal wait modes are Pi's second intentional Codex-v2 divergence alongside depth enforcement.",
    ]);
    const theme = {
      fg: (_color: string, text: string) => String(text),
      bold: (text: string) => String(text),
    } as any;
    const indefinite = byName.get("wait_agent")?.renderCall(
      { target: "worker" },
      theme,
    ).render(200).join("\n");
    const delayed = byName.get("wait_agent")?.renderCall(
      { seconds: 7 },
      theme,
    ).render(200).join("\n");
    expect(indefinite).toContain("until done");
    expect(indefinite).not.toContain("7s");
    expect(delayed).toContain("delay 7s");
    expect(byName.get("spawn_agent")?.promptSnippet).toBe(
      "Asynchronously spawn a persistent, reusable agent with a canonical task name and fork_turns context.",
    );
    expect(byName.get("spawn_agent")?.promptGuidelines).toContain(
      "In a fresh runtime, prove startup with one agent before issuing a parallel fan-out; if startup fails, stop spawning and diagnose the shared runtime instead of retrying with delegate.",
    );
    expect(byName.get("spawn_agent")?.promptGuidelines).toContain(
      "Unlike disposable delegate, spawn_agent returns a persistent canonical task name for send_message and followup_task.",
    );
    expect(byName.get("spawn_agent")?.promptGuidelines).toContain(
      "Pi depth enforcement is one of two intentional Codex-v2 divergences; the other is the user-requested wait_agent contract.",
    );
    expect(byName.get("delegate")?.description).toBe(
      "Run one blocking, disposable, one-shot compatibility sub-agent. It returns its bounded result inline, then closes and cannot be reused or targeted. Context is a compact parent handoff by default or fresh when requested.",
    );
    expect(byName.get("delegate")?.promptGuidelines).toContain(
      "Use delegate only for a blocking one-shot task; unlike spawn_agent, a returned delegate is disposable, non-reusable, and non-targetable.",
    );
    expect(byName.get("delegate")?.promptGuidelines).toContain(
      "Do not use delegate as a fallback after spawn_agent startup failure; diagnose or report the shared runtime failure before any further delegation.",
    );
    const allGuidance = tools
      .flatMap((tool) => [
        tool.description,
        tool.promptSnippet,
        ...(tool.promptGuidelines ?? []),
      ])
      .join("\n")
      .toLowerCase();
    expect(allGuidance).not.toContain("direct child only");
    expect(allGuidance).not.toContain("direct children only");
  });

  test("snapshots the child collaboration boundary guidance", () => {
    const prompt = buildSubagentSystemPrompt(1, 2, "/root/research");
    for (const required of [
      "Your canonical agent path is /root/research; depth 1; max depth 2.",
      "send_message to an idle agent only queues mail; followup_task wakes an idle non-root agent on the same session.",
      "Final answers are delivered automatically to your direct parent. wait_agent snapshots agent identities/epochs and can wait for any descendant, one same-tree target, or all current descendants; later spawns are excluded.",
      "These user-requested terminal wait modes intentionally differ from Codex v2's mailbox wait.",
      "interrupt_agent is a reusable, non-cascading turn interrupt.",
      "All agents share the same cwd and filesystem.",
      "In a fresh runtime, prove startup with one agent before expanding in small batches; after any startup failure, stop delegating",
    ])
      expect(prompt).toContain(required);
  });
});
