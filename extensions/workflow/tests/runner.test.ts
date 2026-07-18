import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { RpcPhaseTransport } from "../rpc-client.ts";
import { WorkflowRunner, extractTerminalStructuredResult, snapshotRunState, type PersistedRunSnapshot } from "../runner.ts";
import { PANEL_ENTRY_TYPE, RUN_STATE_ENTRY, SNAPSHOT_VERSION, validateWorkflow, type WorkflowRunState } from "../schema.ts";

type ClientOptions = {
	messages?: any[];
	events?: any[];
	onGetState?: () => void;
	getStateError?: Error;
	blocked?: boolean;
	stopDelay?: number;
	stopError?: Error;
	onStop?: () => void;
};

class FakeClient implements RpcPhaseTransport {
	onEvent?: (event: any) => void;
	private rejectWait?: (error: Error) => void;
	private resolveWait?: () => void;
	stopped = false;
	aborted = false;
	constructor(private readonly options: ClientOptions = {}) {}
	async request(command: Record<string, unknown>): Promise<any> {
		if (command.type === "prompt" || command.type === "steer") return { success: true };
		if (command.type === "get_messages") return { success: true, data: { messages: this.options.messages ?? textMessages("ok") } };
		if (command.type === "get_state") {
			this.options.onGetState?.();
			if (this.options.getStateError) throw this.options.getStateError;
			return { success: true, data: { sessionFile: "/tmp/child.jsonl" } };
		}
		return { success: true };
	}
	waitForSettled(): Promise<void> {
		for (const event of this.options.events ?? []) this.onEvent?.(event);
		if (!this.options.blocked) {
			this.onEvent?.({ type: "agent_settled" });
			return Promise.resolve();
		}
		return new Promise((resolve, reject) => {
			this.resolveWait = resolve;
			this.rejectWait = reject;
		});
	}
	settle(): void {
		this.onEvent?.({ type: "agent_settled" });
		this.resolveWait?.();
	}
	getStderr(): string { return ""; }
	async abort(): Promise<void> {
		this.aborted = true;
		this.rejectWait?.(new Error("aborted"));
		await this.stop();
	}
	async stop(): Promise<void> {
		if (this.options.stopDelay) await new Promise((resolve) => setTimeout(resolve, this.options.stopDelay));
		this.stopped = true;
		this.options.onStop?.();
		this.resolveWait?.();
		if (this.options.stopError) throw this.options.stopError;
	}
}

function textMessages(text: string): any[] {
	return [{ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" }];
}

function structuredMessages(count = 1): any[] {
	const messages: any[] = [];
	for (let index = 0; index < count; index++) {
		const id = `result-${index}`;
		messages.push({ role: "assistant", content: [{ type: "toolCall", id, name: "workflow_phase_result", arguments: { status: "PASS", report: "ok" } }], stopReason: "toolUse" });
		messages.push({ role: "toolResult", toolCallId: id, toolName: "workflow_phase_result", isError: false, content: [{ type: "text", text: "recorded" }], details: { status: "PASS", report: "ok" } });
	}
	return messages;
}

function workflow(output?: unknown) {
	return validateWorkflow({ phases: [{ id: "run", prompt: "Do {{input}}", ...(output === undefined ? {} : { output }) }] }, "/tmp/test.yaml", "global");
}

function harness(
	clientFactory: () => FakeClient,
	persisted = true,
	branch: any[] = [],
	dependencies: { writeSystemPrompt?: (filePath: string, content: string) => void } = {},
) {
	const appended: Array<{ type: string; data: any }> = [];
	const sent: any[] = [];
	const pi: any = {
		appendEntry(type: string, data: any) { appended.push({ type, data }); },
		sendMessage(message: any) { sent.push(message); },
		getThinkingLevel() { return "off"; },
		getActiveTools() { return ["read", "workflow_run"]; },
	};
	const invocations: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
	const clients: FakeClient[] = [];
	const runner = new WorkflowRunner(pi, {}, {
		getInvocation: (args) => ({ command: "fake-pi", args }),
		createClient: (_command, args, _cwd, env) => {
			invocations.push({ args, env });
			const client = clientFactory();
			clients.push(client);
			return client;
		},
		...dependencies,
	});
	const ctx: any = {
		cwd: process.cwd(), mode: "tui", hasUI: true, model: undefined,
		isProjectTrusted: () => false,
		sessionManager: {
			getSessionFile: () => persisted ? "/tmp/parent.jsonl" : undefined,
			getBranch: () => branch,
			getEntries: () => [],
		},
		ui: { setStatus() {} },
	};
	return { runner, ctx, appended, sent, invocations, clients };
}

describe("workflow state machine", () => {
	test("a failed child tool is a sticky phase/workflow failure", async () => {
		const h = harness(() => new FakeClient({ messages: textMessages("plausible report"), events: [{ type: "tool_execution_end", toolName: "bash", toolCallId: "b1", isError: true }] }));
		const state = await h.runner.run({ workflow: workflow(), input: "x", ctx: h.ctx, displayPanel: false });
		expect(state.status).toBe("failed");
		expect(state.error).toMatch(/Tool bash/);
		expect(state.phases.find((phase) => phase.id === "run")?.status).toBe("failed");
	});

	test("accepts only one correlated terminal structured result", async () => {
		const contract = { type: "structured", status: { enum: ["PASS", "FAIL"] }, data: { fields: { count: { type: "integer" } } } };
		const valid = harness(() => new FakeClient({ messages: structuredMessages(1) }));
		expect((await valid.runner.run({ workflow: workflow(contract), input: "x", ctx: valid.ctx, displayPanel: false })).status).toBe("succeeded");
		const serialized = JSON.parse(valid.invocations[0].env.PI_WORKFLOW_PHASE_OUTPUT_CONFIG ?? "{}");
		expect(serialized.status.enum).toEqual(["PASS", "FAIL"]);
		expect(serialized.data.fields.count.type).toBe("integer");
		expect(serialized.statuses).toBeUndefined();
		expect(serialized.dataFields).toBeUndefined();
		const duplicate = harness(() => new FakeClient({ messages: structuredMessages(2) }));
		const state = await duplicate.runner.run({ workflow: workflow("structured"), input: "x", ctx: duplicate.ctx, displayPanel: false });
		expect(state.status).toBe("failed");
		expect(state.error).toMatch(/exactly one/);
		const sibling = structuredMessages(1);
		sibling[0].content.push({ type: "toolCall", id: "other", name: "bash", arguments: {} });
		expect(() => extractTerminalStructuredResult(sibling)).toThrow(/only tool/);
		const followed = [...structuredMessages(1), ...textMessages("later")];
		expect(() => extractTerminalStructuredResult(followed)).toThrow(/terminal/);
	});

	test("pre-abort and inter-phase abort never spawn a later child", async () => {
		const pre = new AbortController();
		pre.abort();
		const before = harness(() => new FakeClient());
		expect((await before.runner.run({ workflow: workflow(), input: "x", ctx: before.ctx, signal: pre.signal, displayPanel: false })).status).toBe("aborted");
		expect(before.clients).toHaveLength(0);

		const between = new AbortController();
		let created = 0;
		const h = harness(() => new FakeClient({ onStop: created++ === 0 ? () => setImmediate(() => between.abort()) : undefined }));
		const twoPhase = validateWorkflow({ phases: [{ id: "one", prompt: "x" }, { id: "two", prompt: "y" }] }, "/tmp/two.yaml", "global");
		expect((await h.runner.run({ workflow: twoPhase, input: "x", ctx: h.ctx, signal: between.signal, displayPanel: false })).status).toBe("aborted");
		expect(h.clients).toHaveLength(1);
	});

	test("abort during get_state cannot be overwritten by success", async () => {
		const controller = new AbortController();
		const h = harness(() => new FakeClient({ messages: textMessages("ok"), onGetState: () => controller.abort() }));
		const state = await h.runner.run({ workflow: workflow(), input: "x", ctx: h.ctx, signal: controller.signal, displayPanel: false });
		expect(state.status).toBe("aborted");
		expect(state.phases.find((phase) => phase.id === "run")?.status).toBe("aborted");
	});

	test("get_state protocol and timeout failures fail the phase", async () => {
		for (const message of ["Malformed RPC JSON record", "Timeout waiting for RPC response to get_state"]) {
			const h = harness(() => new FakeClient({ getStateError: new Error(message) }));
			const state = await h.runner.run({ workflow: workflow(), input: "x", ctx: h.ctx, displayPanel: false });
			expect(state.status).toBe("failed");
			expect(state.phases.find((phase) => phase.id === "run")?.status).toBe("failed");
			expect(state.error).toContain(message);
		}
	});

	test("runtime prompt rendering failures are attributed to the responsible phase", async () => {
		const definition = validateWorkflow({ phases: [
			{ id: "verify", prompt: "x", output: { type: "structured", status: { enum: ["PASS"] }, data: { fields: { count: { type: "integer" } } } } },
			{ id: "consume", prompt: "Count: {{phase.verify.data.count}}" },
		] }, "/tmp/render.yaml", "global");
		const h = harness(() => new FakeClient({ messages: structuredMessages(1) }));
		const state = await h.runner.run({ workflow: definition, input: "x", ctx: h.ctx, displayPanel: false });
		expect(state.status).toBe("failed");
		expect(state.phases.find((phase) => phase.id === "consume")?.status).toBe("failed");
		expect(state.report).toContain("## consume");
		expect(h.clients).toHaveLength(1);
	});

	test("rejects a concurrent run before creating another child or state", async () => {
		const controller = new AbortController();
		const h = harness(() => new FakeClient({ blocked: true }));
		const first = h.runner.run({ workflow: workflow(), input: "one", ctx: h.ctx, signal: controller.signal, displayPanel: false });
		expect(() => h.runner.run({ workflow: workflow(), input: "two", ctx: h.ctx, displayPanel: false })).toThrow(/already active/);
		expect(h.clients).toHaveLength(1);
		controller.abort();
		expect((await first).status).toBe("aborted");
	});

	test("async shutdown aborts and waits for child teardown and final persistence", async () => {
		const h = harness(() => new FakeClient({ blocked: true, stopDelay: 40 }));
		const run = h.runner.run({ workflow: workflow(), input: "x", ctx: h.ctx, displayPanel: false });
		const started = Date.now();
		await h.runner.shutdown();
		expect(Date.now() - started).toBeGreaterThanOrEqual(35);
		expect((await run).status).toBe("aborted");
		const snapshots = h.appended.filter((entry) => entry.type === RUN_STATE_ENTRY);
		expect(snapshots.at(-1)?.data.state.status).toBe("aborted");
	});

	test("teardown failure cannot reverse an aborted workflow or phase", async () => {
		const controller = new AbortController();
		const h = harness(() => new FakeClient({ blocked: true, stopError: new Error("stop failed") }));
		const run = h.runner.run({ workflow: workflow(), input: "x", ctx: h.ctx, signal: controller.signal, displayPanel: false });
		controller.abort();
		const state = await run;
		expect(state.status).toBe("aborted");
		expect(state.phases.find((phase) => phase.id === "run")?.status).toBe("aborted");
		expect(state.phases.find((phase) => phase.id === "run")?.logs.some((log) => log.text.includes("stop failed"))).toBe(true);
	});

	test("closes the steering gate synchronously at terminal result or agent settlement", async () => {
		const h = harness(() => new FakeClient({ blocked: true }));
		const run = h.runner.run({ workflow: workflow(), input: "x", ctx: h.ctx, displayPanel: false });
		await new Promise((resolve) => setImmediate(resolve));
		const state = h.runner.getActiveState()!;
		const lateSteer = state.steer!;
		h.clients[0].settle();
		expect(state.steer).toBeUndefined();
		await expect(lateSteer("too late")).rejects.toThrow(/already settled/);
		expect((await run).status).toBe("succeeded");

		const structured = harness(() => new FakeClient({
			blocked: true,
			messages: structuredMessages(1),
			events: [{ type: "tool_execution_end", toolName: "workflow_phase_result", toolCallId: "result-0", isError: false }],
		}));
		const structuredRun = structured.runner.run({ workflow: workflow("structured"), input: "x", ctx: structured.ctx, displayPanel: false });
		await new Promise((resolve) => setImmediate(resolve));
		expect(structured.runner.getActiveState()?.steer).toBeUndefined();
		structured.clients[0].settle();
		expect((await structuredRun).status).toBe("succeeded");
	});

	test("phase setup failures mark the phase failed and remove temporary files", async () => {
		const createFailure = harness(() => { throw new Error("spawn setup failed"); });
		const createState = await createFailure.runner.run({ workflow: workflow(), input: "x", ctx: createFailure.ctx, displayPanel: false });
		expect(createState.status).toBe("failed");
		expect(createState.phases.find((phase) => phase.id === "run")?.status).toBe("failed");
		const appendIndex = createFailure.invocations[0].args.lastIndexOf("--append-system-prompt");
		const systemPath = createFailure.invocations[0].args[appendIndex + 1];
		expect(fs.existsSync(path.dirname(systemPath))).toBe(false);

		let failedSystemPath = "";
		const writeFailure = harness(() => new FakeClient(), true, [], {
			writeSystemPrompt(filePath) {
				failedSystemPath = filePath;
				throw new Error("prompt write failed");
			},
		});
		const writeState = await writeFailure.runner.run({ workflow: workflow(), input: "x", ctx: writeFailure.ctx, displayPanel: false });
		expect(writeState.status).toBe("failed");
		expect(writeState.phases.find((phase) => phase.id === "run")?.error).toContain("prompt write failed");
		expect(fs.existsSync(path.dirname(failedSystemPath))).toBe(false);
	});

	test("keeps phase system text literal and never promotes user input into the system prompt", async () => {
		let systemPrompt = "";
		const h = harness(() => new FakeClient(), true, [], {
			writeSystemPrompt(_filePath, content) { systemPrompt = content; },
		});
		const definition = validateWorkflow({ phases: [{ id: "run", system: "Trusted literal: {{input}}", prompt: "Task: {{input}}" }] }, "/tmp/system.yaml", "global");
		const state = await h.runner.run({ workflow: definition, input: "PROMOTED_USER_TEXT", ctx: h.ctx, displayPanel: false });
		expect(state.status).toBe("succeeded");
		expect(systemPrompt).toContain("Trusted literal: {{input}}");
		expect(systemPrompt).not.toContain("PROMOTED_USER_TEXT");
	});

	test("propagates ephemeral sessions and orders normal append before phase append", async () => {
		const h = harness(() => new FakeClient(), false);
		const state = await h.runner.run({ workflow: workflow(), input: "x", ctx: h.ctx, displayPanel: true, recordCommandContext: true });
		expect(state.status).toBe("succeeded");
		const args = h.invocations[0].args;
		expect(args).toContain("--no-session");
		const appendIndexes = args.map((value, index) => value === "--append-system-prompt" ? index : -1).filter((index) => index >= 0);
		expect(appendIndexes).toHaveLength(2);
		expect(args[appendIndexes[0] + 1]).toEndWith("APPEND_SYSTEM.md");
		expect(args[appendIndexes[1] + 1]).toContain("pi-workflow-");
		expect(h.invocations[0].env.PI_WORKFLOW_PARENT_PID).toBe(String(process.pid));
		expect(state.phases.find((phase) => phase.id === "run")?.sessionFile).toBeUndefined();
		expect(h.appended.some((entry) => entry.type === PANEL_ENTRY_TYPE)).toBe(true);
		expect(h.sent).toEqual([expect.objectContaining({ customType: "workflow-context", display: false })]);
	});
});

describe("branch-aware recovery", () => {
	test("restores only active-branch versioned snapshots and marks live-looking runs interrupted", () => {
		const base: WorkflowRunState = {
			runId: "same", workflowId: "test", description: "", input: "x", status: "running", phases: [{ id: "run", status: "running", logs: [] }],
			activePhaseId: "run", selectedPhaseId: "run", startedAt: 1, composer: "stale", scrollOffset: 0, focused: true,
		};
		const snapshot: PersistedRunSnapshot = { version: SNAPSHOT_VERSION, state: snapshotRunState(base) };
		const branch = [{ type: "custom", customType: RUN_STATE_ENTRY, data: snapshot }];
		const h = harness(() => new FakeClient(), true, branch);
		h.runner.restore(h.ctx);
		const restored = h.runner.runStates.get("same")!;
		expect(restored.status).toBe("interrupted");
		expect(restored.phases.find((phase) => phase.id === "run")?.status).toBe("interrupted");
		expect(restored.phases.at(-1)?.id).toBe("report");
		expect(h.appended.at(-1)?.data.state.status).toBe("interrupted");
	});
});
