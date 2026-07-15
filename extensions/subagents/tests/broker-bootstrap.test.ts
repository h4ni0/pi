import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { COLLABORATION_GUARD } from "../constants.ts";
import subagentsExtension from "../extension.ts";
import { buildChildEnvironment, RpcProcess } from "../rpc-process.ts";
import { CollaborationManager } from "../runtime/collaboration-manager.ts";
import { RootTreeBroker } from "../runtime/root-tree-broker.ts";
import { createSubagentRuntimeState } from "../runtime/state.ts";
import { DEFAULT_SETTINGS, loadSettings } from "../settings.ts";
import { globalSubagentsStatus } from "../status.ts";
import {
  buildChildBrokerEnvironment,
  getPiInvocation,
  readChildBrokerBootstrapEnvironment,
} from "../utils.ts";

const roots: RootTreeBroker[] = [];
const treeProcesses: FakePiTreeProcess[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.allSettled(treeProcesses.splice(0).map((process) => process.stop()));
  await Promise.allSettled(roots.splice(0).map((root) => root.close()));
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  delete (globalThis as Record<PropertyKey, unknown>)[COLLABORATION_GUARD];
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-broker-bootstrap-"));
  tempDirs.push(dir);
  return dir;
}

class FakePiTreeProcess {
  private readonly pending = new Map<
    string,
    { resolve(value: any): void; reject(error: Error): void }
  >();
  private nextId = 0;
  private buffer = "";
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private readonly ready = new Promise<void>((resolve, reject) => {
    this.readyResolve = resolve;
    this.readyReject = reject;
  });
  private readonly exited: Promise<void>;
  private closed = false;

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onData(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    this.exited = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        this.closed = true;
        const error = code === 0
          ? undefined
          : new Error(stderr || `fake Pi root exited with ${code ?? signal}`);
        for (const pending of this.pending.values())
          pending.reject(error ?? new Error("fake Pi root exited"));
        this.pending.clear();
        if (error) reject(error);
        else resolve();
      });
    });
    child.once("error", (error) => this.readyReject(error));
    child.once("close", (code) => {
      if (code !== 0)
        this.readyReject(new Error(stderr || `fake Pi root startup exited ${code}`));
    });
  }

  static async start(): Promise<FakePiTreeProcess> {
    const fixture = fileURLToPath(
      new URL("./fixtures/fake-pi-tree-node.ts", import.meta.url),
    );
    const child = spawn(process.execPath, [fixture, "root"], {
      env: buildChildEnvironment({}, ["HOME", "PATH", "TMPDIR"]),
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    const treeProcess = new FakePiTreeProcess(child);
    await treeProcess.ready;
    treeProcesses.push(treeProcess);
    return treeProcess;
  }

  get pid(): number {
    return this.child.pid!;
  }

  request(op: string, payload?: any): Promise<any> {
    const id = `test_${++this.nextId}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ id, op, payload })}\n`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async stop(): Promise<void> {
    if (this.closed) return this.exited;
    try {
      await this.request("shutdown");
    } catch {
      this.child.kill("SIGKILL");
    }
    await this.exited;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.kind === "ready") {
        this.readyResolve();
        continue;
      }
      if (message.kind !== "response") continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(String(message.error ?? "fake Pi request failed")));
    }
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function bootstrapEnv(input: {
  id: string;
  path: string;
  parentId: string;
  parentPath: string;
  depth: number;
  generation: number;
  socketPath: string;
  capability: string;
}): Record<string, string> {
  return buildChildBrokerEnvironment({
    identity: {
      id: input.id,
      path: input.path,
      parentId: input.parentId,
      parentPath: input.parentPath,
      depth: input.depth,
      maxDepth: 2,
      connectionGeneration: input.generation,
    },
    socketPath: input.socketPath,
    capability: input.capability,
    rootId: "root_bootstrap",
    maxResidentAgents: 6,
    maxActiveAgents: 6,
  });
}

async function connectFromEnv(env: Record<string, string>): Promise<RootTreeBroker> {
  const bootstrap = readChildBrokerBootstrapEnvironment(env);
  return RootTreeBroker.connectChild({
    identity: bootstrap.identity,
    maxResidentAgents: bootstrap.maxResidentAgents,
    maxActiveAgents: bootstrap.maxActiveAgents,
    socketPath: bootstrap.socketPath,
    capability: bootstrap.capability,
    dispatch: async () => ({}),
  });
}

describe("broker bootstrap tree", () => {
  test("separate fake Pi processes form one root, sibling, and grandchild tree and shut down recursively", async () => {
    const root = await FakePiTreeProcess.start();
    const alpha = await root.request("spawn", {
      taskName: "alpha",
      id: "id_process_alpha",
    });
    const beta = await root.request("spawn", {
      taskName: "beta",
      id: "id_process_beta",
    });
    const grand = await root.request("child_command", {
      taskName: "alpha",
      op: "spawn",
      payload: { taskName: "grand", id: "id_process_grand" },
    });
    expect(alpha.path).toBe("/root/alpha");
    expect(beta.path).toBe("/root/beta");
    expect(grand.path).toBe("/root/alpha/grand");
    expect((await root.request("list")).agents.map((agent: any) => agent.agent_name)).toEqual([
      "/root",
      "/root/alpha",
      "/root/alpha/grand",
      "/root/beta",
    ]);

    const pids = await root.request("pids") as number[];
    expect(new Set(pids).size).toBe(4);
    expect(pids).toContain(root.pid);
    expect(pids.every((pid) => pid !== process.pid && processIsAlive(pid))).toBe(true);

    await root.stop();
    expect(pids.every((pid) => !processIsAlive(pid))).toBe(true);
  }, 15_000);

  test("multi-process nested managers preserve reload ownership through leaf eviction and reload", async () => {
    const root = await FakePiTreeProcess.start();
    const parent = await root.request("spawn", {
      taskName: "parent",
      id: "id_eviction_parent",
    });
    const grand = await root.request("child_command", {
      taskName: "parent",
      op: "spawn",
      payload: { taskName: "grand", id: "id_eviction_grand" },
    });
    await root.request("child_command", {
      taskName: "parent",
      op: "idle",
      payload: { taskName: "grand" },
    });
    await root.request("idle", { taskName: "parent" });

    const originalPids = await root.request("pids") as number[];
    expect(originalPids).toHaveLength(3);
    const originalGrandPid = originalPids.find(
      (pid) => pid !== root.pid && pid !== parent.pid,
    )!;

    expect(await root.request("set_capacity", {
      maxResidentAgents: 2,
      maxActiveAgents: 6,
    })).toEqual({ unloaded: [grand.path] });
    expect((await root.request("list")).agents.map((agent: any) => agent.agent_name))
      .toEqual(["/root", parent.path]);
    expect(processIsAlive(originalGrandPid)).toBe(false);

    await expect(root.request("set_capacity", {
      maxResidentAgents: 1,
      maxActiveAgents: 6,
    })).rejects.toThrow("safe leaf eviction");
    expect((await root.request("list")).agents.map((agent: any) => agent.agent_name))
      .toEqual(["/root", parent.path]);

    await root.request("set_capacity", {
      maxResidentAgents: 3,
      maxActiveAgents: 6,
    });
    await root.request("send", {
      target: grand.path,
      message: "reload through the retained parent manager",
    });
    expect((await root.request("list")).agents.map((agent: any) => agent.agent_name))
      .toEqual(["/root", parent.path, grand.path]);
    const reloadedPids = await root.request("pids") as number[];
    expect(reloadedPids).toHaveLength(3);
    expect(reloadedPids).not.toContain(originalGrandPid);
    expect(reloadedPids.every(processIsAlive)).toBe(true);
  }, 15_000);

  test("root, siblings, and a grandchild use one transactional tree", async () => {
    const root = await RootTreeBroker.createRoot({
      identity: {
        id: "root_bootstrap",
        path: "/root",
        depth: 0,
        maxDepth: 2,
        connectionGeneration: 1,
      },
      maxResidentAgents: 6,
      maxActiveAgents: 6,
      dispatch: async () => ({}),
    });
    roots.push(root);
    const socketPath = root.endpoint!.socketPath;
    const alphaGrant = await root.reserveChild({
      id: "id_alpha",
      taskName: "alpha",
      maxDepth: 2,
      lastTaskMessage: "alpha",
      reloadable: true,
      transactional: true,
    });
    const betaGrant = await root.reserveChild({
      id: "id_beta",
      taskName: "beta",
      maxDepth: 2,
      lastTaskMessage: "beta",
      reloadable: true,
      transactional: true,
    });
    const alpha = await connectFromEnv(bootstrapEnv({
      id: "id_alpha",
      path: alphaGrant.path,
      parentId: "root_bootstrap",
      parentPath: "/root",
      depth: 1,
      generation: alphaGrant.generation,
      socketPath,
      capability: alphaGrant.capability,
    }));
    const beta = await connectFromEnv(bootstrapEnv({
      id: "id_beta",
      path: betaGrant.path,
      parentId: "root_bootstrap",
      parentPath: "/root",
      depth: 1,
      generation: betaGrant.generation,
      socketPath,
      capability: betaGrant.capability,
    }));
    roots.push(alpha, beta);
    await root.awaitChildRegistration(alphaGrant.path, alphaGrant.generation, 1_000);
    await root.awaitChildRegistration(betaGrant.path, betaGrant.generation, 1_000);
    expect((await root.list()).agents.map((agent) => agent.agent_name)).toEqual(["/root"]);
    await root.commitChildRegistration(alphaGrant.path, alphaGrant.generation);
    await root.commitChildRegistration(betaGrant.path, betaGrant.generation);

    const grandGrant = await alpha.reserveChild({
      id: "id_grand",
      taskName: "grand",
      maxDepth: 2,
      lastTaskMessage: "grand",
      reloadable: true,
      transactional: true,
    });
    const grand = await connectFromEnv(bootstrapEnv({
      id: "id_grand",
      path: grandGrant.path,
      parentId: "id_alpha",
      parentPath: "/root/alpha",
      depth: 2,
      generation: grandGrant.generation,
      socketPath,
      capability: grandGrant.capability,
    }));
    roots.push(grand);
    await alpha.awaitChildRegistration(grandGrant.path, grandGrant.generation, 1_000);
    await alpha.commitChildRegistration(grandGrant.path, grandGrant.generation);
    expect((await root.list()).agents.map((agent) => agent.agent_name)).toEqual([
      "/root",
      "/root/alpha",
      "/root/alpha/grand",
      "/root/beta",
    ]);
  });

  test("owner disconnect rolls back a provisional registration and frees capacity", async () => {
    const root = await RootTreeBroker.createRoot({
      identity: { id: "root_bootstrap", path: "/root", depth: 0, maxDepth: 2 },
      maxResidentAgents: 2,
      maxActiveAgents: 2,
      dispatch: async () => ({}),
    });
    roots.push(root);
    const grant = await root.reserveChild({
      id: "id_failed",
      taskName: "failed",
      maxDepth: 2,
      lastTaskMessage: "failed",
      reloadable: true,
      transactional: true,
    });
    const child = await connectFromEnv(bootstrapEnv({
      id: "id_failed",
      path: grant.path,
      parentId: "root_bootstrap",
      parentPath: "/root",
      depth: 1,
      generation: grant.generation,
      socketPath: root.endpoint!.socketPath,
      capability: grant.capability,
    }));
    await root.awaitChildRegistration(grant.path, grant.generation, 1_000);
    await child.close();
    await Bun.sleep(20);
    const replacement = await root.reserveChild({
      id: "id_replacement",
      taskName: "replacement",
      maxDepth: 2,
      lastTaskMessage: "replacement",
      reloadable: true,
      transactional: true,
    });
    expect(replacement.path).toBe("/root/replacement");
    await root.releaseReservation(replacement.path);
  });
});

interface FakeBrokerOptions {
  registrationError?: Error;
  commitError?: Error;
  promptError?: Error;
  blockRegistration?: boolean;
  stopError?: Error;
  brokerCloseError?: Error;
}

function managerHarness(options: FakeBrokerOptions = {}) {
  const cwd = tempDir();
  const sessionDir = path.join(cwd, "sessions");
  const session = SessionManager.inMemory(cwd);
  session.appendMessage({ role: "user", content: "parent" } as any);
  const ctx = {
    cwd,
    isProjectTrusted: () => true,
    hasUI: false,
    mode: "rpc",
    model: undefined,
    sessionManager: session,
  } as any;
  const pi = {
    getActiveTools: () => [],
    getAllTools: () => [],
    getThinkingLevel: () => "off",
    sendMessage: () => undefined,
    appendEntry: () => undefined,
  } as any;
  const state = createSubagentRuntimeState({
    pi,
    settings: {
      ...DEFAULT_SETTINGS,
      sessionDir,
      maxDepth: 2,
      rpcStartupTimeoutMs: 1_000,
      rpcRequestTimeoutMs: 1_000,
    },
    currentDepth: 0,
    envMaxDepth: 2,
    extensionPath: "/extension/index.ts",
    currentPath: "/root",
    guardToken: {},
    invocationBase: { command: "/trusted/pi", prefixArgs: [] },
  });
  state.latestCtx = ctx;
  state.treeMaxResidentAgents = 4;
  state.treeMaxActiveAgents = 4;
  const order: string[] = [];
  const released: string[] = [];
  let created = 0;
  let registrationEnteredResolve!: () => void;
  const registrationEntered = new Promise<void>((resolve) => {
    registrationEnteredResolve = resolve;
  });
  let releaseRegistration!: () => void;
  const registrationBlock = new Promise<void>((resolve) => {
    releaseRegistration = resolve;
  });
  state.broker = {
    endpoint: { socketPath: "/tmp/fake-root-tree.sock" },
    reserveChild: async (input: any) => {
      order.push("reserve");
      return {
        path: `/root/${input.taskName}`,
        capability: "a".repeat(64),
        generation: 1,
      };
    },
    awaitChildRegistration: async () => {
      order.push("registered");
      registrationEnteredResolve();
      if (options.blockRegistration) await registrationBlock;
      if (options.registrationError) throw options.registrationError;
    },
    commitChildRegistration: async () => {
      order.push("broker_commit");
      if (options.commitError) throw options.commitError;
    },
    abortChildRegistration: async (target: string) => {
      released.push(target);
      order.push("abort_registration");
    },
    releaseReservation: async (target: string) => {
      released.push(target);
      order.push("release");
    },
    updateAgent: async () => order.push("broker_update"),
    list: async () => ({ agents: [] }),
    close: async () => {
      order.push("broker_close");
      if (options.brokerCloseError) throw options.brokerCloseError;
    },
  } as any;
  let capturedEnv: Record<string, string | undefined> = {};
  const manager = new CollaborationManager(state, (_command, _args, rpcOptions) => {
    created += 1;
    capturedEnv = rpcOptions.env;
    let exited = false;
    return {
      pid: 101,
      get exited() { return exited; },
      onEvent: () => () => undefined,
      start: async () => order.push("rpc_start"),
      getState: async () => ({}),
      setSessionName: async () => undefined,
      prompt: async () => {
        order.push("prompt");
        if (options.promptError) throw options.promptError;
      },
      abort: async () => ({ accepted: true }),
      stop: async () => {
        order.push("rpc_stop");
        if (options.stopError) throw options.stopError;
        exited = true;
      },
    } as any;
  });
  state.manager = manager;
  return {
    manager,
    state,
    ctx,
    order,
    released,
    registrationEntered,
    releaseRegistration,
    get created() { return created; },
    get env() { return capturedEnv; },
  };
}

describe("manager broker transaction", () => {
  test("prompt acceptance and registration both precede broker/local commit", async () => {
    const harness = managerHarness();
    const spawned = await harness.manager.spawnAgent(
      { task_name: "worker", message: "work", fork_turns: "none" },
      undefined,
      harness.ctx,
    );
    expect(harness.order.slice(0, 5)).toEqual([
      "reserve",
      "rpc_start",
      "registered",
      "prompt",
      "broker_commit",
    ]);
    expect(harness.state.active.get(spawned.agent_id)?.committed).toBe(true);
    expect(harness.env.PI_SUBAGENT_PARENT_PATH).toBe("/root");
    expect(harness.env.PI_SUBAGENT_BROKER_CAPABILITY).toBe("a".repeat(64));
    await harness.manager.shutdown();
    expect(harness.order.at(-1)).toBe("broker_close");
  });

  test("registration failure rolls back process, local owner, and broker slot", async () => {
    const harness = managerHarness({ registrationError: new Error("registration failed") });
    await expect(harness.manager.spawnAgent(
      { task_name: "failed", message: "work", fork_turns: "none" },
      undefined,
      harness.ctx,
    )).rejects.toThrow("registration failed");
    expect(harness.order).toContain("rpc_stop");
    expect(harness.released).toEqual(["/root/failed"]);
    expect(harness.state.active.size).toBe(0);
  });

  test("commit failure rolls back both sides without a committed local owner", async () => {
    const harness = managerHarness({ commitError: new Error("commit response lost") });
    await expect(harness.manager.spawnAgent(
      { task_name: "commit_failed", message: "work", fork_turns: "none" },
      undefined,
      harness.ctx,
    )).rejects.toThrow("commit response lost");
    expect(harness.released).toEqual(["/root/commit_failed"]);
    expect(harness.state.active.size).toBe(0);
  });

  test("prompt failure rolls back both sides after registration", async () => {
    const harness = managerHarness({ promptError: new Error("prompt failed") });
    await expect(harness.manager.spawnAgent(
      { task_name: "prompt_failed", message: "work", fork_turns: "none" },
      undefined,
      harness.ctx,
    )).rejects.toThrow("prompt failed");
    expect(harness.order).toContain("registered");
    expect(harness.order).toContain("rpc_stop");
    expect(harness.released).toEqual(["/root/prompt_failed"]);
    expect(harness.state.active.size).toBe(0);
  });

  test("spawn cancellation during broker registration stops the process and rolls back both owners", async () => {
    const harness = managerHarness({ blockRegistration: true });
    const controller = new AbortController();
    const spawning = harness.manager.spawnAgent(
      { task_name: "cancelled", message: "work", fork_turns: "none" },
      controller.signal,
      harness.ctx,
    );
    await harness.registrationEntered;
    controller.abort();
    harness.releaseRegistration();
    await expect(spawning).rejects.toThrow("spawn cancelled");
    expect(harness.created).toBe(1);
    expect(harness.order).toContain("rpc_stop");
    expect(harness.released).toEqual(["/root/cancelled"]);
    expect(harness.state.active.size).toBe(0);
  });

  test("shutdown transport failure preserves the broker and direct-owner registry", async () => {
    const harness = managerHarness({ stopError: new Error("termination unconfirmed") });
    await harness.manager.spawnAgent(
      { task_name: "retained", message: "work", fork_turns: "none" },
      undefined,
      harness.ctx,
    );
    const broker = harness.state.broker;
    await expect(harness.manager.shutdown()).rejects.toThrow(
      "Failed to confirm shutdown",
    );
    expect(harness.state.broker).toBe(broker);
    expect(harness.state.active.size).toBe(1);
    expect(harness.order).not.toContain("broker_close");
  });

  test("broker cleanup failure preserves broker readiness and identity state", async () => {
    const harness = managerHarness({ brokerCloseError: new Error("socket cleanup failed") });
    const broker = harness.state.broker;
    const ready = Promise.resolve();
    const identity = {
      id: "root_bootstrap",
      path: "/root",
      depth: 0,
      maxDepth: 2,
    } as const;
    harness.state.brokerReady = ready;
    harness.state.brokerIdentity = identity;
    await expect(harness.manager.shutdown()).rejects.toThrow(
      "root-tree broker cleanup failed",
    );
    expect(harness.state.broker).toBe(broker);
    expect(harness.state.brokerReady).toBe(ready);
    expect(harness.state.brokerIdentity).toBe(identity);
  });

  test("depth bypass creates no process while throwing status observers are quarantined", async () => {
    const depth = managerHarness();
    depth.state.currentDepth = 2;
    await expect(depth.manager.spawnAgent(
      { task_name: "too_deep", message: "work", fork_turns: "none" },
      undefined,
      depth.ctx,
    )).rejects.toThrow("maxDepth");
    expect(depth.created).toBe(0);
    expect(depth.order).toEqual([]);

    const observer = managerHarness();
    const listener = () => { throw new Error("status observer failed"); };
    globalSubagentsStatus().listeners.add(listener);
    try {
      expect(await observer.manager.spawnAgent(
        { task_name: "observer", message: "work", fork_turns: "none" },
        undefined,
        observer.ctx,
      )).toMatchObject({ agent_name: "/root/observer" });
      expect(globalSubagentsStatus().listeners.has(listener)).toBe(false);
    } finally {
      globalSubagentsStatus().listeners.delete(listener);
    }
    expect(observer.created).toBe(1);
    expect(observer.state.active.size).toBe(1);
    await observer.manager.shutdown();
  });
});

describe("bootstrap environment, launcher, and settings trust", () => {
  test("strips inherited capabilities and loader controls while allowing the explicit child grant", () => {
    const oldCapability = process.env.PI_SUBAGENT_BROKER_CAPABILITY;
    const oldNodeOptions = process.env.NODE_OPTIONS;
    const oldLdLibraryPath = process.env.LD_LIBRARY_PATH;
    process.env.PI_SUBAGENT_BROKER_CAPABILITY = "f".repeat(64);
    process.env.NODE_OPTIONS = "--require=/tmp/evil.js";
    process.env.LD_LIBRARY_PATH = "/tmp/evil-loader";
    try {
      const env = buildChildEnvironment(
        {
          PI_SUBAGENT_BROKER_CAPABILITY: "a".repeat(64),
          NODE_OPTIONS: "--require=/tmp/also-evil.js",
          LD_LIBRARY_PATH: "/tmp/also-evil-loader",
        },
        ["PATH", "PI_SUBAGENT_BROKER_CAPABILITY", "NODE_OPTIONS", "LD_LIBRARY_PATH"],
      );
      expect(env.PI_SUBAGENT_BROKER_CAPABILITY).toBe("a".repeat(64));
      expect(env.NODE_OPTIONS).toBeUndefined();
      expect(env.LD_LIBRARY_PATH).toBeUndefined();
    } finally {
      if (oldCapability === undefined) delete process.env.PI_SUBAGENT_BROKER_CAPABILITY;
      else process.env.PI_SUBAGENT_BROKER_CAPABILITY = oldCapability;
      if (oldNodeOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = oldNodeOptions;
      if (oldLdLibraryPath === undefined) delete process.env.LD_LIBRARY_PATH;
      else process.env.LD_LIBRARY_PATH = oldLdLibraryPath;
    }
  });

  test("executes the pinned launcher instead of an actual fake pi first in PATH", async () => {
    const fakeBin = tempDir();
    const marker = path.join(fakeBin, "fake-pi-executed");
    const fakePi = path.join(fakeBin, "pi");
    fs.writeFileSync(
      fakePi,
      `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed");\n`,
      { mode: 0o755 },
    );
    const oldPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${oldPath ?? ""}`;
    const fixture = fileURLToPath(
      new URL("./fixtures/fake-rpc-child.mjs", import.meta.url),
    );
    const invocation = getPiInvocation([], {
      command: process.execPath,
      prefixArgs: [fixture],
    });
    const client = new RpcProcess(invocation.command, invocation.args, {
      cwd: fakeBin,
      env: {},
      envAllowlist: ["HOME", "PATH"],
      startupTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
      shutdownTimeoutMs: 1_000,
    });
    try {
      await client.start();
      expect((await client.getState()).sessionId).toStartWith("fake-");
    } finally {
      await client.stop();
      process.env.PATH = oldPath;
    }
    expect(fs.existsSync(marker)).toBe(false);
  });

  test("gates every project tree limit on project trust", () => {
    const cwd = tempDir();
    fs.mkdirSync(path.join(cwd, ".pi"));
    fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify({
      subagents: { maxPersistentAgents: 123, maxConcurrentAgents: 122, maxDepth: 7 },
    }));
    const untrusted = loadSettings(cwd, false);
    const trusted = loadSettings(cwd, true);
    expect(trusted.maxPersistentAgents).toBe(123);
    expect(trusted.maxConcurrentAgents).toBe(122);
    expect(trusted.maxDepth).toBe(7);
    expect(untrusted.maxPersistentAgents).not.toBe(123);
    expect(untrusted.maxConcurrentAgents).not.toBe(122);
    expect(untrusted.maxDepth).not.toBe(7);
  });

  test("raises an undersized completion burst bound to the per-message bound", () => {
    const cwd = tempDir();
    fs.mkdirSync(path.join(cwd, ".pi"));
    fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify({
      subagents: {
        completionMessageMaxBytes: 24_000,
        completionBurstMaxBytes: 1_000,
      },
    }));
    const settings = loadSettings(cwd, true);
    expect(settings.completionMessageMaxBytes).toBe(24_000);
    expect(settings.completionBurstMaxBytes).toBe(24_000);

    fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify({
      subagents: {
        completionMessageMaxBytes: 4_000,
        completionBurstMaxBytes: 8_000,
      },
    }));
    expect(loadSettings(cwd, true).completionBurstMaxBytes).toBe(8_000);
  });

  test("trusted child project settings cannot expand inherited root limits", () => {
    const cwd = tempDir();
    fs.mkdirSync(path.join(cwd, ".pi"));
    fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify({
      subagents: { maxPersistentAgents: 120, maxConcurrentAgents: 121, maxDepth: 20 },
    }));
    const ctx = {
      cwd,
      isProjectTrusted: () => true,
      sessionManager: SessionManager.inMemory(cwd),
    } as any;
    const state = createSubagentRuntimeState({
      pi: {} as any,
      settings: loadSettings(cwd, true),
      currentDepth: 1,
      envMaxDepth: 2,
      extensionPath: "/extension/index.ts",
      currentPath: "/root/child",
      guardToken: {},
      invocationBase: { command: "/trusted/pi", prefixArgs: [] },
    });
    state.treeMaxResidentAgents = 3;
    state.treeMaxActiveAgents = 2;
    state.brokerIdentity = {
      id: "child_id",
      path: "/root/child",
      parentId: "root_id",
      parentPath: "/root",
      depth: 1,
      maxDepth: 2,
      connectionGeneration: 1,
    };
    const manager = new CollaborationManager(state);
    manager.refreshSettings(ctx);
    expect(state.settings.maxPersistentAgents).toBe(3);
    expect(state.settings.maxConcurrentAgents).toBe(2);
    expect(state.settings.maxDepth).toBe(2);
  });

  test("session shutdown failure preserves the global collaboration guard", async () => {
    const globalRoot = globalThis as Record<PropertyKey, unknown>;
    delete globalRoot[COLLABORATION_GUARD];
    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    const pi = new Proxy({} as any, {
      get(_target, property) {
        if (property === "on")
          return (event: string, handler: (...args: any[]) => any) => {
            const registered = handlers.get(event) ?? [];
            registered.push(handler);
            handlers.set(event, registered);
          };
        if (property === "getActiveTools" || property === "getAllTools")
          return () => [];
        if (property === "getThinkingLevel") return () => "off";
        return () => undefined;
      },
    });
    const originalShutdown = CollaborationManager.prototype.shutdown;
    (CollaborationManager.prototype as any).shutdown = () =>
      Promise.reject(new Error("cleanup failed"));
    try {
      subagentsExtension(pi);
      const guard = globalRoot[COLLABORATION_GUARD];
      expect(guard).toBeDefined();
      const shutdown = handlers.get("session_shutdown")?.[0];
      expect(shutdown).toBeDefined();
      await expect(shutdown!()).rejects.toThrow("cleanup failed");
      expect(globalRoot[COLLABORATION_GUARD]).toBe(guard);
    } finally {
      (CollaborationManager.prototype as any).shutdown = originalShutdown;
      delete globalRoot[COLLABORATION_GUARD];
    }
  });
});
