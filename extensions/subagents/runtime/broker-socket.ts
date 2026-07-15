import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { validateSafeBasename } from "./agent-path.ts";

const BROKER_SOCKET_NAME_RE = /^[a-f0-9]{24}\.sock$/;
const MAX_SCAVENGE_CANDIDATES = 256;

export interface SocketIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly uid?: number;
}

export interface PreparedSocketLocation {
  readonly directoryIdentity: SocketIdentity;
  readonly createdDirectory: boolean;
}

export interface BrokerSocketMaintenanceResult {
  readonly directory: string;
  readonly mode: "dry-run" | "apply";
  readonly stale: string[];
  readonly removed: string[];
}

export function defaultBrokerSocketDirectory(): string {
  return path.join(
    os.tmpdir(),
    `pi-subagents-${process.getuid?.() ?? process.pid}`,
  );
}

export function makeBrokerSocketPath(rootId: string): string {
  validateSafeBasename(rootId, "root session id");
  const digest = crypto
    .createHash("sha256")
    .update(`${rootId}:${process.pid}:${crypto.randomBytes(16).toString("hex")}`)
    .digest("hex")
    .slice(0, 24);
  return path.join(defaultBrokerSocketDirectory(), `${digest}.sock`);
}

export function prepareBrokerSocketLocation(
  socketPath: string,
): PreparedSocketLocation {
  if (!path.isAbsolute(socketPath))
    throw new Error("Broker socket path must be absolute");
  const parent = path.dirname(socketPath);
  if (path.basename(socketPath) !== socketPath.slice(parent.length + 1))
    throw new Error("Invalid broker socket basename");
  let createdDirectory = false;
  try {
    fs.lstatSync(parent);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    createdDirectory = true;
  }
  const directoryIdentity = verifyBrokerSocketDirectory(parent);
  try {
    fs.lstatSync(socketPath);
    throw new Error("Broker socket path already exists");
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  return { directoryIdentity, createdDirectory };
}

export function secureAndVerifyBrokerSocket(socketPath: string): SocketIdentity {
  fs.chmodSync(socketPath, 0o600);
  return verifyBrokerSocket(socketPath);
}

export function verifyBrokerSocket(socketPath: string): SocketIdentity {
  const stat = fs.lstatSync(socketPath);
  if (!stat.isSocket() || stat.isSymbolicLink())
    throw new Error("Broker endpoint is not a Unix socket");
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid)
    throw new Error("Unsafe broker socket owner");
  if ((stat.mode & 0o777) !== 0o600)
    throw new Error("Unsafe broker socket mode; expected 0600");
  return socketIdentity(stat);
}

export async function maintainBrokerSockets(
  directory = defaultBrokerSocketDirectory(),
  options: { apply?: boolean; excludeSocketPath?: string } = {},
): Promise<BrokerSocketMaintenanceResult> {
  if (!path.isAbsolute(directory))
    throw new Error("Broker socket maintenance directory must be absolute");
  const result: BrokerSocketMaintenanceResult = {
    directory,
    mode: options.apply === true ? "apply" : "dry-run",
    stale: [],
    removed: [],
  };
  let names: string[];
  try {
    verifyBrokerSocketDirectory(directory);
    names = fs.readdirSync(directory)
      .filter((name) => BROKER_SOCKET_NAME_RE.test(name))
      .sort()
      .slice(0, MAX_SCAVENGE_CANDIDATES);
  } catch (error: any) {
    if (error?.code === "ENOENT") return result;
    throw error;
  }

  const uid = process.getuid?.();
  for (const name of names) {
    const candidate = path.join(directory, name);
    if (candidate === options.excludeSocketPath) continue;
    let identity: SocketIdentity;
    try {
      const stat = fs.lstatSync(candidate);
      if (
        !stat.isSocket() ||
        stat.isSymbolicLink() ||
        (uid !== undefined && stat.uid !== uid) ||
        (stat.mode & 0o777) !== 0o600
      ) continue;
      identity = socketIdentity(stat);
    } catch {
      continue;
    }
    if (!(await isRefusedUnixSocket(candidate))) continue;
    result.stale.push(candidate);
    if (!options.apply) continue;
    try {
      const current = fs.lstatSync(candidate);
      if (!sameOwnedSocket(current, identity)) continue;
      fs.unlinkSync(candidate);
      result.removed.push(candidate);
    } catch (error: any) {
      if (error?.code !== "ENOENT") continue;
    }
  }
  return result;
}

export async function scavengeStaleBrokerSockets(
  directory: string,
  ownSocketPath: string,
): Promise<BrokerSocketMaintenanceResult> {
  return maintainBrokerSockets(directory, {
    apply: true,
    excludeSocketPath: ownSocketPath,
  });
}

export function safeRemoveBrokerSocket(
  socketPath: string,
  socketIdentityValue?: SocketIdentity,
  directoryIdentity?: SocketIdentity,
  removeDirectory = false,
): void {
  if (socketIdentityValue) {
    try {
      const stat = fs.lstatSync(socketPath);
      if (sameOwnedSocket(stat, socketIdentityValue)) fs.unlinkSync(socketPath);
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (!removeDirectory || !directoryIdentity) return;
  const parent = path.dirname(socketPath);
  try {
    const stat = fs.lstatSync(parent);
    if (
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      stat.dev === directoryIdentity.dev &&
      stat.ino === directoryIdentity.ino &&
      (directoryIdentity.uid === undefined || stat.uid === directoryIdentity.uid)
    ) fs.rmdirSync(parent);
  } catch (error: any) {
    if (error?.code !== "ENOENT" && error?.code !== "ENOTEMPTY") throw error;
  }
}

export function registerBrokerSocketExitCleanup(input: {
  socketPath: string;
  socketIdentity?: SocketIdentity;
  directoryIdentity?: SocketIdentity;
  removeDirectory?: boolean;
}): () => void {
  const cleanup = () => {
    try {
      safeRemoveBrokerSocket(
        input.socketPath,
        input.socketIdentity,
        input.directoryIdentity,
        input.removeDirectory,
      );
    } catch {
      // Exit cleanup is best effort; startup/maintenance scavenging owns residue.
    }
  };
  process.once("exit", cleanup);
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    process.off("exit", cleanup);
  };
}

export function isRefusedUnixSocket(socketPath: string): Promise<boolean> {
  try {
    const active = fs.readFileSync("/proc/net/unix", "utf8")
      .split("\n")
      .some((line) => line.trimEnd().endsWith(` ${socketPath}`));
    if (active) return Promise.resolve(false);
  } catch {
    // Fall through to the bounded ownership probe.
  }
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (stale: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners("connect");
      socket.removeAllListeners("error");
      socket.on("error", () => undefined);
      socket.destroy();
      resolve(stale);
    };
    socket.once("connect", () => finish(false));
    socket.once("error", (error: NodeJS.ErrnoException) =>
      finish(error.code === "ECONNREFUSED" || error.code === "ENOENT"));
    const timer = setTimeout(() => finish(false), 100);
    try {
      socket.connect(socketPath);
    } catch {
      finish(false);
    }
  });
}

function verifyBrokerSocketDirectory(directory: string): SocketIdentity {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Unsafe broker socket directory: not a real directory");
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid)
    throw new Error("Unsafe broker socket directory owner");
  if ((stat.mode & 0o777) !== 0o700)
    throw new Error("Unsafe broker socket directory mode; expected 0700");
  return socketIdentity(stat);
}

function socketIdentity(stat: fs.Stats): SocketIdentity {
  return { dev: stat.dev, ino: stat.ino, uid: stat.uid };
}

function sameOwnedSocket(stat: fs.Stats, identity: SocketIdentity): boolean {
  return stat.isSocket() &&
    !stat.isSymbolicLink() &&
    stat.dev === identity.dev &&
    stat.ino === identity.ino &&
    (identity.uid === undefined || stat.uid === identity.uid);
}
