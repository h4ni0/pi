import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function now() {
  return Date.now();
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        },
        { once: true },
      );
    }
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
  return (
    process.env.PI_SUBAGENT_ID || ctx?.sessionManager.getSessionId() || "root"
  );
}

export function currentRootId(ctx?: ExtensionContext): string {
  return (
    process.env.PI_SUBAGENT_ROOT_ID ||
    ctx?.sessionManager.getSessionId() ||
    currentProcessAgentId(ctx)
  );
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
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function safeWriteJson(filePath: string, value: unknown) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(tmp, filePath);
}

export function safeReadJson<T>(filePath: string): T | undefined {
  try {
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

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }

  return { command: "pi", args };
}

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

export function extractMessageText(message: any): string {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part: any) => {
      if (part?.type === "text") return part.text ?? "";
      if (part?.type === "thinking") return "";
      if (part?.type === "toolCall") return `[tool: ${part.name}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}
