import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  RpcProcess,
  RpcRequestTimeoutError,
  attachJsonlReader,
  type RpcSpawnProcess,
} from "../rpc-process.ts";
import { BROKER_FRAME_MAX_BYTES } from "../constants.ts";
import {
  encodeLifecycleMarker,
  lifecycleEventFingerprint,
  LIFECYCLE_STATUS_KEY,
} from "../runtime/lifecycle-protocol.ts";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/fake-rpc-child.mjs",
);
const processes: RpcProcess[] = [];

function realProcess(
  env: Record<string, string | undefined> = {},
  options: Record<string, unknown> = {},
): RpcProcess {
  const client = new RpcProcess(process.execPath, [fixture], {
    cwd: process.cwd(),
    env,
    startupTimeoutMs: 1_000,
    requestTimeoutMs: 250,
    shutdownTimeoutMs: 120,
    drainTimeoutMs: 300,
    ...options,
  });
  processes.push(client);
  return client;
}

afterEach(async () => {
  await Promise.allSettled(processes.splice(0).map((client) => client.stop()));
});

function writeLifecyclePair(
  control: MockControl,
  event: Record<string, unknown>,
  token: string,
  sequence: number,
  completionEventId?: string,
): void {
  control.child.stdout.write(`${JSON.stringify({
    type: "extension_ui_request",
    method: "setStatus",
    statusKey: LIFECYCLE_STATUS_KEY,
    statusText: encodeLifecycleMarker({
      v: 2,
      token,
      event: String(event.type),
      sequence,
      fingerprint: lifecycleEventFingerprint(event),
      ...(completionEventId ? { completionEventId } : {}),
    }),
  })}\n`);
  control.child.stdout.write(`${JSON.stringify(event)}\n`);
}

function collectEvents(client: RpcProcess): any[] {
  const events: any[] = [];
  client.onEvent((event) => events.push(event));
  return events;
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("waitUntil timed out");
    await Bun.sleep(5);
  }
}

interface MockControl {
  child: any;
  failWrites: boolean;
  signals: NodeJS.Signals[];
}

function mockSpawn(
  mode: "normal" | "sigkill" | "survive" | "close-only" = "normal",
): {
  spawnProcess: RpcSpawnProcess;
  control: MockControl;
} {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter() as any;
  const control: MockControl = { child, failWrites: false, signals: [] };
  let input = "";
  const stdin = new EventEmitter() as any;
  stdin.writable = true;
  stdin.write = (chunk: Buffer | string, callback?: (error?: Error | null) => void) => {
    if (control.failWrites) {
      queueMicrotask(() =>
        callback?.(Object.assign(new Error("mock EPIPE"), { code: "EPIPE" })),
      );
      return false;
    }
    input += chunk.toString();
    while (input.includes("\n")) {
      const index = input.indexOf("\n");
      const line = input.slice(0, index);
      input = input.slice(index + 1);
      if (!line) continue;
      const command = JSON.parse(line);
      if (command.type === "get_state") {
        stdout.write(
          `${JSON.stringify({
            type: "response",
            id: command.id,
            success: true,
            data: { isStreaming: false, sessionId: "mock" },
          })}\n`,
        );
      } else if (command.type !== "prompt" || command.message !== "__stall__") {
        stdout.write(
          `${JSON.stringify({ type: "response", id: command.id, success: true })}\n`,
        );
      }
    }
    queueMicrotask(() => callback?.(null));
    return true;
  };
  Object.assign(child, {
    pid: 98_765,
    stdin,
    stdout,
    stderr,
    exitCode: null,
    signalCode: null,
    kill(signal: NodeJS.Signals) {
      control.signals.push(signal);
      if (mode === "survive" || (mode === "sigkill" && signal === "SIGTERM"))
        return true;
      queueMicrotask(() => {
        stdout.end();
        stderr.end();
        if (mode === "close-only") {
          child.emit("close", 0, null);
          return;
        }
        child.signalCode = signal;
        child.emit("exit", null, signal);
        child.emit("close", null, signal);
      });
      return true;
    },
  });
  return {
    control,
    spawnProcess: (() => child) as RpcSpawnProcess,
  };
}

describe("attachJsonlReader", () => {
  test("flushes fragmented Unicode JSONL exactly once on close", async () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    let drains = 0;
    const stop = attachJsonlReader(
      stream,
      (line) => lines.push(line),
      undefined,
      1_024,
      () => drains++,
    );
    const bytes = Buffer.from('{"text":"✓"}');
    stream.write(bytes.subarray(0, bytes.length - 2));
    stream.write(bytes.subarray(bytes.length - 2));
    stream.emit("close");
    stream.emit("end");
    expect(lines).toEqual(['{"text":"✓"}']);
    expect(drains).toBe(1);
    stop();
    expect(stream.listenerCount("data")).toBe(0);
    expect(stream.listenerCount("end")).toBe(0);
    expect(stream.listenerCount("close")).toBe(0);
    expect(stream.listenerCount("error")).toBe(0);
  });

  test("accepts Pi lifecycle records larger than the broker frame limit", () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    const errors: Error[] = [];
    const stop = attachJsonlReader(
      stream,
      (line) => lines.push(line),
      (error) => errors.push(error),
    );
    const line = JSON.stringify({
      type: "agent_end",
      messages: ["x".repeat(BROKER_FRAME_MAX_BYTES + 1)],
    });
    stream.end(`${line}\n`);
    expect(errors).toEqual([]);
    expect(lines).toEqual([line]);
    stop();
  });
});

describe("RpcProcess transport and OS invariants", () => {
  test("pairs child lifecycle markers with raw events before exposing them", async () => {
    const { spawnProcess, control } = mockSpawn();
    const client = new RpcProcess("mock", [], {
      cwd: process.cwd(),
      env: {},
      spawnProcess,
    });
    processes.push(client);
    const events = collectEvents(client);
    await client.start();
    await client.prompt("work", "sa_test.7");
    const rawEvent = { type: "agent_start" };
    control.child.stdout.write(`${JSON.stringify({
      type: "extension_ui_request",
      method: "setStatus",
      statusKey: LIFECYCLE_STATUS_KEY,
      statusText: encodeLifecycleMarker({
        v: 2,
        token: "sa_test.7",
        event: "agent_start",
        sequence: 1,
        fingerprint: lifecycleEventFingerprint(rawEvent),
      }),
    })}\n`);
    expect(events.some((event) => event.type === "agent_start")).toBe(false);
    control.child.stdout.write(`${JSON.stringify(rawEvent)}\n`);
    await waitUntil(() => events.some((event) => event.type === "agent_start"));
    expect(events.find((event) => event.type === "agent_start")).toMatchObject({
      turn_token: "sa_test.7",
      turn_sequence: 1,
    });
    expect(events.some((event) => event.statusKey === LIFECYCLE_STATUS_KEY)).toBe(false);
    const completionEventId = "completion_0123456789abcdef0123456789abcdef";
    writeLifecyclePair(
      control,
      { type: "agent_settled" },
      "sa_test.7",
      2,
      completionEventId,
    );
    await waitUntil(() => events.some((event) => event.type === "agent_settled"));
    expect(events.find((event) => event.type === "agent_settled"))
      .toMatchObject({ completion_event_id: completionEventId });
  });

  test("fails closed when a bare lifecycle event never receives a child marker", async () => {
    const { spawnProcess, control } = mockSpawn();
    const client = new RpcProcess("mock", [], {
      cwd: process.cwd(),
      env: {},
      requestTimeoutMs: 100,
      spawnProcess,
    });
    processes.push(client);
    const events = collectEvents(client);
    await client.start();
    await client.prompt("work", "sa_test.8");
    control.child.stdout.write(`${JSON.stringify({ type: "agent_start" })}\n`);
    await waitUntil(() => events.some((event) => event.type === "rpc_protocol_error"));
    expect(events.some((event) => event.type === "agent_start")).toBe(false);
    expect(events.find((event) => event.type === "rpc_protocol_error")?.error)
      .toContain("no preceding lifecycle marker");
  });

  test("quarantines bounded closed-token replay while a newer token remains active", async () => {
    const { spawnProcess, control } = mockSpawn();
    const client = new RpcProcess("mock", [], {
      cwd: process.cwd(),
      env: {},
      spawnProcess,
    });
    processes.push(client);
    const events = collectEvents(client);
    await client.start();
    await client.prompt("first", "sa_test.1");
    writeLifecyclePair(control, { type: "agent_start" }, "sa_test.1", 1);
    writeLifecyclePair(control, { type: "agent_settled" }, "sa_test.1", 2);
    await client.prompt("second", "sa_test.2");
    writeLifecyclePair(control, { type: "agent_start" }, "sa_test.2", 1);
    writeLifecyclePair(control, { type: "agent_settled" }, "sa_test.1", 2);
    expect(events.filter((event) => event.turn_token === "sa_test.1" && event.type === "agent_settled"))
      .toHaveLength(1);
    expect(events.some((event) => event.type === "rpc_protocol_error")).toBe(false);
    writeLifecyclePair(control, { type: "agent_settled" }, "sa_test.2", 2);
    await waitUntil(() => events.some(
      (event) => event.turn_token === "sa_test.2" && event.type === "agent_settled",
    ));
  });

  test("fails closed on a second marker or mismatched event identity", async () => {
    for (const mode of ["second-marker", "fingerprint"] as const) {
      const { spawnProcess, control } = mockSpawn();
      const client = new RpcProcess("mock", [], {
        cwd: process.cwd(),
        env: {},
        spawnProcess,
      });
      processes.push(client);
      const events = collectEvents(client);
      await client.start();
      await client.prompt("work", `sa_${mode}.1`);
      const token = `sa_${mode}.1`;
      const marker = (event: Record<string, unknown>, sequence: number) =>
        control.child.stdout.write(`${JSON.stringify({
          type: "extension_ui_request",
          method: "setStatus",
          statusKey: LIFECYCLE_STATUS_KEY,
          statusText: encodeLifecycleMarker({
            v: 2,
            token,
            event: String(event.type),
            sequence,
            fingerprint: lifecycleEventFingerprint(event),
          }),
        })}\n`);
      marker({ type: "agent_start" }, 1);
      if (mode === "second-marker") marker({ type: "agent_start" }, 2);
      else control.child.stdout.write(`${JSON.stringify({ type: "agent_settled" })}\n`);
      await waitUntil(() => events.some((event) => event.type === "rpc_protocol_error"));
      expect(events.some((event) => event.turn_token === token)).toBe(false);
    }
  });

  test("returns request correlation and marks timeout acceptance unknown", async () => {
    const client = realProcess({}, { requestTimeoutMs: 35 });
    await client.start();
    const accepted = await client.prompt("accepted");
    expect(accepted.commandType).toBe("prompt");
    expect(accepted.requestId).toMatch(/^req_\d+$/);

    const abortAcceptance = await client.abort();
    expect(abortAcceptance.commandType).toBe("abort");
    expect(abortAcceptance.requestId).toMatch(/^req_\d+$/);
    try {
      await client.prompt("__stall__");
      throw new Error("expected timeout");
    } catch (error) {
      expect(error).toBeInstanceOf(RpcRequestTimeoutError);
      expect((error as RpcRequestTimeoutError).acceptance).toBe("unknown");
      expect((error as RpcRequestTimeoutError).requestId).toMatch(/^req_\d+$/);
    }
  });

  test("recognizes external SIGTERM, emits one terminal event, and stop clears transport", async () => {
    const client = realProcess();
    const events = collectEvents(client);
    await client.start();
    const pid = client.pid!;
    process.kill(pid, "SIGTERM");
    await waitUntil(() => events.some((event) => event.type === "process_exit"));
    await client.stop();
    expect(events.filter((event) => event.type === "process_exit")).toHaveLength(1);
    expect(events.find((event) => event.type === "process_exit")).toBeDefined();
    expect(client.pid).toBeUndefined();
    expect(client.exited).toBe(true);
  });

  test("drains response, final assistant event, and settlement before process_exit", async () => {
    const client = realProcess();
    const events = collectEvents(client);
    await client.start();
    const accepted = await client.prompt("__tail_exit__");
    expect(accepted.commandType).toBe("prompt");
    await waitUntil(() => events.some((event) => event.type === "process_exit"));
    const types = events.map((event) => event.type);
    expect(types).toContain("message_end");
    expect(types).toContain("agent_settled");
    expect(types.indexOf("message_end")).toBeLessThan(types.indexOf("process_exit"));
    expect(types.indexOf("agent_settled")).toBeLessThan(types.indexOf("process_exit"));
    expect(events.find((event) => event.type === "message_end").message.content[0].text)
      .toContain("tail before exit");
  });

  test("tracked EPIPE causes one failure and rejects every pending request once", async () => {
    const { spawnProcess, control } = mockSpawn();
    const client = realProcess({}, { spawnProcess, requestTimeoutMs: 2_000 });
    const events = collectEvents(client);
    await client.start();
    const stalled = client.prompt("__stall__");
    const stalledResult = stalled.then(
      () => undefined,
      (error) => error as Error,
    );
    control.failWrites = true;
    const failed = client.prompt("write fails");
    const failedResult = failed.then(
      () => undefined,
      (error) => error as Error,
    );
    const [stalledError, failedError] = await Promise.all([
      stalledResult,
      failedResult,
    ]);
    expect(stalledError?.message).toContain("EPIPE");
    expect(failedError?.message).toContain("EPIPE");
    await waitUntil(() =>
      events.some((event) => event.type === "process_stdin_error"),
    );
    expect(
      events.filter((event) => event.type === "process_stdin_error"),
    ).toHaveLength(1);
  });

  test("untracked UI-cancel EPIPE fails transport once and rejects pending", async () => {
    const { spawnProcess, control } = mockSpawn();
    const client = realProcess({}, { spawnProcess, requestTimeoutMs: 2_000 });
    const events = collectEvents(client);
    await client.start();
    const stalled = client.prompt("__stall__");
    control.failWrites = true;
    control.child.stdout.write(
      `${JSON.stringify({
        type: "extension_ui_request",
        id: "dialog-fail",
        method: "confirm",
      })}\n`,
    );
    await expect(stalled).rejects.toThrow("EPIPE");
    await waitUntil(() =>
      events.some((event) => event.type === "process_stdin_error"),
    );
    expect(
      events.filter((event) => event.type === "process_stdin_error"),
    ).toHaveLength(1);
  });

  test("parse and stdout errors each use the one-shot transport failure transition", async () => {
    const parseClient = realProcess();
    const parseEvents = collectEvents(parseClient);
    await parseClient.start();
    await parseClient.prompt("__invalid_json__");
    await waitUntil(() =>
      parseEvents.some((event) => event.type === "rpc_protocol_error"),
    );
    await expect(parseClient.getState()).rejects.toThrow("Invalid child JSONL");
    expect(
      parseEvents.filter((event) => event.type === "rpc_protocol_error"),
    ).toHaveLength(1);

    const { spawnProcess, control } = mockSpawn();
    const stdoutClient = realProcess({}, { spawnProcess, requestTimeoutMs: 2_000 });
    const stdoutEvents = collectEvents(stdoutClient);
    await stdoutClient.start();
    const pending = stdoutClient.prompt("__stall__");
    const pendingResult = pending.then(
      () => undefined,
      (error) => error as Error,
    );
    control.child.stdout.emit("error", new Error("mock stdout failure"));
    expect((await pendingResult)?.message).toContain("mock stdout failure");
    expect(
      stdoutEvents.filter((event) => event.type === "rpc_protocol_error"),
    ).toHaveLength(1);
  });

  test("late and unknown responses are bounded diagnostics, never response lifecycle events", async () => {
    const client = realProcess(
      { FAKE_LATE_RESPONSE_MS: "70" },
      { requestTimeoutMs: 25, tombstoneLimit: 2 },
    );
    const events = collectEvents(client);
    await client.start();
    await expect(client.prompt("__late_response__")).rejects.toThrow("unknown");
    await waitUntil(() =>
      events.some(
        (event) => event.type === "rpc_response_diagnostic" && event.late,
      ),
    );
    await client.prompt("__unknown_response__");
    await waitUntil(() =>
      events.some(
        (event) => event.type === "rpc_response_diagnostic" && !event.late,
      ),
    );
    for (let index = 0; index < 3; index++)
      await expect(client.prompt("__stall__")).rejects.toThrow("unknown");
    expect(events.some((event) => event.type === "response")).toBe(false);
    expect((client as any).tombstones.size).toBe(2);
  });

  test("rejects start after stop was requested", async () => {
    const client = realProcess();
    await client.stop();
    await expect(client.start()).rejects.toThrow("after stop was requested");
    expect(client.pid).toBeUndefined();
  });

  test("spawn error fails transport once and does not pretend error alone is termination", async () => {
    const client = new RpcProcess("ignored", [], {
      cwd: process.cwd(),
      env: {},
      startupTimeoutMs: 100,
      shutdownTimeoutMs: 20,
      spawnProcess: (() => {
        throw new Error("mock spawn failure");
      }) as RpcSpawnProcess,
    });
    const events = collectEvents(client);
    await expect(client.start()).rejects.toThrow("mock spawn failure");
    expect(events.filter((event) => event.type === "process_error")).toHaveLength(1);
    expect(client.pid).toBeUndefined();
  });

  test("handles Node's asynchronous spawn error followed by close", async () => {
    const missing = path.join(
      process.cwd(),
      `.missing-rpc-command-${process.pid}-${Date.now()}`,
    );
    const client = new RpcProcess(missing, [], {
      cwd: process.cwd(),
      env: {},
      startupTimeoutMs: 100,
      shutdownTimeoutMs: 50,
    });
    processes.push(client);
    const events = collectEvents(client);
    await expect(client.start()).rejects.toThrow(/process error|ENOENT|not writable/);
    await waitUntil(() => events.some((event) => event.type === "process_exit"));
    expect(events.filter((event) => event.type === "process_error")).toHaveLength(1);
    expect(events.filter((event) => event.type === "process_exit")).toHaveLength(1);
    expect(client.pid).toBeUndefined();
  });

  test("treats close as confirmed termination even without exit or signal fields", async () => {
    const { spawnProcess } = mockSpawn("close-only");
    const client = realProcess({}, { spawnProcess });
    const events = collectEvents(client);
    await client.start();
    await client.stop();
    expect(events.filter((event) => event.type === "process_exit")).toHaveLength(1);
    expect(events.find((event) => event.type === "process_exit")?.code).toBe(0);
    expect(client.pid).toBeUndefined();
  });

  test("hard-tears the owned tree after the RPC child ignores SIGTERM", async () => {
    const client = realProcess({ FAKE_IGNORE_SIGTERM: "1" });
    const events = collectEvents(client);
    await client.start();
    await client.stop();
    expect(events.some((event) => event.type === "fake_signal")).toBe(true);
    expect(events.find((event) => event.type === "process_exit")?.signal).toBe(
      "SIGKILL",
    );
    expect(client.pid).toBeUndefined();
  });

  test("terminates the owned process group including a signal-ignoring tool child", async () => {
    if (process.platform === "win32") return;
    const pidFile = path.join(
      os.tmpdir(),
      `subagents-grandchild-${process.pid}-${Date.now()}.pid`,
    );
    try {
      const client = realProcess({
        FAKE_GRANDCHILD_PID_FILE: pidFile,
        FAKE_GRANDCHILD_DETACHED: "1",
      });
      await client.start();
      await waitUntil(() => fs.existsSync(pidFile));
      const grandchildPid = Number(fs.readFileSync(pidFile, "utf8"));
      expect(Number.isSafeInteger(grandchildPid)).toBe(true);
      await client.stop();
      expect(() => process.kill(grandchildPid, 0)).toThrow();
    } finally {
      fs.rmSync(pidFile, { force: true });
    }
  });

  test("reaps a reparented same-group child after the RPC leader exits first", async () => {
    if (process.platform !== "linux") return;
    const pidFile = path.join(
      os.tmpdir(),
      `subagents-orphan-${process.pid}-${Date.now()}.pid`,
    );
    let grandchildPid = 0;
    try {
      const client = realProcess({ FAKE_GRANDCHILD_PID_FILE: pidFile });
      await client.start();
      await waitUntil(() => fs.existsSync(pidFile));
      grandchildPid = Number(fs.readFileSync(pidFile, "utf8"));
      process.kill(client.pid!, "SIGKILL");
      await waitUntil(() => client.exited);
      await client.stop();
      await waitUntil(() => {
        try {
          process.kill(grandchildPid, 0);
          return false;
        } catch {
          return true;
        }
      });
    } finally {
      if (grandchildPid > 1) {
        try { process.kill(grandchildPid, "SIGKILL"); } catch { /* already gone */ }
      }
      fs.rmSync(pidFile, { force: true });
    }
  });

  test("acquires a delegated systemd scope from a non-delegated login session", async () => {
    if (process.platform !== "linux" || !fs.existsSync("/usr/bin/systemd-run")) return;
    const client = realProcess({}, {
      forceSystemdScope: true,
      startupTimeoutMs: 3_000,
      shutdownTimeoutMs: 500,
    });
    await client.start();
    const cgroupPath = (client as any).ownedCgroupPath as string;
    expect((client as any).ownedCgroupManagedExternally).toBe(true);
    expect(path.basename(cgroupPath)).toMatch(/^pi-subagent-rpc-.*\.scope$/);
    await client.stop();
    expect((client as any).ownedCgroupPath).toBeUndefined();
  });

  test("sandbox prevents the same-UID RPC child from escaping its owned cgroup", async () => {
    if (process.platform !== "linux") return;
    const resultFile = path.join(
      os.tmpdir(),
      `subagents-cgroup-escape-${process.pid}-${Date.now()}.txt`,
    );
    try {
      const client = realProcess({ FAKE_GRANDCHILD_PID_FILE: resultFile });
      await client.start();
      await client.prompt("__attempt_cgroup_escape__");
      await waitUntil(() => fs.existsSync(resultFile));
      expect(fs.readFileSync(resultFile, "utf8")).toBe("blocked");
      await client.stop();
    } finally {
      fs.rmSync(resultFile, { force: true });
    }
  });

  test("permits a real nested RPC tree only inside the owned cgroup subtree", async () => {
    if (process.platform !== "linux") return;
    const client = realProcess();
    const events = collectEvents(client);
    await client.start();
    await client.prompt("__spawn_nested_rpc__");
    await waitUntil(() => events.some((event) => event.type === "agent_settled"));
    await client.stop();
  });

  test("cgroup ownership reaps a descendant that detaches after startup", async () => {
    if (process.platform !== "linux") return;
    const pidFile = path.join(
      os.tmpdir(),
      `subagents-late-detached-${process.pid}-${Date.now()}.pid`,
    );
    let descendantPid = 0;
    try {
      const client = realProcess({ FAKE_GRANDCHILD_PID_FILE: pidFile });
      await client.start();
      await client.prompt("__detached_after_start__");
      await waitUntil(() => fs.existsSync(pidFile));
      descendantPid = Number(fs.readFileSync(pidFile, "utf8"));
      await waitUntil(() => client.exited);
      await client.stop();
      await waitUntil(() => {
        try {
          process.kill(descendantPid, 0);
          return false;
        } catch {
          return true;
        }
      });
    } finally {
      if (descendantPid > 1) {
        try { process.kill(descendantPid, "SIGKILL"); } catch { /* already gone */ }
      }
      fs.rmSync(pidFile, { force: true });
    }
  });

  test("removes empty nested owned cgroups before releasing the retained handle", async () => {
    if (process.platform !== "linux") return;
    const client = realProcess();
    await client.start();
    const cgroupPath = (client as any).ownedCgroupPath as string;
    expect(cgroupPath).toBeTruthy();
    fs.mkdirSync(path.join(cgroupPath, "nested"));
    await client.stop();
    expect(fs.existsSync(cgroupPath)).toBe(false);
    expect((client as any).ownedCgroupPath).toBeUndefined();
  });

  test("surviving process rejects stop, preserves PID, then cleans up after late termination", async () => {
    const { spawnProcess, control } = mockSpawn("survive");
    const client = realProcess({}, { spawnProcess, shutdownTimeoutMs: 15 });
    await client.start();
    control.child.emit("error", new Error("transport only"));
    expect(client.exited).toBe(false);
    expect(client.pid).toBe(98_765);
    const first = client.stop();
    const second = client.stop();
    expect(second).toBe(first);
    await expect(first).rejects.toThrow("did not terminate after SIGKILL");
    expect(control.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(client.pid).toBe(98_765);
    expect(control.child.listenerCount("exit")).toBe(1);
    expect(control.child.listenerCount("close")).toBe(1);

    control.child.signalCode = "SIGKILL";
    control.child.stdout.end();
    control.child.stderr.end();
    control.child.emit("exit", null, "SIGKILL");
    control.child.emit("close", null, "SIGKILL");
    await waitUntil(() => client.pid === undefined);
    expect(control.child.listenerCount("exit")).toBe(0);
    expect(control.child.listenerCount("close")).toBe(0);
  });

  test("auto-cancels dialogs and bounds remembered UI request IDs", async () => {
    const client = realProcess({ FAKE_DIALOG: "1" }, { uiCancelLimit: 2 });
    const events = collectEvents(client);
    await client.start();
    await waitUntil(() =>
      events.some((event) => event.type === "fake_ui_cancelled"),
    );
    const cancelled = events.find((event) => event.type === "fake_ui_cancelled");
    expect(cancelled).toMatchObject({ id: "dialog-1", cancelled: true });
    await waitUntil(() => !(client as any).uiCancelWriteActive);
    expect(Array.from((client as any).uiCancelIds)).toEqual(["dialog-1"]);
    expect((client as any).uiCancelQueue).toHaveLength(0);
  });

  test("bounds UI-cancel writes under child backpressure", async () => {
    const { spawnProcess, control } = mockSpawn();
    const client = realProcess({}, { spawnProcess, uiCancelLimit: 2 });
    await client.start();
    let writes = 0;
    control.child.stdin.write = () => {
      writes += 1;
      return false;
    };
    for (let index = 0; index < 10; index++)
      (client as any).handleLine(
        JSON.stringify({
          type: "extension_ui_request",
          id: `blocked-dialog-${index}`,
          method: "confirm",
        }),
      );
    expect(writes).toBe(1);
    expect((client as any).uiCancelWriteActive).toBe(true);
    expect((client as any).uiCancelQueue).toHaveLength(1);
    expect((client as any).uiCancelIds.size).toBe(2);
    await client.stop();
    expect((client as any).uiCancelWriteActive).toBe(false);
    expect((client as any).uiCancelQueue).toHaveLength(0);
  });

  test("parses fragmented Unicode JSONL and cleans every owned listener", async () => {
    const { spawnProcess, control } = mockSpawn();
    const client = realProcess({}, { spawnProcess });
    await client.start();
    const accepted = await client.prompt("normal");
    expect(accepted.commandType).toBe("prompt");
    await client.stop();
    expect(control.child.listenerCount("exit")).toBe(0);
    expect(control.child.listenerCount("close")).toBe(0);
    expect(control.child.listenerCount("error")).toBe(0);
    expect(control.child.stdin.listenerCount("error")).toBe(0);
    expect(control.child.stdout.listenerCount("data")).toBe(0);
    expect(control.child.stdout.listenerCount("end")).toBe(0);
    expect(control.child.stdout.listenerCount("close")).toBe(0);
    expect(control.child.stdout.listenerCount("error")).toBe(0);
    expect(control.child.stderr.listenerCount("data")).toBe(0);
    expect(client.pid).toBeUndefined();
  });

  test("bounds pending requests and stderr while honoring the environment allowlist", async () => {
    const previousAllowed = process.env.FAKE_ALLOWED;
    const previousDenied = process.env.FAKE_DENIED;
    process.env.FAKE_ALLOWED = "yes";
    process.env.FAKE_DENIED = "secret";
    try {
      const client = realProcess(
        { PI_SUBAGENT_TEST: "subagent", FAKE_STDERR: "1" },
        {
          envAllowlist: ["PATH", "FAKE_ALLOWED"],
          pendingRequestLimit: 1,
          stderrTailMaxBytes: 8,
        },
      );
      await client.start();
      const environment = (await (client as any).send({ type: "get_env" })).response
        .data;
      expect(environment).toEqual({ allowed: "yes", subagent: "subagent" });
      await waitUntil(() => client.getStderr().includes("tail"));
      expect(Buffer.byteLength(client.getStderr(), "utf8")).toBeLessThanOrEqual(8);
      expect(client.getStderr()).toBe("-✓tail");
      const stalled = client.prompt("__stall__");
      await expect(client.getState()).rejects.toThrow("pending request limit 1");
      await expect(stalled).rejects.toThrow("unknown");
    } finally {
      if (previousAllowed === undefined) delete process.env.FAKE_ALLOWED;
      else process.env.FAKE_ALLOWED = previousAllowed;
      if (previousDenied === undefined) delete process.env.FAKE_DENIED;
      else process.env.FAKE_DENIED = previousDenied;
    }
  });
});
