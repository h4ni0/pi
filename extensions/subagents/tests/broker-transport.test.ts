import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BoundedSocketWriter,
  BrokerFrameDecoder,
  BrokerRateLimiter,
  BROKER_PROTOCOL_VERSION,
} from "../runtime/broker-protocol.ts";
import {
  RootTreeBroker,
  type BrokerConnectionGrant,
  type BrokerDispatch,
  type BrokerIdentity,
} from "../runtime/root-tree-broker.ts";
import { maintainBrokerSockets } from "../runtime/broker-socket.ts";

const FIXTURE = fileURLToPath(
  new URL("./fixtures/broker-client.mjs", import.meta.url),
);
const TOKEN = "a".repeat(48);
const BROKER_TRANSPORT_TEMP_PREFIXES = [
  "pi-broker-transport-",
  "pi-broker-mode-",
  "pi-broker-stale-",
  "pi-broker-maintenance-",
  "pi-broker-location-",
  "pi-broker-unsafe-",
] as const;
const trackedBrokerTransportTempDirs = new Set<string>();

function createBrokerTransportTempDir(
  prefix: (typeof BROKER_TRANSPORT_TEMP_PREFIXES)[number],
): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  trackedBrokerTransportTempDirs.add(directory);
  try {
    fs.chmodSync(directory, 0o700);
    return directory;
  } catch (error) {
    removeBrokerTransportTempDir(directory);
    throw error;
  }
}

function removeBrokerTransportTempDir(directory: string): void {
  fs.rmSync(directory, { recursive: true, force: true });
  trackedBrokerTransportTempDirs.delete(directory);
}

function brokerTransportTempResidue(): string[] {
  return fs.readdirSync(os.tmpdir(), { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        BROKER_TRANSPORT_TEMP_PREFIXES.some((prefix) => entry.name.startsWith(prefix)),
    )
    .map((entry) => path.join(os.tmpdir(), entry.name))
    .sort();
}

afterEach(() => {
  const leaked = [...trackedBrokerTransportTempDirs].filter((directory) =>
    fs.existsSync(directory)
  );
  for (const directory of leaked)
    fs.rmSync(directory, { recursive: true, force: true });
  trackedBrokerTransportTempDirs.clear();
  expect(leaked).toEqual([]);
});

afterAll(() => {
  expect([...trackedBrokerTransportTempDirs]).toEqual([]);
  expect(brokerTransportTempResidue()).toEqual([]);
});

interface RawBinding {
  identity: string;
  generation: number;
  connectionToken: string;
}

interface FrameWaiter {
  resolve(frame: any): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

class RawBrokerClient {
  private readonly frames: any[] = [];
  private readonly waiters: FrameWaiter[] = [];
  private ended = false;
  readonly closed: Promise<void>;

  private constructor(readonly socket: net.Socket) {
    this.closed = new Promise<void>((resolve) => {
      socket.once("close", () => {
        this.ended = true;
        for (const waiter of this.waiters.splice(0)) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error("raw broker socket closed"));
        }
        resolve();
      });
    });
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        this.pushFrame(JSON.parse(line));
      }
    });
    socket.on("error", () => undefined);
  }

  static async connect(socketPath: string): Promise<RawBrokerClient> {
    const socket = net.createConnection(socketPath);
    const client = new RawBrokerClient(socket);
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        socket.off("connect", onConnect);
        socket.off("error", onError);
      };
      const onConnect = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      socket.once("connect", onConnect);
      socket.once("error", onError);
    });
    return client;
  }

  send(...frames: unknown[]): void {
    this.socket.write(frames.map((frame) => `${JSON.stringify(frame)}\n`).join(""));
  }

  writeRaw(text: string): void {
    this.socket.write(text);
  }

  nextFrame(timeoutMs = 2_000): Promise<any> {
    const frame = this.frames.shift();
    if (frame !== undefined) return Promise.resolve(frame);
    if (this.ended) return Promise.reject(new Error("raw broker socket closed"));
    return new Promise((resolve, reject) => {
      const waiter: FrameWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error("timed out waiting for broker frame"));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  destroy(): void {
    this.socket.destroy();
  }

  private pushFrame(frame: any): void {
    const waiter = this.waiters.shift();
    if (!waiter) {
      this.frames.push(frame);
      return;
    }
    clearTimeout(waiter.timer);
    waiter.resolve(frame);
  }
}

function rootOptions(
  overrides: Partial<Parameters<typeof RootTreeBroker.createRoot>[0]> = {},
): Parameters<typeof RootTreeBroker.createRoot>[0] {
  return {
    identity: { id: "root_transport", path: "/root", depth: 0, maxDepth: 3 },
    maxResidentAgents: 8,
    maxActiveAgents: 8,
    dispatch: async () => ({}),
    ...overrides,
  };
}

async function reserve(
  broker: RootTreeBroker,
  taskName: string,
  id = `id_${taskName}`,
): Promise<BrokerConnectionGrant> {
  return broker.reserveChild({
    id,
    taskName,
    maxDepth: 3,
    lastTaskMessage: `${taskName} task`,
    reloadable: true,
  });
}

function childIdentity(
  grant: BrokerConnectionGrant,
  taskName: string,
  id = `id_${taskName}`,
): BrokerIdentity {
  return {
    id,
    path: grant.path,
    parentId: "root_transport",
    parentPath: "/root",
    depth: 1,
    maxDepth: 3,
    connectionGeneration: grant.generation,
  };
}

async function authenticateRaw(
  socketPath: string,
  identity: BrokerIdentity,
  capability: string,
): Promise<{ client: RawBrokerClient; binding: RawBinding; response: any }> {
  const client = await RawBrokerClient.connect(socketPath);
  client.send({
    kind: "hello",
    id: `hello_${crypto.randomBytes(5).toString("hex")}`,
    protocol: BROKER_PROTOCOL_VERSION,
    identity,
    capability,
  });
  const response = await client.nextFrame();
  const binding = response.ok
    ? {
        identity: response.result.identity,
        generation: response.result.generation,
        connectionToken: response.result.connectionToken,
      }
    : { identity: identity.path, generation: identity.connectionGeneration!, connectionToken: TOKEN };
  return { client, binding, response };
}

function requestFrame(
  binding: RawBinding,
  id: string,
  sequence: number,
  op = "list",
  payload: any = {},
  operationToken = crypto.randomBytes(24).toString("hex"),
): any {
  return {
    kind: "request",
    id,
    op,
    sequence,
    payload,
    ...binding,
    operationToken,
  };
}

function dispatchResponse(
  binding: RawBinding,
  dispatch: any,
  result: any = {},
): any {
  return {
    kind: "dispatch_response",
    id: dispatch.id,
    op: dispatch.op,
    sequence: dispatch.sequence,
    ok: true,
    result,
    ...binding,
    operationToken: dispatch.operationToken,
  };
}

function securityCounts(root: RootTreeBroker): Record<string, number> {
  return (root as any).server.securityCounts();
}

async function within<T>(promise: Promise<T>, timeoutMs = 2_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("operation timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function eventually(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("condition did not become true");
    await Bun.sleep(10);
  }
}

async function waitForFixtureReady(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("fixture did not connect")), 2_000);
    child.stdout!.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (!output.includes("READY\n")) return;
      clearTimeout(timer);
      resolve();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      if (output.includes("READY\n")) return;
      clearTimeout(timer);
      reject(new Error(`fixture exited before connecting (${code})`));
    });
  });
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("broker transport security", () => {
  test("creates a private socket location, removes it safely, and rejects symlink directories", async () => {
    const outer = createBrokerTransportTempDir("pi-broker-mode-");
    const socketDirectory = path.join(outer, "owned");
    const socketPath = path.join(socketDirectory, "broker.sock");
    let root: RootTreeBroker | undefined;
    const exitListenersBefore = process.listenerCount("exit");
    try {
      root = await RootTreeBroker.createRoot(rootOptions({ socketPath }));
      expect(process.listenerCount("exit")).toBe(exitListenersBefore + 1);
      expect(fs.lstatSync(socketDirectory).isDirectory()).toBe(true);
      expect(fs.lstatSync(socketDirectory).mode & 0o777).toBe(0o700);
      expect(fs.lstatSync(socketPath).isSocket()).toBe(true);
      expect(fs.lstatSync(socketPath).mode & 0o777).toBe(0o600);
      if (process.getuid) {
        expect(fs.lstatSync(socketDirectory).uid).toBe(process.getuid());
        expect(fs.lstatSync(socketPath).uid).toBe(process.getuid());
      }
      await root.close();
      root = undefined;
      expect(process.listenerCount("exit")).toBe(exitListenersBefore);
      expect(fs.existsSync(socketPath)).toBe(false);
      expect(fs.existsSync(socketDirectory)).toBe(false);

      const realDirectory = path.join(outer, "real");
      const linkedDirectory = path.join(outer, "linked");
      fs.mkdirSync(realDirectory, { mode: 0o700 });
      fs.symlinkSync(realDirectory, linkedDirectory, "dir");
      await expect(
        RootTreeBroker.createRoot(
          rootOptions({ socketPath: path.join(linkedDirectory, "broker.sock") }),
        ),
      ).rejects.toThrow("not a real directory");
    } finally {
      await root?.close().catch(() => undefined);
      removeBrokerTransportTempDir(outer);
    }
  });

  test("cleans the transport directory when connection acquisition ends early", async () => {
    const directory = createBrokerTransportTempDir("pi-broker-transport-");
    const socketPath = path.join(directory, "broker.sock");
    let root: RootTreeBroker | undefined;
    let first: RawBrokerClient | undefined;
    let second: RawBrokerClient | undefined;
    try {
      root = await RootTreeBroker.createRoot(
        rootOptions({
          socketPath,
          protocolLimits: {
            maxAcceptedConnections: 1,
            authenticationDeadlineMs: 50,
          },
        }),
      );
      first = await RawBrokerClient.connect(socketPath);
      try {
        second = await RawBrokerClient.connect(socketPath);
        await within(second.closed, 500);
      } catch {
        // A pre-authentication rejection may race the local connect callback.
      }
      await within(first.closed, 500);
    } finally {
      first?.destroy();
      second?.destroy();
      await root?.close().catch(() => undefined);
      removeBrokerTransportTempDir(directory);
    }
    expect(fs.existsSync(directory)).toBe(false);
  });

  test("scavenges only inode-stable stale owned sockets after SIGKILL", async () => {
    const directory = createBrokerTransportTempDir("pi-broker-stale-");
    const stalePath = path.join(directory, `${"a".repeat(24)}.sock`);
    const ownPath = path.join(directory, `${"b".repeat(24)}.sock`);
    const activePath = path.join(directory, `${"c".repeat(24)}.sock`);
    let child: ChildProcess | undefined;
    let root: RootTreeBroker | undefined;
    let activeRoot: RootTreeBroker | undefined;
    try {
      const spawned = spawn(process.execPath, [
        "-e",
        `const fs=require('fs'),net=require('net');const p=process.argv[1];const s=net.createServer();s.listen(p,()=>{fs.chmodSync(p,0o600);process.stdout.write('ready')});setInterval(()=>{},1000);`,
        stalePath,
      ], { stdio: ["ignore", "pipe", "ignore"] });
      child = spawned;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("stale socket fixture timed out")), 2_000);
        spawned.stdout!.once("data", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      spawned.kill("SIGKILL");
      await new Promise<void>((resolve) => spawned.once("close", () => resolve()));
      expect(fs.existsSync(stalePath)).toBe(true);
      activeRoot = await RootTreeBroker.createRoot({
        identity: { id: "root-active", path: "/root", depth: 0, maxDepth: 1 },
        maxResidentAgents: 2,
        maxActiveAgents: 2,
        socketPath: activePath,
        dispatch: async () => ({}),
      });
      root = await RootTreeBroker.createRoot({
        identity: { id: "root-stale", path: "/root", depth: 0, maxDepth: 1 },
        maxResidentAgents: 2,
        maxActiveAgents: 2,
        socketPath: ownPath,
        dispatch: async () => ({}),
      });
      expect(fs.existsSync(stalePath)).toBe(false);
      expect(fs.existsSync(activePath)).toBe(true);
      expect(fs.existsSync(ownPath)).toBe(true);
      expect((await activeRoot.list()).agents[0]?.agent_name).toBe("/root");
    } finally {
      child?.kill("SIGKILL");
      if (child) await waitForExit(child).catch(() => undefined);
      await root?.close().catch(() => undefined);
      await activeRoot?.close().catch(() => undefined);
      removeBrokerTransportTempDir(directory);
    }
  });

  test("maintenance dry-run reports stale sockets and CLI apply removes only stale sockets", async () => {
    const directory = createBrokerTransportTempDir("pi-broker-maintenance-");
    const stalePath = path.join(directory, `${"d".repeat(24)}.sock`);
    const activePath = path.join(directory, `${"e".repeat(24)}.sock`);
    const activeServer = net.createServer();
    let child: ChildProcess | undefined;
    try {
      const spawned = spawn(process.execPath, [
        "-e",
        `const fs=require('fs'),net=require('net');const p=process.argv[1];const s=net.createServer();s.listen(p,()=>{fs.chmodSync(p,0o600);process.stdout.write('ready')});setInterval(()=>{},1000);`,
        stalePath,
      ], { stdio: ["ignore", "pipe", "ignore"] });
      child = spawned;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("maintenance stale socket fixture timed out")),
          2_000,
        );
        spawned.stdout!.once("data", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      spawned.kill("SIGKILL");
      await new Promise<void>((resolve) => spawned.once("close", () => resolve()));
      await new Promise<void>((resolve, reject) => {
        activeServer.once("error", reject);
        activeServer.listen(activePath, () => {
          activeServer.off("error", reject);
          fs.chmodSync(activePath, 0o600);
          resolve();
        });
      });

      const dryRun = await maintainBrokerSockets(directory);
      expect(dryRun).toMatchObject({
        mode: "dry-run",
        stale: [stalePath],
        removed: [],
      });
      expect(fs.existsSync(stalePath)).toBe(true);
      expect(fs.existsSync(activePath)).toBe(true);

      const script = fileURLToPath(
        new URL("../bin/broker-socket-maintenance.ts", import.meta.url),
      );
      const dryMaintenance = Bun.spawn(
        [process.execPath, script, "--dry-run", "--directory", directory],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [dryStdout, dryStderr, dryExitCode] = await Promise.all([
        new Response(dryMaintenance.stdout).text(),
        new Response(dryMaintenance.stderr).text(),
        dryMaintenance.exited,
      ]);
      expect(dryStderr).toBe("");
      expect(dryExitCode).toBe(0);
      expect(JSON.parse(dryStdout)).toMatchObject({
        mode: "dry-run",
        stale: [stalePath],
        removed: [],
      });
      expect(fs.existsSync(stalePath)).toBe(true);

      const maintenance = Bun.spawn(
        [process.execPath, script, "--apply", "--directory", directory],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(maintenance.stdout).text(),
        new Response(maintenance.stderr).text(),
        maintenance.exited,
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({
        mode: "apply",
        stale: [stalePath],
        removed: [stalePath],
      });
      expect(fs.existsSync(stalePath)).toBe(false);
      expect(fs.existsSync(activePath)).toBe(true);
    } finally {
      child?.kill("SIGKILL");
      if (child) await waitForExit(child).catch(() => undefined);
      if (activeServer.listening)
        await new Promise<void>((resolve) => activeServer.close(() => resolve()));
      removeBrokerTransportTempDir(directory);
    }
  });

  test("rejects forged identities, stale grants, duplicate connections, replay, and sibling release", async () => {
    const root = await RootTreeBroker.createRoot(rootOptions());
    const clients: RawBrokerClient[] = [];
    try {
      const endpoint = root.endpoint!;
      const grant = await reserve(root, "alpha");
      const identity = childIdentity(grant, "alpha");
      const attempts: Array<{ identity: BrokerIdentity; capability: string }> = [
        { identity: { ...identity, id: "forged_id" }, capability: grant.capability },
        { identity: { ...identity, path: "/root/unknown" }, capability: grant.capability },
        { identity: { ...identity, parentId: "forged_parent" }, capability: grant.capability },
        { identity: { ...identity, depth: 2 }, capability: grant.capability },
        { identity: { ...identity, maxDepth: 4 }, capability: grant.capability },
        {
          identity: { ...identity, connectionGeneration: grant.generation + 1 },
          capability: grant.capability,
        },
        { identity, capability: "0".repeat(64) },
        {
          identity: {
            id: "root_transport",
            path: "/root",
            depth: 0,
            maxDepth: 3,
            connectionGeneration: 1,
          },
          capability: grant.capability,
        },
      ];
      for (const attempt of attempts) {
        const result = await authenticateRaw(
          endpoint.socketPath,
          attempt.identity,
          attempt.capability,
        );
        clients.push(result.client);
        expect(result.response.ok).toBe(false);
        await within(result.client.closed);
      }

      const authenticated = await authenticateRaw(
        endpoint.socketPath,
        identity,
        grant.capability,
      );
      clients.push(authenticated.client);
      expect(authenticated.response.ok).toBe(true);

      const duplicate = await authenticateRaw(
        endpoint.socketPath,
        identity,
        grant.capability,
      );
      clients.push(duplicate.client);
      expect(duplicate.response.ok).toBe(false);
      await within(duplicate.client.closed);

      const first = requestFrame(authenticated.binding, "req_replay", 1);
      authenticated.client.send(first);
      expect((await authenticated.client.nextFrame()).ok).toBe(true);
      authenticated.client.send(first);
      const replay = await authenticated.client.nextFrame();
      expect(replay.ok).toBe(false);
      expect(replay.error).toContain("replay");

      const siblingGrant = await reserve(root, "beta");
      authenticated.client.send(
        requestFrame(
          authenticated.binding,
          "req_sibling_release",
          2,
          "release",
          { targetPath: siblingGrant.path },
        ),
      );
      const release = await authenticated.client.nextFrame();
      expect(release.ok).toBe(false);
      expect(release.error).toContain("owning controller");

      const sibling = await authenticateRaw(
        endpoint.socketPath,
        childIdentity(siblingGrant, "beta"),
        siblingGrant.capability,
      );
      clients.push(sibling.client);
      expect(sibling.response.ok).toBe(true);

      authenticated.client.send(
        requestFrame(authenticated.binding, "req_stale", 3, "list", {
          pathPrefix: "/root",
        }, TOKEN),
      );
      expect((await authenticated.client.nextFrame()).ok).toBe(true);
      authenticated.client.send({
        ...requestFrame(authenticated.binding, "req_bad_generation", 4),
        generation: authenticated.binding.generation + 1,
      });
      await within(authenticated.client.closed);
    } finally {
      for (const client of clients) client.destroy();
      await root.close().catch(() => undefined);
    }
  });

  test("accepts valid batched frames, rejects an oversized frame, and enforces rate limits", async () => {
    const root = await RootTreeBroker.createRoot(
      rootOptions({
        protocolLimits: {
          frameMaxBytes: 512,
          maxRequestsPerWindow: 2,
          rateWindowMs: 60_000,
        },
      }),
    );
    const clients: RawBrokerClient[] = [];
    try {
      const grant = await reserve(root, "batch");
      const authenticated = await authenticateRaw(
        root.endpoint!.socketPath,
        childIdentity(grant, "batch"),
        grant.capability,
      );
      clients.push(authenticated.client);
      const frames = [
        requestFrame(authenticated.binding, "batch_one", 1, "list", {
          padding: "x".repeat(150),
        }),
        requestFrame(authenticated.binding, "batch_two", 2, "list", {
          padding: "y".repeat(150),
        }),
      ];
      const texts = frames.map((frame) => `${JSON.stringify(frame)}\n`);
      expect(texts.every((text) => Buffer.byteLength(text) <= 512)).toBe(true);
      expect(Buffer.byteLength(texts.join(""))).toBeGreaterThan(512);
      authenticated.client.writeRaw(texts.join(""));
      const responses = [
        await authenticated.client.nextFrame(),
        await authenticated.client.nextFrame(),
      ];
      expect(responses.every((response) => response.ok)).toBe(true);

      authenticated.client.send(
        requestFrame(authenticated.binding, "batch_rate", 3),
      );
      const limited = await authenticated.client.nextFrame();
      expect(limited.ok).toBe(false);
      expect(limited.error).toContain("rate limit");

      const oversized = await RawBrokerClient.connect(root.endpoint!.socketPath);
      clients.push(oversized);
      oversized.writeRaw(`${JSON.stringify({ padding: "z".repeat(600) })}\n`);
      await within(oversized.closed);
    } finally {
      for (const client of clients) client.destroy();
      await root.close().catch(() => undefined);
    }
  });

  test("binds active and tombstoned dispatch responses to the exact connection and tuple", async () => {
    const root = await RootTreeBroker.createRoot(rootOptions());
    const clients: RawBrokerClient[] = [];
    try {
      const alphaGrant = await reserve(root, "dispatch_alpha");
      const betaGrant = await reserve(root, "dispatch_beta");
      const alpha = await authenticateRaw(
        root.endpoint!.socketPath,
        childIdentity(alphaGrant, "dispatch_alpha"),
        alphaGrant.capability,
      );
      const beta = await authenticateRaw(
        root.endpoint!.socketPath,
        childIdentity(betaGrant, "dispatch_beta"),
        betaGrant.capability,
      );
      clients.push(alpha.client, beta.client);

      const routed = (root as any).server.dispatchToIdentity(
        alphaGrant.path,
        { op: "deliver_mailbox", payload: { marker: "first" } },
      );
      const dispatch = await alpha.client.nextFrame();
      beta.client.send(dispatchResponse(beta.binding, dispatch));
      await within(beta.client.closed);
      alpha.client.send(dispatchResponse(alpha.binding, dispatch));
      await expect(within(routed)).resolves.toEqual({});

      // An exact late response is harmless only after its full tuple is checked.
      alpha.client.send(dispatchResponse(alpha.binding, dispatch));
      alpha.client.send(requestFrame(alpha.binding, "still_live", 1));
      expect((await alpha.client.nextFrame()).ok).toBe(true);

      const gammaGrant = await reserve(root, "dispatch_gamma");
      const gamma = await authenticateRaw(
        root.endpoint!.socketPath,
        childIdentity(gammaGrant, "dispatch_gamma"),
        gammaGrant.capability,
      );
      clients.push(gamma.client);
      gamma.client.send(dispatchResponse(gamma.binding, dispatch));
      await within(gamma.client.closed);

      const deltaGrant = await reserve(root, "dispatch_delta");
      const delta = await authenticateRaw(
        root.endpoint!.socketPath,
        childIdentity(deltaGrant, "dispatch_delta"),
        deltaGrant.capability,
      );
      clients.push(delta.client);
      const disconnected = (root as any).server.dispatchToIdentity(
        deltaGrant.path,
        { op: "deliver_mailbox", payload: { marker: "second" } },
      );
      expect((await delta.client.nextFrame()).kind).toBe("dispatch");
      delta.client.destroy();
      await expect(within(disconnected)).rejects.toThrow("owner disconnected");

      alpha.client.send({
        ...dispatchResponse(alpha.binding, dispatch),
        operationToken: "b".repeat(48),
      });
      await within(alpha.client.closed);
      await eventually(
        () => securityCounts(root).dispatches === 0 && securityCounts(root).tombstones === 0,
      );
    } finally {
      for (const client of clients) client.destroy();
      await root.close().catch(() => undefined);
    }
  });

  test("validates late dispatch cancellations against the client tombstone tuple", async () => {
    const root = await RootTreeBroker.createRoot(rootOptions());
    let child: RootTreeBroker | undefined;
    try {
      const grant = await reserve(root, "cancel_tombstone");
      child = await RootTreeBroker.connectChild({
        identity: childIdentity(grant, "cancel_tombstone"),
        maxResidentAgents: 8,
        maxActiveAgents: 8,
        socketPath: root.endpoint!.socketPath,
        capability: grant.capability,
        dispatch: async () => ({}),
      });
      await (root as any).server.dispatchToIdentity(
        grant.path,
        { op: "deliver_mailbox", payload: { marker: "complete" } },
      );
      await eventually(() => (child as any).dispatchTombstones.size === 1);
      const tombstone = [...(child as any).dispatchTombstones.values()][0] as any;
      const connection = (root as any).server.connections.get(grant.path);
      const cancel = {
        kind: "dispatch_cancel",
        id: tombstone.id,
        op: tombstone.op,
        sequence: tombstone.sequence,
        identity: tombstone.identityPath,
        generation: tombstone.generation,
        connectionToken: tombstone.connectionToken,
        operationToken: tombstone.operationToken,
      };
      await connection.writer.send(cancel);
      await child.list();
      await connection.writer.send({
        ...cancel,
        operationToken: "b".repeat(48),
      });
      await eventually(() => securityCounts(root).authenticated === 0);
    } finally {
      await child?.close().catch(() => undefined);
      await root.close().catch(() => undefined);
    }
  });

  test("bounded close reclaims an unauthenticated fixture socket", async () => {
    const root = await RootTreeBroker.createRoot(
      rootOptions({
        protocolLimits: {
          authenticationDeadlineMs: 10_000,
          shutdownTimeoutMs: 500,
          dispatchDrainTimeoutMs: 200,
        },
      }),
    );
    const child = spawn(process.execPath, [FIXTURE, root.endpoint!.socketPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await waitForFixtureReady(child);
      await eventually(() => securityCounts(root).accepted === 1);
      await within(root.close(), 1_000);
      await within(waitForExit(child), 1_000);
    } finally {
      child.kill("SIGTERM");
      await root.close().catch(() => undefined);
    }
  });

  test("closes on a queue-full client cancel so remote work aborts without leaks", async () => {
    const started = deferred();
    const aborted = deferred();
    const root = await RootTreeBroker.createRoot(
      rootOptions({
        dispatch: async (_dispatch, signal) => {
          started.resolve();
          return new Promise((_, reject) => {
            const onAbort = () => {
              aborted.resolve();
              reject(new Error("remote work aborted"));
            };
            if (signal?.aborted) onAbort();
            else signal?.addEventListener("abort", onAbort, { once: true });
          });
        },
      }),
    );
    let child: RootTreeBroker | undefined;
    try {
      const grant = await reserve(root, "client_backpressure");
      child = await RootTreeBroker.connectChild({
        identity: childIdentity(grant, "client_backpressure"),
        maxResidentAgents: 8,
        maxActiveAgents: 8,
        socketPath: root.endpoint!.socketPath,
        capability: grant.capability,
        dispatch: async () => ({}),
      });
      const writer = (child as any).writer;
      const originalSend = writer.send.bind(writer);
      writer.send = (frame: any) =>
        frame?.kind === "cancel"
          ? Promise.reject(new Error("Broker outbound queue is full"))
          : originalSend(frame);
      const controller = new AbortController();
      const pending = child.askParent(
        {
          message: "cancel me",
          reason: "blocked",
          blocking: true,
        },
        controller.signal,
      );
      await within(started.promise);
      controller.abort();
      await expect(pending).rejects.toThrow("aborted");
      await within(aborted.promise);
      await eventually(() => {
        const counts = securityCounts(root);
        return counts.requestJobs === 0 && counts.dispatches === 0 && counts.tombstones === 0;
      });
    } finally {
      await child?.close().catch(() => undefined);
      await root.close().catch(() => undefined);
    }
  });

  test("closes on a queue-full server dispatch_cancel so child work aborts without leaks", async () => {
    const started = deferred();
    const aborted = deferred();
    const root = await RootTreeBroker.createRoot(rootOptions());
    let child: RootTreeBroker | undefined;
    let grandchild: RootTreeBroker | undefined;
    try {
      const childGrant = await reserve(root, "server_backpressure");
      child = await RootTreeBroker.connectChild({
        identity: childIdentity(childGrant, "server_backpressure"),
        maxResidentAgents: 8,
        maxActiveAgents: 8,
        socketPath: root.endpoint!.socketPath,
        capability: childGrant.capability,
        dispatch: async (dispatch, signal) => {
          if (dispatch.op !== "ask_parent") return {};
          started.resolve();
          return new Promise((_, reject) => {
            const onAbort = () => {
              aborted.resolve();
              reject(new Error("child work aborted"));
            };
            if (signal?.aborted) onAbort();
            else signal?.addEventListener("abort", onAbort, { once: true });
          });
        },
      });
      const grant = await child.reserveChild({
        id: "id_server_backpressure_grandchild",
        taskName: "server_backpressure_grandchild",
        maxDepth: 3,
        lastTaskMessage: "cancel parent dispatch",
        reloadable: true,
      });
      grandchild = await RootTreeBroker.connectChild({
        identity: {
          id: "id_server_backpressure_grandchild",
          path: grant.path,
          parentId: "id_server_backpressure",
          parentPath: childGrant.path,
          depth: 2,
          maxDepth: 3,
          connectionGeneration: grant.generation,
        },
        maxResidentAgents: 8,
        maxActiveAgents: 8,
        socketPath: root.endpoint!.socketPath,
        capability: grant.capability,
        dispatch: async () => ({}),
      });
      const serverConnection = (root as any).server.connections.get(childGrant.path);
      const originalSend = serverConnection.writer.send.bind(serverConnection.writer);
      serverConnection.writer.send = (frame: any) =>
        frame?.kind === "dispatch_cancel"
          ? Promise.reject(new Error("Broker outbound queue is full"))
          : originalSend(frame);
      const controller = new AbortController();
      const pending = grandchild.askParent(
        {
          message: "cancel nested work",
          reason: "blocked",
          blocking: true,
        },
        controller.signal,
      );
      await within(started.promise);
      controller.abort();
      await expect(pending).rejects.toThrow("aborted");
      await within(aborted.promise);
      await eventually(() => {
        const counts = securityCounts(root);
        return counts.requestJobs === 0 && counts.dispatches === 0 && counts.tombstones === 0;
      });
      expect((child as any).dispatchJobs.size).toBe(0);
    } finally {
      await grandchild?.close().catch(() => undefined);
      await child?.close().catch(() => undefined);
      await root.close().catch(() => undefined);
    }
  });

  test("canceling a nested ask_parent aborts and drains request/dispatch jobs", async () => {
    const dispatchStarted = deferred();
    const dispatchAborted = deferred();
    const root = await RootTreeBroker.createRoot(rootOptions());
    let child: RootTreeBroker | undefined;
    let grandchild: RootTreeBroker | undefined;
    try {
      const childGrant = await reserve(root, "parent_agent");
      child = await RootTreeBroker.connectChild({
        identity: childIdentity(childGrant, "parent_agent"),
        maxResidentAgents: 8,
        maxActiveAgents: 8,
        socketPath: root.endpoint!.socketPath,
        capability: childGrant.capability,
        dispatch: async (dispatch: BrokerDispatch, signal?: AbortSignal) => {
          if (dispatch.op !== "ask_parent") return {};
          dispatchStarted.resolve();
          return new Promise((_, reject) => {
            const onAbort = () => {
              dispatchAborted.resolve();
              const error = new Error("ask_parent model work aborted");
              error.name = "AbortError";
              reject(error);
            };
            if (signal?.aborted) onAbort();
            else signal?.addEventListener("abort", onAbort, { once: true });
          });
        },
      });
      const grandchildGrant = await child.reserveChild({
        id: "id_grandchild",
        taskName: "grandchild",
        maxDepth: 3,
        lastTaskMessage: "ask parent",
        reloadable: true,
      });
      grandchild = await RootTreeBroker.connectChild({
        identity: {
          id: "id_grandchild",
          path: grandchildGrant.path,
          parentId: "id_parent_agent",
          parentPath: childGrant.path,
          depth: 2,
          maxDepth: 3,
          connectionGeneration: grandchildGrant.generation,
        },
        maxResidentAgents: 8,
        maxActiveAgents: 8,
        socketPath: root.endpoint!.socketPath,
        capability: grandchildGrant.capability,
        dispatch: async () => ({}),
      });

      const abort = new AbortController();
      const pending = grandchild.askParent(
        {
          message: "Should this stop?",
          reason: "blocked",
          blocking: true,
        },
        abort.signal,
      );
      await within(dispatchStarted.promise);
      const cancelledAt = Date.now();
      abort.abort();
      await expect(pending).rejects.toThrow("aborted");
      await within(dispatchAborted.promise, 500);
      await eventually(() => {
        const counts = securityCounts(root);
        return counts.requestJobs === 0 && counts.dispatches === 0;
      }, 500);
      expect(Date.now() - cancelledAt).toBeLessThan(500);
      expect(securityCounts(root).authenticated).toBe(2);
      await within(child.list(), 500);
      await within(grandchild.list(), 500);
      expect(securityCounts(root).authenticated).toBe(2);
      expect(securityCounts(root).tombstones).toBeLessThanOrEqual(512);
    } finally {
      await grandchild?.close().catch(() => undefined);
      await child?.close().catch(() => undefined);
      await root.close().catch(() => undefined);
    }
  });

  test("an unloaded one-use capability cannot replay or reclaim capacity", async () => {
    const root = await RootTreeBroker.createRoot(
      rootOptions({ maxResidentAgents: 2, maxActiveAgents: 2 }),
    );
    const clients: RawBrokerClient[] = [];
    try {
      const grant = await reserve(root, "unloaded");
      const identity = childIdentity(grant, "unloaded");
      const live = await authenticateRaw(
        root.endpoint!.socketPath,
        identity,
        grant.capability,
      );
      clients.push(live.client);
      await root.updateAgent(grant.path, { active: false });
      await root.updateAgent(grant.path, { resident: false });
      await within(live.client.closed);

      const replay = await authenticateRaw(
        root.endpoint!.socketPath,
        identity,
        grant.capability,
      );
      clients.push(replay.client);
      expect(replay.response.ok).toBe(false);
      await within(replay.client.closed);
      expect((await root.list()).agents.map((agent) => agent.agent_name)).not.toContain(
        grant.path,
      );

      const replacement = await reserve(root, "replacement");
      expect(replacement.path).toBe("/root/replacement");
      await root.releaseReservation(replacement.path);
      expect(securityCounts(root).capabilities).toBe(0);
    } finally {
      for (const client of clients) client.destroy();
      await root.close().catch(() => undefined);
    }
  });
});

describe("broker protocol bounds", () => {
  test("decodes per LF frame and applies deterministic queue/rate limits", async () => {
    const decoder = new BrokerFrameDecoder(16);
    const batch = '{"a":1}\n{"b":2}\n{"c":3}\n';
    expect(Buffer.byteLength(batch)).toBeGreaterThan(16);
    expect(decoder.push(Buffer.from(batch))).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
    expect(() => decoder.push(Buffer.from(`${"x".repeat(17)}\n`))).toThrow(
      "Oversized broker frame",
    );

    const callbacks: Array<(error?: Error | null) => void> = [];
    const writer = new BoundedSocketWriter(
      {
        destroyed: false,
        write(_data, callback) {
          callbacks.push(callback!);
          return false;
        },
      },
      {
        frameMaxBytes: 128,
        maxOutboundQueueFrames: 2,
        maxOutboundQueueBytes: 128,
      },
    );
    const first = writer.send({ id: "first" });
    const second = writer.send({ id: "second" });
    expect(writer.pendingFrames).toBe(2);
    await expect(writer.send({ id: "third" })).rejects.toThrow("queue is full");
    callbacks.shift()!(null);
    await first;
    callbacks.shift()!(null);
    await second;
    expect(writer.pendingFrames).toBe(0);
    expect(writer.pendingBytes).toBe(0);

    let now = 0;
    const rate = new BrokerRateLimiter(2, 10, () => now);
    expect(rate.take()).toBe(true);
    expect(rate.take()).toBe(true);
    expect(rate.take()).toBe(false);
    now = 10;
    expect(rate.take()).toBe(true);
  });
});
