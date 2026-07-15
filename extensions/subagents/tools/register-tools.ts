import { Text } from "@earendil-works/pi-tui";
import { AskParentParams, DelegateParams } from "../schemas.ts";
import { OneLineList, renderToolTree } from "../render-utils.ts";
import type { DelegateDetails } from "../types.ts";
import { generatedLabel, oneLine } from "../utils.ts";
import { spawnDelegate } from "../runtime/launcher.ts";
import type { SubagentRuntimeState } from "../runtime/state.ts";
import { registerCollaborationTools } from "./register-collaboration-tools.ts";

export function registerSubagentTools(state: SubagentRuntimeState) {
  const { pi } = state;

  registerCollaborationTools(state);

  // Registered everywhere so trusted settings can activate it dynamically;
  // applyRoleActiveTools withholds it at/above the effective depth limit.
  pi.registerTool({
      name: "delegate",
      label: "Delegate",
      description:
        "Run one blocking, disposable, one-shot compatibility sub-agent. It returns its bounded result inline, then closes and cannot be reused or targeted. Context is a compact parent handoff by default or fresh when requested.",
      promptSnippet:
        "Run one blocking disposable sub-agent; use spawn_agent instead for asynchronous reusable collaboration.",
      promptGuidelines: [
        "Use delegate only for a blocking one-shot task; unlike spawn_agent, a returned delegate is disposable, non-reusable, and non-targetable.",
        "Do not use delegate as a fallback after spawn_agent startup failure; diagnose or report the shared runtime failure before any further delegation.",
        "When using delegate, provide a short title so the UI can display 'Delegate: <title>'.",
        "delegate context defaults to a compact summary, not a transcript fork; use context='fresh' for unrelated tasks.",
        "Avoid parallel write-capable delegates in the same checkout unless tasks are independent; they can clobber each other.",
      ],
      parameters: DelegateParams,
      executionMode: "parallel",
      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        return spawnDelegate(state, params, signal, onUpdate, ctx);
      },
      renderCall(args, theme) {
        const title = oneLine(
          args.title?.trim?.() || generatedLabel(args.task ?? "delegated task"),
          80,
        );
        return new OneLineList([
          `${theme.fg("toolTitle", theme.bold("Delegate:"))} ${theme.fg("accent", title)}`,
        ]);
      },
      renderResult(result, options, theme) {
        const text = result.content[0]?.type === "text" ? result.content[0].text : "";
        if (options.expanded)
          return new Text(theme.fg("toolOutput", text), 0, 0);
        const details = result.details as DelegateDetails | undefined;
        if (!details) {
          return new OneLineList(
            text ? [theme.fg("toolOutput", oneLine(text, 220))] : [],
          );
        }
        const lines = renderToolTree(details.events, theme, 130);
        if (details.finalOutput)
          lines.push(theme.fg("toolOutput", oneLine(details.finalOutput, 220)));
        return new OneLineList(lines);
      },
    });

  if (state.isChild) {
    pi.registerTool({
      name: "ask_parent",
      label: "Ask Parent",
      description:
        "Ask the immediate parent agent for blocking decisions/clarifications or report course-changing discoveries. This does not ask the human user directly.",
      promptSnippet:
        "Ask the immediate parent agent when blocked, uncertain, or when a course-changing risk/discovery needs visibility.",
      promptGuidelines: [
        "Use ask_parent for blocking questions and material course-changing updates only; do not use it for routine progress.",
        "ask_parent goes to the parent agent, not to the human user. Phrase questions for the parent agent.",
        "Default ask_parent blocking=true when scope, destructive edits, architecture, security, data loss, cost, or user intent is affected.",
        "Never silently assume user intent when correctness or safety depends on it; ask_parent instead.",
      ],
      parameters: AskParentParams,
      executionMode: "sequential",
      async execute(_toolCallId, params, signal) {
        const broker = state.broker;
        if (!broker) throw new Error("Authenticated parent broker is unavailable");
        const answer = await broker.askParent(
          {
            message: params.message,
            reason: params.reason,
            blocking: params.blocking ?? true,
            question: params.question,
            options: params.options,
            recommendation: params.recommendation,
          },
          signal,
        );
        return {
          content: [{ type: "text", text: answer.answer }],
          details: { answer },
        };
      },
      renderCall(args, theme) {
        const blocking = args.blocking === false ? "non-blocking" : "blocking";
        return new Text(
          `${theme.fg("toolTitle", theme.bold("ask_parent"))} ${theme.fg("accent", args.reason)} ${theme.fg("dim", blocking)}\n${theme.fg("dim", oneLine(args.question || args.message || "", 160))}`,
          0,
          0,
        );
      },
      renderResult(result, _options, theme) {
        const text = result.content[0]?.type === "text" ? result.content[0].text : "";
        return new Text(theme.fg("toolOutput", text), 0, 0);
      },
    });
  }
}
