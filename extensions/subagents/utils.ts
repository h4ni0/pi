import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Deferred, RootTreeIdentity } from "./types.ts";
import {
  agentPathDepth,
  parseAgentPath,
  validateSafeBasename,
} from "./runtime/agent-path.ts";

export function now() {
  return Date.now();
}

export function abortError(message = "aborted"): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    let settled = false;
    const cleanup = () => {
      if (signal) signal.removeEventListener("abort", onAbort);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function parseDepthEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function makeId(): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `sa_${Date.now().toString(36)}_${random}`;
}

export function currentProcessAgentId(ctx?: ExtensionContext): string {
  return validateSafeBasename(
    process.env.PI_SUBAGENT_ID || ctx?.sessionManager.getSessionId() || "root",
    "agent id",
  );
}

export function currentRootId(ctx?: ExtensionContext): string {
  return validateSafeBasename(
    process.env.PI_SUBAGENT_ROOT_ID ||
      ctx?.sessionManager.getSessionId() ||
      currentProcessAgentId(ctx),
    "root session id",
  );
}

export function currentAgentPath(): string {
  const value = process.env.PI_SUBAGENT_PATH;
  return value === undefined ? "/root" : parseAgentPath(value);
}

export function createDeferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const deferred: Deferred<T> = {
    promise: new Promise<T>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    }),
    resolve(value: T) {
      if (deferred.settled) return;
      deferred.settled = true;
      resolvePromise(value);
    },
    reject(error: Error) {
      if (deferred.settled) return;
      deferred.settled = true;
      rejectPromise(error);
    },
    settled: false,
  };
  return deferred;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Validate semantic non-emptiness without normalizing the caller's bytes. */
export function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${field} must be a non-empty string`);
  return value;
}

export function truncateUtf8(text: string, maxBytes: number): string {
  if (bytes(text) <= maxBytes) return text;
  const suffix = "\n[truncated]";
  const budget = Math.max(0, maxBytes - bytes(suffix));
  const buffer = Buffer.from(text, "utf8");
  let end = Math.min(buffer.length, budget);
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8") + suffix;
}

export function generatedLabel(task: string): string {
  const words = task
    .replace(/[`*_#>\[\](){}]/g, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean)
    .slice(0, 7)
    .join(" ");
  return words.length > 48
    ? `${words.slice(0, 45)}...`
    : words || "delegated task";
}

export function oneLine(text: string, limit = 160): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > limit
    ? `${normalized.slice(0, Math.max(0, limit - 1))}…`
    : normalized;
}

export function argsSummary(args: unknown): string {
  try {
    return oneLine(JSON.stringify(args), 180);
  } catch {
    return "(unserializable args)";
  }
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  if (hours === 0) return `${minutes}m ${seconds}s`;
  return `${hours}h ${remMinutes}m`;
}

export function formatTokens(count: number | null | undefined): string {
  if (count === null || count === undefined || !Number.isFinite(count))
    return "?";
  if (count < 1_000) return `${count}`;
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

export function unique(items: string[]): string[] {
  return Array.from(new Set(items.filter(Boolean)));
}

export function ensureDir(dir: string) {
  const resolved = path.resolve(dir);
  const missing: string[] = [];
  let cursor = resolved;
  while (true) {
    try {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink())
        throw new Error(`Refusing symlinked directory: ${cursor}`);
      if (!stat.isDirectory()) throw new Error(`Not a directory: ${cursor}`);
      break;
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      missing.push(cursor);
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      cursor = parent;
    }
  }
  for (const item of missing.reverse()) fs.mkdirSync(item, { mode: 0o700 });
  assertNoSymlinkParents(resolved);
}

export function assertNoSymlinkParents(target: string): void {
  let cursor = path.resolve(target);
  while (true) {
    try {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink())
        throw new Error(`Refusing symlinked path component: ${cursor}`);
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

export function resolveContained(root: string, ...segments: string[]): string {
  const base = path.resolve(root);
  const candidate = path.resolve(base, ...segments);
  if (candidate !== base && !candidate.startsWith(`${base}${path.sep}`))
    throw new Error(`Resolved path escapes configured root: ${candidate}`);
  return candidate;
}

export function safeWriteJson(filePath: string, value: unknown) {
  safeWriteText(filePath, `${JSON.stringify(value)}\n`);
}

export function safeWriteText(filePath: string, value: string) {
  const parent = path.dirname(filePath);
  ensureDir(parent);
  assertNoSymlinkParents(parent);
  try {
    const existing = fs.lstatSync(filePath);
    if (existing.isSymbolicLink() || !existing.isFile())
      throw new Error(`Refusing non-regular output path: ${filePath}`);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, value, { encoding: "utf8" });
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}

export function safeReadJson<T>(filePath: string, maxBytes = 64 * 1024): T | undefined {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) return undefined;
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export function removeFileQuietly(filePath: string) {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}

export interface ChildBrokerBootstrap {
  identity: RootTreeIdentity & { connectionGeneration: number };
  socketPath: string;
  capability: string;
  rootId: string;
  maxResidentAgents: number;
  maxActiveAgents: number;
}

export const CHILD_BROKER_ENV = Object.freeze({
  socketPath: "PI_SUBAGENT_BROKER_SOCKET",
  capability: "PI_SUBAGENT_BROKER_CAPABILITY",
  generation: "PI_SUBAGENT_BROKER_GENERATION",
  id: "PI_SUBAGENT_ID",
  path: "PI_SUBAGENT_PATH",
  parentId: "PI_SUBAGENT_PARENT_ID",
  parentPath: "PI_SUBAGENT_PARENT_PATH",
  rootId: "PI_SUBAGENT_ROOT_ID",
  depth: "PI_SUBAGENT_DEPTH",
  maxDepth: "PI_SUBAGENT_MAX_DEPTH",
  maxResidentAgents: "PI_SUBAGENT_MAX_RESIDENT_AGENTS",
  maxActiveAgents: "PI_SUBAGENT_MAX_ACTIVE_AGENTS",
} as const);

/** Parse the complete authenticated child bootstrap envelope; partial input fails closed. */
export function readChildBrokerBootstrapEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): ChildBrokerBootstrap {
  const required = (name: string): string => {
    const value = env[name];
    if (typeof value !== "string" || value.length === 0)
      throw new Error(`Missing required child broker environment '${name}'`);
    return value;
  };
  const integer = (name: string, min: number, max: number): number => {
    const raw = required(name);
    if (!/^(0|[1-9][0-9]*)$/.test(raw))
      throw new Error(`Invalid integer child broker environment '${name}'`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw new Error(`Child broker environment '${name}' is out of range`);
    return value;
  };

  const childPath = parseAgentPath(required(CHILD_BROKER_ENV.path));
  const parentPath = parseAgentPath(required(CHILD_BROKER_ENV.parentPath));
  const depth = integer(CHILD_BROKER_ENV.depth, 1, 20);
  const maxDepth = integer(CHILD_BROKER_ENV.maxDepth, depth, 20);
  if (depth !== agentPathDepth(childPath))
    throw new Error("Child broker path/depth metadata mismatch");
  if (childPath.split("/").slice(0, -1).join("/") !== parentPath)
    throw new Error("Child broker parent path does not own child path");
  const socketPath = required(CHILD_BROKER_ENV.socketPath);
  if (!path.isAbsolute(socketPath) || socketPath.includes("\0"))
    throw new Error("Child broker socket path must be an absolute safe path");
  const capability = required(CHILD_BROKER_ENV.capability);
  if (!/^[a-f0-9]{64}$/.test(capability))
    throw new Error("Child broker capability is invalid");

  return {
    identity: {
      id: validateSafeBasename(required(CHILD_BROKER_ENV.id), "agent id"),
      path: childPath,
      parentId: validateSafeBasename(
        required(CHILD_BROKER_ENV.parentId),
        "parent agent id",
      ),
      parentPath,
      depth,
      maxDepth,
      connectionGeneration: integer(CHILD_BROKER_ENV.generation, 1, 1_000_000_000),
    },
    socketPath,
    capability,
    rootId: validateSafeBasename(
      required(CHILD_BROKER_ENV.rootId),
      "root session id",
    ),
    maxResidentAgents: integer(
      CHILD_BROKER_ENV.maxResidentAgents,
      1,
      256,
    ),
    maxActiveAgents: integer(CHILD_BROKER_ENV.maxActiveAgents, 1, 256),
  };
}

/** Build only the per-child broker values; callers add non-identity child metadata. */
export function buildChildBrokerEnvironment(
  input: ChildBrokerBootstrap,
): Record<string, string> {
  const validated = readChildBrokerBootstrapEnvironment({
    [CHILD_BROKER_ENV.socketPath]: input.socketPath,
    [CHILD_BROKER_ENV.capability]: input.capability,
    [CHILD_BROKER_ENV.generation]: String(input.identity.connectionGeneration),
    [CHILD_BROKER_ENV.id]: input.identity.id,
    [CHILD_BROKER_ENV.path]: input.identity.path,
    [CHILD_BROKER_ENV.parentId]: input.identity.parentId,
    [CHILD_BROKER_ENV.parentPath]: input.identity.parentPath,
    [CHILD_BROKER_ENV.rootId]: input.rootId,
    [CHILD_BROKER_ENV.depth]: String(input.identity.depth),
    [CHILD_BROKER_ENV.maxDepth]: String(input.identity.maxDepth),
    [CHILD_BROKER_ENV.maxResidentAgents]: String(input.maxResidentAgents),
    [CHILD_BROKER_ENV.maxActiveAgents]: String(input.maxActiveAgents),
  });
  return {
    [CHILD_BROKER_ENV.socketPath]: validated.socketPath,
    [CHILD_BROKER_ENV.capability]: validated.capability,
    [CHILD_BROKER_ENV.generation]: String(validated.identity.connectionGeneration),
    [CHILD_BROKER_ENV.id]: validated.identity.id,
    [CHILD_BROKER_ENV.path]: validated.identity.path,
    [CHILD_BROKER_ENV.parentId]: validated.identity.parentId!,
    [CHILD_BROKER_ENV.parentPath]: validated.identity.parentPath!,
    [CHILD_BROKER_ENV.rootId]: validated.rootId,
    [CHILD_BROKER_ENV.depth]: String(validated.identity.depth),
    [CHILD_BROKER_ENV.maxDepth]: String(validated.identity.maxDepth),
    [CHILD_BROKER_ENV.maxResidentAgents]: String(validated.maxResidentAgents),
    [CHILD_BROKER_ENV.maxActiveAgents]: String(validated.maxActiveAgents),
  };
}

export interface PiInvocationBase {
  command: string;
  prefixArgs: string[];
}

/** Resolve and pin the launcher without consulting a child-controlled PATH. */
export function resolvePiInvocationBase(): PiInvocationBase {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && path.isAbsolute(currentScript)) {
    try {
      const script = fs.realpathSync(currentScript);
      return { command: fs.realpathSync(process.execPath), prefixArgs: [script] };
    } catch {
      // Fall through to known installation paths.
    }
  }
  const execName = path.basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(execName))
    return { command: fs.realpathSync(process.execPath), prefixArgs: [] };

  for (const candidate of [
    path.join(os.homedir(), ".local", "bin", "pi"),
    "/usr/local/bin/pi",
    "/usr/bin/pi",
  ]) {
    try {
      return { command: fs.realpathSync(candidate), prefixArgs: [] };
    } catch {
      // Try the next fixed location; never search PATH.
    }
  }
  throw new Error("Unable to resolve a trusted absolute Pi executable");
}

export function getPiInvocation(
  args: string[],
  base = resolvePiInvocationBase(),
): { command: string; args: string[] } {
  return { command: base.command, args: [...base.prefixArgs, ...args] };
}

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

export function extractMessageText(message: any): string {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part: any) => (part?.type === "text" ? part.text ?? "" : ""))
    .filter(Boolean)
    .join("\n");
}
