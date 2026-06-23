import { completeSimple } from "@earendil-works/pi-ai";
import {
  buildSessionContext,
  convertToLlm,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  ASK_PARENT_ESCALATE_CLOSE,
  ASK_PARENT_ESCALATE_OPEN,
  NOTICE_MESSAGE_TYPE,
} from "../../constants.ts";
import type { AskParentRequest, SubagentRecord } from "../../types.ts";
import { selectRecentMessages } from "../../summaries.ts";
import { askParentViaBridge } from "./bridge.ts";
import { formatAskParentRequest, publishAskParentExchange } from "./format.ts";
import { askUserQuestions } from "./ui.ts";
import type { SubagentRuntimeState } from "../state.ts";

export async function answerQuestionForChild(
  state: SubagentRuntimeState,
  record: SubagentRecord,
  request: AskParentRequest,
): Promise<string> {
  const formatted = formatAskParentRequest(record, request);
  const ctx = state.latestCtx;
  if (!request.blocking) {
    notifyAskParentUpdate(state, record, request, formatted, ctx);
    return "Parent agent notified. Continue with the safe next step unless the parent steers you.";
  }

  if (!ctx) return escalateAskParent(state, record, request, formatted, undefined);
  return answerWithParentAgent(state, record, request, formatted, ctx);
}

function notifyAskParentUpdate(
  state: SubagentRuntimeState,
  record: SubagentRecord,
  request: AskParentRequest,
  formatted: string,
  ctx: ExtensionContext | undefined,
) {
  ctx?.ui.notify?.(
    `Sub-agent ${record.id}: ${request.reason}`,
    request.reason === "risk_detected" ? "warning" : "info",
  );
  state.pi.sendMessage(
    {
      customType: NOTICE_MESSAGE_TYPE,
      content: formatted,
      display: true,
      details: { request, childId: record.id },
    },
    ctx && !ctx.isIdle() ? { deliverAs: "steer", triggerTurn: false } : undefined,
  );
}

async function answerWithParentAgent(
  state: SubagentRuntimeState,
  record: SubagentRecord,
  request: AskParentRequest,
  formatted: string,
  ctx: ExtensionContext,
): Promise<string> {
  const model = ctx.model;
  if (!model) {
    const answer = await escalateAskParent(state, record, request, formatted, ctx);
    publishAskParentExchange(state, record, request, answer, ctx);
    return answer;
  }
  try {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      const answer = await escalateAskParent(state, record, request, formatted, ctx);
      publishAskParentExchange(state, record, request, answer, ctx);
      return answer;
    }
    const sessionContext = buildSessionContext(ctx.sessionManager.getBranch());
    const recent = selectRecentMessages(
      sessionContext.messages,
      state.settings.handoffKeepRecentTokens,
    );
    const parentPrompt = [
      "A child sub-agent invoked ask_parent. Answer as the immediate parent Pi agent, not as the human user.",
      "Use the parent conversation context and your own task understanding. Do not claim to have user approval unless it is already present in the conversation.",
      "If you cannot answer confidently from parent context, escalate instead of guessing.",
      `To escalate, return exactly ${ASK_PARENT_ESCALATE_OPEN}, then the question/context to send upward, then ${ASK_PARENT_ESCALATE_CLOSE}.`,
      "Otherwise return only the answer/instruction that should be delivered to the child sub-agent.",
      "",
      formatted,
    ].join("\n");
    const response = await completeSimple(
      model,
      {
        systemPrompt: `${ctx.getSystemPrompt()}\n\nYou may answer child sub-agent ask_parent requests as the immediate parent agent. Escalate upward when the immediate parent cannot answer confidently.`,
        messages: [
          ...convertToLlm(recent),
          {
            role: "user",
            content: [{ type: "text", text: parentPrompt }],
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        signal: ctx.signal,
        reasoning:
          state.pi.getThinkingLevel?.() === "off"
            ? undefined
            : (state.pi.getThinkingLevel?.() as any),
      },
    );
    if (response.stopReason === "error" || response.stopReason === "aborted")
      throw new Error(response.errorMessage || response.stopReason);
    const rawAnswer =
      response.content
        .filter((part: any) => part.type === "text")
        .map((part: any) => part.text)
        .join("\n")
        .trim() ||
      "The parent agent produced no answer. Stop and report this blocker.";
    const escalation = parseParentEscalation(rawAnswer);
    const answer = escalation
      ? await escalateAskParent(state, record, request, escalation, ctx)
      : rawAnswer;
    publishAskParentExchange(state, record, request, answer, ctx);
    return answer;
  } catch (err) {
    record.error =
      record.error ??
      `parent agent answer failed: ${err instanceof Error ? err.message : String(err)}`;
    const answer = await escalateAskParent(state, record, request, formatted, ctx);
    publishAskParentExchange(state, record, request, answer, ctx);
    return answer;
  }
}

function parseParentEscalation(answer: string): string | undefined {
  const start = answer.indexOf(ASK_PARENT_ESCALATE_OPEN);
  if (start < 0) return undefined;
  const after = start + ASK_PARENT_ESCALATE_OPEN.length;
  const end = answer.indexOf(ASK_PARENT_ESCALATE_CLOSE, after);
  const inner = (end >= 0 ? answer.slice(after, end) : answer.slice(after)).trim();
  return (
    inner ||
    answer
      .replace(ASK_PARENT_ESCALATE_OPEN, "")
      .replace(ASK_PARENT_ESCALATE_CLOSE, "")
      .trim()
  );
}

async function escalateAskParent(
  state: SubagentRuntimeState,
  record: SubagentRecord,
  request: AskParentRequest,
  formatted: string,
  ctx: ExtensionContext | undefined,
): Promise<string> {
  if (state.currentDepth > 0 && process.env.PI_SUBAGENT_BRIDGE_DIR) {
    const upstream = await askParentViaBridge(
      state,
      {
        message: formatted,
        reason: request.reason,
        blocking: request.blocking,
        question: request.question ?? request.message,
        options: request.options,
        recommendation: request.recommendation,
        lastMessageSnippet: request.lastMessageSnippet,
        lastToolCall: request.lastToolCall,
      },
      ctx?.signal,
    );
    return upstream.answer;
  }

  if (ctx?.hasUI) {
    return askUserQuestions(
      {
        title: `Sub-agent ${record.id} asks parent`,
        message: formatted,
        question: request.question ?? request.message,
        options: request.options,
        recommendation: request.recommendation,
      },
      ctx,
    );
  }

  return "The parent agent could not answer confidently and no higher-level parent/user UI is available. Stop and report this blocker with the ask_parent context.";
}
