import { DEFAULT_CHILD_TOOLS } from "../constants.ts";
import { unique } from "../utils.ts";
import type { SubagentRuntimeState } from "./state.ts";

export function isSubagentsTool(name: string): boolean {
  return name === "delegate" || name === "ask_parent";
}

export function childToolsForSpawn(state: SubagentRuntimeState): string[] {
  const allSet = new Set(state.pi.getAllTools().map((tool) => tool.name));
  const activeTools = state.pi.getActiveTools();
  const inherited = activeTools.filter((name) => !isSubagentsTool(name));
  const base = activeTools.length ? inherited : DEFAULT_CHILD_TOOLS;
  const extras = ["ask_parent"];
  if (state.currentDepth + 1 < state.settings.maxDepth && state.settings.allowChildSubagents)
    extras.push("delegate");
  return unique([...base, ...extras]).filter(
    (name) => allSet.has(name) || isSubagentsTool(name),
  );
}

export function applyChildActiveTools(state: SubagentRuntimeState) {
  if (!state.isChild) return;
  const inheritedToolsWereProvided = process.env.PI_SUBAGENT_ACTIVE_TOOLS !== undefined;
  const inherited = parseToolListEnv(process.env.PI_SUBAGENT_ACTIVE_TOOLS).filter(
    (name) => !isSubagentsTool(name),
  );
  const allToolNames = new Set(state.pi.getAllTools().map((tool) => tool.name));
  const base = (inheritedToolsWereProvided ? inherited : DEFAULT_CHILD_TOOLS).filter(
    (name) => allToolNames.has(name),
  );
  const extras = ["ask_parent"];
  if (state.currentDepth < state.settings.maxDepth && state.settings.allowChildSubagents)
    extras.push("delegate");
  state.pi.setActiveTools(
    unique([...base, ...extras]).filter((name) => allToolNames.has(name)),
  );
}

function parseToolListEnv(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed))
      return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}
