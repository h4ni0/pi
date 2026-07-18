import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export interface RpcBounds {
	requestTimeoutMs: number;
	settlementTimeoutMs: number;
	termGraceMs: number;
	killGraceMs: number;
	maxRecordBytes: number;
	maxStderrBytes: number;
}

export const DEFAULT_RPC_BOUNDS: RpcBounds = {
	requestTimeoutMs: 30_000,
	settlementTimeoutMs: 2 * 60 * 60 * 1000,
	termGraceMs: 2_500,
	killGraceMs: 2_500,
	maxRecordBytes: 8 * 1024 * 1024,
	maxStderrBytes: 64 * 1024,
};

export interface RpcPhaseTransport {
	onEvent?: (event: any) => void;
	request(command: Record<string, unknown>): Promise<any>;
	waitForSettled(): Promise<void>;
	getStderr(): string;
	abort(): Promise<void>;
	stop(): Promise<void>;
}

export type SpawnRpcProcess = (
	command: string,
	args: readonly string[],
	options: { cwd: string; env: NodeJS.ProcessEnv; shell: false; detached: boolean; stdio: ["pipe", "pipe", "pipe"] },
) => ChildProcessWithoutNullStreams;

interface PendingRequest {
	resolve: (value: any) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
	commandType: string;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RpcPhaseClient implements RpcPhaseTransport {
	private readonly proc: ChildProcessWithoutNullStreams;
	private readonly bounds: RpcBounds;
	private readonly ownedProcessGroupId?: number;
	private nextId = 1;
	private readonly pending = new Map<string, PendingRequest>();
	private stderr: Buffer = Buffer.alloc(0);
	private closed = false;
	private closeError?: Error;
	private protocolError?: Error;
	private settled = false;
	private stopPromise?: Promise<void>;
	private closeResolve!: () => void;
	private readonly closePromise: Promise<void>;
	private readonly settledWaiters = new Set<{ resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
	public onEvent?: (event: any) => void;

	constructor(
		command: string,
		args: string[],
		cwd: string,
		env: NodeJS.ProcessEnv,
		bounds: Partial<RpcBounds> = {},
		spawnProcess: SpawnRpcProcess = spawn as SpawnRpcProcess,
	) {
		this.bounds = { ...DEFAULT_RPC_BOUNDS, ...bounds };
		this.closePromise = new Promise((resolve) => {
			this.closeResolve = resolve;
		});
		const detached = process.platform !== "win32";
		this.proc = spawnProcess(command, args, {
			cwd,
			env,
			shell: false,
			detached,
			stdio: ["pipe", "pipe", "pipe"],
		});
		if (detached && Number.isSafeInteger(this.proc.pid) && (this.proc.pid ?? 0) > 0) this.ownedProcessGroupId = this.proc.pid;
		this.attachJsonlReader();
		this.proc.stderr.on("data", (chunk: Buffer | string) => this.appendStderr(chunk));
		this.proc.stdin.on("error", (error) => this.fail(new Error(`RPC child stdin error: ${errorMessage(error)}. Stderr: ${this.getStderr()}`)));
		this.proc.once("error", (error) => this.fail(new Error(`RPC child process error: ${errorMessage(error)}. Stderr: ${this.getStderr()}`)));
		this.proc.once("close", (code, signal) => {
			this.closed = true;
			this.closeError ??= new Error(`RPC child exited before protocol completion (code=${code}, signal=${signal}). Stderr: ${this.getStderr()}`);
			this.rejectPending(this.closeError);
			this.rejectSettled(this.closeError);
			this.closeResolve();
		});
	}

	private appendStderr(chunk: Buffer | string): void {
		const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		if (data.length >= this.bounds.maxStderrBytes) this.stderr = data.subarray(data.length - this.bounds.maxStderrBytes);
		else {
			const combined = Buffer.concat([this.stderr, data]);
			this.stderr = combined.length > this.bounds.maxStderrBytes ? combined.subarray(combined.length - this.bounds.maxStderrBytes) : combined;
		}
	}

	private attachJsonlReader(): void {
		const decoder = new StringDecoder("utf8");
		let buffer = "";
		let bufferBytes = 0;
		const consume = (text: string) => {
			buffer += text;
			bufferBytes = Buffer.byteLength(buffer, "utf8");
			while (true) {
				const newline = buffer.indexOf("\n");
				if (newline === -1) break;
				let line = buffer.slice(0, newline);
				if (Buffer.byteLength(line, "utf8") > this.bounds.maxRecordBytes) {
					this.failProtocol(`RPC record exceeded ${this.bounds.maxRecordBytes} bytes`);
					return;
				}
				buffer = buffer.slice(newline + 1);
				if (line.endsWith("\r")) line = line.slice(0, -1);
				this.handleLine(line);
				if (this.protocolError) return;
			}
			bufferBytes = Buffer.byteLength(buffer, "utf8");
			if (bufferBytes > this.bounds.maxRecordBytes) this.failProtocol(`RPC record exceeded ${this.bounds.maxRecordBytes} bytes`);
		};
		this.proc.stdout.on("data", (chunk: Buffer | string) => consume(typeof chunk === "string" ? chunk : decoder.write(chunk)));
		this.proc.stdout.on("end", () => {
			consume(decoder.end());
			if (!this.protocolError && buffer.length > 0) this.handleLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
		});
	}

	private handleLine(line: string): void {
		if (!line.trim()) return;
		let event: any;
		try {
			event = JSON.parse(line);
		} catch (error) {
			this.failProtocol(`Malformed RPC JSON record: ${errorMessage(error)}`);
			return;
		}
		if (event.type === "response" && typeof event.id === "string") {
			const pending = this.pending.get(event.id);
			if (pending) {
				clearTimeout(pending.timer);
				this.pending.delete(event.id);
				if (event.success && (pending.commandType === "prompt" || pending.commandType === "steer")) this.settled = false;
				pending.resolve(event);
				return;
			}
		}
		if (event.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(event.method)) {
			void this.write({ type: "extension_ui_response", id: event.id, cancelled: true }).catch((error) => this.fail(error));
			return;
		}
		if (event.type === "agent_settled") {
			this.settled = true;
			for (const waiter of this.settledWaiters) {
				clearTimeout(waiter.timer);
				waiter.resolve();
			}
			this.settledWaiters.clear();
		}
		this.onEvent?.(event);
	}

	private failProtocol(message: string): void {
		if (this.protocolError) return;
		this.protocolError = new Error(`${message}. Stderr: ${this.getStderr()}`);
		this.fail(this.protocolError);
		void this.stop();
	}

	private fail(error: Error): void {
		this.closeError ??= error;
		this.rejectPending(error);
		this.rejectSettled(error);
	}

	private rejectPending(error: Error): void {
		for (const request of this.pending.values()) {
			clearTimeout(request.timer);
			request.reject(error);
		}
		this.pending.clear();
	}

	private rejectSettled(error: Error): void {
		for (const waiter of this.settledWaiters) {
			clearTimeout(waiter.timer);
			waiter.reject(error);
		}
		this.settledWaiters.clear();
	}

	private write(value: unknown): Promise<void> {
		if (this.closed || this.proc.exitCode !== null || this.proc.stdin.destroyed || !this.proc.stdin.writable) {
			return Promise.reject(this.closeError ?? new Error(`RPC child stdin is not writable. Stderr: ${this.getStderr()}`));
		}
		const data = `${JSON.stringify(value)}\n`;
		return new Promise((resolve, reject) => {
			try {
				this.proc.stdin.write(data, (error) => {
					if (error) {
						const failure = new Error(`RPC child stdin write failed: ${errorMessage(error)}. Stderr: ${this.getStderr()}`);
						this.fail(failure);
						reject(failure);
					} else resolve();
				});
			} catch (error) {
				const failure = new Error(`RPC child stdin write failed: ${errorMessage(error)}. Stderr: ${this.getStderr()}`);
				this.fail(failure);
				reject(failure);
			}
		});
	}

	request(command: Record<string, unknown>): Promise<any> {
		if (this.closeError || this.protocolError) return Promise.reject(this.protocolError ?? this.closeError);
		const id = `wf-${this.nextId++}`;
		const commandType = String(command.type ?? "command");
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Timeout waiting for RPC response to ${commandType} after ${this.bounds.requestTimeoutMs}ms. Stderr: ${this.getStderr()}`));
			}, this.bounds.requestTimeoutMs);
			this.pending.set(id, { resolve, reject, timer, commandType });
			void this.write({ id, ...command }).catch((error) => {
				const pending = this.pending.get(id);
				if (!pending) return;
				clearTimeout(pending.timer);
				this.pending.delete(id);
				pending.reject(error instanceof Error ? error : new Error(String(error)));
			});
		});
	}

	waitForSettled(): Promise<void> {
		if (this.settled) return Promise.resolve();
		if (this.closeError) return Promise.reject(this.closeError);
		return new Promise((resolve, reject) => {
			const waiter = {
				resolve,
				reject,
				timer: setTimeout(() => {
					this.settledWaiters.delete(waiter);
					reject(new Error(`Timeout waiting for agent_settled after ${this.bounds.settlementTimeoutMs}ms. Stderr: ${this.getStderr()}`));
				}, this.bounds.settlementTimeoutMs),
			};
			this.settledWaiters.add(waiter);
		});
	}

	getStderr(): string {
		return this.stderr.toString("utf8");
	}

	async abort(): Promise<void> {
		if (!this.closed && !this.closeError) {
			try {
				await this.write({ type: "abort" });
			} catch {
				// stop() below still owns bounded termination.
			}
		}
		await this.stop();
	}

	private isLeaderAlive(): boolean {
		return !this.closed && this.proc.exitCode === null;
	}

	private isOwnedProcessGroupAlive(): boolean {
		if (!this.ownedProcessGroupId) return false;
		try {
			process.kill(-this.ownedProcessGroupId, 0);
			return true;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "EPERM";
		}
	}

	private signal(signal: NodeJS.Signals): void {
		if (this.ownedProcessGroupId) {
			try {
				process.kill(-this.ownedProcessGroupId, signal);
				return;
			} catch {
				// The leader may still need a direct signal if group creation failed.
			}
		}
		if (!this.isLeaderAlive()) return;
		try {
			this.proc.kill(signal);
		} catch {
			// Process may already be gone.
		}
	}

	private async waitForOwnedProcessesToExit(timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		do {
			if (!this.isLeaderAlive() && !this.isOwnedProcessGroupAlive()) return true;
			await wait(Math.min(20, Math.max(1, deadline - Date.now())));
		} while (Date.now() < deadline);
		return !this.isLeaderAlive() && !this.isOwnedProcessGroupAlive();
	}

	stop(): Promise<void> {
		if (this.stopPromise) return this.stopPromise;
		this.stopPromise = (async () => {
			if (!this.isLeaderAlive() && !this.isOwnedProcessGroupAlive()) return;
			this.signal("SIGTERM");
			if (await this.waitForOwnedProcessesToExit(this.bounds.termGraceMs)) return;
			this.signal("SIGKILL");
			if (await this.waitForOwnedProcessesToExit(this.bounds.killGraceMs)) return;
			const error = new Error(`RPC child process group did not exit after SIGTERM/SIGKILL. Stderr: ${this.getStderr()}`);
			this.fail(error);
			throw error;
		})();
		return this.stopPromise;
	}
}
