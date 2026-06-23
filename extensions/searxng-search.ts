import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_BASE_URL = "http://192.168.1.50:6767/";

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web using the user's local SearXNG instance.",
    promptSnippet:
      "Search the web via local SearXNG and return relevant results with URLs and snippets",
    promptGuidelines: [
      "Use web_search when current or external information is needed and the user allows internet search.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 40,
          default: 20,
          description: "Maximum number of results to return (default: 20)",
        }),
      ),
      timeRange: Type.Optional(
        Type.String({
          description: "Optional time range: day, month, or year",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      const query = asString(params.query).trim();
      if (!query) {
        return {
          isError: true,
          content: [
            { type: "text", text: "web_search requires a non-empty query." },
          ],
          details: { error: "empty_query" },
        };
      }

      const limit = Math.max(1, Math.min(40, Number(params.limit ?? 20)));
      const url = new URL("/search", DEFAULT_BASE_URL);
      url.searchParams.set("q", query);
      url.searchParams.set("format", "json");

      if (params.timeRange)
        url.searchParams.set("time_range", asString(params.timeRange));

      onUpdate?.({
        content: [{ type: "text", text: `Searching SearXNG for: ${query}` }],
      });

      try {
        const response = await fetch(url, {
          signal,
          headers: {
            Accept: "application/json",
            "User-Agent": "pi-web-search-extension/1.0",
          },
        });

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `SearXNG request failed: HTTP ${response.status}${body ? ` - ${body.slice(0, 500)}` : ""}`,
              },
            ],
            details: { status: response.status, url: url.toString() },
          };
        }

        const data = (await response.json()) as any;
        const results = Array.isArray(data.results)
          ? data.results.slice(0, limit).map((item: any) => ({
              title: asString(item.title),
              url: asString(item.url),
              content: asString(item.content),
              engine:
                asString(item.engine) ||
                (Array.isArray(item.engines) ? item.engines.join(",") : ""),
              publishedDate:
                asString(item.publishedDate) || asString(item.published_date),
            }))
          : [];

        const text = results.length
          ? results
              .map((result: any, index: number) => {
                const parts = [
                  `${index + 1}. ${result.title || "Untitled"}`,
                  `   ${result.url}`,
                ];
                if (result.content) parts.push(`   ${result.content}`);
                if (result.engine) parts.push(`   engine: ${result.engine}`);
                return parts.join("\n");
              })
              .join("\n\n")
          : "No results found.";

        return {
          content: [{ type: "text", text }],
          details: {
            query,
            DEFAULT_BASE_URL,
            resultCount: results.length,
            results,
            answers: Array.isArray(data.answers) ? data.answers : [],
            infoboxes: Array.isArray(data.infoboxes) ? data.infoboxes : [],
            suggestions: Array.isArray(data.suggestions)
              ? data.suggestions
              : [],
          },
        };
      } catch (error: any) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `SearXNG search failed: ${error?.message ?? String(error)}`,
            },
          ],
          details: {
            error: error?.message ?? String(error),
            url: url.toString(),
          },
        };
      }
    },
  });
}
