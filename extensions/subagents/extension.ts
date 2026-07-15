import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  COLLABORATION_GUARD,
} from "./constants.ts";
import { registerSubagentMessageRenderers } from "./message-renderers.ts";
import { buildSubagentSystemPrompt } from "./prompts.ts";
import { loadSettings } from "./settings.ts";
import { CollaborationManager } from "./runtime/collaboration-manager.ts";
import {
  createSubagentRuntimeState,
  type SubagentRuntimeState,
} from "./runtime/state.ts";
import { updateStatus } from "./runtime/status-ui.ts";
import { applyRoleActiveTools } from "./runtime/tool-list.ts";
import { PiMailbox } from "./runtime/pi-mailbox.ts";
import { SelfTurnReporter } from "./runtime/self-turn-reporter.ts";
import { enterChildMode, openAgentsModal } from "./ui/agents-panel.ts";
import { registerSubagentTools } from "./tools/register-tools.ts";
import { currentAgentPath, parseDepthEnv } from "./utils.ts";
import {
  ChildLifecycleTokenController,
  encodeLifecycleMarker,
  LIFECYCLE_STATUS_KEY,
  removeLifecycleToken,
} from "./runtime/lifecycle-protocol.ts";

const EXTENSION_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "index.ts",
);

const RUNTIME_EVENT_NAMES = [
  "agent_start",
  "message_end",
  "turn_end",
  "agent_end",
  "agent_settled",
  "extension_error",
  "model_select",
  "thinking_level_select",
] as const;

/**
 * Register only synchronous lifecycle hooks. Pi serializes a raw lifecycle
 * event after these hooks return, so no completion delivery may be awaited (or
 * even started) while its correlation marker is open.
 */
export function registerRuntimeEventHandlers(
  pi: ExtensionAPI,
  state: SubagentRuntimeState,
  childLifecycle?: ChildLifecycleTokenController,
): void {
  for (const eventName of RUNTIME_EVENT_NAMES) {
    pi.on(eventName as any, ((_event: any, ctx: ExtensionContext) => {
      state.latestCtx = ctx;
      const isLifecycleEvent = eventName === "agent_start" ||
        ((eventName === "message_end" || eventName === "turn_end") &&
          _event.message?.role === "assistant") ||
        eventName === "agent_end" ||
        eventName === "agent_settled" ||
        eventName === "extension_error";
      if (!state.isChild || !isLifecycleEvent) {
        updateStatus(state, ctx);
        return;
      }

      const lifecycleToken = childLifecycle!.activeToken;
      let completionEventId: string | undefined;
      let delivery: (() => Promise<void>) | undefined;
      if (
        lifecycleToken &&
        (eventName === "message_end" || eventName === "turn_end")
      ) state.selfTurnReporter?.captureMessage(lifecycleToken, _event.message);
      if (lifecycleToken && eventName === "extension_error")
        state.selfTurnReporter?.captureExtensionError(lifecycleToken, _event);
      if (lifecycleToken && eventName === "agent_end")
        state.selfTurnReporter?.captureAgentEnd(lifecycleToken, _event);
      if (eventName === "agent_settled") {
        try {
          const prepared = lifecycleToken
            ? state.selfTurnReporter?.captureSettled(lifecycleToken, ctx)
            : undefined;
          completionEventId = prepared?.eventId;
          if (prepared)
            delivery = () => state.selfTurnReporter!.deliverPrepared(prepared.eventId, ctx);
        } catch {
          // install() updates the in-memory outbox before persisting. Preserve
          // its stable identity in the authoritative lifecycle marker.
          completionEventId = lifecycleToken
            ? state.selfTurnReporter?.eventIdForToken(lifecycleToken)
            : undefined;
          if (state.selfTurnReporter)
            delivery = () => state.selfTurnReporter!.retryPending(ctx);
        }
      }
      const marker = childLifecycle!.marker(
        _event,
        eventName,
        completionEventId,
      );
      if (eventName === "agent_settled") childLifecycle!.closeActive();

      // Ordinary status and detached scheduling must precede the marker. The
      // marker is the final synchronous action before Pi writes the raw event.
      try {
        updateStatus(state, ctx);
      } catch {
        // Lifecycle correlation is authoritative; UI/status observers are not.
      }
      if (delivery) scheduleReporterDelivery(delivery);
      ctx.ui.setStatus(LIFECYCLE_STATUS_KEY, encodeLifecycleMarker(marker));
    }) as any);
  }
}

function scheduleReporterDelivery(delivery: () => Promise<void>): void {
  setImmediate(() => {
    try {
      void delivery().catch(() => undefined);
    } catch {
      // Detached completion delivery must never surface as extension_error.
    }
  });
}

function scheduleReporterRetry(
  reporter: SelfTurnReporter,
  ctx: ExtensionContext,
): void {
  scheduleReporterDelivery(() => reporter.retryPending(ctx));
}

export default function (pi: ExtensionAPI) {
  const root = globalThis as Record<PropertyKey, any>;
  if (root[COLLABORATION_GUARD]) {
    throw new Error(
      "Duplicate subagents collaboration manager initialization detected. Load extensions/subagents/index.ts exactly once.",
    );
  }
  const guardToken = {};
  root[COLLABORATION_GUARD] = guardToken;

  // Factory-time configuration is global only. Project settings are read only
  // after session_start confirms trust.
  let settings = loadSettings(process.cwd(), false);
  const currentDepth = parseDepthEnv("PI_SUBAGENT_DEPTH", 0);
  const envMaxDepthExplicit = process.env.PI_SUBAGENT_MAX_DEPTH !== undefined;
  const envMaxDepth = parseDepthEnv("PI_SUBAGENT_MAX_DEPTH", settings.maxDepth);
  if (envMaxDepthExplicit) settings = { ...settings, maxDepth: envMaxDepth };

  const state = createSubagentRuntimeState({
    pi,
    settings,
    currentDepth,
    envMaxDepth,
    envMaxDepthExplicit,
    extensionPath: EXTENSION_PATH,
    currentPath: currentAgentPath(),
    guardToken,
  });
  state.piMailbox = new PiMailbox(pi);
  if (state.isChild) state.selfTurnReporter = new SelfTurnReporter(state);
  const manager = new CollaborationManager(state);
  state.manager = manager;
  let shortcutRegistered = false;

  pi.on("session_start", async (_event, ctx) => {
    state.latestCtx = ctx;
    manager.refreshSettings(ctx);
    await manager.initializeBroker(ctx);
    manager.restoreHistorical(ctx);
    if (state.selfTurnReporter?.restorePending(ctx)) {
      await state.broker?.restoreCompletionOutbox(
        state.selfTurnReporter.pendingEventIds(),
      );
      scheduleReporterRetry(state.selfTurnReporter, ctx);
    }
    applyRoleActiveTools(state);
    if (!shortcutRegistered && state.settings.shortcut) {
      shortcutRegistered = true;
      pi.registerShortcut(state.settings.shortcut as any, {
        description: "Open collaboration agents panel",
        handler: async (shortcutCtx) => {
          state.latestCtx = shortcutCtx;
          await openAgentsModal(state, shortcutCtx);
        },
      });
    }
    if (!state.settings.killChildrenOnParentExit && ctx.hasUI) {
      ctx.ui.notify(
        "Persistent collaboration agents always close on session shutdown because RPC pipes cannot be reattached. killChildrenOnParentExit=false applies only to legacy compatibility.",
        "warning",
      );
    }
    updateStatus(state, ctx);
  });

  const childLifecycle = state.isChild
    ? new ChildLifecycleTokenController()
    : undefined;
  pi.on("input", (event) => {
    // New user/RPC input cancels a pending lifecycle wait; it is never modeled
    // as an agent completion.
    manager.cancelPendingWait();
    if (!childLifecycle || event.source !== "rpc") return;
    const parsed = removeLifecycleToken(event.text);
    if (!parsed.token) return;
    childLifecycle.queuePrompt(parsed.token);
    return { action: "transform" as const, text: parsed.message, images: event.images };
  });

  pi.on("before_agent_start", (event) => {
    if (!state.isChild) return;
    childLifecycle!.promotePending();
    return {
      systemPrompt: `${event.systemPrompt}\n\n${buildSubagentSystemPrompt(
        state.currentDepth,
        state.settings.maxDepth,
        state.currentPath,
      )}`,
    };
  });

  registerRuntimeEventHandlers(pi, state, childLifecycle);

  pi.on("session_shutdown", async () => {
    await state.selfTurnReporter?.stop();
    let shutdownComplete = false;
    try {
      await manager.shutdown();
      shutdownComplete = true;
    } catch {
      // shutdown() resets its cached rejection; one immediate idempotent retry
      // handles transient broker/drain teardown failures during /reload.
      await manager.shutdown();
      shutdownComplete = true;
    } finally {
      const fullyClosed = shutdownComplete && state.broker === undefined &&
        [...state.active.values()].every((record) => !record.client || record.client.exited);
      if (fullyClosed && root[COLLABORATION_GUARD] === guardToken)
        delete root[COLLABORATION_GUARD];
    }
  });

  pi.registerCommand("agents", {
    description: "Open locally owned collaboration agents and bounded UI history",
    handler: async (_args, ctx) => {
      state.latestCtx = ctx;
      await openAgentsModal(state, ctx);
    },
  });

  pi.registerCommand("subagent-enter", {
    description: "Enter a locally owned child agent by id/path",
    handler: async (args, ctx) => {
      state.latestCtx = ctx;
      const id = args;
      if (!id.trim()) {
        ctx.ui.notify("Usage: /subagent-enter <id-or-path>", "warning");
        return;
      }
      await enterChildMode(state, ctx, id);
    },
  });

  registerSubagentMessageRenderers(pi);
  registerSubagentTools(state);
}
