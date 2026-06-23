import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import { toolArgsPreview } from "./text.ts";
import type { AssistantItem, ChatItem, ToolItem } from "./types.ts";

export class SideChatEventState {
  private currentAssistant?: AssistantItem;
  private activeTools = new Map<string, ToolItem>();

  constructor(
    private readonly items: ChatItem[],
    private readonly changed: () => void,
  ) {}

  addStatus(level: "info" | "warning" | "error", text: string): void {
    this.items.push({ kind: "status", level, text });
    this.changed();
  }

  finishRunningAssistant(): void {
    if (this.currentAssistant) this.currentAssistant.running = false;
    this.currentAssistant = undefined;
  }

  handle(event: AgentSessionEvent): void {
    switch (event.type) {
      case "message_start":
        if (isAssistantMessage(event.message)) this.startAssistant();
        break;
      case "message_update":
        if (event.assistantMessageEvent.type === "text_delta") {
          this.appendAssistant(event.assistantMessageEvent.delta);
        }
        break;
      case "message_end":
        if (isAssistantMessage(event.message)) this.finishAssistant(event.message);
        break;
      case "tool_execution_start":
        this.startTool(event.toolCallId, event.toolName, event.args);
        break;
      case "tool_execution_end":
        this.finishTool(event.toolCallId, event.toolName, event.isError);
        break;
      case "agent_end":
        if (event.willRetry) {
          this.addStatus("warning", "Side agent will retry after a provider error…");
        }
        break;
      case "auto_retry_start":
        this.addStatus(
          "warning",
          `Retrying side answer (${event.attempt}/${event.maxAttempts})…`,
        );
        break;
      case "compaction_start":
        this.addStatus("info", "Side context is compacting…");
        break;
    }
  }

  private startAssistant(): void {
    this.currentAssistant = { kind: "assistant", text: "", running: true };
    this.items.push(this.currentAssistant);
    this.changed();
  }

  private appendAssistant(delta: string): void {
    if (!this.currentAssistant) this.startAssistant();
    this.currentAssistant!.text += delta;
    this.changed();
  }

  private finishAssistant(message: AssistantMessage): void {
    const text = assistantText(message);
    if (!this.currentAssistant) {
      this.currentAssistant = { kind: "assistant", text, running: false };
      this.items.push(this.currentAssistant);
    } else if (!this.currentAssistant.text.trim() && text) {
      this.currentAssistant.text = text;
    }
    this.currentAssistant.running = false;
    this.currentAssistant.stopReason = message.stopReason;
    this.changed();
  }

  private startTool(id: string, name: string, args: unknown): void {
    const preview = toolArgsPreview(args);
    const item: ToolItem = {
      kind: "tool",
      status: "running",
      text: `${name}${preview ? ` ${preview}` : ""}`,
    };
    this.activeTools.set(id, item);
    this.items.push(item);
    this.changed();
  }

  private finishTool(id: string, name: string, isError: boolean): void {
    const item = this.activeTools.get(id);
    if (item) item.status = isError ? "error" : "done";
    else {
      this.items.push({
        kind: "tool",
        status: isError ? "error" : "done",
        text: name,
      });
    }
    this.activeTools.delete(id);
    this.changed();
  }
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
  return Boolean(
    message &&
      typeof message === "object" &&
      (message as { role?: string }).role === "assistant",
  );
}
