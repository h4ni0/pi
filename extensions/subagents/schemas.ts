import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

export const DelegateParams = Type.Object({
  title: Type.Optional(
    Type.String({
      description: "Short UI title for this sub-agent. Displayed as: Delegate: <title>.",
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
});

export const AskParentParams = Type.Object({
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
});
