import * as fs from "node:fs";
import * as path from "node:path";
import {
  COLLABORATION_TOOL_NAMES,
  DEFAULT_CHILD_TOOLS,
} from "../constants.ts";
import { unique } from "../utils.ts";
import type { SubagentRuntimeState } from "./state.ts";

const MANAGEMENT_TOOLS = [
  "send_message",
  "followup_task",
  "wait_agent",
  "interrupt_agent",
  "list_agents",
];

export function isSubagentsTool(name: string): boolean {
  return (COLLABORATION_TOOL_NAMES as readonly string[]).includes(name);
}

export function collaborationToolsForRole(
  state: SubagentRuntimeState,
  depth = state.currentDepth,
): string[] {
  const tools = [...MANAGEMENT_TOOLS];
  if (depth > 0) tools.push("ask_parent");
  if (state.settings.allowChildSubagents && depth < state.settings.maxDepth)
    tools.push("spawn_agent", "delegate");
  return tools;
}

export function childToolsForSpawn(state: SubagentRuntimeState): string[] {
  const activeTools = state.pi.getActiveTools();
  // getActiveTools() is authoritative, including an explicitly empty list.
  const inherited = activeTools.filter((name) => !isSubagentsTool(name));
  const controls = collaborationToolsForRole(state, state.currentDepth + 1);
  return unique([...inherited, ...controls]);
}

export function applyRoleActiveTools(state: SubagentRuntimeState): void {
  const allToolNames = new Set(state.pi.getAllTools().map((tool) => tool.name));
  let base: string[];
  if (state.isChild) {
    const provided = process.env.PI_SUBAGENT_ACTIVE_TOOLS !== undefined;
    const inherited = parseToolListEnv(process.env.PI_SUBAGENT_ACTIVE_TOOLS).filter(
      (name) => !isSubagentsTool(name),
    );
    const requested = provided ? inherited : DEFAULT_CHILD_TOOLS;
    if (provided) {
      const unavailable = unique(requested).filter(
        (name) => !allToolNames.has(name),
      );
      if (unavailable.length) {
        throw new Error(
          `Cannot reconstruct inherited active tools in child: ${unavailable.join(", ")}`,
        );
      }
    }
    base = requested.filter((name) => allToolNames.has(name));
  } else {
    base = state.pi.getActiveTools().filter((name) => !isSubagentsTool(name));
  }
  const controls = collaborationToolsForRole(state).filter((name) =>
    allToolNames.has(name),
  );
  state.pi.setActiveTools(unique([...base, ...controls]));
}

/** Backward-compatible export. */
export const applyChildActiveTools = applyRoleActiveTools;

export interface SpawnToolSources {
  paths: string[];
  omittedTools: string[];
  fatalOmittedTools: string[];
  /** Exact active child tool snapshot captured during preflight. */
  childTools: string[];
}

/**
 * Resolve every active non-collaboration tool before reserving a child. Builtins
 * are present in RPC mode; extension tools must have a loadable provider path;
 * SDK-only tools cannot be reconstructed and therefore fail closed.
 */
export function extensionSourcesForSpawn(
  state: SubagentRuntimeState,
): SpawnToolSources {
  const active = new Set(
    state.pi.getActiveTools().filter((name) => !isSubagentsTool(name)),
  );
  const seen = new Set<string>();
  const paths: string[] = [];
  const omittedTools: string[] = [];
  const fatalOmittedTools: string[] = [];
  const extensionResolved = path.resolve(state.extensionPath);
  const extensionReal = fs.existsSync(extensionResolved)
    ? fs.realpathSync(extensionResolved)
    : extensionResolved;
  for (const tool of state.pi.getAllTools() as any[]) {
    if (!active.has(tool.name)) continue;
    seen.add(tool.name);
    const source = tool.sourceInfo?.source;
    const sourcePath = tool.sourceInfo?.path;
    if (source === "builtin") continue;
    if (source === "sdk") {
      fatalOmittedTools.push(tool.name);
      continue;
    }
    if (typeof sourcePath !== "string" || sourcePath.startsWith("<")) {
      fatalOmittedTools.push(tool.name);
      continue;
    }
    const resolved = path.resolve(sourcePath);
    if (!fs.existsSync(resolved)) {
      fatalOmittedTools.push(tool.name);
      continue;
    }
    const real = fs.realpathSync(resolved);
    if (real === extensionReal) continue;
    paths.push(real);
  }
  for (const name of active) {
    if (!seen.has(name)) fatalOmittedTools.push(name);
  }
  return {
    paths: unique(paths),
    omittedTools: unique(omittedTools),
    fatalOmittedTools: unique(fatalOmittedTools),
    childTools: unique([
      ...active,
      ...collaborationToolsForRole(state, state.currentDepth + 1),
    ]),
  };
}

export function parseToolListEnv(value: string | undefined): string[] {
  if (value === undefined) return [];
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
