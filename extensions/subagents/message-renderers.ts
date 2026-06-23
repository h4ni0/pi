import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, keyHint } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import {
  ASK_PARENT_EXCHANGE_MESSAGE_TYPE,
  COMPLETION_MESSAGE_TYPE,
  NOTICE_MESSAGE_TYPE,
  QUESTION_MESSAGE_TYPE,
} from "./constants.ts";
import { OneLineList } from "./render-utils.ts";
import type { CompletionPayload } from "./types.ts";
import { oneLine } from "./utils.ts";

export function registerSubagentMessageRenderers(pi: ExtensionAPI): void {
  pi.registerMessageRenderer(
    COMPLETION_MESSAGE_TYPE,
    (message, _options, theme) => {
      const details = message.details as CompletionPayload | undefined;
      const content = typeof message.content === "string" ? message.content : "";
      const output = details?.output || content;
      return new OneLineList(output ? [theme.fg("toolOutput", oneLine(output, 220))] : []);
    },
  );

  pi.registerMessageRenderer(
    NOTICE_MESSAGE_TYPE,
    (message, _options, theme) => {
      const content =
        typeof message.content === "string" ? message.content : "";
      return new Text(
        `${theme.fg("warning", theme.bold("Sub-agent notice"))}\n${theme.fg("toolOutput", content)}`,
        0,
        0,
      );
    },
  );

  pi.registerMessageRenderer(
    QUESTION_MESSAGE_TYPE,
    (message, _options, theme) => {
      const content =
        typeof message.content === "string" ? message.content : "";
      return new Text(
        `${theme.fg("warning", theme.bold("Sub-agent question"))}\n${theme.fg("toolOutput", content)}`,
        0,
        0,
      );
    },
  );

  pi.registerMessageRenderer(
    ASK_PARENT_EXCHANGE_MESSAGE_TYPE,
    (message, options, theme) => {
      const content =
        typeof message.content === "string" ? message.content : "";
      const details = message.details as any;
      const container = new Container();
      const label = details?.childId
        ? `${details.childId} ${details.label ?? ""}`.trim()
        : "ask_parent";
      container.addChild(
        new Text(
          `${theme.fg("toolTitle", theme.bold("ask_parent"))} ${theme.fg("accent", label)} ${theme.fg("dim", "parent exchange")}`,
          0,
          0,
        ),
      );
      if (options.expanded) {
        container.addChild(new Spacer(1));
        container.addChild(new Markdown(content, 0, 0, getMarkdownTheme()));
      } else {
        const question =
          details?.request?.question ||
          details?.request?.message ||
          "child question";
        const answer = details?.answer || content;
        container.addChild(
          new Text(
            `${theme.fg("muted", "Q:")} ${theme.fg("toolOutput", oneLine(question, 180))}`,
            0,
            0,
          ),
        );
        container.addChild(
          new Text(
            `${theme.fg("muted", "A:")} ${theme.fg("toolOutput", oneLine(answer, 220))}`,
            0,
            0,
          ),
        );
        container.addChild(
          new Text(
            theme.fg("dim", keyHint("app.tools.expand", "expand")),
            0,
            0,
          ),
        );
      }
      return container;
    },
  );
}
