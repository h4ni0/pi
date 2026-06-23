import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ASK_PARENT_EXCHANGE_MESSAGE_TYPE } from "../../constants.ts";
import type { AskParentRequest, SubagentRecord } from "../../types.ts";
import type { SubagentRuntimeState } from "../state.ts";

export function askParentRequestKind(request: AskParentRequest): string {
  if (request.reason === "course_change" || request.reason === "risk_detected")
    return "course-changing update";
  return "question";
}

export function publishAskParentExchange(
  state: SubagentRuntimeState,
  record: SubagentRecord,
  request: AskParentRequest,
  answer: string,
  ctx: ExtensionContext,
) {
  const content = [
    "## ask_parent",
    `Sub-agent: ${record.id} (${record.generatedLabel})`,
    `Depth: ${record.depth}`,
    `Reason: ${request.reason}`,
    `Blocking: ${request.blocking ? "yes" : "no"}`,
    `Type: ${askParentRequestKind(request)}`,
    "",
    "### Child question/update",
    request.question || request.message,
    request.question ? `\nContext: ${request.message}` : undefined,
    request.options?.length ? `Options: ${request.options.join(" | ")}` : undefined,
    request.recommendation ? `Recommendation: ${request.recommendation}` : undefined,
    request.lastToolCall
      ? `Last tool: ${request.lastToolCall.name} ${request.lastToolCall.argsSummary}`
      : undefined,
    request.lastMessageSnippet ? `Last child message: ${request.lastMessageSnippet}` : undefined,
    "",
    "### Parent agent answer",
    answer,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
  state.pi.sendMessage(
    {
      customType: ASK_PARENT_EXCHANGE_MESSAGE_TYPE,
      content,
      display: true,
      details: { childId: record.id, label: record.generatedLabel, request, answer },
    },
    ctx.isIdle() ? undefined : { deliverAs: "steer", triggerTurn: false },
  );
}

export function formatAskParentRequest(
  record: SubagentRecord,
  request: AskParentRequest,
): string {
  const lines = [
    `Sub-agent ${record.id} (${record.generatedLabel}) asks parent.`,
    `Depth: ${record.depth}`,
    `Reason: ${request.reason}`,
    `Blocking: ${request.blocking ? "yes" : "no"}`,
    `Type: ${askParentRequestKind(request)}`,
    `Message: ${request.message}`,
  ];
  if (request.question) lines.push(`Question: ${request.question}`);
  if (request.recommendation) lines.push(`Recommendation: ${request.recommendation}`);
  if (request.options?.length) lines.push(`Options: ${request.options.join(" | ")}`);
  if (request.lastToolCall)
    lines.push(
      `Last tool: ${request.lastToolCall.name} ${request.lastToolCall.argsSummary}`,
    );
  if (request.lastMessageSnippet) lines.push(`Last child message: ${request.lastMessageSnippet}`);
  return lines.join("\n");
}
