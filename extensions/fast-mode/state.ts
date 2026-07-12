import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FAST_SERVICE_TIER = "priority";
const SUPPORTED_PROVIDERS = new Set(["openai", "openai-codex"]);
const SUPPORTED_APIS = new Set(["openai-responses", "openai-codex-responses"]);
const SUPPORTED_MODEL_IDS = new Set([
  "gpt-5.4",
  "gpt-5.5",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
]);

const STORE_PATH = path.join(os.homedir(), ".pi", "fast-mode.json");

type Store = {
  enabledBySession: Map<string, boolean>;
  revision: number;
};

type FastModeJson = {
  version: 1;
  sessions: Record<string, boolean>;
};

const STORE_KEY = Symbol.for("pi.fastMode.store");

function readStoreFile(): Map<string, boolean> {
  try {
    if (!fs.existsSync(STORE_PATH)) return new Map();
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, "utf8")) as Partial<FastModeJson>;
    const sessions = parsed.sessions;
    if (!sessions || typeof sessions !== "object") return new Map();

    const entries = Object.entries(sessions)
      .filter(([sessionId, enabled]) => sessionId && typeof enabled === "boolean")
      .map(([sessionId, enabled]) => [sessionId, enabled] as const);
    return new Map(entries);
  } catch {
    return new Map();
  }
}

function writeStoreFile(enabledBySession: Map<string, boolean>): void {
  const dir = path.dirname(STORE_PATH);
  fs.mkdirSync(dir, { recursive: true });

  const sessions = Object.fromEntries(
    Array.from(enabledBySession.entries()).sort(([a], [b]) => a.localeCompare(b)),
  );
  const data: FastModeJson = { version: 1, sessions };
  const tmp = `${STORE_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, STORE_PATH);
}

function store(): Store {
  const g = globalThis as typeof globalThis & { [STORE_KEY]?: Store };
  g[STORE_KEY] ??= { enabledBySession: readStoreFile(), revision: 0 };
  return g[STORE_KEY];
}

export function fastModeSessionKey(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionId();
}

export function supportsFastMode(ctx: ExtensionContext): boolean {
  const model = ctx.model as any;
  return (
    !!model &&
    SUPPORTED_PROVIDERS.has(model.provider) &&
    SUPPORTED_APIS.has(model.api) &&
    SUPPORTED_MODEL_IDS.has(model.id)
  );
}

export function getFastMode(ctx: ExtensionContext): boolean {
  return store().enabledBySession.get(fastModeSessionKey(ctx)) === true;
}

export function setFastMode(ctx: ExtensionContext, enabled: boolean): void {
  const s = store();
  const sessionId = fastModeSessionKey(ctx);

  // Read-before-write so two Pi processes toggling different sessions do not
  // unnecessarily clobber each other's JSON entries.
  const latest = readStoreFile();
  latest.set(sessionId, enabled);
  writeStoreFile(latest);

  s.enabledBySession = latest;
  s.revision += 1;
}

export function isFastModeActive(ctx: ExtensionContext): boolean {
  return getFastMode(ctx) && supportsFastMode(ctx);
}

export function fastModeStatusText(ctx: ExtensionContext): string {
  if (!getFastMode(ctx)) return "Fast mode: off";
  if (isFastModeActive(ctx)) return "Fast mode: on";
  return "Fast mode: on (not supported by current model)";
}

export function applyFastModeToPayload(ctx: ExtensionContext, payload: unknown): unknown | undefined {
  if (!isFastModeActive(ctx)) return undefined;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  return {
    ...(payload as Record<string, unknown>),
    service_tier: FAST_SERVICE_TIER,
  };
}
