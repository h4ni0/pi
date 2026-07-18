import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { RpcPhaseClient } from "../rpc-client.ts";

const fixture = path.join(import.meta.dir, "fixtures", "fake-rpc-child.mjs");
const bounds = { requestTimeoutMs: 120, settlementTimeoutMs: 160, termGraceMs: 80, killGraceMs: 200, maxRecordBytes: 1024, maxStderrBytes: 1024 };

function client(scenario: string, overrides: Partial<typeof bounds> = {}, env: NodeJS.ProcessEnv = {}): RpcPhaseClient {
	return new RpcPhaseClient(process.execPath, [fixture], process.cwd(), { ...process.env, ...env, WF_RPC_SCENARIO: scenario }, { ...bounds, ...overrides });
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("bounded RPC lifecycle", () => {
	test("waits through retry and compaction until agent_settled", async () => {
		const rpc = client("settled");
		const events: string[] = [];
		rpc.onEvent = (event) => events.push(event.type);
		try {
			const response = await rpc.request({ type: "prompt", message: "x" });
			expect(response.success).toBe(true);
			await rpc.waitForSettled();
			expect(events).toContain("agent_settled");
			expect(events.filter((type) => type === "agent_end")).toHaveLength(2);
			expect((await rpc.request({ type: "get_messages" })).success).toBe(true);
		} finally {
			await rpc.stop();
		}
	});

	test("bounds request and settlement waits", async () => {
		const never = client("never");
		await expect(never.request({ type: "prompt", message: "x" })).rejects.toThrow(/Timeout waiting for RPC response/);
		await never.stop();
		const unsettled = client("settlement-timeout");
		await unsettled.request({ type: "prompt", message: "x" });
		await expect(unsettled.waitForSettled()).rejects.toThrow(/Timeout waiting for agent_settled/);
		await unsettled.stop();
	});

	test("fails malformed and oversized protocol records", async () => {
		for (const scenario of ["malformed", "oversized"]) {
			const rpc = client(scenario);
			await rpc.request({ type: "prompt", message: "x" });
			await expect(rpc.waitForSettled()).rejects.toThrow(scenario === "malformed" ? /Malformed RPC JSON/ : /exceeded/);
			await rpc.stop().catch(() => undefined);
		}
	});

	test("propagates malformed and timed-out get_state requests after settlement", async () => {
		for (const scenario of ["get-state-malformed", "get-state-timeout"]) {
			const rpc = client(scenario);
			await rpc.request({ type: "prompt", message: "x" });
			await rpc.waitForSettled();
			await expect(rpc.request({ type: "get_state" })).rejects.toThrow(scenario.endsWith("malformed") ? /Malformed RPC JSON/ : /Timeout waiting for RPC response to get_state/);
			await rpc.stop().catch(() => undefined);
		}
	});

	test("requires a new settlement when a racing steer is accepted after an earlier settlement event", async () => {
		const rpc = client("steer-race", { requestTimeoutMs: 200, settlementTimeoutMs: 250 });
		try {
			await rpc.request({ type: "prompt", message: "x" });
			const steer = rpc.request({ type: "steer", message: "more" });
			await rpc.waitForSettled();
			await steer;
			let settledAgain = false;
			const secondSettlement = rpc.waitForSettled().then(() => { settledAgain = true; });
			await new Promise((resolve) => setTimeout(resolve, 15));
			expect(settledAgain).toBe(false);
			await secondSettlement;
			expect(settledAgain).toBe(true);
		} finally {
			await rpc.stop();
		}
	});

	test("rejects close-before-settlement and a closed stdin/process promptly", async () => {
		const earlyClose = client("close-after-prompt");
		expect((await earlyClose.request({ type: "prompt", message: "x" })).success).toBe(true);
		await expect(earlyClose.waitForSettled()).rejects.toThrow(/exited before protocol completion/);
		await earlyClose.stop();

		const fake: any = new EventEmitter();
		fake.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(Object.assign(new Error("broken pipe"), { code: "EPIPE" })); } });
		fake.stdout = new PassThrough();
		fake.stderr = new PassThrough();
		fake.exitCode = null;
		fake.signalCode = null;
		fake.pid = undefined;
		fake.kill = () => { queueMicrotask(() => { fake.exitCode = 0; fake.emit("close", 0, null); }); return true; };
		const brokenPipe = new RpcPhaseClient("fake", [], process.cwd(), process.env, bounds, () => fake);
		await expect(brokenPipe.request({ type: "prompt", message: "x" })).rejects.toThrow(/stdin|EPIPE|write|broken pipe/i);
		await brokenPipe.stop();

		const rpc = client("exit", { requestTimeoutMs: 1000 });
		await new Promise((resolve) => setTimeout(resolve, 40));
		await expect(rpc.request({ type: "prompt", message: "x" })).rejects.toThrow(/exited|stdin|process/i);
		await rpc.stop();
	});

	test("keeps only a bounded stderr tail", async () => {
		const rpc = client("stderr", { maxStderrBytes: 2048 });
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(Buffer.byteLength(rpc.getStderr())).toBeLessThanOrEqual(2048);
		await rpc.stop();
	});

	test("escalates an ignored SIGTERM to SIGKILL and awaits exit", async () => {
		const rpc = client("ignore-term", { termGraceMs: 50, killGraceMs: 500 });
		await new Promise((resolve) => setTimeout(resolve, 40));
		const started = Date.now();
		await rpc.stop();
		expect(Date.now() - started).toBeLessThan(800);
		await rpc.stop();
	});

	test("terminates an owned descendant group after the RPC leader exits", async () => {
		if (process.platform === "win32") return;
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-rpc-group-"));
		const pidFile = path.join(root, "descendant.pid");
		const rpc = client("orphan-descendant", { termGraceMs: 100, killGraceMs: 500 }, { WF_RPC_DESCENDANT_PID_FILE: pidFile });
		let descendantPid = 0;
		try {
			for (let attempt = 0; attempt < 50 && !fs.existsSync(pidFile); attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
			descendantPid = Number(fs.readFileSync(pidFile, "utf8"));
			expect(Number.isSafeInteger(descendantPid)).toBe(true);
			await new Promise((resolve) => setTimeout(resolve, 60));
			expect(processExists(descendantPid)).toBe(true);
			await rpc.stop();
			for (let attempt = 0; attempt < 50 && processExists(descendantPid); attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
			expect(processExists(descendantPid)).toBe(false);
		} finally {
			if (descendantPid && processExists(descendantPid)) try { process.kill(descendantPid, "SIGKILL"); } catch { /* already gone */ }
			await rpc.stop().catch(() => undefined);
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
