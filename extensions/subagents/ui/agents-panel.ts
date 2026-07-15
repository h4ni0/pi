import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { AgentsOverlay, ChildConsoleOverlay } from "../overlays.ts";
import { recordsToList } from "../render-utils.ts";
import type { SubagentRecord } from "../types.ts";
import type { SubagentRuntimeState } from "../runtime/state.ts";
import { activeRecords, updateStatus } from "../runtime/status-ui.ts";
import { resolveAgentReferenceWithAliases } from "../runtime/agent-path.ts";

export async function openAgentsModal(
  state: SubagentRuntimeState,
  ctx: ExtensionContext,
) {
  if (ctx.mode !== "tui") {
    ctx.ui.notify(recordsToList(activeRecords(state)), "info");
    return;
  }
  while (true) {
    const result = await ctx.ui.custom<
      | {
          action: "message" | "followup" | "interrupt" | "enter";
          id: string;
        }
      | undefined
    >(
      (tui: TUI, theme: Theme, _kb, done) =>
        new AgentsOverlay(
          theme,
          () => activeRecords(state),
          done,
          () => tui.requestRender(),
          () => Math.max(8, Math.floor(tui.terminal.rows * 0.86) - 6),
        ),
      {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: "88%",
          maxHeight: "86%",
          margin: 1,
        },
      },
    );
    if (!result) return;
    const record = state.active.get(result.id) ?? state.history.get(result.id);
    if (!record) {
      ctx.ui.notify(`Sub-agent ${result.id} is no longer retained.`, "warning");
      continue;
    }
    if (result.action === "message") await promptAndSend(state, ctx, record, false);
    else if (result.action === "followup")
      await promptAndSend(state, ctx, record, true);
    else if (result.action === "interrupt")
      await promptAndInterrupt(state, ctx, record);
    else if (result.action === "enter") await enterChildMode(state, ctx, record.id);
  }
}

async function promptAndSend(
  state: SubagentRuntimeState,
  ctx: ExtensionContext,
  record: SubagentRecord,
  followup: boolean,
) {
  const action = followup ? "Follow up" : "Message";
  const message = await ctx.ui.editor(`${action} ${record.agentName}`, "");
  if (!message?.trim()) return;
  try {
    if (!state.manager) throw new Error("Collaboration manager is unavailable");
    if (followup) await state.manager.followupTask(record.id, message);
    else await state.manager.sendMessage(record.id, message);
    ctx.ui.notify(`${action} sent to ${record.agentName}`, "info");
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
  }
}

async function promptAndInterrupt(
  state: SubagentRuntimeState,
  ctx: ExtensionContext,
  record: SubagentRecord,
) {
  const ok = await ctx.ui.confirm(
    `Interrupt ${record.agentName}?`,
    "This soft-interrupts only the current turn; the agent remains reusable.",
  );
  if (!ok) return;
  try {
    await state.manager?.interruptAgent(record.id);
    ctx.ui.notify(`Interrupted ${record.agentName}`, "warning");
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
  }
}

export async function enterChildMode(
  state: SubagentRuntimeState,
  ctx: ExtensionContext,
  id: string,
) {
  const records = [...state.active.values(), ...state.history.values()];
  let resolvedPath: string;
  try {
    resolvedPath = resolveAgentReferenceWithAliases(
      state.currentPath,
      id,
      new Map(records.map((record) => [record.id, record.agentName])),
      new Set(records.map((record) => record.agentName)),
    );
  } catch (error) {
    ctx.ui.notify(
      error instanceof Error ? error.message : `Sub-agent ${id} is not retained.`,
      "warning",
    );
    return;
  }
  const record = records.find(
    (candidate) => candidate.agentName === resolvedPath,
  );
  if (!record) {
    ctx.ui.notify(`Sub-agent ${id} is not retained.`, "warning");
    return;
  }
  state.insideChildId = record.id;
  updateStatus(state, ctx);
  try {
    while (state.active.has(record.id)) {
      const current = state.active.get(record.id)!;
      const action = await ctx.ui.custom<
        { action: "message" | "followup" | "interrupt" | "close" } | undefined
      >(
        (tui, theme, _kb, done) =>
          new ChildConsoleOverlay(
            theme,
            current,
            done,
            () => tui.requestRender(),
            () => Math.max(8, Math.floor(tui.terminal.rows * 0.86) - 6),
          ),
        {
          overlay: true,
          overlayOptions: {
            anchor: "center",
            width: "90%",
            maxHeight: "86%",
            margin: 1,
          },
        },
      );
      if (!action) return;
      if (action.action === "message")
        await promptAndSend(state, ctx, current, false);
      if (action.action === "followup")
        await promptAndSend(state, ctx, current, true);
      if (action.action === "interrupt")
        await promptAndInterrupt(state, ctx, current);
    }
  } finally {
    state.insideChildId = undefined;
    updateStatus(state, ctx);
  }
}
