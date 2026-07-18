import { afterEach, describe, expect, test } from "bun:test";
import { Value } from "typebox/value";
import workflowExtension, { isDirectWorkflowChild, sanitizeTerminalText } from "../index.ts";
import { capParentText } from "../schema.ts";
import { serializeStructuredOutputConfigForChild, snapshotRunState } from "../runner.ts";

const originalChild = process.env.PI_WORKFLOW_CHILD;
const originalParent = process.env.PI_WORKFLOW_PARENT_PID;
const originalOutputConfig = process.env.PI_WORKFLOW_PHASE_OUTPUT_CONFIG;
afterEach(() => {
	if (originalChild === undefined) delete process.env.PI_WORKFLOW_CHILD; else process.env.PI_WORKFLOW_CHILD = originalChild;
	if (originalParent === undefined) delete process.env.PI_WORKFLOW_PARENT_PID; else process.env.PI_WORKFLOW_PARENT_PID = originalParent;
	if (originalOutputConfig === undefined) delete process.env.PI_WORKFLOW_PHASE_OUTPUT_CONFIG; else process.env.PI_WORKFLOW_PHASE_OUTPUT_CONFIG = originalOutputConfig;
});

describe("parent context and render bounds", () => {
	test("caps parent-facing content with an explicit marker", () => {
		const capped = capParentText(`${"line\n".repeat(3000)}${"x".repeat(80_000)}`);
		expect(Buffer.byteLength(capped, "utf8")).toBeLessThanOrEqual(50 * 1024);
		expect(capped.split("\n").length).toBeLessThanOrEqual(2000);
		expect(capped).toContain("[Truncated workflow output:");
	});

	test("omits logs from tool details", () => {
		const snapshot = snapshotRunState({
			runId: "r", workflowId: "w", description: "", input: "x", status: "succeeded", startedAt: 1,
			composer: "", scrollOffset: 0, focused: false,
			phases: [{ id: "run", status: "succeeded", logs: [{ kind: "tool", text: "secret log", timestamp: 1 }], output: "ok" }],
		}, false);
		expect(snapshot.phases[0].logs).toEqual([]);
		expect(snapshot.phases[0].output).toBeUndefined();
		const large = snapshotRunState({
			runId: "large", workflowId: "w", description: "d".repeat(20_000), input: "i".repeat(100_000), status: "succeeded", startedAt: 1,
			composer: "", scrollOffset: 0, focused: false, report: "r".repeat(100_000),
			phases: Array.from({ length: 500 }, (_, index) => ({ id: `phase-${index}`, status: "succeeded" as const, logs: [{ kind: "assistant" as const, text: "l".repeat(6000), timestamp: 1 }], output: "o".repeat(60_000) })),
		}, false);
		expect(Buffer.byteLength(JSON.stringify(large), "utf8")).toBeLessThanOrEqual(50 * 1024);
	});

	test("strips OSC, CSI, APC, BEL, and C1 controls at the render boundary", () => {
		const hostile = "safe\x1b]52;c;YQ==\x07\x1b]8;;https://evil\x1b\\link\x1b]8;;\x1b\\\x1b[2J\x1b[H\x1b_payload\x1b\\\x07\x9bunsafe";
		const clean = sanitizeTerminalText(hostile);
		expect(clean).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/);
		expect(clean).not.toContain("52;");
		expect(clean).toContain("safe");
	});
});

describe("headless and child-mode contracts", () => {
	test("binds workflow child mode to the direct parent PID", () => {
		process.env.PI_WORKFLOW_CHILD = "1";
		process.env.PI_WORKFLOW_PARENT_PID = String(process.ppid);
		expect(isDirectWorkflowChild()).toBe(true);
		process.env.PI_WORKFLOW_PARENT_PID = String(process.ppid + 1);
		expect(isDirectWorkflowChild()).toBe(false);
	});

	test("registers the configured structured child-tool schema without a generic fallback", async () => {
		process.env.PI_WORKFLOW_CHILD = "1";
		process.env.PI_WORKFLOW_PARENT_PID = String(process.ppid);
		process.env.PI_WORKFLOW_PHASE_OUTPUT_CONFIG = serializeStructuredOutputConfigForChild({
			type: "structured",
			statuses: ["PASS", "FAIL"],
			statusDescription: "Routing status",
			reportDescription: "Verification report",
			dataFields: { count: { type: "integer", description: "Failure count" } },
		});
		let tool: any;
		workflowExtension({ registerTool(definition: any) { tool = definition; } } as any);
		expect(tool.name).toBe("workflow_phase_result");
		expect(Value.Check(tool.parameters, { status: "PASS", report: "ok", data: { count: 1 } })).toBe(true);
		expect(Value.Check(tool.parameters, { status: "OTHER", report: "ok", data: { count: 1 } })).toBe(false);
		expect(Value.Check(tool.parameters, { status: "PASS", report: "ok", data: { count: "one" } })).toBe(false);
		await expect(tool.execute("call", { status: "OTHER", report: "ok", data: { count: 1 } })).rejects.toThrow(/must be one of/);
		await expect(tool.execute("call", { status: "PASS", report: "ok", data: { count: "one" } })).rejects.toThrow(/must be integer/);
	});

	test("rejects malformed configured child contracts instead of silently weakening them", () => {
		process.env.PI_WORKFLOW_CHILD = "1";
		process.env.PI_WORKFLOW_PARENT_PID = String(process.ppid);
		process.env.PI_WORKFLOW_PHASE_OUTPUT_CONFIG = JSON.stringify({ type: "structured", dataFields: { count: { type: "integer" } } });
		expect(() => workflowExtension({ registerTool() {} } as any)).toThrow(/unknown field/);
	});

	test("headless missing-task command never opens an editor", async () => {
		let command: any;
		const sent: any[] = [];
		const pi: any = {
			registerEntryRenderer() {}, registerMessageRenderer() {},
			registerCommand(_name: string, definition: any) { command = definition; },
			on() {}, appendEntry() {}, getThinkingLevel() { return "off"; }, getActiveTools() { return []; },
			sendMessage(message: any) { sent.push(message); },
		};
		workflowExtension(pi);
		await command.handler("pipeline", {
			cwd: process.cwd(), mode: "rpc", hasUI: true, isProjectTrusted: () => false,
			ui: { editor() { throw new Error("editor must not open"); } },
			sessionManager: { getSessionFile: () => undefined, getBranch: () => [] },
		});
		expect(sent.at(-1)?.content).toMatch(/requires explicit task text in rpc mode/);
	});

	test("unknown workflow_run invocations reject with parent tool-error semantics", async () => {
		let sessionStart: any;
		let tool: any;
		const pi: any = {
			registerEntryRenderer() {}, registerMessageRenderer() {}, registerCommand() {}, appendEntry() {}, sendMessage() {},
			getThinkingLevel() { return "off"; }, getActiveTools() { return []; },
			registerTool(definition: any) { if (definition.name === "workflow_run") tool = definition; },
			on(event: string, handler: any) { if (event === "session_start") sessionStart = handler; },
		};
		workflowExtension(pi);
		const ctx: any = {
			cwd: process.cwd(), mode: "rpc", hasUI: true, model: undefined, isProjectTrusted: () => false,
			ui: { setStatus() {} }, sessionManager: { getSessionFile: () => undefined, getBranch: () => [] },
		};
		sessionStart({}, ctx);
		await expect(tool.execute("call", { workflow: "does-not-exist", input: "x" }, undefined, undefined, ctx)).rejects.toThrow(/Unknown or invalid workflow/);
	});
});
