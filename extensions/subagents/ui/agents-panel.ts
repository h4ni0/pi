import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { AgentsOverlay, ChildConsoleOverlay } from "../overlays.ts";
import { recordsToList } from "../render-utils.ts";
import type { SubagentRecord } from "../types.ts";
import { abortChild, sendToChild } from "../runtime/records.ts";
import type { SubagentRuntimeState } from "../runtime/state.ts";
import { activeRecords, updateStatus } from "../runtime/status-ui.ts";

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
      { action: "steer" | "abort" | "enter"; id: string } | undefined
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
    const record = state.active.get(result.id);
    if (!record) {
      ctx.ui.notify(`Sub-agent ${result.id} is no longer active.`, "warning");
      continue;
    }
    if (result.action === "steer") await promptAndSteer(ctx, record);
    else if (result.action === "abort") await promptAndAbort(state, ctx, record);
    else if (result.action === "enter") await enterChildMode(state, ctx, record.id);
  }
}

async function promptAndSteer(ctx: ExtensionContext, record: SubagentRecord) {
  const title = `Steer ${record.generatedLabel || record.id}`;
  const message = await ctx.ui.editor(title, "");
  if (!message?.trim()) return;
  try {
    await sendToChild(record, message.trim());
    ctx.ui.notify(`Steered ${record.generatedLabel || record.id}`, "info");
  } catch (err) {
    ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
  }
}

async function promptAndAbort(
  state: SubagentRuntimeState,
  ctx: ExtensionContext,
  record: SubagentRecord,
) {
  const ok = await ctx.ui.confirm(
    `Abort ${record.generatedLabel}?`,
    `This aborts ${record.id} and its current task.`,
  );
  if (!ok) return;
  await abortChild(state, record);
  ctx.ui.notify(`Aborted ${record.id}`, "warning");
}

export async function enterChildMode(
  state: SubagentRuntimeState,
  ctx: ExtensionContext,
  id: string,
) {
  const record = state.active.get(id);
  if (!record) {
    ctx.ui.notify(`Sub-agent ${id} is not active.`, "warning");
    return;
  }
  state.insideChildId = id;
  updateStatus(state, ctx);
  try {
    while (state.active.has(id)) {
      const current = state.active.get(id)!;
      const action = await ctx.ui.custom<{ action: "send" | "abort" } | undefined>(
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
      if (action.action === "send") await promptAndSteer(ctx, current);
      if (action.action === "abort") await promptAndAbort(state, ctx, current);
    }
  } finally {
    state.insideChildId = undefined;
    updateStatus(state, ctx);
  }
}
