#!/usr/bin/env bun
import * as path from "node:path";
import {
  defaultBrokerSocketDirectory,
  maintainBrokerSockets,
} from "../runtime/broker-socket.ts";

export async function runBrokerSocketMaintenanceCli(
  args: string[],
): Promise<void> {
  let mode: "dry-run" | "apply" | undefined;
  let directory = defaultBrokerSocketDirectory();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--apply" || argument === "--dry-run") {
      const requested = argument === "--apply" ? "apply" : "dry-run";
      if (mode && mode !== requested)
        throw new Error("--apply and --dry-run are mutually exclusive");
      mode = requested;
      continue;
    }
    if (argument === "--directory") {
      const value = args[++index];
      if (!value) throw new Error("--directory requires an absolute path");
      if (!path.isAbsolute(value)) throw new Error("--directory requires an absolute path");
      directory = value;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      process.stdout.write(
        "Usage: broker-socket-maintenance.ts [--dry-run | --apply] [--directory <absolute-path>]\n",
      );
      return;
    }
    throw new Error(`Unknown broker socket maintenance option '${argument}'`);
  }

  const result = await maintainBrokerSockets(directory, { apply: mode === "apply" });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.main) {
  runBrokerSocketMaintenanceCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
