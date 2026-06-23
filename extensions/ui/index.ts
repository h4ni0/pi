import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  refreshChatGptUsage,
  resetChatGptUsage,
} from "./chatgptUsage.ts";
import { editors, notifyEditors } from "./editorRegistry.ts";
import { updateBranch } from "./git.ts";
import { bigPiHeader } from "./piHeader.ts";
import { updateState } from "./state.ts";
import { subscribeSubagents } from "./subagents.ts";
import { TerminalEditor } from "./terminalEditor.ts";
import { clearTerminal } from "./terminal.ts";
import type { UiTheme } from "./types.ts";

// UI extension: startup header, terminal-style editor, and footer cleanup.
let unsubscribeSubagents: (() => void) | undefined;

export default function uiExtension(pi: ExtensionAPI) {
  pi.on("session_start", async (event, ctx) => {
    if (ctx.mode !== "tui") return;

    if (event.reason === "startup" || event.reason === "resume")
      clearTerminal();

    updateState(ctx, pi);
    void updateBranch(pi);
    void refreshChatGptUsage(ctx, { force: true });
    unsubscribeSubagents?.();
    unsubscribeSubagents = subscribeSubagents(notifyEditors);

    ctx.ui.setHeader((_tui, theme) => ({
      render: () => bigPiHeader(theme as unknown as UiTheme),
      invalidate: () => {},
    }));

    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const editor = new TerminalEditor(tui, theme, keybindings);
      editors.add(editor);
      return editor;
    });

    // Move the model/thinking/folder/branch/context information into the editor
    // header, so the default footer does not duplicate it under the prompt.
    ctx.ui.setFooter((_tui, _theme) => ({
      render: () => [],
      invalidate: () => {},
    }));
  });

  pi.on("model_select", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    updateState(ctx, pi);
    void refreshChatGptUsage(ctx, { force: true });
    notifyEditors();
  });

  pi.on("thinking_level_select", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    updateState(ctx, pi);
    notifyEditors();
  });

  pi.on("message_end", async (event, ctx) => {
    if (ctx.mode !== "tui") return;
    updateState(ctx, pi);
    if (event.message.role === "assistant") void refreshChatGptUsage(ctx);
    notifyEditors();
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    updateState(ctx, pi);
    void updateBranch(pi);
    void refreshChatGptUsage(ctx);
    notifyEditors();
  });

  pi.on("session_shutdown", async () => {
    resetChatGptUsage();
    unsubscribeSubagents?.();
    unsubscribeSubagents = undefined;
    editors.clear();
  });
}
