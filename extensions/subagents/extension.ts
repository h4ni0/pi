import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSubagentMessageRenderers } from "./message-renderers.ts";
import { buildSubagentSystemPrompt } from "./prompts.ts";
import { loadSettings } from "./settings.ts";
import type { SubagentRuntimeState } from "./runtime/state.ts";
import { abortChild } from "./runtime/records.ts";
import { updateStatus } from "./runtime/status-ui.ts";
import { applyChildActiveTools } from "./runtime/tool-list.ts";
import { openAgentsModal, enterChildMode } from "./ui/agents-panel.ts";
import { registerSubagentTools } from "./tools/register-tools.ts";
import { parseDepthEnv } from "./utils.ts";

const EXTENSION_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "index.ts",
);

export default function (pi: ExtensionAPI) {
  let settings = loadSettings(process.cwd());
  const currentDepth = parseDepthEnv("PI_SUBAGENT_DEPTH", 0);
  const envMaxDepth = parseDepthEnv("PI_SUBAGENT_MAX_DEPTH", settings.maxDepth);
  if (process.env.PI_SUBAGENT_MAX_DEPTH)
    settings = { ...settings, maxDepth: envMaxDepth };

  const state: SubagentRuntimeState = {
    pi,
    active: new Map(),
    settings,
    parentAnswerQueue: Promise.resolve(),
    currentDepth,
    envMaxDepth,
    isChild: currentDepth > 0,
    extensionPath: EXTENSION_PATH,
  };

  pi.on("session_start", (_event, ctx) => {
    state.latestCtx = ctx;
    state.settings = loadSettings(ctx.cwd);
    if (process.env.PI_SUBAGENT_MAX_DEPTH)
      state.settings.maxDepth = state.envMaxDepth;
    applyChildActiveTools(state);

    if (
      !state.isChild &&
      (!state.settings.allowChildSubagents || state.settings.maxDepth === 0)
    ) {
      pi.setActiveTools(pi.getActiveTools().filter((tool) => tool !== "delegate"));
    }

    updateStatus(state, ctx);
  });

  pi.on("before_agent_start", (event) => {
    if (!state.isChild) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${buildSubagentSystemPrompt(
        state.currentDepth,
        state.settings.maxDepth,
      )}`,
    };
  });

  pi.on("agent_start", (_event, ctx) => {
    state.latestCtx = ctx;
    updateStatus(state, ctx);
  });

  pi.on("agent_end", (_event, ctx) => {
    state.latestCtx = ctx;
    updateStatus(state, ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    state.latestCtx = ctx;
    updateStatus(state, ctx);
  });

  pi.on("thinking_level_select", (_event, ctx) => {
    state.latestCtx = ctx;
    updateStatus(state, ctx);
  });

  pi.on("session_shutdown", async () => {
    if (!state.settings.killChildrenOnParentExit) return;
    await Promise.allSettled(
      Array.from(state.active.values()).map((record) =>
        abortChild(state, record),
      ),
    );
  });

  if (state.settings.shortcut) {
    pi.registerShortcut(state.settings.shortcut, {
      description: "Open sub-agents panel",
      handler: async (ctx) => {
        state.latestCtx = ctx;
        await openAgentsModal(state, ctx);
      },
    });
  }

  pi.registerCommand("agents", {
    description: "Open active sub-agents panel",
    handler: async (_args, ctx) => {
      state.latestCtx = ctx;
      await openAgentsModal(state, ctx);
    },
  });

  pi.registerCommand("subagent-enter", {
    description: "Enter a running direct child sub-agent by id",
    handler: async (args, ctx) => {
      state.latestCtx = ctx;
      const id = args.trim();
      if (!id) {
        ctx.ui.notify("Usage: /subagent-enter <id>", "warning");
        return;
      }
      await enterChildMode(state, ctx, id);
    },
  });

  registerSubagentMessageRenderers(pi);
  registerSubagentTools(state);
}
