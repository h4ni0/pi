import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { buildChildEnvironment } from "../../rpc-process.ts";
import { RootTreeBroker, type BrokerConnectionGrant } from "../../runtime/root-tree-broker.ts";
import {
  buildChildBrokerEnvironment,
  readChildBrokerBootstrapEnvironment,
} from "../../utils.ts";

interface Command {
  id: string;
  op: string;
  payload?: any;
}

interface Response {
  kind: "response";
  id: string;
  ok: boolean;
  result?: any;
  error?: string;
}

const mode = process.argv[2];
if (mode !== "root" && mode !== "child")
  throw new Error("fake Pi tree node requires root or child mode");

interface RetainedNode {
  id: string;
  taskName: string;
  path: string;
}

const selfFile = fileURLToPath(import.meta.url);
const owned = new Map<string, OwnedNode>();
const retained = new Map<string, RetainedNode>();
const broker = mode === "root"
  ? await RootTreeBroker.createRoot({
      identity: {
        id: "root_bootstrap",
        path: "/root",
        depth: 0,
        maxDepth: 2,
        connectionGeneration: 1,
      },
      maxResidentAgents: 6,
      maxActiveAgents: 6,
      dispatch: dispatchOwned,
    })
  : await connectChild();
const identity = mode === "root"
  ? {
      id: "root_bootstrap",
      path: "/root",
      depth: 0,
      maxDepth: 2,
      connectionGeneration: 1,
    }
  : readChildBrokerBootstrapEnvironment().identity;
const rootId = mode === "root"
  ? "root_bootstrap"
  : readChildBrokerBootstrapEnvironment().rootId;
let exitAfterResponse = false;
let shuttingDown = false;

write({
  kind: "ready",
  pid: process.pid,
  path: identity.path,
  socketPath: broker.endpoint?.socketPath,
});

const decoder = new StringDecoder("utf8");
let buffer = "";
let chain = Promise.resolve();
process.stdin.on("data", (chunk) => {
  buffer += decoder.write(chunk);
  while (true) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).replace(/\r$/, "");
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const command = JSON.parse(line) as Command;
    chain = chain.then(() => handleCommand(command), () => handleCommand(command));
  }
});
process.stdin.on("end", () => {
  void shutdown().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});

async function connectChild(): Promise<RootTreeBroker> {
  const bootstrap = readChildBrokerBootstrapEnvironment();
  return RootTreeBroker.connectChild({
    identity: bootstrap.identity,
    maxResidentAgents: bootstrap.maxResidentAgents,
    maxActiveAgents: bootstrap.maxActiveAgents,
    socketPath: bootstrap.socketPath,
    capability: bootstrap.capability,
    dispatch: dispatchOwned,
  });
}

async function dispatchOwned(message: any): Promise<any> {
  const targetPath = String(message?.payload?.targetPath ?? "");
  const metadata = retained.get(targetPath);
  if (message?.op === "prepare_unload") {
    if (!metadata || !owned.has(metadata.taskName))
      throw new Error("fake manager does not own the unload target");
    return {};
  }
  if (message?.op === "unload") {
    if (!metadata) throw new Error("fake manager has no retained unload metadata");
    const child = owned.get(metadata.taskName);
    if (!child) throw new Error("fake manager unload target is not resident");
    await child.stop();
    owned.delete(metadata.taskName);
    return {};
  }
  if (message?.op === "reload") {
    if (!metadata) throw new Error("fake manager has no retained reload metadata");
    if (owned.has(metadata.taskName))
      throw new Error("fake manager reload target is already resident");
    const grant = message.payload?.broker;
    const childEnv = buildChildBrokerEnvironment({
      identity: {
        id: metadata.id,
        path: metadata.path,
        parentId: identity.id,
        parentPath: identity.path,
        depth: identity.depth + 1,
        maxDepth: identity.maxDepth,
        connectionGeneration: Number(grant?.generation),
      },
      socketPath: String(grant?.socketPath ?? ""),
      capability: String(grant?.capability ?? ""),
      rootId,
      maxResidentAgents: 6,
      maxActiveAgents: 6,
    });
    owned.set(metadata.taskName, await OwnedNode.start(childEnv));
    return {};
  }
  if (message?.op === "deliver_mailbox")
    return { disposition: "accepted" };
  return {};
}

async function handleCommand(command: Command): Promise<void> {
  let response: Response;
  try {
    const result = await operation(command.op, command.payload);
    response = { kind: "response", id: command.id, ok: true, result };
  } catch (error) {
    response = {
      kind: "response",
      id: command.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  write(response, () => {
    if (exitAfterResponse) process.exit(response.ok ? 0 : 1);
  });
}

async function operation(op: string, payload: any): Promise<any> {
  switch (op) {
    case "spawn":
      return spawnOwned(String(payload?.taskName ?? ""), String(payload?.id ?? ""));
    case "child_command": {
      const child = owned.get(String(payload?.taskName ?? ""));
      if (!child) throw new Error("unknown owned fake Pi child");
      return child.request(String(payload?.op ?? ""), payload?.payload);
    }
    case "list":
      return broker.list();
    case "idle": {
      const metadata = [...retained.values()].find(
        (candidate) => candidate.taskName === String(payload?.taskName ?? ""),
      );
      if (!metadata || !owned.has(metadata.taskName))
        throw new Error("unknown resident fake Pi child");
      await broker.updateAgent(
        metadata.path,
        { active: false, status: { completed: null } },
        1,
      );
      return {};
    }
    case "set_capacity":
      return broker.setCapacities(
        Number(payload?.maxResidentAgents),
        Number(payload?.maxActiveAgents),
      );
    case "send":
      return broker.route(
        "send",
        String(payload?.target ?? ""),
        String(payload?.message ?? "message"),
      );
    case "pids": {
      const descendants = await Promise.all(
        [...owned.values()].map((child) => child.request("pids")),
      );
      return [process.pid, ...descendants.flat()];
    }
    case "shutdown":
      await shutdown();
      exitAfterResponse = true;
      return {};
    default:
      throw new Error(`unsupported fake Pi tree operation '${op}'`);
  }
}

async function spawnOwned(taskName: string, id: string): Promise<{
  path: string;
  pid: number;
}> {
  if (!taskName || !id) throw new Error("fake Pi child identity is required");
  if (owned.has(taskName)) throw new Error("fake Pi child task already exists");
  const grant = await broker.reserveChild({
    id,
    taskName,
    maxDepth: identity.maxDepth,
    lastTaskMessage: taskName,
    reloadable: true,
    transactional: true,
  });
  let child: OwnedNode | undefined;
  try {
    const childEnv = buildChildBrokerEnvironment({
      identity: {
        id,
        path: grant.path,
        parentId: identity.id,
        parentPath: identity.path,
        depth: identity.depth + 1,
        maxDepth: identity.maxDepth,
        connectionGeneration: grant.generation,
      },
      socketPath: broker.endpoint!.socketPath,
      capability: grant.capability,
      rootId,
      maxResidentAgents: 6,
      maxActiveAgents: 6,
    });
    child = await OwnedNode.start(childEnv);
    await broker.awaitChildRegistration(grant.path, grant.generation, 2_000);
    await broker.commitChildRegistration(grant.path, grant.generation);
    owned.set(taskName, child);
    retained.set(grant.path, { id, taskName, path: grant.path });
    return { path: grant.path, pid: child.pid };
  } catch (error) {
    await child?.stop().catch(() => undefined);
    await broker.abortChildRegistration(grant.path, grant.generation).catch(() => undefined);
    throw error;
  }
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const children = [...owned.values()];
  const results = await Promise.allSettled(children.map((child) => child.stop()));
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length > 0) {
    shuttingDown = false;
    throw new AggregateError(failures, "fake Pi descendant cleanup failed");
  }
  owned.clear();
  await broker.close();
}

class OwnedNode {
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

  private constructor(private readonly process: ChildProcessWithoutNullStreams) {
    this.exited = new Promise((resolve, reject) => {
      process.once("error", reject);
      process.once("close", (code, signal) => {
        const error = code === 0
          ? undefined
          : new Error(`fake Pi child exited with ${code ?? signal}`);
        for (const pending of this.pending.values())
          pending.reject(error ?? new Error("fake Pi child exited"));
        this.pending.clear();
        if (error) reject(error);
        else resolve();
      });
    });
    process.stdout.setEncoding("utf8");
    process.stdout.on("data", (chunk: string) => this.onData(chunk));
    process.stderr.setEncoding("utf8");
    let stderr = "";
    process.stderr.on("data", (chunk: string) => { stderr += chunk; });
    process.once("error", (error) => this.readyReject(error));
    process.once("close", (code) => {
      if (code !== 0) this.readyReject(new Error(stderr || `fake Pi child startup exited ${code}`));
    });
  }

  static async start(env: Record<string, string>): Promise<OwnedNode> {
    const child = spawn(process.execPath, [selfFile, "child"], {
      env: buildChildEnvironment(env, ["HOME", "PATH", "TMPDIR"]),
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    const node = new OwnedNode(child);
    await node.ready;
    return node;
  }

  get pid(): number {
    return this.process.pid!;
  }

  request(op: string, payload?: any): Promise<any> {
    const id = `node_${++this.nextId}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.process.stdin.write(`${JSON.stringify({ id, op, payload })}\n`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async stop(): Promise<void> {
    await this.request("shutdown");
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
      else pending.reject(new Error(String(message.error ?? "fake Pi child request failed")));
    }
  }
}

function write(value: unknown, callback?: () => void): void {
  process.stdout.write(`${JSON.stringify(value)}\n`, callback);
}
