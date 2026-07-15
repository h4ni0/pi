import type { ContextMode } from "./types.ts";
import { parseAgentPath } from "./runtime/agent-path.ts";
import { requireNonEmptyString } from "./utils.ts";

export type InterAgentMessageType = "NEW_TASK" | "MESSAGE" | "FINAL_ANSWER";

export const COMPLETION_ERROR_NEXT_ACTION =
  "This agent's turn failed. If you still need this agent, use the available collaboration tools to give it another task.";

export function buildSubagentSystemPrompt(
  depth: number,
  maxDepth: number,
  selfPath = process.env.PI_SUBAGENT_PATH || "/root",
): string {
  return `
You are a focused sub-agent running inside a parent Pi session.

Boundary:
- Your canonical agent path is ${selfPath}; depth ${depth}; max depth ${maxDepth}.
- Stay inside delegated scope unless the parent sends a message or follow-up task.
- You have only the context present in this session: canonical spawn fork_turns history or a legacy delegate handoff. Never assume hidden parent context.
- Your Pi RPC process and conversation persist after a completed turn; same-tree agents may send more work later.
- send_message to an idle agent only queues mail; followup_task wakes an idle non-root agent on the same session.
- Final answers are delivered automatically to your direct parent. wait_agent snapshots agent identities/epochs and can wait for any descendant, one same-tree target, or all current descendants; later spawns are excluded. These user-requested terminal wait modes intentionally differ from Codex v2's mailbox wait.
- interrupt_agent is a reusable, non-cascading turn interrupt.
- Depth is enforced: do not attempt to spawn once depth ${maxDepth} is reached.
- All agents share the same cwd and filesystem. Inspect current file contents immediately before edits; parallel writers can clobber one another.
- Use available tools to solve the task. Mention important files read or changed and commands run in final answers.
- Use ask_parent when blocked, intent is ambiguous, or correctness/scope/safety/security/data-loss/cost depends on a decision.
- ask_parent reaches the immediate parent agent, not the human user. Report material course changes, not routine progress.
- Do not recursively spawn unless it materially helps and depth permits it. Use the smallest useful team. In a fresh runtime, prove startup with one agent before expanding in small batches; after any startup failure, stop delegating and diagnose/report it rather than retrying with delegate.
- Return a compact result with evidence, changed/read files, commands, risks, and next steps.
`;
}

export function taskEnvelope(
  type: InterAgentMessageType,
  recipientPath: string,
  senderPath: string,
  payload: string,
): string {
  const recipient = parseAgentPath(recipientPath);
  const sender = parseAgentPath(senderPath);
  const originalPayload =
    type === "FINAL_ANSWER"
      ? String(payload)
      : requireNonEmptyString(payload, "payload");
  return [
    `Message Type: ${type}`,
    `Task name: ${recipient}`,
    `Sender: ${sender}`,
    "Payload:",
    originalPayload,
  ].join("\n");
}

export function canonicalCompletionPayload(
  outcome: "completed" | "errored",
  value: string,
): string {
  if (outcome === "completed") return value;
  const error = value || "Child turn failed without an error message.";
  return `Agent errored: ${error}\n\n${COMPLETION_ERROR_NEXT_ACTION}`;
}

export function buildInitialPrompt(
  task: string,
  contextMode: ContextMode,
  handoff: string | undefined,
  depth: number,
  maxDepth: number,
  childPath = process.env.PI_SUBAGENT_PATH || "/root/legacy",
  senderPath = childPath.split("/").slice(0, -1).join("/") || "/root",
): string {
  const parts = [
    `You are a Pi sub-agent at depth ${depth}/${maxDepth}.`,
    contextMode === "compact"
      ? [
          "The following is an ephemeral compacted handoff summary from your immediate parent.",
          "It is not the full transcript; do not assume hidden context beyond it.",
          "",
          "<parent_handoff_summary>",
          handoff?.trim() || "No handoff summary was available.",
          "</parent_handoff_summary>",
        ].join("\n")
      : "Fresh context mode: no parent transcript or handoff summary is provided.",
    "",
    taskEnvelope("NEW_TASK", childPath, senderPath, task),
    "",
    "Work independently, ask the parent only for blocking/material questions, then provide your final answer compactly.",
  ];
  return parts.join("\n");
}
