/**
 * memory — hermes-style persistent memory for pi.
 *
 * Curated, char-capped notes (user / global / project scopes) injected into
 * every system prompt as a frozen per-session snapshot.
 *
 * Self-improvement: after `reviewInterval` user prompts with no memory write,
 * the agent either gets an in-band curation nudge (default) or a quiet
 * background reviewer process is forked, mirroring hermes' post-turn review.
 *
 * Commands: /memory [status|show|edit|review|reload] [user|global|project]
 * Flag:     --no-memory disables injection + self-review for the run
 * Config:   ~/.pi/memory/config.json (see README.md)
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { buildBackgroundReviewPrompt, buildMemoryBlock, buildNudgeText, buildReviewUserPrompt, formatUsage } from "./prompts.ts";
import {
	addEntry,
	ensureMemoryDirs,
	findProjectRoot,
	loadConfig,
	MAX_ENTRY_CHARS,
	MEMORY_SCOPES,
	type MemoryScope,
	memoryFilePath,
	memoryUsage,
	readMemory,
	removeEntry,
	replaceText,
	writeMemoryRaw,
} from "./store.ts";

/** Set on the forked reviewer so it can't count turns or fork reviews itself. */
const IS_REVIEWER = process.env.PI_MEMORY_REVIEWER === "1";

const REVIEW_TIMEOUT_MS = 5 * 60 * 1000;

function shortenPath(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

export default function (pi: ExtensionAPI) {
	const config = loadConfig();
	let projectRoot = findProjectRoot(process.cwd());
	let memoryBlock: string | undefined;
	let turnsSinceWrite = 0;
	let reviewProc: ReturnType<typeof spawn> | undefined;

	pi.registerFlag("no-memory", {
		description: "Disable memory injection and self-review for this run",
		type: "boolean",
		default: false,
	});

	const disabled = () => pi.getFlag("no-memory") === true;

	function refreshSnapshot(cwd: string): void {
		projectRoot = findProjectRoot(cwd);
		memoryBlock = buildMemoryBlock(projectRoot, config);
	}

	pi.on("session_start", async (_event, ctx) => {
		ensureMemoryDirs();
		refreshSnapshot(ctx.cwd);
		turnsSinceWrite = 0;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (disabled() || !config.inject) return;
		if (!memoryBlock) refreshSnapshot(ctx.cwd);
		return { systemPrompt: `${event.systemPrompt}\n\n${memoryBlock}` };
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (disabled() || IS_REVIEWER || config.review === "off" || ctx.mode === "print") return;
		turnsSinceWrite++;
		if (turnsSinceWrite < config.reviewInterval) return;
		if (config.review === "background") {
			spawnBackgroundReview(ctx);
		} else {
			turnsSinceWrite = 0;
			pi.sendMessage(
				{ customType: "memory-nudge", content: buildNudgeText(config.reviewInterval), display: true },
				{ deliverAs: "nextTurn" },
			);
		}
	});

	pi.on("session_shutdown", async (event) => {
		if (event.reason === "quit") reviewProc?.kill();
	});

	pi.registerMessageRenderer("memory-nudge", (_message, _options, theme) => {
		return new Text(theme.fg("dim", "✦ memory: self-review nudge attached to this turn"), 0, 0);
	});

	// ---- curated memory tool ----

	pi.registerTool({
		name: "memory",
		label: "Memory",
		description: [
			"Edit your persistent memory (it is shown in your system prompt under MEMORY and survives across sessions).",
			"Targets: user (who the user is, how they like to work), global (your behavior + environment, all projects), project (this project only).",
			"Actions: add appends a new entry; replace swaps matched text (old_text -> content); remove deletes the entry line matching old_text.",
			`Entries must be dense single declarative lines (max ${MAX_ENTRY_CHARS} chars), never secrets. Capacity is bounded — consolidate when a target nears its limit.`,
		].join("\n"),
		promptSnippet: "Persist durable notes across sessions (user / global / project memory)",
		promptGuidelines: [
			"Use the memory tool when you hit broadly reusable durable knowledge: user corrections, preferences, environment facts, project conventions, tool quirks, lessons from failures. Context resets every session — memory is how you improve.",
			"Do not store one-off or hyper-specific task/UI details unless they reveal a reusable preference or convention.",
			"Keep memory entries to one dense declarative line; when a memory section passes 80%, consolidate with replace/remove instead of adding more.",
		],
		parameters: Type.Object({
			action: StringEnum(["add", "replace", "remove"] as const, {
				description: "add = append entry; replace = swap old_text for content; remove = delete entry matching old_text",
			}),
			target: StringEnum(["user", "global", "project"] as const, {
				description: "user = user profile; global = agent behavior/environment (all projects); project = current project",
			}),
			content: Type.Optional(
				Type.String({ description: `New text for add/replace — one dense line, max ${MAX_ENTRY_CHARS} chars` }),
			),
			old_text: Type.Optional(
				Type.String({ description: "Existing text to match for replace/remove; must match exactly one place" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const target = params.target as MemoryScope;
			const file = memoryFilePath(target, projectRoot);
			return withFileMutationQueue(file, async () => {
				let usage;
				switch (params.action) {
					case "add":
						usage = addEntry(target, projectRoot, params.content ?? "", config);
						break;
					case "replace":
						usage = replaceText(target, projectRoot, params.old_text ?? "", params.content ?? "", config);
						break;
					case "remove":
						usage = removeEntry(target, projectRoot, params.old_text ?? "", config);
						break;
					default:
						throw new Error(`Unknown action: ${params.action}`);
				}
				turnsSinceWrite = 0;
				const warn = usage.pct >= 80 ? ` ⚠ ${usage.pct}% full — consolidate (merge, generalize, drop stale).` : "";
				return {
					content: [
						{
							type: "text",
							text: `${params.action} → ${target} memory [${formatUsage(usage)}].${warn} Prompt snapshot refreshes next session.`,
						},
					],
					details: { action: params.action, target, file, usage },
				};
			});
		},
		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("memory "));
			text += theme.fg("accent", `${args.action ?? "…"} `);
			text += theme.fg("muted", String(args.target ?? ""));
			const preview = String((args.action === "remove" ? args.old_text : args.content) ?? "");
			if (preview) {
				text += theme.fg("dim", ` "${preview.length > 64 ? `${preview.slice(0, 64)}…` : preview}"`);
			}
			return new Text(text, 0, 0);
		},
	});

	// ---- self-improvement: quiet background reviewer (hermes-style fork) ----

	function renderTranscript(ctx: ExtensionContext): string {
		const lines: string[] = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const message = entry.message as { role?: string; content?: unknown };
			if (message.role !== "user" && message.role !== "assistant") continue;
			const content = message.content;
			const text =
				typeof content === "string"
					? content
					: Array.isArray(content)
						? content
								.filter((item: { type?: string; text?: string }) => item?.type === "text" && typeof item.text === "string")
								.map((item: { text: string }) => item.text)
								.join("\n")
						: "";
			if (text.trim()) lines.push(`[${message.role}]\n${text.trim()}`);
		}
		const transcript = lines.join("\n\n");
		return transcript.length > 24000 ? `…(earlier turns omitted)\n${transcript.slice(-24000)}` : transcript;
	}

	function getPiInvocation(args: string[]): { command: string; args: string[] } {
		const currentScript = process.argv[1];
		const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
		if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
			return { command: process.execPath, args: [currentScript, ...args] };
		}
		const execName = path.basename(process.execPath).toLowerCase();
		if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
		return { command: "pi", args };
	}

	function spawnBackgroundReview(ctx: ExtensionContext): void {
		if (reviewProc) return;
		turnsSinceWrite = 0;
		const transcript = renderTranscript(ctx);
		if (transcript.length < 400) return;

		let tmpDir: string;
		try {
			tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-review-"));
			const transcriptPath = path.join(tmpDir, "transcript.txt");
			fs.writeFileSync(transcriptPath, transcript, { mode: 0o600 });

			const invocation = getPiInvocation(["-p", "--no-session", buildBackgroundReviewPrompt(transcriptPath)]);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: projectRoot,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, PI_MEMORY_REVIEWER: "1" },
			});
			reviewProc = proc;
			if (ctx.hasUI) ctx.ui.setStatus("memory", "✦ memory self-review running…");

			let output = "";
			proc.stdout?.on("data", (chunk) => {
				output += String(chunk);
				if (output.length > 16384) output = output.slice(-16384);
			});
			const timeout = setTimeout(() => proc.kill("SIGKILL"), REVIEW_TIMEOUT_MS);
			proc.on("error", () => {
				// surfaced via close handler
			});
			proc.on("close", (code) => {
				clearTimeout(timeout);
				reviewProc = undefined;
				fs.rmSync(tmpDir, { recursive: true, force: true });
				// ctx may belong to a replaced session by now; UI calls are best-effort.
				try {
					if (!ctx.hasUI) return;
					ctx.ui.setStatus("memory", undefined);
					const summary = output.trim().split("\n").filter(Boolean).pop() ?? "";
					if (code === 0 && summary) ctx.ui.notify(`memory review: ${summary.slice(0, 200)}`, "info");
					else if (code !== 0) ctx.ui.notify(`memory review failed (exit ${code})`, "warning");
				} catch {
					// stale session context after a switch — nothing to report to
				}
			});
		} catch {
			reviewProc = undefined;
		}
	}

	// ---- /memory command ----

	const SUBCOMMANDS = ["status", "show", "edit", "review", "reload"];

	pi.registerCommand("memory", {
		description: "Memory: status | show | edit | review | reload [user|global|project]",
		getArgumentCompletions: (prefix) => {
			const first = prefix.trimStart().split(/\s+/)[0] ?? "";
			if (prefix.trim().includes(" ")) return null;
			const items = SUBCOMMANDS.filter((sub) => sub.startsWith(first)).map((sub) => ({ value: sub, label: sub }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const sub = parts[0] ?? "status";
			const scope = (MEMORY_SCOPES as readonly string[]).includes(parts[1] ?? "")
				? (parts[1] as MemoryScope)
				: undefined;

			switch (sub) {
				case "status": {
					const lines = MEMORY_SCOPES.map((s) => {
						const usage = memoryUsage(s, projectRoot, config);
						return `${s.padEnd(7)} [${formatUsage(usage)}]  ${shortenPath(memoryFilePath(s, projectRoot))}`;
					});
					lines.push(`project root: ${shortenPath(projectRoot)}`);
					lines.push(
						`inject: ${config.inject && !disabled() ? "on" : "off"} (frozen per session) · review: ${config.review} every ${config.reviewInterval} turns · turns since write: ${turnsSinceWrite}`,
					);
					ctx.ui.notify(lines.join("\n"), "info");
					break;
				}
				case "show": {
					const scopes = scope ? [scope] : MEMORY_SCOPES;
					const out = scopes
						.map((s) => `── ${s} (${shortenPath(memoryFilePath(s, projectRoot))})\n${readMemory(s, projectRoot) || "(empty)"}`)
						.join("\n\n");
					ctx.ui.notify(out, "info");
					break;
				}
				case "edit": {
					const target = scope ?? "project";
					const current = readMemory(target, projectRoot);
					const edited = await ctx.ui.editor(`Edit ${target} memory`, current);
					if (edited === undefined) return;
					const file = memoryFilePath(target, projectRoot);
					await withFileMutationQueue(file, async () => writeMemoryRaw(target, projectRoot, edited));
					refreshSnapshot(ctx.cwd);
					const usage = memoryUsage(target, projectRoot, config);
					ctx.ui.notify(
						`${target} memory saved [${formatUsage(usage)}]${usage.pct > 100 ? " — over limit, consider trimming" : ""} · snapshot refreshed`,
						usage.pct > 100 ? "warning" : "info",
					);
					break;
				}
				case "review": {
					if (!ctx.isIdle()) {
						ctx.ui.notify("Agent is busy — try /memory review again when idle.", "warning");
						return;
					}
					pi.sendUserMessage(buildReviewUserPrompt());
					break;
				}
				case "reload": {
					refreshSnapshot(ctx.cwd);
					ctx.ui.notify("Memory snapshot refreshed from disk for this session.", "info");
					break;
				}
				default:
					ctx.ui.notify(`Unknown subcommand "${sub}". Use: status | show | edit | review | reload`, "warning");
			}
		},
	});
}
