import { Text } from "@earendil-works/pi-tui";
import {
  FollowupTaskParams,
  InterruptAgentParams,
  ListAgentsParams,
  SendMessageParams,
  SpawnAgentParams,
  WaitAgentParams,
} from "../schemas.ts";
import type {
  AgentStatus,
  WaitAgentResultDetails,
} from "../types.ts";
import { oneLine } from "../utils.ts";
import type { SubagentRuntimeState } from "../runtime/state.ts";

export type CanonicalCollaborationToolName =
  | "spawn_agent"
  | "send_message"
  | "followup_task"
  | "wait_agent"
  | "interrupt_agent"
  | "list_agents";

interface CanonicalListedAgentDetails {
  agent_name: string;
  agent_status: AgentStatus;
  last_task_message: string | null;
}

export interface CanonicalCollaborationDetails {
  spawn_agent: { agent_name: string };
  send_message: object;
  followup_task: object;
  wait_agent: WaitAgentResultDetails;
  interrupt_agent: { previous_status: AgentStatus };
  list_agents: { agents: CanonicalListedAgentDetails[] };
}

export interface CanonicalCollaborationToolResult<
  T extends CanonicalCollaborationToolName,
> {
  content: Array<{ type: "text"; text: string }>;
  details: CanonicalCollaborationDetails[T];
}

/** Keep canonical model text sparse while retaining typed Pi-native details. */
export function canonicalCollaborationResult<
  T extends CanonicalCollaborationToolName,
>(
  tool: T,
  details: CanonicalCollaborationDetails[T],
): CanonicalCollaborationToolResult<T> {
  let modelValue: unknown;
  switch (tool) {
    case "spawn_agent": {
      const spawn = details as CanonicalCollaborationDetails["spawn_agent"];
      modelValue = { task_name: spawn.agent_name };
      break;
    }
    case "send_message":
    case "followup_task":
      return {
        content: [{ type: "text", text: "" }],
        details,
      };
    case "wait_agent": {
      const wait = details as CanonicalCollaborationDetails["wait_agent"];
      modelValue = {
        message: wait.message,
        timed_out: wait.timed_out,
        completed: wait.completed.map((agent) => ({
          agent_name: agent.agent_name,
          agent_status: agent.agent_status,
        })),
        pending: [...wait.pending],
      };
      break;
    }
    case "interrupt_agent": {
      const interrupt =
        details as CanonicalCollaborationDetails["interrupt_agent"];
      modelValue = { previous_status: interrupt.previous_status };
      break;
    }
    case "list_agents": {
      const list = details as CanonicalCollaborationDetails["list_agents"];
      modelValue = {
        agents: list.agents.map((agent) => ({
          agent_name: agent.agent_name,
          agent_status: agent.agent_status,
          last_task_message: agent.last_task_message,
        })),
      };
      break;
    }
  }
  return {
    content: [{ type: "text", text: JSON.stringify(modelValue) }],
    details,
  };
}

function statusLabel(status: AgentStatus): string {
  if (typeof status === "string") return status;
  if ("completed" in status) return "completed";
  return "errored";
}

function expandedDetails(details: unknown, theme: any): Text {
  return new Text(theme.fg("dim", JSON.stringify(details, null, 2)), 0, 0);
}

export function registerCollaborationTools(state: SubagentRuntimeState): void {
  const { pi } = state;
  const manager = () => {
    if (!state.manager) throw new Error("Collaboration manager is not initialized");
    return state.manager;
  };

  pi.registerTool({
    name: "spawn_agent",
    label: "Spawn Agent",
    description:
      "Spawns a persistent agent for a concrete task. Relative task names become canonical descendants of the caller. The agent is reusable, receives fork_turns context, and returns its final answer separately. Pi depth limits are enforced.",
    promptSnippet:
      "Asynchronously spawn a persistent, reusable agent with a canonical task name and fork_turns context.",
    promptGuidelines: [
      "Use spawn_agent for concrete bounded work that can run independently; it returns asynchronously and the agent remains reusable.",
      "In a fresh runtime, prove startup with one agent before issuing a parallel fan-out; if startup fails, stop spawning and diagnose the shared runtime instead of retrying with delegate.",
      "Use the smallest useful team and expand in small batches rather than launching every conceivable reviewer at once.",
      "Unlike disposable delegate, spawn_agent returns a persistent canonical task name for send_message and followup_task.",
      "Persistence is runtime-scoped: /reload, resume, fork, or a new Pi runtime invalidates prior live handles; use list_agents and spawn replacements.",
      "All spawn_agent agents share cwd/filesystem; parallel research should be read-only and parallel writers need disjoint paths or worktrees.",
      "Pi depth enforcement is one of two intentional Codex-v2 divergences; the other is the user-requested wait_agent contract.",
    ],
    parameters: SpawnAgentParams,
    executionMode: "parallel",
    async execute(id, params, signal, _onUpdate, ctx) {
      return canonicalCollaborationResult(
        "spawn_agent",
        await manager().spawnAgent(params, signal, ctx, id),
      );
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("spawn_agent"))} ${theme.fg("accent", args.task_name || "agent")}`,
        0,
        0,
      );
    },
    renderResult(toolResult, options, theme) {
      const details = toolResult.details as any;
      if (options.expanded) return expandedDetails(details, theme);
      const label = details?.agent_name || details?.agent_id || "spawn";
      const status = details?.status ? statusLabel(details.status) : "done";
      return new Text(
        `${theme.fg("toolOutput", oneLine(label, 100))} ${theme.fg(status === "errored" ? "error" : "dim", status)}`,
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: "send_message",
    label: "Send Message",
    description:
      "Send a message to an existing same-tree agent. The message is delivered promptly and does not trigger a new turn.",
    promptSnippet:
      "Message a same-tree agent without waking it when idle.",
    promptGuidelines: [
      "send_message never wakes an idle agent; use followup_task when an idle agent should start another turn.",
    ],
    parameters: SendMessageParams,
    executionMode: "parallel",
    async execute(_id, params) {
      return canonicalCollaborationResult(
        "send_message",
        await manager().sendMessage(params.target, params.message),
      );
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("send_message"))} ${theme.fg("accent", oneLine(args.target || "", 80))}`,
        0,
        0,
      );
    },
    renderResult(toolResult, options, theme) {
      const details = toolResult.details as any;
      if (options.expanded) return expandedDetails(details, theme);
      return new Text(
        theme.fg(
          "toolOutput",
          `${details?.delivery ?? "sent"} → ${details?.target ?? "child"}${details?.pending_messages ? ` · ${details.pending_messages} queued` : ""}`,
        ),
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: "followup_task",
    label: "Follow-up Task",
    description:
      "Send a follow-up task to an existing non-root same-tree agent. Reuse its session and trigger a turn if idle; deliver promptly if already running.",
    promptSnippet:
      "Give a persistent same-tree agent a new task and wake it when idle.",
    promptGuidelines: [
      "Only current-runtime live handles are targetable; after /reload, resume, fork, or a new runtime, call list_agents and spawn replacements.",
    ],
    parameters: FollowupTaskParams,
    executionMode: "parallel",
    async execute(_id, params) {
      return canonicalCollaborationResult(
        "followup_task",
        await manager().followupTask(params.target, params.message),
      );
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("followup_task"))} ${theme.fg("accent", oneLine(args.target || "", 80))}`,
        0,
        0,
      );
    },
    renderResult(toolResult, options, theme) {
      const details = toolResult.details as any;
      if (options.expanded) return expandedDetails(details, theme);
      return new Text(
        theme.fg(
          "toolOutput",
          `${details?.delivery ?? "sent"} → ${details?.target ?? "child"} · ${details?.turn_id ?? "turn"}`,
        ),
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: "wait_agent",
    label: "Wait Agent",
    description:
      "Wait indefinitely for any, one, or all selected agents to reach terminal status. Agent waits never take a time limit. The separate `{seconds}` mode is only a clock delay and does not inspect agents.",
    promptSnippet:
      "Wait indefinitely for one, any, or all snapshotted agents, or use a standalone clock delay.",
    promptGuidelines: [
      "For agent completion, use {} for ANY, target for one agent, or all:true for ALL; these modes have no time limit.",
      "Never use seconds to poll or wait for agents. `{seconds}` is a standalone clock delay only.",
      "Later spawns are never added to an existing agent wait.",
      "The user-requested terminal wait modes are Pi's second intentional Codex-v2 divergence alongside depth enforcement.",
    ],
    parameters: WaitAgentParams,
    executionMode: "sequential",
    async execute(_id, params, signal) {
      return canonicalCollaborationResult(
        "wait_agent",
        await manager().waitAgent(params, signal),
      );
    },
    renderCall(args, theme) {
      const selector = args as { target?: string; all?: true; seconds?: number };
      const mode = selector.seconds !== undefined
        ? `delay ${selector.seconds}s`
        : `${selector.target ?? (selector.all === true ? "all" : "any")} · until done`;
      return new Text(
        `${theme.fg("toolTitle", theme.bold("wait_agent"))} ${theme.fg("accent", mode)}`,
        0,
        0,
      );
    },
    renderResult(toolResult, options, theme) {
      const details = toolResult.details as any;
      if (options.expanded) return expandedDetails(details, theme);
      return new Text(
        theme.fg(details?.timed_out ? "warning" : "toolOutput", details?.message ?? "Wait ended."),
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: "interrupt_agent",
    label: "Interrupt Agent",
    description:
      "Interrupt a same-tree agent's current turn, if any, and return its previous status. The request is non-cascading and the agent remains reusable.",
    promptSnippet:
      "Soft-interrupt an agent's current turn while preserving it for reuse.",
    promptGuidelines: [
      "interrupt_agent is non-cascading; use followup_task to give the reusable agent more work later.",
    ],
    parameters: InterruptAgentParams,
    executionMode: "parallel",
    async execute(_id, params) {
      return canonicalCollaborationResult(
        "interrupt_agent",
        await manager().interruptAgent(params.target),
      );
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("interrupt_agent"))} ${theme.fg("accent", oneLine(args.target || "", 80))}`,
        0,
        0,
      );
    },
    renderResult(toolResult, options, theme) {
      const details = toolResult.details as any;
      if (options.expanded) return expandedDetails(details, theme);
      const current = details?.current_status
        ? statusLabel(details.current_status)
        : "unknown";
      return new Text(
        theme.fg("toolOutput", `${details?.target ?? "child"} · ${current}`),
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: "list_agents",
    label: "List Agents",
    description:
      "List live agents in the current root agent tree, optionally filtered by a strict canonical or caller-relative path prefix.",
    promptSnippet:
      "List live root-tree agents with canonical status and last task message.",
    parameters: ListAgentsParams,
    executionMode: "sequential",
    async execute(_id, params) {
      return canonicalCollaborationResult(
        "list_agents",
        await manager().listAgents(params.path_prefix),
      );
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("list_agents"))}${args.path_prefix ? ` ${theme.fg("dim", oneLine(args.path_prefix, 80))}` : ""}`,
        0,
        0,
      );
    },
    renderResult(toolResult, options, theme) {
      const details = toolResult.details as any;
      if (options.expanded) return expandedDetails(details, theme);
      const agents = Array.isArray(details?.agents) ? details.agents : [];
      return new Text(
        theme.fg("toolOutput", `${agents.length} agent record${agents.length === 1 ? "" : "s"} · shared workspace`),
        0,
        0,
      );
    },
  });
}
