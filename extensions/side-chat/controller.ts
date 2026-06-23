import type { AgentSession } from "@earendil-works/pi-coding-agent";

import { SideChatEventState } from "./event-state.ts";
import { createSideSession } from "./side-session.ts";
import type { ChatItem, SideChatSnapshot } from "./types.ts";

export class SideChatController {
  readonly items: ChatItem[] = [];

  private readonly events = new SideChatEventState(this.items, () => this.changed());
  private session?: AgentSession;
  private initPromise?: Promise<AgentSession>;
  private runPromise?: Promise<void>;
  private unsubscribe?: () => void;
  private requestRender?: () => void;
  private closed = false;

  constructor(readonly snapshot: SideChatSnapshot) {
    const count = snapshot.inheritedMessages.length;
    const plural = count === 1 ? "" : "s";
    this.events.addStatus(
      "info",
      `Side chat opened with ${count} inherited context message${plural}. ` +
        "Main history will not receive this chat.",
    );
    if (snapshot.inheritedWhileMainRunning) {
      this.events.addStatus(
        "warning",
        "Main agent was running when /btw opened; the snapshot may miss its partial current answer.",
      );
    }
  }

  get isBusy(): boolean {
    return Boolean(this.runPromise);
  }

  setRequestRender(fn: () => void): void {
    this.requestRender = fn;
  }

  submit(text: string): boolean {
    const question = text.trim();
    if (!question || this.closed) return false;
    if (this.runPromise) {
      this.events.addStatus("warning", "Wait for the current side answer to finish first.");
      return false;
    }

    this.items.push({ kind: "user", text: question });
    this.runPromise = this.run(question)
      .catch((err) => {
        if (!this.closed) this.events.addStatus("error", errorText(err));
      })
      .finally(() => {
        this.events.finishRunningAssistant();
        this.runPromise = undefined;
        this.changed();
      });
    this.changed();
    return true;
  }

  async dispose(): Promise<void> {
    this.closed = true;
    try {
      if (this.session?.isStreaming) await this.session.abort();
    } catch {
      // Ignore abort failures during overlay close.
    }
    this.unsubscribe?.();
    this.session?.dispose();
  }

  private async run(question: string): Promise<void> {
    const session = await this.ensureSession();
    if (!this.closed) {
      await session.prompt(question, {
        expandPromptTemplates: false,
        source: "extension",
      });
    }
  }

  private async ensureSession(): Promise<AgentSession> {
    if (this.session) return this.session;
    if (this.initPromise) return this.initPromise;

    this.events.addStatus("info", `Starting side agent on ${this.snapshot.model.id}…`);
    this.initPromise = createSideSession(this.snapshot).then((session) => {
      this.unsubscribe = session.subscribe((event) => {
        if (!this.closed) this.events.handle(event);
      });
      this.session = session;
      return session;
    });
    return this.initPromise;
  }

  private changed(): void {
    this.requestRender?.();
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
