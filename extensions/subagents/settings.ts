import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_RETURN_MAX_BYTES } from "./constants.ts";
import type { SubagentSettings } from "./types.ts";

export const DEFAULT_SETTINGS: SubagentSettings = {
  maxDepth: 2,
  defaultContext: "compact",
  handoffTokenBudget: 8_000,
  handoffKeepRecentTokens: 4_000,
  childTools: "inherit-parent-or-pi-default",
  returnMaxBytes: DEFAULT_RETURN_MAX_BYTES,
  statusHistoryLimit: 0,
  shortcut: "alt+s",
  persistSessions: true,
  sessionDir: "~/.pi/agent/sessions/subagents",
  showInNormalResume: false,
  killChildrenOnParentExit: true,
  allowChildSubagents: true,
};

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function clampNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function readJsonFile(filePath: string): any | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

export function loadSettings(cwd: string): SubagentSettings {
  const globalSettings = readJsonFile(
    path.join(os.homedir(), ".pi", "agent", "settings.json"),
  );
  const projectSettings = readJsonFile(path.join(cwd, ".pi", "settings.json"));
  const merged = {
    ...(globalSettings?.subagents ?? {}),
    ...(projectSettings?.subagents ?? {}),
  };
  const defaultContext =
    merged.defaultContext === "fresh" ? "fresh" : "compact";
  const sessionDir =
    typeof merged.sessionDir === "string" && merged.sessionDir.trim()
      ? merged.sessionDir
      : DEFAULT_SETTINGS.sessionDir;
  const shortcut =
    typeof merged.shortcut === "string" && merged.shortcut.trim()
      ? merged.shortcut
      : DEFAULT_SETTINGS.shortcut;
  return {
    maxDepth: clampNumber(merged.maxDepth, DEFAULT_SETTINGS.maxDepth, 0, 20),
    defaultContext,
    handoffTokenBudget: clampNumber(
      merged.handoffTokenBudget,
      DEFAULT_SETTINGS.handoffTokenBudget,
      1_000,
      200_000,
    ),
    handoffKeepRecentTokens: clampNumber(
      merged.handoffKeepRecentTokens,
      DEFAULT_SETTINGS.handoffKeepRecentTokens,
      500,
      100_000,
    ),
    childTools: "inherit-parent-or-pi-default",
    returnMaxBytes: clampNumber(
      merged.returnMaxBytes,
      DEFAULT_SETTINGS.returnMaxBytes,
      1_000,
      1_000_000,
    ),
    statusHistoryLimit: clampNumber(
      merged.statusHistoryLimit,
      DEFAULT_SETTINGS.statusHistoryLimit,
      0,
      10_000,
    ),
    shortcut,
    persistSessions: merged.persistSessions !== false,
    sessionDir: path.resolve(expandHome(sessionDir)),
    showInNormalResume: merged.showInNormalResume === true,
    killChildrenOnParentExit: merged.killChildrenOnParentExit !== false,
    allowChildSubagents: merged.allowChildSubagents !== false,
  };
}
