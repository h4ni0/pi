import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_CHILD_ENV_ALLOWLIST,
  DEFAULT_COMPLETION_BURST_MAX_BYTES,
  DEFAULT_COMPLETION_MESSAGE_MAX_BYTES,
  DEFAULT_COMPLETION_OUTBOX_LIMIT,
  DEFAULT_RETURN_MAX_BYTES,
  DEFAULT_RPC_REQUEST_TIMEOUT_MS,
  HARD_COMPLETION_MESSAGE_MAX_BYTES,
  DEFAULT_RPC_SHUTDOWN_TIMEOUT_MS,
  DEFAULT_RPC_STARTUP_TIMEOUT_MS,
} from "./constants.ts";
import type { SubagentSettings } from "./types.ts";

export const DEFAULT_SETTINGS: SubagentSettings = {
  maxDepth: 2,
  defaultContext: "compact",
  handoffTokenBudget: 8_000,
  handoffKeepRecentTokens: 4_000,
  childTools: "inherit-parent-or-pi-default",
  returnMaxBytes: DEFAULT_RETURN_MAX_BYTES,
  completionMessageMaxBytes: DEFAULT_COMPLETION_MESSAGE_MAX_BYTES,
  completionBurstMaxBytes: DEFAULT_COMPLETION_BURST_MAX_BYTES,
  completionOutboxLimit: DEFAULT_COMPLETION_OUTBOX_LIMIT,
  statusHistoryLimit: 100,
  shortcut: "alt+s",
  persistSessions: true,
  sessionDir: "~/.pi/agent/sessions/subagents",
  showInNormalResume: false,
  killChildrenOnParentExit: true,
  allowChildSubagents: true,
  maxConcurrentAgents: 16,
  maxPersistentAgents: 16,
  rpcStartupTimeoutMs: DEFAULT_RPC_STARTUP_TIMEOUT_MS,
  rpcRequestTimeoutMs: DEFAULT_RPC_REQUEST_TIMEOUT_MS,
  rpcShutdownTimeoutMs: DEFAULT_RPC_SHUTDOWN_TIMEOUT_MS,
  childEnvAllowlist: [...DEFAULT_CHILD_ENV_ALLOWLIST],
  askParentConfidential: false,
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

export function loadSettings(
  cwd: string,
  projectTrusted = true,
): SubagentSettings {
  const globalSettings = readJsonFile(
    path.join(os.homedir(), ".pi", "agent", "settings.json"),
  );
  const projectSettings = projectTrusted
    ? readJsonFile(path.join(cwd, ".pi", "settings.json"))
    : undefined;
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
  const completionMessageMaxBytes = clampNumber(
    merged.completionMessageMaxBytes,
    DEFAULT_SETTINGS.completionMessageMaxBytes,
    1_000,
    HARD_COMPLETION_MESSAGE_MAX_BYTES,
  );
  const completionBurstMaxBytes = Math.max(
    completionMessageMaxBytes,
    clampNumber(
      merged.completionBurstMaxBytes,
      DEFAULT_SETTINGS.completionBurstMaxBytes,
      1_000,
      256 * 1024,
    ),
  );
  const maxPersistentAgents = clampNumber(
    merged.maxPersistentAgents,
    DEFAULT_SETTINGS.maxPersistentAgents,
    1,
    128,
  );
  const maxConcurrentAgents = Math.min(
    maxPersistentAgents,
    clampNumber(
      merged.maxConcurrentAgents,
      DEFAULT_SETTINGS.maxConcurrentAgents,
      1,
      128,
    ),
  );
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
    completionMessageMaxBytes,
    completionBurstMaxBytes,
    completionOutboxLimit: clampNumber(
      merged.completionOutboxLimit,
      DEFAULT_SETTINGS.completionOutboxLimit,
      1,
      256,
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
    maxConcurrentAgents,
    maxPersistentAgents,
    rpcStartupTimeoutMs: clampNumber(
      merged.rpcStartupTimeoutMs,
      DEFAULT_SETTINGS.rpcStartupTimeoutMs,
      1_000,
      120_000,
    ),
    rpcRequestTimeoutMs: clampNumber(
      merged.rpcRequestTimeoutMs,
      DEFAULT_SETTINGS.rpcRequestTimeoutMs,
      1_000,
      300_000,
    ),
    rpcShutdownTimeoutMs: clampNumber(
      merged.rpcShutdownTimeoutMs,
      DEFAULT_SETTINGS.rpcShutdownTimeoutMs,
      250,
      30_000,
    ),
    childEnvAllowlist: Array.isArray(merged.childEnvAllowlist)
      ? merged.childEnvAllowlist
          .filter((item: unknown): item is string =>
            typeof item === "string" && /^[A-Z_][A-Z0-9_]*$/.test(item),
          )
          .slice(0, 128)
      : [...DEFAULT_SETTINGS.childEnvAllowlist],
    askParentConfidential: merged.askParentConfidential === true,
  };
}
