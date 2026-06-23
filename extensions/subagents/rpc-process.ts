import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { CHILD_STOP_GRACE_MS } from "./constants.ts";
import type { RpcEvent } from "./types.ts";
import { sleep } from "./utils.ts";

function attachJsonlReader(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
): () => void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  const onData = (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    while (true) {
      const index = buffer.indexOf("\n");
      if (index === -1) break;
      let line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      onLine(line);
    }
  };
  const onEnd = () => {
    buffer += decoder.end();
    if (buffer.length > 0)
      onLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
  };
  stream.on("data", onData);
  stream.on("end", onEnd);
  return () => {
    stream.off("data", onData);
    stream.off("end", onEnd);
  };
}

export class RpcProcess {
  private proc?: ChildProcessWithoutNullStreams;
  private stopReader?: () => void;
  private stderr = "";
  private requestId = 0;
  private pending = new Map<
    string,
    {
      resolve: (value: any) => void;
      reject: (err: Error) => void;
      timer?: NodeJS.Timeout;
    }
  >();
  private listeners: Array<(event: RpcEvent) => void> = [];
  private exitError?: Error;

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly options: {
      cwd: string;
      env: Record<string, string | undefined>;
    },
  ) {}

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  getStderr(): string {
    return this.stderr;
  }

  onEvent(listener: (event: RpcEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  async start(): Promise<void> {
    if (this.proc) throw new Error("RPC process already started");
    const proc = spawn(this.command, this.args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;
    proc.stderr.on("data", (data) => {
      this.stderr += data.toString();
    });
    proc.once("exit", (code, signal) => {
      if (this.proc !== proc) return;
      const err = new Error(
        `child pi exited (code=${code} signal=${signal}). ${this.stderr.trim()}`,
      );
      this.exitError = err;
      this.rejectPending(err);
      this.emit({ type: "process_exit", code, signal, error: err.message });
    });
    proc.once("error", (err) => {
      if (this.proc !== proc) return;
      const wrapped = new Error(
        `child pi process error: ${err.message}. ${this.stderr.trim()}`,
      );
      this.exitError = wrapped;
      this.rejectPending(wrapped);
      this.emit({ type: "process_error", error: wrapped.message });
    });
    this.stopReader = attachJsonlReader(proc.stdout, (line) =>
      this.handleLine(line),
    );
    await sleep(120);
    if (proc.exitCode !== null) {
      throw (
        this.exitError ??
        new Error(`child pi exited during startup. ${this.stderr.trim()}`)
      );
    }
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    this.stopReader?.();
    this.stopReader = undefined;
    if (proc.exitCode === null) proc.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (proc.exitCode === null) proc.kill("SIGKILL");
        resolve();
      }, CHILD_STOP_GRACE_MS);
      proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.proc = undefined;
    this.pending.clear();
  }

  async prompt(message: string): Promise<void> {
    await this.send({ type: "prompt", message });
  }

  async steer(message: string): Promise<void> {
    await this.send({ type: "steer", message });
  }

  async followUp(message: string): Promise<void> {
    await this.send({ type: "follow_up", message });
  }

  async abort(): Promise<void> {
    await this.send({ type: "abort" });
  }

  async getState(): Promise<any> {
    return this.getData(await this.send({ type: "get_state" }));
  }

  async getMessages(): Promise<AgentMessage[]> {
    return (
      this.getData(await this.send({ type: "get_messages" })).messages ?? []
    );
  }

  async getLastAssistantText(): Promise<string | null> {
    return (
      this.getData(await this.send({ type: "get_last_assistant_text" })).text ??
      null
    );
  }

  async getSessionStats(): Promise<any> {
    return this.getData(await this.send({ type: "get_session_stats" }));
  }

  async compact(customInstructions?: string): Promise<any> {
    return this.getData(
      await this.send({ type: "compact", customInstructions }),
    );
  }

  async setSessionName(name: string): Promise<void> {
    await this.send({ type: "set_session_name", name });
  }

  private handleLine(line: string) {
    if (!line.trim()) return;
    let data: any;
    try {
      data = JSON.parse(line);
    } catch {
      return;
    }
    if (data.type === "response" && data.id && this.pending.has(data.id)) {
      const pending = this.pending.get(data.id)!;
      this.pending.delete(data.id);
      if (pending.timer) clearTimeout(pending.timer);
      pending.resolve(data);
      return;
    }
    if (
      data.type === "extension_ui_request" &&
      data.id &&
      isDialogUiRequest(data)
    ) {
      this.sendUiCancel(data.id);
    }
    this.emit(data);
  }

  private emit(event: RpcEvent) {
    for (const listener of this.listeners) listener(event);
  }

  private sendUiCancel(id: string) {
    try {
      this.proc?.stdin.write(
        `${JSON.stringify({ type: "extension_ui_response", id, cancelled: true })}\n`,
      );
    } catch {
      // ignore
    }
  }

  private send(command: Record<string, any>): Promise<any> {
    const proc = this.proc;
    if (!proc || !proc.stdin.writable)
      throw new Error("RPC process not started");
    if (this.exitError) throw this.exitError;
    if (proc.exitCode !== null)
      throw new Error(`RPC process already exited. ${this.stderr.trim()}`);
    const id = `req_${++this.requestId}`;
    const fullCommand = { ...command, id };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        proc.stdin.write(`${JSON.stringify(fullCommand)}\n`);
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private getData(response: any): any {
    if (!response.success)
      throw new Error(response.error || "RPC command failed");
    return response.data;
  }

  private rejectPending(err: Error) {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }
}

function isDialogUiRequest(request: any): boolean {
  return (
    request.method === "select" ||
    request.method === "confirm" ||
    request.method === "input" ||
    request.method === "editor"
  );
}
