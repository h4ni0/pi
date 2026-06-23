import * as path from "node:path";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildInitialPrompt } from "../prompts.ts";
import { loadSettings } from "../settings.ts";
import { RpcProcess } from "../rpc-process.ts";
import { generateHandoffSummary, makeCompletionPayload } from "../summaries.ts";
import type {
  CompletionPayload,
  ContextMode,
  DelegateDetails,
  LiveDelegateUpdater,
  SubagentRecord,
} from "../types.ts";
import {
  currentProcessAgentId,
  currentRootId,
  ensureDir,
  generatedLabel,
  getPiInvocation,
  makeId,
  now,
  oneLine,
} from "../utils.ts";
import { startBridgeWatcher } from "./ask-parent.ts";
import {
  abortChild,
  handleRpcEvent,
  makeLiveUpdater,
  removeActiveWhenSettled,
  toDelegateDetails,
  usageFromStats,
} from "./records.ts";
import type { SubagentRuntimeState } from "./state.ts";
import { childToolsForSpawn } from "./tool-list.ts";
import { updateStatus } from "./status-ui.ts";

export async function launchChild(
  state: SubagentRuntimeState,
  record: SubagentRecord,
  initialPrompt: string,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
  liveUpdate?: LiveDelegateUpdater,
): Promise<CompletionPayload> {
  const childSettings = state.settings;
  if (!record.sessionDir || !record.bridgeDir)
    throw new Error("child session directories were not initialized");
  ensureDir(record.sessionDir);
  ensureDir(path.join(record.bridgeDir, "requests"));
  ensureDir(path.join(record.bridgeDir, "answers"));

  const args = [
    "--mode",
    "rpc",
    "--name",
    record.generatedLabel,
    "-e",
    state.extensionPath,
  ];
  if (childSettings.persistSessions) args.push("--session-dir", record.sessionDir);
  else args.push("--no-session");
  if (ctx.model) args.push("--model", `${ctx.model.provider}/${ctx.model.id}`);
  const thinking = state.pi.getThinkingLevel?.();
  if (thinking) args.push("--thinking", thinking);

  const invocation = getPiInvocation(args);
  const env: Record<string, string | undefined> = {
    PI_SUBAGENT_ID: record.id,
    PI_SUBAGENT_LABEL: record.generatedLabel,
    PI_SUBAGENT_DEPTH: String(record.depth),
    PI_SUBAGENT_MAX_DEPTH: String(childSettings.maxDepth),
    PI_SUBAGENT_PARENT_ID: currentProcessAgentId(ctx),
    PI_SUBAGENT_ROOT_ID: record.rootId,
    PI_SUBAGENT_BRIDGE_DIR: record.bridgeDir,
    PI_SUBAGENT_ACTIVE_TOOLS: JSON.stringify(childToolsForSpawn(state)),
  };
  const client = new RpcProcess(invocation.command, invocation.args, {
    cwd: ctx.cwd,
    env,
  });
  record.client = client;
  record.status = "starting";
  startBridgeWatcher(state, record);
  const stopEventUpdates = client.onEvent((event) => {
    handleRpcEvent(state, record, event);
    liveUpdate?.notify();
  });
  let abortListener: (() => void) | undefined;
  try {
    if (signal) {
      abortListener = () => {
        void abortChild(state, record);
      };
      if (signal.aborted) abortListener();
      else signal.addEventListener("abort", abortListener, { once: true });
    }
    await client.start();
    record.pid = client.pid;
    const stateBefore = await client.getState().catch(() => undefined);
    if (stateBefore?.sessionFile) record.sessionFile = stateBefore.sessionFile;
    if (stateBefore?.model)
      record.model = `${stateBefore.model.provider}/${stateBefore.model.id}`;
    if (stateBefore?.thinkingLevel) record.thinkingLevel = stateBefore.thinkingLevel;
    await client.setSessionName(record.generatedLabel).catch(() => undefined);
    await client.prompt(initialPrompt);
    await waitForChildFinish(record, signal);
    const finalText = await client.getLastAssistantText().catch(() => null);
    record.finalOutput = finalText ?? record.finalOutput ?? "";
    const stateAfter = await client.getState().catch(() => undefined);
    if (stateAfter?.sessionFile) record.sessionFile = stateAfter.sessionFile;
    if (stateAfter?.model)
      record.model = `${stateAfter.model.provider}/${stateAfter.model.id}`;
    if (stateAfter?.thinkingLevel) record.thinkingLevel = stateAfter.thinkingLevel;
    const stats = await client.getSessionStats().catch(() => undefined);
    if (stats) record.usage = usageFromStats(stats);
    if (record.status !== "failed" && record.status !== "aborted")
      record.status = "completed";
    record.endedAt ??= now();
    liveUpdate?.notify(true);
    return await makeCompletionPayload(
      record,
      ctx,
      childSettings,
      signal,
      state.pi.getThinkingLevel?.(),
    );
  } catch (err) {
    if (record.status !== "aborted") record.status = "failed";
    record.error = err instanceof Error ? err.message : String(err);
    record.finalOutput = record.finalOutput || record.error;
    record.endedAt = now();
    liveUpdate?.notify(true);
    return await makeCompletionPayload(
      record,
      ctx,
      childSettings,
      signal,
      state.pi.getThinkingLevel?.(),
    );
  } finally {
    if (signal && abortListener) signal.removeEventListener("abort", abortListener);
    liveUpdate?.close();
    stopEventUpdates();
    clearInterval(record.bridgeTimer);
    await client.stop().catch(() => undefined);
    updateStatus(state);
  }
}

function waitForChildFinish(
  record: SubagentRecord,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Sub-agent aborted"));
      return;
    }
    const client = record.client;
    if (!client) {
      reject(new Error("Sub-agent client missing"));
      return;
    }
    const cleanup = client.onEvent((event) => {
      if (event.type === "agent_end") {
        cleanup();
        resolve();
      }
      if (event.type === "process_exit" || event.type === "process_error") {
        cleanup();
        reject(new Error(event.error || "Sub-agent process exited before completion"));
      }
    });
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          cleanup();
          reject(new Error("Sub-agent aborted"));
        },
        { once: true },
      );
    }
  });
}

export async function spawnDelegate(
  state: SubagentRuntimeState,
  params: { title?: string; task: string; context?: ContextMode },
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<DelegateDetails> | undefined,
  ctx: ExtensionContext,
): Promise<AgentToolResult<DelegateDetails>> {
  state.latestCtx = ctx;
  state.settings = loadSettings(ctx.cwd);
  if (process.env.PI_SUBAGENT_MAX_DEPTH) state.settings.maxDepth = state.envMaxDepth;
  const contextMode = params.context ?? state.settings.defaultContext;
  if (!state.settings.allowChildSubagents || state.currentDepth >= state.settings.maxDepth) {
    return {
      content: [
        {
          type: "text",
          text: `Cannot delegate: maxDepth ${state.settings.maxDepth} reached at depth ${state.currentDepth}.`,
        },
      ],
      details: {
        id: "",
        label: "max depth",
        status: "failed",
        contextMode,
        depth: state.currentDepth,
        maxDepth: state.settings.maxDepth,
        task: params.task,
        error: "max depth reached",
        events: [],
      },
    };
  }

  const id = makeId();
  const label = oneLine(params.title?.trim() || generatedLabel(params.task), 48);
  const rootId = currentRootId(ctx);
  const depth = state.currentDepth + 1;
  const sessionDir = path.join(state.settings.sessionDir, rootId, id);
  const bridgeDir = path.join(sessionDir, "bridge");
  const record: SubagentRecord = {
    id,
    generatedLabel: label,
    parentId: currentProcessAgentId(ctx),
    rootId,
    depth,
    status: "queued",
    task: params.task,
    contextMode,
    createdAt: now(),
    sessionDir,
    bridgeDir,
    nestedActiveCount: 0,
    events: [],
    handledBridgeRequestIds: new Set(),
  };
  state.active.set(id, record);
  updateStatus(state, ctx);

  const handoff =
    contextMode === "compact"
      ? await generateHandoffSummary(
          ctx,
          state.settings,
          signal,
          state.pi.getThinkingLevel?.(),
        )
      : undefined;
  const initialPrompt = buildInitialPrompt(
    params.task,
    contextMode,
    handoff,
    depth,
    state.settings.maxDepth,
  );
  const liveUpdate = makeLiveUpdater(state, record, onUpdate);
  record.completion = launchChild(state, record, initialPrompt, ctx, signal, liveUpdate);

  const completion = await record.completion;
  removeActiveWhenSettled(state, record);
  return {
    content: [{ type: "text", text: oneLine(completion.output || completion.payload || "", 220) }],
    details: toDelegateDetails(record, state.settings),
  };
}
