import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";

export type ChatItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; running?: boolean; stopReason?: string }
  | { kind: "tool"; text: string; status: "running" | "done" | "error" }
  | { kind: "status"; text: string; level: "info" | "warning" | "error" };

export type AssistantItem = Extract<ChatItem, { kind: "assistant" }>;
export type ToolItem = Extract<ChatItem, { kind: "tool" }>;

export interface SideChatSnapshot {
  cwd: string;
  model: Model<any>;
  modelRegistry: ModelRegistry;
  thinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]>;
  inheritedMessages: AgentMessage[];
  systemPrompt: string;
  inheritedWhileMainRunning: boolean;
}
