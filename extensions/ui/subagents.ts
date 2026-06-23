import { color } from "./formatting.ts";

const SUBAGENTS_GLOBAL_STATUS_KEY = "__pi_subagents_status_v1";

type SubagentsStatus = {
  running: number;
  total: number;
  waiting: number;
  nested: number;
  inside?: string;
  updatedAt: number;
  listeners: Set<() => void>;
};

function subagentsStatus(): SubagentsStatus {
  const root = globalThis as any;
  root[SUBAGENTS_GLOBAL_STATUS_KEY] ??= {
    running: 0,
    total: 0,
    waiting: 0,
    nested: 0,
    updatedAt: 0,
    listeners: new Set<() => void>(),
  };
  root[SUBAGENTS_GLOBAL_STATUS_KEY].listeners ??= new Set<() => void>();
  return root[SUBAGENTS_GLOBAL_STATUS_KEY] as SubagentsStatus;
}

export function subagentsLabel(): string | undefined {
  const status = subagentsStatus();
  if (!status.total && !status.inside) return undefined;
  const bits = [`${status.running}/${status.total}`];
  if (status.waiting) bits.push(color("warning", `${status.waiting} waiting`));
  if (status.nested) bits.push(`${status.nested} nested`);
  if (status.inside) bits.push(`inside ${status.inside}`);
  return [
    color("customMessageLabel", "agents"),
    color("muted", bits.join(" · ")),
  ].join(" ");
}

export function subscribeSubagents(listener: () => void): () => void {
  const status = subagentsStatus();
  status.listeners.add(listener);
  return () => status.listeners.delete(listener);
}
