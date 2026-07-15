import { SessionManager } from "@earendil-works/pi-coding-agent";
import { SelfTurnReporter } from "../../runtime/self-turn-reporter.ts";
import { createSubagentRuntimeState } from "../../runtime/state.ts";
import { DEFAULT_SETTINGS } from "../../settings.ts";

const root = process.argv[2];
const output = process.argv[3];
if (!root || output === undefined) throw new Error("usage: worker <root> <output>");
const session = SessionManager.inMemory(root);
const state = createSubagentRuntimeState({
  pi: {} as any,
  settings: { ...DEFAULT_SETTINGS, sessionDir: root },
  currentDepth: 1,
  envMaxDepth: 2,
  extensionPath: "/extension/index.ts",
  currentPath: "/root/child",
  guardToken: {},
  invocationBase: { command: "/trusted/pi", prefixArgs: [] },
});
state.broker = {
  deliverCompletion: async () => ({ accepted: true, observed: true }),
} as any;
const reporter = new SelfTurnReporter(state);
const ctx = { sessionManager: session } as any;
reporter.captureMessage("child.1", {
  role: "assistant",
  content: [{ type: "text", text: output }],
  stopReason: "stop",
});
reporter.captureAgentEnd("child.1", { willRetry: false });
await reporter.settled("child.1", ctx);
const event = reporter.snapshot()[0]!;
console.log(JSON.stringify({ artifactPath: event.artifactPath, output: event.output }));
await reporter.stop();
