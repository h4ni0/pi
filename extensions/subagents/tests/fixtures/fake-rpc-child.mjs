import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

const decoder = new StringDecoder("utf8");
let buffer = "";
let streaming = false;
let turn = 0;
let stallDiagnostics = false;
let activeTurnToken;
const settleTimers = new Set();
const lifecycleSequences = new Map();
const sessionFile = process.env.FAKE_SESSION_FILE ?? `/tmp/fake-session-${process.pid}.jsonl`;
let treeBroker;
if (process.env.FAKE_GRANDCHILD_PID_FILE) {
  const grandchild = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
    {
      stdio: "ignore",
      detached: process.env.FAKE_GRANDCHILD_DETACHED === "1",
    },
  );
  writeFileSync(process.env.FAKE_GRANDCHILD_PID_FILE, String(grandchild.pid));
}
if (process.env.FAKE_CONNECT_BROKER === "1") {
  const [{ RootTreeBroker }, { readChildBrokerBootstrapEnvironment }] = await Promise.all([
    import("../../runtime/root-tree-broker.ts"),
    import("../../utils.ts"),
  ]);
  const bootstrap = readChildBrokerBootstrapEnvironment();
  treeBroker = await RootTreeBroker.connectChild({
    identity: bootstrap.identity,
    maxResidentAgents: bootstrap.maxResidentAgents,
    maxActiveAgents: bootstrap.maxActiveAgents,
    socketPath: bootstrap.socketPath,
    capability: bootstrap.capability,
    dispatch: async () => ({}),
  });
}

if (process.env.FAKE_IGNORE_SIGTERM === "1") {
  process.on("SIGTERM", () => {
    write({ type: "fake_signal", signal: "SIGTERM" });
  });
}

function write(value, fragmented = false) {
  const line = `${JSON.stringify(value)}\n`;
  if (!fragmented) {
    process.stdout.write(line);
    return;
  }
  const bytes = Buffer.from(line, "utf8");
  const cuts = [1, 3, Math.max(4, bytes.length - 2), bytes.length];
  let start = 0;
  for (const end of cuts) {
    if (end > start) process.stdout.write(bytes.subarray(start, end));
    start = end;
  }
}

function response(command, success = true, data, error) {
  write({
    id: command.id,
    type: "response",
    command: command.type,
    success,
    ...(data === undefined ? {} : { data }),
    ...(error ? { error } : {}),
  }, process.env.FAKE_FRAGMENT === "1");
}

function lifecycleFingerprint(event) {
  const message = event.message;
  const messages = Array.isArray(event.messages) ? event.messages : undefined;
  const lastMessage = messages?.at(-1);
  const identity = event.type === "message_end" || event.type === "turn_end"
    ? {
        type: event.type,
        role: message?.role,
        timestamp: message?.timestamp,
        stopReason: message?.stopReason,
        errorMessage: message?.errorMessage,
      }
    : event.type === "agent_end"
      ? {
          type: event.type,
          count: messages?.length,
          lastRole: lastMessage?.role,
          lastTimestamp: lastMessage?.timestamp,
          lastStopReason: lastMessage?.stopReason,
        }
      : event.type === "extension_error"
        ? {
            type: event.type,
            extensionPath: event.extensionPath,
            event: event.event,
            error: event.error,
          }
        : { type: event.type };
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

function turnEvent(type, token, extra = {}, replaySequence) {
  const event = { type, ...extra };
  const sequence = replaySequence ?? ((lifecycleSequences.get(token) ?? 0) + 1);
  if (replaySequence === undefined) lifecycleSequences.set(token, sequence);
  if (process.env.FAKE_LIFECYCLE_MARKERS === "1") {
    write({
      type: "extension_ui_request",
      method: "setStatus",
      statusKey: "subagents_lifecycle_v2",
      statusText: JSON.stringify({
        v: 2,
        token,
        event: type,
        sequence,
        fingerprint: lifecycleFingerprint(event),
      }),
    });
    write(event);
  } else {
    write({ ...event, ...(token ? { turn_token: token, turn_sequence: sequence } : {}) });
  }
  return sequence;
}

function parseLifecycleMessage(message) {
  const match = /^<!-- pi-subagent-lifecycle:([A-Za-z0-9_.:-]{1,200}) -->\n/.exec(message);
  if (!match) return { message };
  return { token: match[1], message: message.slice(match[0].length) };
}

function settle(message, token, delay = Number(process.env.FAKE_SETTLE_DELAY_MS ?? 10)) {
  const thisTurn = ++turn;
  activeTurnToken = token;
  streaming = true;
  const startSequence = turnEvent("agent_start", token);
  const timer = setTimeout(() => {
    settleTimers.delete(timer);
    const text = `turn ${thisTurn}: ${message} ✓ \u2028 unicode`;
    const assistant = {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: "stop",
      timestamp: Date.now(),
    };
    const terminalSequence = turnEvent("message_end", token, { message: assistant });
    const endSequence = turnEvent("agent_end", token, { messages: [assistant], willRetry: false });
    streaming = false;
    const settlementSequence = turnEvent("agent_settled", token);
    if (message.includes("__duplicate_settlement__"))
      setTimeout(() => turnEvent("agent_settled", token, {}, settlementSequence), 3);
    if (message.includes("__stale_replay__")) {
      setTimeout(() => {
        turnEvent("agent_start", token, {}, startSequence);
        turnEvent("message_end", token, { message: assistant }, terminalSequence);
        turnEvent("agent_end", token, { messages: [assistant], willRetry: false }, endSequence);
        turnEvent("agent_settled", token, {}, settlementSequence);
      }, Number(process.env.FAKE_STALE_REPLAY_DELAY_MS ?? 80));
    }
  }, delay);
  settleTimers.add(timer);
}

function handle(command) {
  if (command.type === "get_state") {
    if (stallDiagnostics) return;
    response(command, true, {
      model: { provider: "fake", id: "fake-model" },
      thinkingLevel: "off",
      isStreaming: streaming,
      sessionFile,
      sessionId: `fake-${process.pid}`,
      pendingMessageCount: 0,
    });
    return;
  }
  if (command.type === "get_session_stats") {
    if (stallDiagnostics) return;
    response(command, true, {
      sessionFile,
      tokens: { input: turn, output: turn, total: turn * 2 },
      cost: 0,
    });
    return;
  }
  if (command.type === "get_env") {
    response(command, true, {
      allowed: process.env.FAKE_ALLOWED,
      denied: process.env.FAKE_DENIED,
      subagent: process.env.PI_SUBAGENT_TEST,
    });
    return;
  }
  if (command.type === "get_last_assistant_text") {
    response(command, true, { text: turn ? `turn ${turn} final` : null });
    return;
  }
  if (command.type === "set_session_name") {
    response(command);
    return;
  }
  if (command.type === "prompt") {
    const parsedPrompt = parseLifecycleMessage(command.message);
    const promptMessage = parsedPrompt.message;
    const promptToken = parsedPrompt.token;
    activeTurnToken = promptToken;
    if (promptMessage.includes("__duplicate_start_precommit__")) {
      turnEvent("agent_start", promptToken);
      turnEvent("agent_start", promptToken);
      response(command);
      return;
    }
    if (
      promptMessage.includes("__duplicate_start_before_ack__") ||
      promptMessage.includes("__duplicate_start__")
    ) {
      turn += 1;
      streaming = true;
      turnEvent("agent_start", promptToken);
      turnEvent("agent_start", promptToken);
      response(command);
      return;
    }
    if (promptMessage.includes("__duplicate_start_after_ack__")) {
      response(command);
      turn += 1;
      streaming = true;
      setTimeout(() => {
        turnEvent("agent_start", promptToken);
        turnEvent("agent_start", promptToken);
      }, Number(process.env.FAKE_POST_ACK_EVENT_DELAY_MS ?? 10));
      return;
    }
    if (promptMessage === "__spawn_nested_rpc__") {
      void (async () => {
        const { RpcProcess } = await import("../../rpc-process.ts");
        const nested = new RpcProcess(
          process.execPath,
          [new URL(import.meta.url).pathname],
          {
            cwd: process.cwd(),
            env: {},
            startupTimeoutMs: 2_000,
            requestTimeoutMs: 2_000,
            shutdownTimeoutMs: 500,
          },
        );
        await nested.start();
        await nested.stop();
        response(command);
        settle(promptMessage, promptToken);
      })().catch((error) => response(command, false, undefined, String(error)));
      return;
    }
    if (promptMessage === "__stall__") return;
    if (promptMessage.includes("__late_response__")) {
      setTimeout(
        () => response(command),
        Number(process.env.FAKE_LATE_RESPONSE_MS ?? 100),
      );
      return;
    }
    if (promptMessage === "__unknown_response__") {
      response(command);
      write({ type: "response", id: "unknown-request", success: true });
      return;
    }
    if (promptMessage === "__invalid_json__") {
      response(command);
      process.stdout.write("{invalid-json}\n");
      return;
    }
    if (promptMessage === "__close_stdin__") {
      response(command);
      process.stdin.destroy();
      setInterval(() => {}, 1_000).unref();
      return;
    }
    if (promptMessage === "__attempt_cgroup_escape__") {
      let outcome = "blocked";
      try {
        const membership = readFileSync("/proc/self/cgroup", "utf8")
          .split(/\r?\n/)
          .find((line) => line.startsWith("0::"))
          ?.slice(3);
        writeFileSync(
          `/sys/fs/cgroup${membership}/../cgroup.procs`,
          String(process.pid),
        );
        outcome = "escaped";
      } catch { /* read-only cgroup mount is the required boundary */ }
      if (process.env.FAKE_GRANDCHILD_PID_FILE)
        writeFileSync(process.env.FAKE_GRANDCHILD_PID_FILE, outcome);
      response(command);
      settle(promptMessage, promptToken);
      return;
    }
    if (promptMessage === "__detached_after_start__") {
      const detached = spawn(
        process.execPath,
        ["-e", "setInterval(()=>{},1000)"],
        { stdio: "ignore", detached: true },
      );
      detached.unref();
      if (process.env.FAKE_GRANDCHILD_PID_FILE)
        writeFileSync(process.env.FAKE_GRANDCHILD_PID_FILE, String(detached.pid));
      response(command);
      setTimeout(() => process.exit(0), 20);
      return;
    }
    if (promptMessage === "__tail_exit__") {
      const assistant = {
        role: "assistant",
        content: [{ type: "text", text: "tail before exit ✓" }],
        stopReason: "stop",
        timestamp: Date.now(),
      };
      const records = [
        {
          id: command.id,
          type: "response",
          command: command.type,
          success: true,
        },
        { type: "message_end", message: assistant },
        { type: "agent_settled" },
      ];
      process.stdout.write(
        records.map((record) => `${JSON.stringify(record)}\n`).join(""),
        () => process.exit(17),
      );
      return;
    }
    if (promptMessage.includes("__late_ack__")) {
      // Execute and settle but deliberately omit the command response.
      settle(promptMessage, promptToken);
      return;
    }
    if (promptMessage.includes("__empty_terminal__")) {
      response(command);
      turn += 1;
      streaming = true;
      turnEvent("agent_start", promptToken);
      const intermediate = {
        role: "assistant",
        content: [{ type: "text", text: "stale intermediate" }],
        stopReason: "stop",
        timestamp: Date.now(),
      };
      turnEvent("message_end", promptToken, { message: intermediate });
      setTimeout(() => {
        const empty = {
          role: "assistant",
          content: [],
          stopReason: "stop",
          timestamp: Date.now(),
        };
        turnEvent("message_end", promptToken, { message: empty });
        streaming = false;
        turnEvent("agent_end", promptToken, { messages: [intermediate, empty], willRetry: false });
        turnEvent("agent_settled", promptToken);
      }, Number(process.env.FAKE_SETTLE_DELAY_MS ?? 10));
      return;
    }
    if (promptMessage.includes("__stall_diagnostics__")) {
      response(command);
      turn += 1;
      streaming = true;
      turnEvent("agent_start", promptToken);
      const assistant = {
        role: "assistant",
        content: [{ type: "text", text: "settled before diagnostics" }],
        stopReason: "stop",
        timestamp: Date.now(),
      };
      turnEvent("message_end", promptToken, { message: assistant });
      turnEvent("agent_end", promptToken, { messages: [assistant], willRetry: false });
      streaming = false;
      stallDiagnostics = true;
      turnEvent("agent_settled", promptToken);
      return;
    }
    if (promptMessage.includes("__slow_settlement__")) {
      response(command);
      turn += 1;
      streaming = true;
      turnEvent("agent_start", promptToken);
      setTimeout(() => {
        const assistant = {
          role: "assistant",
          content: [{ type: "text", text: "current turn output" }],
          stopReason: "stop",
          timestamp: Date.now(),
        };
        turnEvent("message_end", promptToken, { message: assistant });
        turnEvent("agent_end", promptToken, { messages: [assistant], willRetry: false });
      }, Number(process.env.FAKE_CURRENT_TERMINAL_DELAY_MS ?? 40));
      setTimeout(() => {
        streaming = false;
        turnEvent("agent_settled", promptToken);
      }, Number(process.env.FAKE_CURRENT_SETTLE_DELAY_MS ?? 180));
      return;
    }
    if (promptMessage.includes("__no_output__")) {
      response(command);
      turn += 1;
      streaming = true;
      turnEvent("agent_start", promptToken);
      setTimeout(() => {
        streaming = false;
        turnEvent("agent_end", promptToken, { messages: [], willRetry: false });
        if (!promptMessage.includes("__missing_settlement__"))
          turnEvent("agent_settled", promptToken);
      }, Number(process.env.FAKE_SETTLE_DELAY_MS ?? 10));
      return;
    }
    if (promptMessage.includes("__retry_success__") || promptMessage.includes("__retry_empty_success__")) {
      response(command);
      turn += 1;
      streaming = true;
      turnEvent("agent_start", promptToken);
      const failed = {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "transient retry failure",
        timestamp: Date.now(),
      };
      turnEvent("message_end", promptToken, { message: failed });
      turnEvent("extension_error", promptToken, { error: "transient extension retry error" });
      turnEvent("agent_end", promptToken, { messages: [failed], willRetry: true });
      setTimeout(() => {
        turnEvent("agent_start", promptToken);
        const recovered = {
          role: "assistant",
          content: promptMessage.includes("__retry_empty_success__")
            ? []
            : [{ type: "text", text: "recovered answer" }],
          stopReason: "stop",
          timestamp: Date.now(),
        };
        turnEvent("message_end", promptToken, { message: recovered });
        streaming = false;
        turnEvent("agent_end", promptToken, { messages: [recovered], willRetry: false });
        turnEvent("agent_settled", promptToken);
      }, Number(process.env.FAKE_SETTLE_DELAY_MS ?? 10));
      return;
    }
    if (promptMessage.includes("__error__")) {
      response(command);
      turn += 1;
      streaming = true;
      turnEvent("agent_start", promptToken);
      setTimeout(() => {
        const assistant = {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "fixture turn failed",
          timestamp: Date.now(),
        };
        turnEvent("message_end", promptToken, { message: assistant });
        streaming = false;
        turnEvent("agent_end", promptToken, { messages: [assistant], willRetry: false });
        turnEvent("agent_settled", promptToken);
      }, Number(process.env.FAKE_SETTLE_DELAY_MS ?? 10));
      return;
    }
    if (promptMessage.includes("__crash_before_ack__")) {
      setTimeout(() => process.exit(23), 1);
      return;
    }
    if (promptMessage.includes("__crash__")) {
      response(command);
      setTimeout(() => process.exit(19), 5);
      return;
    }
    response(command);
    settle(promptMessage, promptToken);
    return;
  }
  if (command.type === "steer" || command.type === "follow_up") {
    const delay = Number(process.env.FAKE_STEER_RESPONSE_DELAY_MS ?? 0);
    if (delay > 0) setTimeout(() => response(command), delay);
    else response(command);
    return;
  }
  if (command.type === "abort") {
    if (process.env.FAKE_ABORT_STALL === "1") {
      if (process.env.FAKE_ABORT_SETTLEMENT_ONLY_DELAY_MS !== undefined) {
        const token = activeTurnToken;
        setTimeout(
          () => turnEvent("agent_settled", token),
          Number(process.env.FAKE_ABORT_SETTLEMENT_ONLY_DELAY_MS),
        );
      }
      return;
    }
    const finishAbort = () => {
      if (process.env.FAKE_ABORT_FAIL === "1") {
        response(command, false, undefined, "fixture abort rejected");
        return;
      }
      response(command);
      for (const timer of settleTimers) clearTimeout(timer);
      settleTimers.clear();
      streaming = false;
      if (process.env.FAKE_DROP_ABORT_SETTLEMENT !== "1") {
        const token = activeTurnToken;
        const abortSettleDelay = Number(process.env.FAKE_ABORT_SETTLE_DELAY_MS ?? 0);
        if (abortSettleDelay > 0)
          setTimeout(() => turnEvent("agent_settled", token), abortSettleDelay);
        else turnEvent("agent_settled", token);
      }
    };
    const responseDelay = Number(process.env.FAKE_ABORT_RESPONSE_DELAY_MS ?? 0);
    if (responseDelay > 0) setTimeout(finishAbort, responseDelay);
    else finishAbort();
    return;
  }
  if (command.type === "extension_ui_response") {
    write({
      type: "fake_ui_cancelled",
      id: command.id,
      cancelled: command.cancelled === true,
    });
    return;
  }
  response(command, false, undefined, `unsupported ${command.type}`);
}

process.stdin.on("data", (chunk) => {
  buffer += decoder.write(chunk);
  while (true) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    let line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line.trim()) continue;
    handle(JSON.parse(line));
  }
});

process.stdin.on("end", () => {
  void treeBroker?.close().finally(() => process.exit(0));
  if (!treeBroker) process.exit(0);
});

if (process.env.FAKE_STDERR === "1") {
  const stderr = Buffer.from("discard-prefix-✓tail", "utf8");
  const unicode = stderr.indexOf(Buffer.from("✓", "utf8"));
  process.stderr.write(stderr.subarray(0, unicode + 1));
  process.stderr.write(stderr.subarray(unicode + 1));
}

if (process.env.FAKE_STARTUP_EXTENSION_ERROR === "1") {
  write({
    type: "extension_error",
    event: "session_start",
    error: "Cannot reconstruct inherited active tools in child: unregistered_extension_tool",
  });
}

if (process.env.FAKE_DIALOG === "1") {
  setTimeout(
    () =>
      write({
        type: "extension_ui_request",
        id: "dialog-1",
        method: "confirm",
        title: "unexpected",
        message: "must auto-cancel",
      }),
    5,
  );
}
