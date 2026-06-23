import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  withFileMutationQueue,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_BASE_URL = "http://192.168.1.50:3002";
const DEFAULT_FETCH_MAX_CHARS = 20_000;
const DEFAULT_SEARCH_RESULT_CHARS = 4_000;
const DEFAULT_CRAWL_PAGE_CHARS = 4_000;

function baseUrl(): string {
  return (
    process.env.PI_FIRECRAWL_BASE_URL ||
    process.env.FIRECRAWL_BASE_URL ||
    DEFAULT_BASE_URL
  ).replace(/\/+$/, "");
}

function apiKey(): string | undefined {
  return process.env.PI_FIRECRAWL_API_KEY || process.env.FIRECRAWL_API_KEY;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function parseCommaList(value: unknown, allowed?: readonly string[]): string[] {
  const raw = Array.isArray(value)
    ? value.map(String)
    : asString(value)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

  const allowedSet = allowed ? new Set(allowed) : undefined;
  return raw.filter((item) => !allowedSet || allowedSet.has(item));
}

function timeRangeToTbs(value: unknown): string | undefined {
  const normalized = asString(value).trim().toLowerCase();
  if (!normalized) return undefined;
  if (["day", "d", "24h"].includes(normalized)) return "qdr:d";
  if (["week", "w", "7d"].includes(normalized)) return "qdr:w";
  if (["month", "m", "30d"].includes(normalized)) return "qdr:m";
  if (["year", "y", "365d"].includes(normalized)) return "qdr:y";
  return normalized;
}

function headers(): Record<string, string> {
  const result: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": "pi-firecrawl-extension/1.0",
  };
  const key = apiKey();
  if (key) result.Authorization = `Bearer ${key}`;
  return result;
}

async function parseResponse(response: Response, path: string): Promise<any> {
  const text = await response.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = undefined;
  }

  if (!response.ok || data?.success === false) {
    const message = data?.error || data?.message || text.slice(0, 800) || response.statusText;
    throw new Error(`Firecrawl ${path} failed: HTTP ${response.status} - ${message}`);
  }

  return data ?? { raw: text };
}

async function firecrawlPost(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
  const response = await fetch(`${baseUrl()}${path}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
    signal,
  });
  return parseResponse(response, path);
}

async function firecrawlGet(path: string, signal?: AbortSignal): Promise<any> {
  const response = await fetch(`${baseUrl()}${path}`, {
    method: "GET",
    headers: headers(),
    signal,
  });
  return parseResponse(response, path);
}

async function writeTempOutput(prefix: string, output: string): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), prefix));
  const tempFile = join(tempDir, "output.txt");
  await withFileMutationQueue(tempFile, async () => writeFile(tempFile, output, "utf8"));
  return tempFile;
}

async function truncateOutput(output: string, tempPrefix: string): Promise<{
  text: string;
  truncation?: TruncationResult;
  fullOutputPath?: string;
}> {
  const truncation = truncateHead(output, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });

  if (!truncation.truncated) return { text: output };

  const fullOutputPath = await writeTempOutput(tempPrefix, output);
  let text = truncation.content;
  text += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
  text += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
  text += ` Full output saved to: ${fullOutputPath}]`;
  return { text, truncation, fullOutputPath };
}

function clip(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: `${text.slice(0, maxChars)}\n\n[Field truncated at ${maxChars.toLocaleString()} of ${text.length.toLocaleString()} chars]`,
    truncated: true,
  };
}

function documentContent(doc: any, maxChars: number): { text: string; truncatedFields: string[] } {
  const parts: string[] = [];
  const truncatedFields: string[] = [];

  const add = (label: string, value: unknown) => {
    if (typeof value !== "string" || !value.trim()) return;
    const clipped = clip(value.trim(), maxChars);
    if (clipped.truncated) truncatedFields.push(label);
    parts.push(`${label}:\n${clipped.text}`);
  };

  add("Markdown", doc?.markdown ?? doc?.content);
  add("Summary", doc?.summary);
  if (doc?.json !== undefined) add("JSON", JSON.stringify(doc.json, null, 2));
  if (Array.isArray(doc?.links) && doc.links.length) add("Links", doc.links.join("\n"));
  if (Array.isArray(doc?.images) && doc.images.length) add("Images", doc.images.join("\n"));
  add("HTML", doc?.html);
  add("Raw HTML", doc?.rawHtml);

  return {
    text: parts.join("\n\n") || "(No content returned.)",
    truncatedFields,
  };
}

function documentHeader(doc: any): string {
  const metadata = doc?.metadata ?? {};
  const lines = [
    metadata.title || doc?.title ? `Title: ${metadata.title || doc.title}` : undefined,
    metadata.description || doc?.description ? `Description: ${metadata.description || doc.description}` : undefined,
    metadata.sourceURL || metadata.url || doc?.url ? `URL: ${metadata.sourceURL || metadata.url || doc.url}` : undefined,
    metadata.statusCode ? `Status: ${metadata.statusCode}` : undefined,
    metadata.contentType ? `Content-Type: ${metadata.contentType}` : undefined,
  ].filter(Boolean);
  return lines.join("\n");
}

function parseFormats(value: unknown): string[] {
  const formats = parseCommaList(value || "markdown", [
    "markdown",
    "html",
    "rawHtml",
    "links",
    "images",
    "summary",
  ]);
  return formats.length ? formats : ["markdown"];
}

async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("Cancelled");
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
  if (signal?.aborted) throw new Error("Cancelled");
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: "Fetch and extract a URL using the user's self-hosted Firecrawl instance at 192.168.1.50:3002.",
    promptSnippet: "Fetch a specific URL through self-hosted Firecrawl and return clean Markdown/text",
    promptGuidelines: [
      "Use web_fetch to inspect a specific URL after search results or when the user provides a URL.",
      "web_fetch is backed by Firecrawl /v2/scrape and can handle JavaScript-rendered pages better than a plain HTTP fetch.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "Absolute URL to scrape" }),
      formats: Type.Optional(
        Type.String({ description: "Comma-separated Firecrawl formats: markdown,html,rawHtml,links,images,summary (default: markdown)" }),
      ),
      onlyMainContent: Type.Optional(Type.Boolean({ description: "Extract only main page content (default: true)" })),
      waitFor: Type.Optional(Type.Integer({ minimum: 0, maximum: 60000, description: "Milliseconds to wait after load before scraping" })),
      timeout: Type.Optional(Type.Integer({ minimum: 1000, maximum: 180000, description: "Firecrawl timeout in milliseconds" })),
      maxChars: Type.Optional(Type.Integer({ minimum: 1000, maximum: 100000, default: DEFAULT_FETCH_MAX_CHARS, description: "Max chars per returned content field" })),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      const url = asString(params.url).trim();
      if (!url) throw new Error("web_fetch requires a URL.");

      const maxChars = clampInteger(params.maxChars, DEFAULT_FETCH_MAX_CHARS, 1000, 100000);
      const body: Record<string, unknown> = {
        url,
        formats: parseFormats(params.formats),
        onlyMainContent: asBool(params.onlyMainContent, true),
      };
      if (params.waitFor !== undefined) body.waitFor = clampInteger(params.waitFor, 0, 0, 60000);
      if (params.timeout !== undefined) body.timeout = clampInteger(params.timeout, 30000, 1000, 180000);

      onUpdate?.({ content: [{ type: "text", text: `Scraping with Firecrawl: ${url}` }] });
      const response = await firecrawlPost("/v2/scrape", body, signal);
      const doc = response.data ?? {};
      const content = documentContent(doc, maxChars);
      const header = documentHeader(doc);
      const output = `${header ? `${header}\n\n` : ""}${content.text}`;
      const truncated = await truncateOutput(output, "pi-firecrawl-scrape-");

      return {
        content: [{ type: "text", text: truncated.text }],
        details: {
          baseUrl: baseUrl(),
          endpoint: "/v2/scrape",
          url,
          formats: body.formats,
          metadata: doc.metadata,
          truncatedFields: content.truncatedFields,
          truncation: truncated.truncation,
          fullOutputPath: truncated.fullOutputPath,
          warnings: response.warnings,
        },
      };
    },
  });

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web using the user's self-hosted Firecrawl /v2/search endpoint.",
    promptSnippet: "Search via self-hosted Firecrawl; optionally scrape result pages into Markdown",
    promptGuidelines: [
      "Use web_search when Firecrawl search is preferred or when search results should optionally include scraped Markdown.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 10, description: "Maximum results to return" })),
      sources: Type.Optional(Type.String({ description: "Comma-separated sources: web,news,images (default: web)" })),
      categories: Type.Optional(Type.String({ description: "Comma-separated categories: github,research,pdf" })),
      timeRange: Type.Optional(Type.String({ description: "day, week, month, year, or raw Google tbs value like qdr:m" })),
      scrapeResults: Type.Optional(Type.Boolean({ description: "Also scrape returned web pages with markdown format (default: false)" })),
      maxCharsPerResult: Type.Optional(Type.Integer({ minimum: 500, maximum: 20000, default: DEFAULT_SEARCH_RESULT_CHARS, description: "Max scraped markdown chars per result" })),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      const query = asString(params.query).trim();
      if (!query) throw new Error("web_search requires a query.");

      const limit = clampInteger(params.limit, 10, 1, 20);
      const sources = parseCommaList(params.sources || "web", ["web", "news", "images"]);
      const categories = parseCommaList(params.categories, ["github", "research", "pdf"]);
      const scrapeResults = asBool(params.scrapeResults, false);
      const maxCharsPerResult = clampInteger(params.maxCharsPerResult, DEFAULT_SEARCH_RESULT_CHARS, 500, 20000);

      const body: Record<string, unknown> = {
        query,
        limit,
        sources: sources.length ? sources : ["web"],
      };
      if (categories.length) body.categories = categories;
      const tbs = timeRangeToTbs(params.timeRange);
      if (tbs) body.tbs = tbs;
      if (scrapeResults) body.scrapeOptions = { formats: ["markdown"], onlyMainContent: true };

      onUpdate?.({ content: [{ type: "text", text: `Searching Firecrawl for: ${query}` }] });
      const response = await firecrawlPost("/v2/search", body, signal);
      const data = response.data ?? {};
      const sections: string[] = [];
      const detailsResults: any[] = [];

      for (const source of ["web", "news", "images"] as const) {
        const results = Array.isArray(data[source]) ? data[source] : [];
        if (!results.length) continue;
        sections.push(`## ${source}`);
        results.slice(0, limit).forEach((result: any, index: number) => {
          const lines = [
            `### ${index + 1}. ${result.title || "Untitled"}`,
            result.url ? `URL: ${result.url}` : undefined,
            result.description || result.snippet ? `Description: ${result.description || result.snippet}` : undefined,
          ].filter(Boolean) as string[];

          if (typeof result.markdown === "string" && result.markdown.trim()) {
            const clipped = clip(result.markdown.trim(), maxCharsPerResult);
            lines.push(`Markdown:\n${clipped.text}`);
          }

          sections.push(lines.join("\n"));
          detailsResults.push({
            source,
            title: result.title,
            url: result.url,
            description: result.description || result.snippet,
            hasMarkdown: typeof result.markdown === "string",
            markdownChars: typeof result.markdown === "string" ? result.markdown.length : 0,
            metadata: result.metadata,
          });
        });
      }

      const output = sections.length ? sections.join("\n\n") : "No Firecrawl search results found.";
      const truncated = await truncateOutput(output, "pi-firecrawl-search-");

      return {
        content: [{ type: "text", text: truncated.text }],
        details: {
          baseUrl: baseUrl(),
          endpoint: "/v2/search",
          query,
          limit,
          sources: body.sources,
          categories,
          scrapeResults,
          resultCount: detailsResults.length,
          results: detailsResults,
          creditsUsed: response.creditsUsed,
          id: response.id,
          truncation: truncated.truncation,
          fullOutputPath: truncated.fullOutputPath,
        },
      };
    },
  });

  pi.registerTool({
    name: "web_map",
    label: "Web Map",
    description: "Discover links on a site using Firecrawl /v2/map.",
    promptSnippet: "Map/discover URLs on a website via self-hosted Firecrawl",
    promptGuidelines: [
      "Use web_map to discover URLs on a site before choosing pages to fetch or crawl.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "Website URL to map" }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000, default: 100, description: "Maximum links to return" })),
      search: Type.Optional(Type.String({ description: "Optional search term to filter discovered URLs" })),
      sitemap: Type.Optional(Type.String({ description: "Sitemap mode: include, skip, or only (default: include)" })),
      includeSubdomains: Type.Optional(Type.Boolean({ description: "Include subdomains (default: true)" })),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      const url = asString(params.url).trim();
      if (!url) throw new Error("web_map requires a URL.");
      const body: Record<string, unknown> = {
        url,
        limit: clampInteger(params.limit, 100, 1, 5000),
        includeSubdomains: asBool(params.includeSubdomains, true),
      };
      if (params.search) body.search = asString(params.search);
      const sitemap = asString(params.sitemap).trim();
      if (["include", "skip", "only"].includes(sitemap)) body.sitemap = sitemap;

      onUpdate?.({ content: [{ type: "text", text: `Mapping with Firecrawl: ${url}` }] });
      const response = await firecrawlPost("/v2/map", body, signal);
      const links = Array.isArray(response.links) ? response.links : [];
      const output = links.length ? links.map((link: string, i: number) => `${i + 1}. ${link}`).join("\n") : "No links found.";
      const truncated = await truncateOutput(output, "pi-firecrawl-map-");

      return {
        content: [{ type: "text", text: truncated.text }],
        details: {
          baseUrl: baseUrl(),
          endpoint: "/v2/map",
          url,
          linkCount: links.length,
          linksPreview: links.slice(0, 200),
          id: response.id,
          truncation: truncated.truncation,
          fullOutputPath: truncated.fullOutputPath,
        },
      };
    },
  });

  pi.registerTool({
    name: "web_crawl",
    label: "Web Crawl",
    description: "Start a Firecrawl /v2/crawl job and optionally wait for scraped Markdown results.",
    promptSnippet: "Crawl a website through self-hosted Firecrawl and return scraped pages or a crawl job id",
    promptGuidelines: [
      "Use web_crawl for multi-page site crawling; keep limits small unless the user asks for a broad crawl.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "Website URL to crawl" }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 10, description: "Maximum pages to crawl" })),
      includePaths: Type.Optional(Type.String({ description: "Comma-separated path substrings/regexes to include" })),
      excludePaths: Type.Optional(Type.String({ description: "Comma-separated path substrings/regexes to exclude" })),
      maxDiscoveryDepth: Type.Optional(Type.Integer({ minimum: 0, maximum: 10, description: "Maximum discovery depth" })),
      wait: Type.Optional(Type.Boolean({ description: "Wait for completion and return pages (default: true)" })),
      maxWaitSeconds: Type.Optional(Type.Integer({ minimum: 5, maximum: 300, default: 60, description: "Maximum seconds to wait when wait=true" })),
      maxCharsPerPage: Type.Optional(Type.Integer({ minimum: 500, maximum: 20000, default: DEFAULT_CRAWL_PAGE_CHARS, description: "Max content chars per crawled page" })),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      const url = asString(params.url).trim();
      if (!url) throw new Error("web_crawl requires a URL.");

      const limit = clampInteger(params.limit, 10, 1, 100);
      const body: Record<string, unknown> = {
        url,
        limit,
        scrapeOptions: { formats: ["markdown"], onlyMainContent: true },
      };
      const includePaths = parseCommaList(params.includePaths);
      const excludePaths = parseCommaList(params.excludePaths);
      if (includePaths.length) body.includePaths = includePaths;
      if (excludePaths.length) body.excludePaths = excludePaths;
      if (params.maxDiscoveryDepth !== undefined) body.maxDiscoveryDepth = clampInteger(params.maxDiscoveryDepth, 2, 0, 10);

      onUpdate?.({ content: [{ type: "text", text: `Starting Firecrawl crawl: ${url}` }] });
      const started = await firecrawlPost("/v2/crawl", body, signal);
      const id = started.id;
      const statusUrl = started.url || `${baseUrl()}/v2/crawl/${id}`;

      if (!asBool(params.wait, true)) {
        return {
          content: [{ type: "text", text: `Started Firecrawl crawl ${id}\nStatus: ${statusUrl}` }],
          details: { baseUrl: baseUrl(), endpoint: "/v2/crawl", id, statusUrl, url, limit },
        };
      }

      const maxWaitSeconds = clampInteger(params.maxWaitSeconds, 60, 5, 300);
      const maxCharsPerPage = clampInteger(params.maxCharsPerPage, DEFAULT_CRAWL_PAGE_CHARS, 500, 20000);
      const deadline = Date.now() + maxWaitSeconds * 1000;
      let status: any = started;

      while (Date.now() < deadline) {
        await pause(2000, signal);
        status = await firecrawlGet(`/v2/crawl/${id}`, signal);
        onUpdate?.({
          content: [
            {
              type: "text",
              text: `Crawl ${id}: ${status.status ?? "unknown"} (${status.completed ?? 0}/${status.total ?? "?"})`,
            },
          ],
        });
        if (["completed", "failed", "cancelled"].includes(status.status)) break;
      }

      const docs = Array.isArray(status.data) ? status.data : [];
      const sections = docs.map((doc: any, index: number) => {
        const header = documentHeader(doc) || `Page ${index + 1}`;
        const content = documentContent(doc, maxCharsPerPage);
        return `## Page ${index + 1}\n${header}\n\n${content.text}`;
      });
      const output = sections.length
        ? sections.join("\n\n---\n\n")
        : `Crawl ${id} status: ${status.status ?? "unknown"}\nStatus: ${statusUrl}`;
      const truncated = await truncateOutput(output, "pi-firecrawl-crawl-");

      return {
        content: [{ type: "text", text: truncated.text }],
        details: {
          baseUrl: baseUrl(),
          endpoint: "/v2/crawl",
          id,
          statusUrl,
          url,
          limit,
          status: status.status,
          completed: status.completed,
          total: status.total,
          expiresAt: status.expiresAt,
          pageCount: docs.length,
          truncation: truncated.truncation,
          fullOutputPath: truncated.fullOutputPath,
        },
      };
    },
  });
}
