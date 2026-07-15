import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { EXTENSION_KEY } from "../constants.ts";
import {
  formatCwdForDisplay,
  globalSubagentsStatus,
  usageTotals,
} from "../status.ts";
import { formatTokens, now, oneLine, stripAnsi } from "../utils.ts";
import type { SubagentRuntimeState } from "./state.ts";

export function activeRecords(state: SubagentRuntimeState) {
  return [
    ...state.active.values(),
    ...state.history.values(),
  ].sort((left, right) => left.updatedAt - right.updatedAt);
}

export function subagentStatusText(
  state: SubagentRuntimeState,
  theme: Theme,
  compact = false,
): string {
  const records = activeRecords(state);
  const running = records.filter(
    (r) =>
      r.status === "running" ||
      r.status === "starting" ||
      r.status === "queued",
  ).length;
  const waiting = records.filter((r) => r.status === "waiting_for_answer").length;
  const nested = records.reduce((sum, r) => sum + (r.nestedActiveCount ?? 0), 0);
  const idle = records.filter((r) => ["completed", "interrupted", "failed", "aborted"].includes(r.status)).length;
  const shutdown = records.filter((r) => r.status === "shutdown").length;
  const total = records.length;
  const label = theme.fg(total || state.insideChildId ? "accent" : "dim", "agents");
  const counts = [`${running}/${total}`];
  if (!compact) counts[0] += " running";
  if (waiting) counts.push(theme.fg("warning", `${waiting} waiting`));
  if (idle) counts.push(`${idle} idle`);
  if (shutdown) counts.push(`${shutdown} shutdown`);
  if (nested) counts.push(`${nested} nested`);
  if (state.insideChildId) counts.push(`inside ${state.insideChildId}`);
  return `${label} ${theme.fg("dim", counts.join(" · "))}`;
}

export function installSubagentsFooter(
  state: SubagentRuntimeState,
  ctx: ExtensionContext,
) {
  if (ctx.mode !== "tui") return;
  ctx.ui.setFooter((tui, theme, footerData) => {
    const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
    const timer = setInterval(() => tui.requestRender(), 1_000);
    return {
      dispose() {
        unsubscribe();
        clearInterval(timer);
      },
      invalidate() {},
      render(width: number): string[] {
        const current = state.latestCtx ?? ctx;
        const cwd = formatCwdForDisplay(current.cwd);
        const branch = footerData.getGitBranch();
        const sessionName = current.sessionManager.getSessionName();
        const leftParts = [cwd, branch ? `git ${branch}` : undefined, sessionName].filter(Boolean);
        const totals = usageTotals(current);
        const usageParts = [
          totals.input ? `↑${formatTokens(totals.input)}` : undefined,
          totals.output ? `↓${formatTokens(totals.output)}` : undefined,
          totals.cacheRead ? `R${formatTokens(totals.cacheRead)}` : undefined,
          totals.cacheWrite ? `W${formatTokens(totals.cacheWrite)}` : undefined,
          totals.cost ? `$${totals.cost.toFixed(3)}` : undefined,
        ].filter(Boolean);
        const context = current.getContextUsage?.();
        const contextWindow = context?.contextWindow ?? current.model?.contextWindow;
        const contextText = contextWindow
          ? `${context?.percent === null || context?.percent === undefined ? "?" : Math.round(context.percent)}%/${formatTokens(contextWindow)}`
          : undefined;
        const modelText = current.model
          ? `${current.model.id}${current.model.reasoning && state.pi.getThinkingLevel?.() ? ` • ${state.pi.getThinkingLevel?.()}` : ""}`
          : "no model";
        const externalStatuses = Array.from(
          footerData.getExtensionStatuses().entries(),
        )
          .filter(([key]) => key !== EXTENSION_KEY)
          .map(([, text]) => oneLine(stripAnsi(text), 80));
        const rightParts = [
          ...externalStatuses,
          usageParts.length ? usageParts.join(" ") : undefined,
          modelText,
          contextText,
          subagentStatusText(state, theme, true),
        ].filter(Boolean);
        let left = theme.fg("dim", leftParts.join(" │ "));
        let right = rightParts
          .map((part) =>
            String(part).includes("\x1b[")
              ? String(part)
              : theme.fg("dim", String(part)),
          )
          .join(theme.fg("dim", " │ "));
        const minGap = 2;
        const rightWidth = visibleWidth(right);
        const maxLeft = Math.max(0, width - rightWidth - minGap);
        left = truncateToWidth(left, maxLeft, theme.fg("dim", "…"));
        let gap = width - visibleWidth(left) - rightWidth;
        if (gap < minGap) {
          const maxRight = Math.max(0, width - visibleWidth(left) - minGap);
          right = truncateToWidth(right, maxRight, theme.fg("dim", "…"));
          gap = width - visibleWidth(left) - visibleWidth(right);
        }
        return [
          truncateToWidth(
            left + " ".repeat(Math.max(1, gap)) + right,
            width,
            theme.fg("dim", "…"),
            true,
          ),
        ];
      },
    };
  });
}

export function updateStatus(
  state: SubagentRuntimeState,
  ctx = state.latestCtx,
) {
  const records = activeRecords(state);
  const status = globalSubagentsStatus();
  status.running = records.filter(
    (r) =>
      r.status === "running" ||
      r.status === "starting" ||
      r.status === "queued",
  ).length;
  status.total = records.length;
  status.waiting = records.filter((r) => r.status === "waiting_for_answer").length;
  status.nested = records.reduce((sum, r) => sum + (r.nestedActiveCount ?? 0), 0);
  status.idle = records.filter((r) => ["completed", "interrupted", "failed", "aborted"].includes(r.status)).length;
  status.interrupted = records.filter((r) => r.status === "interrupted" || r.status === "aborted").length;
  status.errored = records.filter((r) => r.status === "failed").length;
  status.shutdown = records.filter((r) => r.status === "shutdown").length;
  status.inside = state.insideChildId;
  status.updatedAt = now();
  for (const listener of status.listeners) {
    try {
      listener();
    } catch {
      // UI observers never participate in spawn, routing, or teardown success.
      status.listeners.delete(listener);
    }
  }

  if (!ctx?.hasUI) return;
  ctx.ui.setStatus(EXTENSION_KEY, subagentStatusText(state, ctx.ui.theme));
  ctx.ui.setWidget(EXTENSION_KEY, undefined);
}
