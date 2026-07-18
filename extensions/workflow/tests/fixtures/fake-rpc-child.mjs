import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const scenario = process.env.WF_RPC_SCENARIO ?? "settled";

if (scenario === "ignore-term") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
}
if (scenario === "stderr") {
  process.stderr.write("z".repeat(256 * 1024));
}
if (scenario === "exit") {
  process.stdin.resume();
  setTimeout(() => process.exit(7), 10);
}
if (scenario === "orphan-descendant") {
  const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  descendant.unref();
  writeFileSync(process.env.WF_RPC_DESCENDANT_PID_FILE, String(descendant.pid));
  setTimeout(() => process.exit(0), 20);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const command = JSON.parse(line);
    if (scenario === "never") continue;
    if (command.type === "prompt") {
      process.stdout.write(`${JSON.stringify({ type: "response", id: command.id, command: "prompt", success: true })}\n`);
      if (scenario === "settlement-timeout") continue;
      if (scenario === "close-after-prompt") {
        setTimeout(() => process.exit(9), 5);
        continue;
      }
      if (scenario === "malformed") {
        process.stdout.write("{not json}\n");
        continue;
      }
      if (scenario === "oversized") {
        process.stdout.write(`${"x".repeat(4096)}\n`);
        continue;
      }
      if (scenario === "settled") {
        process.stdout.write(`${JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "error", reason: "error", error: { errorMessage: "transient" } } })}\n`);
        process.stdout.write(`${JSON.stringify({ type: "agent_end", messages: [], willRetry: true })}\n`);
        process.stdout.write(`${JSON.stringify({ type: "compaction_start", reason: "overflow" })}\n`);
        process.stdout.write(`${JSON.stringify({ type: "compaction_end", reason: "overflow", result: {}, willRetry: true })}\n`);
        process.stdout.write(`${JSON.stringify({ type: "agent_end", messages: [], willRetry: false })}\n`);
        process.stdout.write(`${JSON.stringify({ type: "agent_settled" })}\n`);
      } else if (scenario === "get-state-malformed" || scenario === "get-state-timeout") {
        process.stdout.write(`${JSON.stringify({ type: "agent_settled" })}\n`);
      } else if (scenario === "steer-race") {
        setTimeout(() => process.stdout.write(`${JSON.stringify({ type: "agent_settled" })}\n`), 20);
      }
    } else if (command.type === "steer" && scenario === "steer-race") {
      setTimeout(() => process.stdout.write(`${JSON.stringify({ type: "response", id: command.id, command: "steer", success: true })}\n`), 40);
      setTimeout(() => process.stdout.write(`${JSON.stringify({ type: "agent_settled" })}\n`), 80);
    } else if (command.type === "get_messages") {
      process.stdout.write(`${JSON.stringify({ type: "response", id: command.id, command: "get_messages", success: true, data: { messages: [] } })}\n`);
    } else if (command.type === "get_state" && scenario === "get-state-malformed") {
      process.stdout.write("{not json}\n");
    } else if (command.type === "get_state" && scenario === "get-state-timeout") {
      // Deliberately never respond.
    } else if (command.type === "abort") {
      process.stdout.write(`${JSON.stringify({ type: "response", id: command.id, command: "abort", success: true })}\n`);
    }
  }
});
