import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { buildChildEnvironment } from "../rpc-process.ts";
import { CompletionDedupeLedger } from "../runtime/completion-dedupe.ts";
import {
  completionOutboxDirectory,
  SelfTurnReporter,
  stableCompletionEventId,
} from "../runtime/self-turn-reporter.ts";
import { RootTreeBroker } from "../runtime/root-tree-broker.ts";
import { createSubagentRuntimeState } from "../runtime/state.ts";
import { DEFAULT_SETTINGS } from "../settings.ts";

const dirs: string[] = [];
const brokers: RootTreeBroker[] = [];
const reporters: SelfTurnReporter[] = [];
afterEach(async () => {
  await Promise.allSettled(reporters.splice(0).map((reporter) => reporter.stop()));
  await Promise.allSettled(brokers.splice(0).map((broker) => broker.close()));
  const ownedDirs = dirs.splice(0);
  for (const dir of ownedDirs) fs.rmSync(dir, { recursive: true, force: true });
  await Bun.sleep(0);
  for (const dir of ownedDirs) expect(fs.existsSync(dir)).toBe(false);
});

function trackedReporter(state: ReturnType<typeof createSubagentRuntimeState>): SelfTurnReporter {
  const reporter = new SelfTurnReporter(state);
  reporters.push(reporter);
  return reporter;
}

function brokerCompletionIdentity(agentId: string, agentPath: string, epoch: number) {
  const turnId = `${agentId}.${epoch}`;
  return {
    eventId: stableCompletionEventId(agentPath, turnId),
    details: { turn_id: turnId },
  };
}

function reporterHarness(deliver: (input: any) => Promise<any>) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-completion-outbox-"));
  dirs.push(cwd);
  const session = SessionManager.inMemory(cwd);
  const state = createSubagentRuntimeState({
    pi: {} as any,
    settings: {
      ...DEFAULT_SETTINGS,
      sessionDir: cwd,
      completionMessageMaxBytes: 4_000,
      completionBurstMaxBytes: 8_000,
      completionOutboxLimit: 4,
    },
    currentDepth: 1,
    envMaxDepth: 2,
    extensionPath: "/extension/index.ts",
    currentPath: "/root/child",
    guardToken: {},
    invocationBase: { command: "/trusted/pi", prefixArgs: [] },
  });
  state.broker = { deliverCompletion: deliver } as any;
  const reporter = trackedReporter(state);
  const ctx = { sessionManager: session } as any;
  return { cwd, state, reporter, ctx };
}

describe("child-self completion outbox", () => {
  test("isolates in-memory/sessionless artifacts beneath the configured agent root", () => {
    const first = reporterHarness(async () => ({ accepted: true, observed: true }));
    const second = reporterHarness(async () => ({ accepted: true, observed: true }));
    const firstDir = completionOutboxDirectory(first.state, first.ctx);
    const secondDir = completionOutboxDirectory(second.state, second.ctx);
    expect(path.isAbsolute(firstDir)).toBe(true);
    expect(path.isAbsolute(secondDir)).toBe(true);
    expect(firstDir.startsWith(`${first.cwd}${path.sep}`)).toBe(true);
    expect(secondDir.startsWith(`${second.cwd}${path.sep}`)).toBe(true);
    expect(firstDir).not.toBe(secondDir);
    expect(firstDir).not.toBe(path.join(process.cwd(), "completion-outbox"));
  });

  test("keeps ten concurrent process writers isolated with identical lifecycle tokens", async () => {
    const fixture = path.join(
      process.cwd(),
      "extensions/subagents/tests/fixtures/completion-outbox-worker.ts",
    );
    const roots = Array.from({ length: 10 }, (_, index) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-outbox-worker-${index}-`));
      dirs.push(root);
      return root;
    });
    const results = await Promise.all(roots.map(async (root, index) => {
      const child = Bun.spawn(["bun", fixture, root, `output-${index}`], {
        env: buildChildEnvironment({}, ["HOME", "PATH", "TMPDIR"]),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (exitCode !== 0) throw new Error(stderr);
      return JSON.parse(stdout.trim());
    }));
    expect(new Set(results.map((result) => result.artifactPath)).size).toBe(10);
    for (const [index, result] of results.entries()) {
      expect(fs.readFileSync(result.artifactPath, "utf8")).toBe(`output-${index}`);
      expect(result.artifactPath.startsWith(`${roots[index]}${path.sep}`)).toBe(true);
    }
  });

  test("intermediate output is overwritten by completed-empty final and artifact is empty", async () => {
    let delivered: any;
    const { reporter, ctx } = reporterHarness(async (input) => {
      delivered = input;
      return { accepted: true, observed: true };
    });
    reporter.captureMessage("child.1", {
      role: "assistant",
      content: [{ type: "text", text: "intermediate" }],
      stopReason: "stop",
    });
    reporter.captureMessage("child.1", {
      role: "assistant",
      content: [],
      stopReason: "stop",
    });
    reporter.captureAgentEnd("child.1", { willRetry: false });
    await reporter.settled("child.1", ctx);
    const event = reporter.snapshot()[0]!;
    expect(event.stage).toBe("observed");
    expect(event.output).toBe("");
    expect(event.payload).toBe("");
    expect(fs.readFileSync(event.artifactPath, "utf8")).toBe("");
    expect(delivered.content).toBe(
      "Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/child\nPayload:\n",
    );
  });

  test("error-then-success retry uses fresh success and later error has exact canonical payload", async () => {
    const delivered: any[] = [];
    const { reporter, ctx } = reporterHarness(async (input) => {
      delivered.push(input);
      return { accepted: true, observed: true };
    });
    reporter.captureMessage("child.1", {
      role: "assistant", content: [], stopReason: "error", errorMessage: "transient",
    });
    reporter.captureAgentEnd("child.1", { willRetry: true });
    reporter.captureMessage("child.1", {
      role: "assistant", content: [{ type: "text", text: "recovered" }], stopReason: "stop",
    });
    reporter.captureAgentEnd("child.1", { willRetry: false });
    await reporter.settled("child.1", ctx);
    expect(delivered[0].content.endsWith("Payload:\nrecovered")).toBe(true);

    reporter.captureMessage("child.2", {
      role: "assistant", content: [{ type: "text", text: "partial output" }],
      stopReason: "error", errorMessage: "final failure",
    });
    reporter.captureAgentEnd("child.2", { willRetry: false });
    await reporter.settled("child.2", ctx);
    expect(reporter.snapshot().at(-1)?.payload).toBe(
      "Agent errored: final failure\n\nThis agent's turn failed. If you still need this agent, use the available collaboration tools to give it another task.",
    );
    expect(fs.readFileSync(reporter.snapshot().at(-1)!.artifactPath, "utf8"))
      .toBe("partial output");

    reporter.captureMessage("child.3", {
      role: "assistant",
      content: [{ type: "text", text: "text before extension failure" }],
      stopReason: "stop",
    });
    reporter.captureExtensionError("child.3", { error: "extension exploded" });
    reporter.captureAgentEnd("child.3", { willRetry: false });
    await reporter.settled("child.3", ctx);
    expect(reporter.snapshot().at(-1)).toMatchObject({
      outcome: "errored",
      error: "extension exploded",
    });
    expect(delivered.at(-1).content).toContain("Agent errored: extension exploded");
  });

  test("failed insertion retries the stable immutable event and interrupted turns emit none", async () => {
    const attempts: any[] = [];
    const { reporter, ctx } = reporterHarness(async (input) => {
      attempts.push(input);
      if (attempts.length === 1) throw new Error("insertion failed");
      return { accepted: true, observed: true };
    });
    reporter.captureAgentEnd("child.1", { willRetry: false });
    await expect(reporter.settled("child.1", ctx)).rejects.toThrow("insertion failed");
    expect(reporter.snapshot()[0]?.stage).toBe("injection_pending");
    await reporter.retryPending(ctx);
    expect(attempts).toHaveLength(2);
    expect(attempts[1].eventId).toBe(attempts[0].eventId);
    expect(reporter.snapshot()[0]?.stage).toBe("observed");

    await reporter.settled("child.2", ctx);
    expect(attempts).toHaveLength(2);
  });

  test("automatically retries a failed stable event without a new turn", async () => {
    const attempts: any[] = [];
    const { reporter, ctx } = reporterHarness(async (input) => {
      attempts.push(input);
      if (attempts.length === 1) throw new Error("transient broker failure");
      return { accepted: true, observed: true };
    });
    reporter.captureMessage("child.1", {
      role: "assistant", content: [{ type: "text", text: "eventual" }], stopReason: "stop",
    });
    reporter.captureAgentEnd("child.1", { willRetry: false });
    await expect(reporter.settled("child.1", ctx)).rejects.toThrow("transient");
    const deadline = Date.now() + 1_000;
    while (reporter.snapshot()[0]?.stage !== "observed") {
      if (Date.now() >= deadline) throw new Error("automatic completion retry timed out");
      await Bun.sleep(10);
    }
    expect(attempts).toHaveLength(2);
    expect(attempts[1].eventId).toBe(attempts[0].eventId);
    await reporter.stop();
  });

  test("serializes direct settlement and retry delivery so later finals cannot overtake", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const order: string[] = [];
    const { reporter, ctx } = reporterHarness(async (input) => {
      order.push(input.eventId);
      if (order.length === 1) await firstGate;
      return { accepted: true, observed: true };
    });
    const settle = (token: string, output: string) => {
      reporter.captureMessage(token, {
        role: "assistant", content: [{ type: "text", text: output }], stopReason: "stop",
      });
      reporter.captureAgentEnd(token, { willRetry: false });
      return reporter.settled(token, ctx);
    };
    const first = settle("child.1", "first");
    while (order.length === 0) await Bun.sleep(1);
    const second = settle("child.2", "second");
    const retry = reporter.retryPending(ctx);
    await Bun.sleep(20);
    expect(order).toHaveLength(1);
    releaseFirst();
    await Promise.all([first, second, retry]);
    expect(order).toEqual([
      stableCompletionEventId("/root/child", "child.1"),
      stableCompletionEventId("/root/child", "child.2"),
    ]);
  });

  test("uses the durable turn epoch as FIFO order when timestamps and hashes disagree", async () => {
    const order: string[] = [];
    const { state, reporter, ctx } = reporterHarness(async (input) => {
      order.push(input.details.turn_id);
      return { accepted: true, observed: true };
    });
    const realNow = Date.now;
    try {
      Date.now = () => 1_234_567_890_000;
      for (const token of ["child.1", "child.2", "child.3"]) {
        reporter.captureMessage(token, {
          role: "assistant",
          content: [{ type: "text", text: token }],
          stopReason: "stop",
        });
        reporter.captureAgentEnd(token, { willRetry: false });
        reporter.captureSettled(token, ctx);
      }
    } finally {
      Date.now = realNow;
    }
    expect(reporter.pendingEventIds()).toEqual(
      ["child.1", "child.2", "child.3"].map((token) =>
        stableCompletionEventId("/root/child", token)
      ),
    );

    await reporter.stop();
    const restarted = trackedReporter(state);
    expect(restarted.restorePending(ctx)).toBe(3);
    expect(restarted.snapshot().map((event) => event.lifecycleToken))
      .toEqual(["child.1", "child.2", "child.3"]);
    await restarted.retryPending(ctx);
    expect(order).toEqual(["child.1", "child.2", "child.3"]);
  });

  test("restores persisted injection_pending and retries its stable event ID", async () => {
    const attempts: any[] = [];
    const { state, reporter, ctx } = reporterHarness(async (input) => {
      attempts.push(input);
      throw new Error("broker unavailable");
    });
    reporter.captureMessage("child.7", {
      role: "assistant",
      content: [{ type: "text", text: "durable result" }],
      stopReason: "stop",
    });
    reporter.captureAgentEnd("child.7", { willRetry: false });
    await expect(reporter.settled("child.7", ctx)).rejects.toThrow("broker unavailable");
    const pending = reporter.snapshot()[0]!;
    expect(pending.stage).toBe("injection_pending");
    await reporter.stop();
    for (let index = 0; index < 300; index++)
      fs.writeFileSync(path.join(path.dirname(pending.artifactPath), `old-${index}.md`), "old");

    state.broker = {
      deliverCompletion: async (input: any) => {
        attempts.push(input);
        return { accepted: true, observed: true };
      },
    } as any;
    const restarted = trackedReporter(state);
    expect(restarted.restorePending(ctx)).toBe(1);
    expect(restarted.snapshot()[0]).toMatchObject({
      eventId: pending.eventId,
      lifecycleToken: "child.7",
      stage: "injection_pending",
    });
    await restarted.retryPending(ctx);
    expect(attempts).toHaveLength(2);
    expect(attempts[1].eventId).toBe(attempts[0].eventId);
    expect(restarted.snapshot()[0]?.stage).toBe("observed");
  });

  test("compacts legacy observed sidecars before restoring a later pending event", async () => {
    const harness = reporterHarness(async () => {
      throw new Error("offline");
    });
    const artifactDirectory = completionOutboxDirectory(harness.state, harness.ctx);
    const stateDirectory = path.join(artifactDirectory, "state");
    fs.mkdirSync(stateDirectory, { recursive: true });
    for (let index = 0; index < 300; index++) {
      const name = `completion_${index.toString(16).padStart(32, "0")}.md.json`;
      fs.writeFileSync(path.join(stateDirectory, name), '{"stage":"observed"}\n');
    }
    harness.reporter.captureMessage("child.1", {
      role: "assistant",
      content: [{ type: "text", text: "recover me" }],
      stopReason: "stop",
    });
    harness.reporter.captureAgentEnd("child.1", { willRetry: false });
    await expect(harness.reporter.settled("child.1", harness.ctx)).rejects.toThrow(
      "offline",
    );
    await harness.reporter.stop();

    const restored = trackedReporter(harness.state);
    expect(restored.restorePending(harness.ctx)).toBe(1);
    expect(restored.snapshot()[0]).toMatchObject({
      output: "recover me",
      stage: "injection_pending",
    });
    expect(
      fs.readdirSync(stateDirectory).filter((name) => name.endsWith(".json")),
    ).toHaveLength(1);
  });

  test("never evicts pending entries when the configured outbox limit is reached", async () => {
    const attempts: any[] = [];
    const { state, reporter, ctx } = reporterHarness(async (input) => {
      attempts.push(input);
      throw new Error("offline");
    });
    state.settings.completionOutboxLimit = 1;
    for (const token of ["child.1", "child.2"]) {
      reporter.captureMessage(token, {
        role: "assistant", content: [{ type: "text", text: token }], stopReason: "stop",
      });
      reporter.captureAgentEnd(token, { willRetry: false });
      await expect(reporter.settled(token, ctx)).rejects.toThrow("offline");
    }
    expect(reporter.pendingEventIds()).toHaveLength(2);
    expect(reporter.snapshot().filter((event) => event.stage === "injection_pending"))
      .toHaveLength(2);
    await reporter.stop();
  });

  test("large output is bounded in the envelope once while the artifact remains complete", async () => {
    let delivered: any;
    let pendingSidecarSize = 0;
    const { reporter, ctx } = reporterHarness(async (input) => {
      delivered = input;
      const artifactPath = input.details.output_path;
      const sidecarPath = path.join(
        path.dirname(artifactPath),
        "state",
        `${path.basename(artifactPath)}.json`,
      );
      pendingSidecarSize = fs.statSync(sidecarPath).size;
      return { accepted: true, observed: true };
    });
    const output = "x".repeat(20_000);
    reporter.captureMessage("child.1", {
      role: "assistant", content: [{ type: "text", text: output }], stopReason: "stop",
    });
    reporter.captureAgentEnd("child.1", { willRetry: false });
    await reporter.settled("child.1", ctx);
    const event = reporter.snapshot()[0]!;
    expect(Buffer.byteLength(delivered.content, "utf8")).toBeLessThanOrEqual(4_000);
    expect(Buffer.byteLength(delivered.details.output, "utf8")).toBeLessThanOrEqual(4_000);
    expect((delivered.content.match(/\[Full output:/g) ?? [])).toHaveLength(1);
    expect(fs.readFileSync(event.artifactPath, "utf8")).toBe(output);
    const sidecar = path.join(
      path.dirname(event.artifactPath),
      "state",
      `${path.basename(event.artifactPath)}.json`,
    );
    expect(pendingSidecarSize).toBeLessThan(128 * 1024);
    expect(fs.existsSync(sidecar)).toBe(false);
  });
});

describe("durable completion dedupe ledger", () => {
  test("compacts beyond 4096 turns without admitting old normal or crash replay", () => {
    const ledger = new CompletionDedupeLedger();
    for (let epoch = 1; epoch <= 10_000; epoch++) {
      const eventId = epoch % 7 === 0 ? `crash_child_${epoch}` : `completion_${epoch}`;
      expect(ledger.check("/root/child", epoch, eventId)).toBe("new");
      if (epoch % 7 === 0) ledger.acceptTerminal("/root/child", epoch, eventId);
      else {
        ledger.terminal("/root/child", epoch, eventId);
        ledger.accept("/root/child", epoch, eventId);
      }
    }
    expect(ledger.snapshot("/root/child")).toEqual({
      contiguousThrough: 10_000,
      rangeCount: 0,
      pendingCount: 0,
    });
    expect(ledger.check("/root/child", 1, "completion_1")).toBe("duplicate");
    expect(ledger.check("/root/child", 7, "crash_child_7")).toBe("duplicate");
  });

  test("retains compact out-of-order acceptance until an older durable gap resolves", () => {
    const ledger = new CompletionDedupeLedger();
    ledger.terminal("/root/child", 1, "completion_1");
    for (let epoch = 2; epoch <= 5_000; epoch++)
      ledger.acceptTerminal("/root/child", epoch, `crash_child_${epoch}`);
    expect(ledger.snapshot("/root/child").rangeCount).toBe(1);
    ledger.accept("/root/child", 1, "completion_1");
    expect(ledger.snapshot("/root/child")).toEqual({
      contiguousThrough: 5_000,
      rangeCount: 0,
      pendingCount: 0,
    });
  });
});

describe("authenticated completion broker", () => {
  test("broker pending completion blocks unload and clearance wakes an owned follow-up", async () => {
    const accepted: any[] = [];
    const deliveries: any[] = [];
    const root = await RootTreeBroker.createRoot({
      identity: { id: "root-id", path: "/root", depth: 0, maxDepth: 2 },
      maxResidentAgents: 2,
      maxActiveAgents: 2,
      completionOutboxLimit: 1,
      dispatch: async (dispatch) => {
        if (dispatch.op === "inbox") accepted.push(dispatch.payload);
        if (dispatch.op === "deliver_mailbox") deliveries.push(dispatch.payload);
        return dispatch.op === "inbox"
          ? { observed: true }
          : { disposition: "accepted" };
      },
    });
    brokers.push(root);
    const grant = await root.reserveChild({
      id: "pending-child-id", taskName: "pending_child", maxDepth: 2,
      lastTaskMessage: "pending", reloadable: true,
    });
    const child = await RootTreeBroker.connectChild({
      identity: {
        id: "pending-child-id", path: grant.path, parentId: "root-id",
        parentPath: "/root", depth: 1, maxDepth: 2,
        connectionGeneration: grant.generation,
      },
      maxResidentAgents: 2,
      maxActiveAgents: 2,
      socketPath: root.endpoint!.socketPath,
      capability: grant.capability,
      dispatch: async () => ({}),
    });
    brokers.push(child);
    const completion = brokerCompletionIdentity("pending-child-id", grant.path, 1);
    const eventId = completion.eventId;
    await root.updateAgent(grant.path, {
      active: false,
      status: { completed: "done" },
      pendingCompletionEventId: eventId,
    }, 1);
    await expect(root.setCapacities(1, 2)).rejects.toThrow("safe leaf eviction");
    const ownedFollowup = await root.route(
      "followup",
      grant.path,
      "run after pending final acceptance",
    );
    expect(ownedFollowup.delivery).toBe("queued");
    expect(deliveries).toHaveLength(0);
    await child.deliverCompletion({
      targetPath: "/root", eventId, sender: grant.path,
      content: "final", details: completion.details,
    });
    expect(accepted).toHaveLength(1);
    const deadline = Date.now() + 2_000;
    while (deliveries.length === 0) {
      if (Date.now() >= deadline) throw new Error("outbox-clear mailbox wake timed out");
      await Bun.sleep(10);
    }
    expect(deliveries[0].triggerTurn).toBe(true);
    await root.updateAgent(
      grant.path,
      { active: false, status: { completed: "follow-up done" } },
      2,
    );
    expect((await root.setCapacities(1, 2)).unloaded).toEqual([grant.path]);
  });

  test("completion-before-terminal-registration cannot resurrect pending residency", async () => {
    const root = await RootTreeBroker.createRoot({
      identity: { id: "root-id", path: "/root", depth: 0, maxDepth: 2 },
      maxResidentAgents: 2,
      maxActiveAgents: 2,
      dispatch: async () => ({ observed: true }),
    });
    brokers.push(root);
    const grant = await root.reserveChild({
      id: "racing-child-id", taskName: "racing_child", maxDepth: 2,
      lastTaskMessage: "racing", reloadable: true,
    });
    const child = await RootTreeBroker.connectChild({
      identity: {
        id: "racing-child-id", path: grant.path, parentId: "root-id",
        parentPath: "/root", depth: 1, maxDepth: 2,
        connectionGeneration: grant.generation,
      },
      maxResidentAgents: 2,
      maxActiveAgents: 2,
      socketPath: root.endpoint!.socketPath,
      capability: grant.capability,
      dispatch: async () => ({}),
    });
    brokers.push(child);
    const completion = brokerCompletionIdentity("racing-child-id", grant.path, 1);
    const eventId = completion.eventId;
    await child.deliverCompletion({
      targetPath: "/root", eventId, sender: grant.path,
      content: "racing final", details: completion.details,
    });
    await root.updateAgent(grant.path, {
      active: false,
      status: { completed: "done" },
      pendingCompletionEventId: eventId,
    }, 1);
    expect((await root.setCapacities(1, 2)).unloaded).toEqual([grant.path]);
  });

  test("keeps disconnected pending-outbox recovery alive beyond six reload failures", async () => {
    let reloadAttempts = 0;
    let recovered: RootTreeBroker | undefined;
    const completion = brokerCompletionIdentity(
      "durable-child-id",
      "/root/durable_child",
      1,
    );
    const eventId = completion.eventId;
    const accepted: any[] = [];
    let root!: RootTreeBroker;
    const rootDispatch = async (dispatch: any) => {
      if (dispatch.op === "inbox") {
        accepted.push(dispatch.payload);
        return { observed: true };
      }
      if (dispatch.op === "disconnect_cleanup") return {
        closed: true,
        connectionGeneration: dispatch.payload.connectionGeneration,
      };
      if (dispatch.op === "reload") {
        reloadAttempts += 1;
        if (reloadAttempts <= 7) throw new Error("controller not ready yet");
        const grant = dispatch.payload.broker;
        recovered = await RootTreeBroker.connectChild({
          identity: {
            id: "durable-child-id", path: "/root/durable_child",
            parentId: "root-id", parentPath: "/root", depth: 1, maxDepth: 2,
            connectionGeneration: grant.generation,
          },
          maxResidentAgents: 2,
          maxActiveAgents: 2,
          socketPath: grant.socketPath,
          capability: grant.capability,
          dispatch: async (message) => {
            if (message.op === "retry_outbox") {
              await recovered!.deliverCompletion({
                targetPath: "/root", eventId, sender: "/root/durable_child",
                content: "durable final", details: completion.details,
              });
            }
            return {};
          },
        });
        brokers.push(recovered);
        return {};
      }
      return {};
    };
    root = await RootTreeBroker.createRoot({
      identity: { id: "root-id", path: "/root", depth: 0, maxDepth: 2 },
      maxResidentAgents: 2,
      maxActiveAgents: 2,
      dispatch: rootDispatch,
    });
    brokers.push(root);
    const grant = await root.reserveChild({
      id: "durable-child-id", taskName: "durable_child", maxDepth: 2,
      lastTaskMessage: "durable", reloadable: true,
    });
    const original = await RootTreeBroker.connectChild({
      identity: {
        id: "durable-child-id", path: grant.path, parentId: "root-id",
        parentPath: "/root", depth: 1, maxDepth: 2,
        connectionGeneration: grant.generation,
      },
      maxResidentAgents: 2,
      maxActiveAgents: 2,
      socketPath: root.endpoint!.socketPath,
      capability: grant.capability,
      dispatch: async () => ({}),
    });
    brokers.push(original);
    await root.updateAgent(grant.path, {
      active: false,
      status: { completed: "pending durable final" },
      pendingCompletionEventId: eventId,
    }, 1);
    await original.close();
    const deadline = Date.now() + 8_000;
    while (accepted.length === 0) {
      if (Date.now() >= deadline)
        throw new Error(`durable recovery timed out after ${reloadAttempts} attempts`);
      await Bun.sleep(20);
    }
    expect(reloadAttempts).toBeGreaterThan(7);
    expect(accepted).toHaveLength(1);
    for (let attempt = 0; attempt < 100 && (root.serverSecurityCounts?.outboxRecoveries ?? 0) !== 0; attempt++)
      await Bun.sleep(5);
    expect(root.serverSecurityCounts?.outboxRecoveries).toBe(0);
  }, 12_000);

  test("accepts direct child once and rejects forged child/crash identities", async () => {
    const accepted: any[] = [];
    const root = await RootTreeBroker.createRoot({
      identity: { id: "root-id", path: "/root", depth: 0, maxDepth: 2 },
      maxResidentAgents: 4,
      maxActiveAgents: 4,
      dispatch: async (dispatch) => {
        if (dispatch.op === "inbox") accepted.push(dispatch.payload);
        return { observed: true };
      },
    });
    brokers.push(root);
    const connected: RootTreeBroker[] = [];
    for (const [name, id] of [["child", "child-id"], ["sibling", "sibling-id"]] as const) {
      const grant = await root.reserveChild({
        id, taskName: name, maxDepth: 2, lastTaskMessage: name, reloadable: true,
      });
      const broker = await RootTreeBroker.connectChild({
        identity: {
          id, path: grant.path, parentId: "root-id", parentPath: "/root",
          depth: 1, maxDepth: 2, connectionGeneration: grant.generation,
        },
        maxResidentAgents: 4,
        maxActiveAgents: 4,
        socketPath: root.endpoint!.socketPath,
        capability: grant.capability,
        dispatch: async () => ({}),
      });
      brokers.push(broker);
      connected.push(broker);
    }
    const child = connected[0]!;
    const sibling = connected[1]!;
    const completion = brokerCompletionIdentity("child-id", "/root/child", 1);
    const input = {
      targetPath: "/root", eventId: completion.eventId, sender: "/root/child",
      content: "final", details: completion.details,
    };
    expect(await child.deliverCompletion(input)).toEqual({ accepted: true, observed: true });
    expect(await child.deliverCompletion(input)).toMatchObject({ duplicate: true });
    expect(accepted).toHaveLength(1);
    const forgedCompletion = await sibling.deliverCompletion(input).catch((error) => error);
    expect(forgedCompletion.message).toContain("authenticated child identity");
    const forgedCrash = await child.reportCrash({
      targetPath: "/root/sibling", eventId: "forged-crash", activeEpoch: 1,
      content: "error", details: {},
    }).catch((error) => error);
    expect(forgedCrash.message).toContain("owning controller");
  });
});
