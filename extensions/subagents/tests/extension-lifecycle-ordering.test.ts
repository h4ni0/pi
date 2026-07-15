import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { registerRuntimeEventHandlers } from "../extension.ts";
import { DEFAULT_SETTINGS } from "../settings.ts";
import {
  ChildLifecycleTokenController,
  decodeLifecycleMarker,
  LIFECYCLE_STATUS_KEY,
} from "../runtime/lifecycle-protocol.ts";
import {
  SelfTurnReporter,
  stableCompletionEventId,
} from "../runtime/self-turn-reporter.ts";
import { createSubagentRuntimeState } from "../runtime/state.ts";

const dirs: string[] = [];
const reporters: SelfTurnReporter[] = [];
afterEach(async () => {
  await Promise.allSettled(reporters.splice(0).map((reporter) => reporter.stop()));
  const ownedDirs = dirs.splice(0);
  for (const dir of ownedDirs) fs.rmSync(dir, { recursive: true, force: true });
  await Bun.sleep(0);
  for (const dir of ownedDirs) expect(fs.existsSync(dir)).toBe(false);
});

function harness(deliverCompletion: (input: any) => Promise<any>) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-extension-lifecycle-"));
  dirs.push(cwd);
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const wire: any[] = [];
  const pi = {
    on(name: string, handler: (event: any, ctx: any) => unknown) {
      handlers.set(name, handler);
    },
  } as any;
  const state = createSubagentRuntimeState({
    pi,
    settings: { ...DEFAULT_SETTINGS, sessionDir: cwd },
    currentDepth: 1,
    envMaxDepth: 2,
    extensionPath: "/extension/index.ts",
    currentPath: "/root/child",
    guardToken: {},
    invocationBase: { command: "/trusted/pi", prefixArgs: [] },
  });
  state.broker = { deliverCompletion } as any;
  state.selfTurnReporter = new SelfTurnReporter(state);
  reporters.push(state.selfTurnReporter);
  const lifecycle = new ChildLifecycleTokenController();
  const ctx = {
    hasUI: false,
    sessionManager: SessionManager.inMemory(cwd),
    ui: {
      setStatus(statusKey: string, statusText: string) {
        if (statusKey === LIFECYCLE_STATUS_KEY) {
          wire.push({
            type: "marker",
            marker: decodeLifecycleMarker({
              type: "extension_ui_request",
              method: "setStatus",
              statusKey,
              statusText,
            } as any),
          });
        }
      },
    },
  } as any;
  registerRuntimeEventHandlers(pi, state, lifecycle);

  let extensionErrors = 0;
  async function dispatch(type: string, event: any): Promise<unknown> {
    let result: unknown;
    try {
      result = handlers.get(type)!(event, ctx);
      await result;
    } catch {
      // This models Pi converting a rejected extension hook into extension_error.
      extensionErrors++;
    }
    wire.push({ type: "raw", event });
    return result;
  }

  return {
    state,
    lifecycle,
    wire,
    dispatch,
    extensionErrors: () => extensionErrors,
  };
}

function assistant(text: string) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

async function completeTurn(
  test: ReturnType<typeof harness>,
  token: string,
  output: string,
): Promise<unknown> {
  test.lifecycle.queuePrompt(token);
  test.lifecycle.promotePending();
  await test.dispatch("agent_start", { type: "agent_start" });
  const message = assistant(output);
  await test.dispatch("message_end", { type: "message_end", message });
  await test.dispatch("agent_end", {
    type: "agent_end",
    messages: [message],
    willRetry: false,
  });
  return test.dispatch("agent_settled", { type: "agent_settled" });
}

describe("extension lifecycle marker ordering", () => {
  test("serializes raw settled before >250ms rejected delivery without extension_error", async () => {
    const timeline: string[] = [];
    let rawSeenAtDelivery = false;
    let test!: ReturnType<typeof harness>;
    test = harness(async () => {
      rawSeenAtDelivery = test.wire.some(
        (item) => item.type === "raw" && item.event.type === "agent_settled",
      );
      timeline.push("delivery_started");
      await Bun.sleep(320);
      timeline.push("delivery_rejected");
      throw new Error("insertion rejected");
    });

    const settledReturn = await completeTurn(test, "child.1", "done");
    expect(settledReturn).toBeUndefined();
    expect(test.wire.filter(
      (item) => item.type === "raw" && item.event.type === "agent_settled",
    )).toHaveLength(1);
    const settledMarker = test.wire.find(
      (item) => item.type === "marker" && item.marker?.event === "agent_settled",
    );
    const settledRawIndex = test.wire.findIndex(
      (item) => item.type === "raw" && item.event.type === "agent_settled",
    );
    expect(settledMarker?.marker.token).toBe("child.1");
    expect(settledMarker?.marker.completionEventId).toBe(
      stableCompletionEventId("/root/child", "child.1"),
    );
    expect(test.wire.indexOf(settledMarker)).toBe(settledRawIndex - 1);

    await Bun.sleep(360);
    expect(rawSeenAtDelivery).toBe(true);
    expect(timeline).toEqual(["delivery_started", "delivery_rejected"]);
    expect(test.extensionErrors()).toBe(0);
    expect(test.state.selfTurnReporter?.snapshot()[0]?.stage).toBe("injection_pending");
  });

  test("follow-up reuse emits exactly one agent_start for each token", async () => {
    const test = harness(async () => ({ accepted: true, observed: true }));
    await completeTurn(test, "child.1", "first");
    await completeTurn(test, "child.2", "follow-up");
    await Bun.sleep(10);

    const starts = test.wire.filter(
      (item) => item.type === "raw" && item.event.type === "agent_start",
    );
    expect(starts).toHaveLength(2);
    const startMarkers = test.wire.filter(
      (item) => item.type === "marker" && item.marker?.event === "agent_start",
    );
    expect(startMarkers.map((item) => item.marker.token)).toEqual(["child.1", "child.2"]);
    expect(test.extensionErrors()).toBe(0);
  });
});
