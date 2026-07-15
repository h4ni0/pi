import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import {
  MAX_WAIT_DELAY_SECONDS,
  MIN_WAIT_DELAY_SECONDS,
} from "./constants.ts";
import type { ForkTurns } from "./types.ts";

const strict = { additionalProperties: false } as const;

export const DelegateParams = Type.Object(
  {
    title: Type.Optional(
      Type.String({
        description:
          "Short UI title for this sub-agent. Displayed as: Delegate: <title>.",
      }),
    ),
    task: Type.String({
      description: "The delegated task for one general-purpose sub-agent.",
    }),
    context: Type.Optional(
      StringEnum(["compact", "fresh"] as const, {
        description:
          "compact (default) passes an ephemeral parent handoff summary; fresh passes no parent context.",
        default: "compact",
      }),
    ),
  },
  strict,
);

export const AskParentParams = Type.Object(
  {
    message: Type.String({
      description: "Concise explanation of what the parent agent needs to know.",
    }),
    reason: StringEnum(
      [
        "need_decision",
        "need_clarification",
        "blocked",
        "risk_detected",
        "course_change",
      ] as const,
      {
        description: "Why this is being escalated to the immediate parent agent.",
      },
    ),
    blocking: Type.Optional(
      Type.Boolean({
        description:
          "Whether the child must pause until the parent agent answers. Default true.",
        default: true,
      }),
    ),
    question: Type.Optional(
      Type.String({
        description:
          "Specific question for the parent agent to answer, if different from message.",
      }),
    ),
    options: Type.Optional(
      Type.Array(Type.String(), {
        description: "Clear choices the parent agent can pick from.",
      }),
    ),
    recommendation: Type.Optional(
      Type.String({
        description: "Child's recommended option or safe next step.",
      }),
    ),
  },
  strict,
);

export const SpawnAgentParams = Type.Object(
  {
    task_name: Type.String({
      minLength: 1,
      pattern: "^(?!root$)[a-z0-9_]+$",
      description:
        "Task name for the new agent. Use lowercase letters, digits, and underscores; `root` is reserved.",
    }),
    message: Type.String({
      minLength: 1,
      description: "Initial plain-text task for the new agent.",
    }),
    fork_turns: Type.Optional(
      Type.String({
        pattern: "^(none|all|[1-9][0-9]*)$",
        description:
          "Optional number of turns to fork. Defaults to `all`. Use `none`, `all`, or a positive integer string such as `3`.",
        default: "all",
      }),
    ),
  },
  strict,
);

export const SendMessageParams = Type.Object(
  {
    target: Type.String({
      minLength: 1,
      description:
        "Relative or canonical task name to message (opaque Pi IDs are accepted as compatibility aliases).",
    }),
    message: Type.String({
      minLength: 1,
      description: "Message to enqueue for the target.",
    }),
  },
  strict,
);

export const FollowupTaskParams = Type.Object(
  {
    target: Type.String({
      minLength: 1,
      description:
        "Relative or canonical task name for the follow-up (opaque Pi IDs are accepted as compatibility aliases).",
    }),
    message: Type.String({
      minLength: 1,
      description: "New task to enqueue and trigger for the target.",
    }),
  },
  strict,
);

export const InterruptAgentParams = Type.Object(
  {
    target: Type.String({
      minLength: 1,
      description:
        "Relative or canonical spawned-agent task name (opaque Pi IDs are accepted as compatibility aliases).",
    }),
  },
  strict,
);

const WaitDelaySeconds = Type.Integer({
  minimum: MIN_WAIT_DELAY_SECONDS,
  maximum: MAX_WAIT_DELAY_SECONDS,
  description:
    "Standalone clock delay in seconds (1 to 3,600). It does not select, poll, or wait for agents.",
});

/** Agent selection and clock delay are distinct, mutually exclusive modes. */
export const WaitAgentParams = Type.Union([
  Type.Object(
    {
      target: Type.String({
        minLength: 1,
        description:
          "Wait indefinitely for one same-tree non-self agent (opaque IDs are accepted as compatibility aliases).",
      }),
    },
    strict,
  ),
  Type.Object(
    {
      all: Type.Literal(true, {
        description: "Wait indefinitely for all snapshotted nonterminal descendants.",
      }),
    },
    strict,
  ),
  Type.Object(
    { seconds: WaitDelaySeconds },
    strict,
  ),
  Type.Object({}, strict),
]);

export const ListAgentsParams = Type.Object(
  {
    path_prefix: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Optional canonical or caller-relative path prefix within this root agent tree.",
      }),
    ),
  },
  strict,
);

/** Normalize the canonical v2 fork selector without consulting legacy settings. */
export function parseForkTurns(value: unknown): ForkTurns {
  if (value === undefined) return "all";
  if (
    typeof value === "string" &&
    (value === "none" || value === "all" || /^[1-9][0-9]*$/.test(value))
  )
    return value as ForkTurns;
  throw new Error(
    "fork_turns must be `none`, `all`, or a positive integer string",
  );
}

export type SpawnAgentInput = Static<typeof SpawnAgentParams>;
export type SendMessageInput = Static<typeof SendMessageParams>;
export type FollowupTaskInput = Static<typeof FollowupTaskParams>;
export type InterruptAgentInput = Static<typeof InterruptAgentParams>;
export type WaitAgentInput = Static<typeof WaitAgentParams>;
export type ListAgentsInput = Static<typeof ListAgentsParams>;

/** Defense-in-depth for direct callers that bypass TypeBox validation. */
export function parseWaitAgentInput(value: unknown): WaitAgentInput {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("wait_agent arguments must be an object");
  const input = value as Record<string, unknown>;
  const allowed = new Set(["target", "all", "seconds"]);
  for (const key of Object.keys(input))
    if (!allowed.has(key)) throw new Error(`Unknown wait_agent argument '${key}'`);
  const modes = [input.target, input.all, input.seconds]
    .filter((item) => item !== undefined).length;
  if (modes > 1)
    throw new Error("wait_agent target, all, and seconds are mutually exclusive");
  if (
    input.target !== undefined &&
    (typeof input.target !== "string" || input.target.length === 0)
  ) throw new Error("wait_agent target must be a non-empty agent reference");
  if (input.all !== undefined && input.all !== true)
    throw new Error("wait_agent all must be true when provided");
  const seconds = input.seconds;
  if (
    seconds !== undefined &&
    (!Number.isInteger(seconds) ||
      Number(seconds) < MIN_WAIT_DELAY_SECONDS ||
      Number(seconds) > MAX_WAIT_DELAY_SECONDS)
  ) {
    throw new Error(
      `seconds must be an integer between ${MIN_WAIT_DELAY_SECONDS} and ${MAX_WAIT_DELAY_SECONDS}`,
    );
  }
  return input as WaitAgentInput;
}
