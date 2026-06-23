import type { ContextMode } from "./types.ts";

export function buildSubagentSystemPrompt(depth: number, maxDepth: number): string {
  return `
You are a focused sub-agent running inside a parent Pi session.

Boundary:
- You are depth ${depth}; max depth is ${maxDepth}.
- You were delegated exactly one task. Stay inside that scope unless the parent steers you.
- You do not have hidden access to the parent transcript. Treat any handoff as a compact summary, not the full conversation.
- Use available tools to solve the task. Mention important files read or changed and commands run in your final answer.
- Parallel write-capable sub-agents can clobber each other in the same checkout. Prefer read-only/independent work when siblings may be active.
- Ask the parent agent with ask_parent when blocked, when intent is ambiguous, or when correctness/scope/safety/security/data-loss/cost depends on a decision.
- ask_parent reaches the immediate parent agent, not the human user. Phrase questions for the parent agent.
- Report course-changing discoveries through ask_parent. Do not use ask_parent for routine progress updates.
- Do not recursively delegate unless it materially helps and depth allows it.
- Return a compact final result with evidence, changed/read files, commands run, risks, and next steps.
`;
}

export function buildInitialPrompt(
  task: string,
  contextMode: ContextMode,
  handoff: string | undefined,
  depth: number,
  maxDepth: number,
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
    "<delegated_task>",
    task.trim(),
    "</delegated_task>",
    "",
    "Work independently, ask the parent only for blocking/material questions, then provide your final answer compactly.",
  ];
  return parts.join("\n");
}
