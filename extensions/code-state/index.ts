/**
 * Pi Code State Extension
 *
 * Git-backed, message/branch-linked code undo/redo and /tree code restore.
 *
 * V1 constraints and API notes:
 * - Git worktrees only. Outside a git repository the extension records no snapshots and
 *   /undo + /redo report that code undo is unavailable.
 * - Implemented as a project-local Pi extension; it does not patch Pi's installed dist/.
 * - Pi exposes /tree as a built-in selector plus a post-navigation `session_tree` hook.
 *   This extension intentionally prompts from `session_tree`, so the restore-code prompt
 *   appears after Pi's normal branch-summary prompt. The extension cannot replace the
 *   built-in selector or change Pi's editor prefill behavior.
 * - Snapshots are whole-turn net snapshots: a before tree is captured when a user prompt
 *   starts and an after tree when the agent ends. A code_state checkpoint is recorded
 *   for every completed prompt, with empty diff metadata when no files changed.
 *   This catches write/edit/bash mutations alike, but does not try to attribute individual tool calls.
 * - /undo restores the before tree, navigates to before the linked user message,
 *   and refills the composer with that prompt. /redo restores the after tree and
 *   navigates back to the saved branch leaf from before the undo.
 */

import type {
	ExecResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import os from "node:os";

const CODE_STATE_TYPE = "code_state";
const CODE_RESTORE_TYPE = "code_restore";
const VERSION = 1;
const GIT_TIMEOUT_MS = 120_000;
const QUICK_GIT_TIMEOUT_MS = 15_000;

const CORE_GIT_CONFIG = ["-c", "core.longpaths=true", "-c", "core.symlinks=true", "-c", "core.autocrlf=false"];
const QUOTED_GIT_CONFIG = [...CORE_GIT_CONFIG, "-c", "core.quotepath=false"];

type SessionManagerLike = ExtensionContext["sessionManager"];

interface SnapshotRepo {
	root: string;
	storeDir: string;
	gitDir: string;
}

interface DiffSummary {
	changedFiles: string[];
	patchStats: {
		files: number;
		additions: number;
		deletions: number;
		binaryFiles: number;
	};
}

interface CodeStateData {
	kind: "code_state";
	version: 1;
	targetId: string;
	repoRoot: string;
	snapshotGitDir: string;
	beforeSnapshot: string;
	afterSnapshot: string;
	changedFiles: string[];
	patchStats: DiffSummary["patchStats"];
	createdAt: string;
}

interface RestoreData {
	kind: "code_restore";
	version: 1;
	action: "undo" | "redo" | "tree";
	repoRoot: string;
	stateEntryId?: string;
	stateTargetId?: string;
	userMessageId?: string;
	/** User prompt linked to the restored code_state, when there is one. */
	promptText?: string;
	/** Composer text expected at this restore leaf after navigation. */
	composerText?: string;
	/** Branch leaf before the undo; redo navigates back here. */
	oldLeafId?: string | null;
	/** Active leaf when this restore command started. */
	restoreFromLeafId?: string | null;
	/** Active leaf after conversation navigation, before this custom entry is appended. */
	restoreToLeafId?: string | null;
	navigationCancelled?: boolean;
	baseSnapshot: string;
	targetSnapshot: string;
	beforeRestoreSnapshot: string;
	afterRestoreSnapshot: string;
	changedFiles: string[];
	restoredFiles: string[];
	alreadyOkFiles: string[];
	skippedConflicts: string[];
	failedFiles: string[];
	forced: boolean;
	createdAt: string;
}

interface CodeStateRecord {
	entry: SessionEntry;
	data: CodeStateData;
}

interface RestoreRecord {
	entry: SessionEntry;
	data: RestoreData;
}

interface PendingTurnSnapshot {
	repo: SnapshotRepo;
	beforeSnapshot: string;
	preTurnLeafId: string | null;
}

interface RestoreSnapshotResult {
	beforeRestoreSnapshot: string;
	afterRestoreSnapshot: string;
	changedFiles: string[];
	restoredFiles: string[];
	alreadyOkFiles: string[];
	skippedConflicts: string[];
	failedFiles: string[];
}

interface RestoreEntryMetadata {
	stateEntryId?: string;
	stateTargetId?: string;
	userMessageId?: string;
	promptText?: string;
	composerText?: string;
	oldLeafId?: string | null;
	restoreFromLeafId?: string | null;
	restoreToLeafId?: string | null;
	navigationCancelled?: boolean;
}

type QuietNavigateTree = (targetId: string) => Promise<{ cancelled: boolean }>;

const migratedSnapshotStores = new Set<string>();

function expandHome(path: string): string {
	if (path === "~") return os.homedir();
	if (path.startsWith("~/") || path.startsWith("~\\")) return join(os.homedir(), path.slice(2));
	return path;
}

function agentDir(): string {
	return resolve(expandHome(process.env.PI_CODING_AGENT_DIR || join(os.homedir(), ".pi", "agent")));
}

function snapshotRootDir(): string {
	return join(dirname(agentDir()), "snapshots");
}

async function migrateLegacySnapshotStore(hash: string, storeDir: string): Promise<void> {
	const legacyStoreDir = join(agentDir(), "snapshots", hash);
	const legacyResolved = resolve(legacyStoreDir);
	const targetResolved = resolve(storeDir);
	if (legacyResolved === targetResolved || migratedSnapshotStores.has(targetResolved) || !existsSync(legacyStoreDir)) return;

	await mkdir(dirname(targetResolved), { recursive: true });
	const targetGitDir = join(targetResolved, "git");
	if (!existsSync(targetGitDir)) {
		try {
			await rename(legacyStoreDir, targetResolved);
		} catch {
			await cp(legacyStoreDir, targetResolved, { recursive: true, force: false, errorOnExist: false });
		}
	} else {
		const legacyObjectsDir = join(legacyStoreDir, "git", "objects");
		if (existsSync(legacyObjectsDir)) {
			const targetObjectsDir = join(targetGitDir, "objects");
			await mkdir(targetObjectsDir, { recursive: true });
			await cp(legacyObjectsDir, targetObjectsDir, { recursive: true, force: false, errorOnExist: false });
		}
	}
	migratedSnapshotStores.add(targetResolved);
}

function hashPath(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function snapshotGitArgs(repo: SnapshotRepo, args: string[], quoted = true): string[] {
	return [
		...(quoted ? QUOTED_GIT_CONFIG : CORE_GIT_CONFIG),
		"--git-dir",
		repo.gitDir,
		"--work-tree",
		repo.root,
		...args,
	];
}

function shorten(text: string, limit = 800): string {
	const trimmed = text.trim();
	return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

async function runGit(
	pi: ExtensionAPI,
	args: string[],
	cwd: string,
	options: { timeout?: number; signal?: AbortSignal; allowCodes?: number[] } = {},
): Promise<ExecResult> {
	const result = await pi.exec("git", args, {
		cwd,
		timeout: options.timeout ?? GIT_TIMEOUT_MS,
		signal: options.signal,
	});
	const allow = options.allowCodes ?? [0];
	if (!allow.includes(result.code)) {
		throw new Error(`git ${args.join(" ")} failed with code ${result.code}: ${shorten(result.stderr || result.stdout)}`);
	}
	return result;
}

async function resolveGitRepo(pi: ExtensionAPI, cwd: string): Promise<SnapshotRepo | undefined> {
	const inside = await pi.exec("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], {
		cwd,
		timeout: QUICK_GIT_TIMEOUT_MS,
	});
	if (inside.code !== 0 || inside.stdout.trim() !== "true") return undefined;

	const top = await runGit(pi, ["-C", cwd, "rev-parse", "--show-toplevel"], cwd, {
		timeout: QUICK_GIT_TIMEOUT_MS,
	});
	const root = resolve(cwd, top.stdout.trim());
	const hash = hashPath(root);
	const storeDir = join(snapshotRootDir(), hash);
	await migrateLegacySnapshotStore(hash, storeDir);
	return {
		root,
		storeDir,
		gitDir: join(storeDir, "git"),
	};
}

function excludePatternForDirInsideRepo(repo: SnapshotRepo, dir: string): string | undefined {
	const root = resolve(repo.root);
	const abs = resolve(dir);
	if (abs !== root && !abs.startsWith(root + sep)) return undefined;
	const rel = relative(root, abs).replace(/\\/g, "/");
	if (!rel || rel.startsWith("../") || rel === "..") return undefined;
	return `/${rel}/`;
}

function snapshotExcludePatterns(repo: SnapshotRepo): string[] {
	return Array.from(
		new Set(
			[snapshotRootDir(), join(agentDir(), "snapshots")]
				.map((dir) => excludePatternForDirInsideRepo(repo, dir))
				.filter((pattern): pattern is string => typeof pattern === "string"),
		),
	);
}

async function syncSnapshotExclude(pi: ExtensionAPI, repo: SnapshotRepo): Promise<void> {
	let sourceExclude = "";
	const sourceExcludePath = await pi.exec(
		"git",
		["-C", repo.root, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude"],
		{ cwd: repo.root, timeout: QUICK_GIT_TIMEOUT_MS },
	);
	if (sourceExcludePath.code === 0) {
		const file = sourceExcludePath.stdout.trim();
		if (file && existsSync(file)) {
			sourceExclude = await readFile(file, "utf8").catch(() => "");
		}
	}

	const target = join(repo.gitDir, "info", "exclude");
	await mkdir(dirname(target), { recursive: true });
	const text = [
		sourceExclude.trimEnd(),
		"# Added by Pi code-state snapshots.",
		"/.git",
		"/.git/",
		...snapshotExcludePatterns(repo),
	]
		.filter(Boolean)
		.join("\n");
	await writeFile(target, `${text}\n`, "utf8");
}

async function ensureSnapshotRepo(pi: ExtensionAPI, repo: SnapshotRepo): Promise<void> {
	await mkdir(repo.storeDir, { recursive: true });
	if (!existsSync(join(repo.gitDir, "HEAD"))) {
		await runGit(pi, snapshotGitArgs(repo, ["init"], false), repo.root);
		for (const [key, value] of [
			["core.autocrlf", "false"],
			["core.longpaths", "true"],
			["core.symlinks", "true"],
			["core.fsmonitor", "false"],
		] as const) {
			await runGit(pi, snapshotGitArgs(repo, ["config", key, value], false), repo.root);
		}
	}
	// Snapshot hashes are raw tree objects stored only in Pi session entries, not Git refs/commits.
	// Keep automatic GC disabled in this private repo so unanchored snapshot trees are not pruned.
	await runGit(pi, snapshotGitArgs(repo, ["config", "gc.auto", "0"], false), repo.root, {
		timeout: QUICK_GIT_TIMEOUT_MS,
	});
	await syncSnapshotExclude(pi, repo);
}

async function snapshotWorktree(pi: ExtensionAPI, repo: SnapshotRepo, signal?: AbortSignal): Promise<string> {
	await ensureSnapshotRepo(pi, repo);
	await runGit(pi, snapshotGitArgs(repo, ["add", "--all", "--", "."]), repo.root, {
		timeout: GIT_TIMEOUT_MS,
		signal,
	});
	// write-tree returns an unanchored tree object; ensureSnapshotRepo disables auto-GC for this store.
	const tree = await runGit(pi, snapshotGitArgs(repo, ["write-tree"]), repo.root, {
		timeout: GIT_TIMEOUT_MS,
		signal,
	});
	const hash = tree.stdout.trim();
	if (!/^[0-9a-f]{40,64}$/.test(hash)) {
		throw new Error(`git write-tree returned an invalid tree hash: ${JSON.stringify(hash)}`);
	}
	return hash;
}

function parseNameStatusZ(output: string): string[] {
	const parts = output.split("\0").filter(Boolean);
	const paths: string[] = [];
	for (let i = 0; i < parts.length; ) {
		const status = parts[i++];
		if (!status) break;
		if (status.startsWith("R") || status.startsWith("C")) {
			const oldPath = parts[i++];
			const newPath = parts[i++];
			if (oldPath) paths.push(oldPath);
			if (newPath) paths.push(newPath);
			continue;
		}
		const file = parts[i++];
		if (file) paths.push(file);
	}
	return Array.from(new Set(paths));
}

function parseNumstatZ(output: string): { additions: number; deletions: number; binaryFiles: number; files: number } {
	let additions = 0;
	let deletions = 0;
	let binaryFiles = 0;
	let files = 0;
	for (const record of output.split("\0").filter(Boolean)) {
		const first = record.indexOf("\t");
		const second = first === -1 ? -1 : record.indexOf("\t", first + 1);
		if (first === -1 || second === -1) continue;
		files++;
		const add = record.slice(0, first);
		const del = record.slice(first + 1, second);
		if (add === "-" || del === "-") {
			binaryFiles++;
			continue;
		}
		additions += Number.parseInt(add, 10) || 0;
		deletions += Number.parseInt(del, 10) || 0;
	}
	return { additions, deletions, binaryFiles, files };
}

async function diffSummary(pi: ExtensionAPI, repo: SnapshotRepo, from: string, to: string): Promise<DiffSummary> {
	if (from === to) {
		return { changedFiles: [], patchStats: { files: 0, additions: 0, deletions: 0, binaryFiles: 0 } };
	}
	const names = await runGit(
		pi,
		snapshotGitArgs(repo, ["diff", "--name-status", "--no-renames", "-z", from, to, "--", "."]),
		repo.root,
	);
	const numstat = await runGit(
		pi,
		snapshotGitArgs(repo, ["diff", "--numstat", "--no-renames", "-z", from, to, "--", "."]),
		repo.root,
	);
	const changedFiles = parseNameStatusZ(names.stdout).filter(isSafeRelPath);
	const stats = parseNumstatZ(numstat.stdout);
	return {
		changedFiles,
		patchStats: {
			files: changedFiles.length || stats.files,
			additions: stats.additions,
			deletions: stats.deletions,
			binaryFiles: stats.binaryFiles,
		},
	};
}

function isSafeRelPath(rel: string): boolean {
	if (!rel || rel.includes("\0")) return false;
	if (rel.startsWith("/") || rel.startsWith("\\")) return false;
	const pieces = rel.split("/");
	return !pieces.some((piece) => piece === ".." || piece === "");
}

function safeAbsPath(repo: SnapshotRepo, rel: string): string | undefined {
	if (!isSafeRelPath(rel)) return undefined;
	const abs = resolve(repo.root, rel);
	return abs === repo.root || abs.startsWith(repo.root + sep) ? abs : undefined;
}

function literalPathspec(rel: string): string {
	return `:(literal)${rel}`;
}

function chunks<T>(items: T[], size: number): T[][] {
	const result: T[][] = [];
	for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
	return result;
}

async function snapshotsEqualPath(
	pi: ExtensionAPI,
	repo: SnapshotRepo,
	left: string,
	right: string,
	rel: string,
): Promise<boolean> {
	const result = await runGit(
		pi,
		snapshotGitArgs(repo, ["diff", "--quiet", "--no-ext-diff", left, right, "--", literalPathspec(rel)]),
		repo.root,
		{ allowCodes: [0, 1] },
	);
	return result.code === 0;
}

async function pathsPresentInTree(
	pi: ExtensionAPI,
	repo: SnapshotRepo,
	tree: string,
	paths: string[],
): Promise<Set<string>> {
	const present = new Set<string>();
	for (const group of chunks(paths, 200)) {
		if (!group.length) continue;
		const result = await runGit(
			pi,
			snapshotGitArgs(repo, ["ls-tree", "-r", "-z", "--name-only", tree, "--", ...group.map(literalPathspec)]),
			repo.root,
		);
		for (const item of result.stdout.split("\0").filter(Boolean)) present.add(item);
	}
	return present;
}

async function checkoutPathsFromTree(
	pi: ExtensionAPI,
	repo: SnapshotRepo,
	tree: string,
	paths: string[],
	force: boolean,
): Promise<{ restored: string[]; failed: string[] }> {
	const restored: string[] = [];
	const failed: string[] = [];
	for (const group of chunks(paths, 100)) {
		if (!group.length) continue;
		if (force) {
			for (const rel of group) {
				const abs = safeAbsPath(repo, rel);
				if (abs) await rm(abs, { recursive: true, force: true }).catch(() => undefined);
			}
		}
		try {
			await runGit(
				pi,
				snapshotGitArgs(repo, ["checkout", tree, "--", ...group.map(literalPathspec)]),
				repo.root,
			);
			restored.push(...group);
		} catch (_err) {
			for (const rel of group) {
				try {
					await runGit(pi, snapshotGitArgs(repo, ["checkout", tree, "--", literalPathspec(rel)]), repo.root);
					restored.push(rel);
				} catch {
					failed.push(rel);
				}
			}
		}
	}
	return { restored, failed };
}

async function restoreSnapshot(
	pi: ExtensionAPI,
	repo: SnapshotRepo,
	options: {
		baseSnapshot: string;
		targetSnapshot: string;
		paths?: string[];
		force: boolean;
	},
): Promise<RestoreSnapshotResult> {
	const beforeRestoreSnapshot = await snapshotWorktree(pi, repo);
	const changedFiles = Array.from(
		new Set((options.paths ?? (await diffSummary(pi, repo, options.baseSnapshot, options.targetSnapshot)).changedFiles).filter(isSafeRelPath)),
	);

	const alreadyOkFiles: string[] = [];
	const skippedConflicts: string[] = [];
	const candidates: string[] = [];

	for (const rel of changedFiles) {
		if (await snapshotsEqualPath(pi, repo, beforeRestoreSnapshot, options.targetSnapshot, rel)) {
			alreadyOkFiles.push(rel);
			continue;
		}
		if (options.force || (await snapshotsEqualPath(pi, repo, beforeRestoreSnapshot, options.baseSnapshot, rel))) {
			candidates.push(rel);
		} else {
			skippedConflicts.push(rel);
		}
	}

	const present = await pathsPresentInTree(pi, repo, options.targetSnapshot, candidates);
	const checkoutPaths = candidates.filter((rel) => present.has(rel));
	const deletePaths = candidates.filter((rel) => !present.has(rel));
	const checkout = await checkoutPathsFromTree(pi, repo, options.targetSnapshot, checkoutPaths, options.force);

	const restoredFiles = [...checkout.restored];
	const failedFiles = [...checkout.failed];
	for (const rel of deletePaths.sort((a, b) => b.length - a.length)) {
		const abs = safeAbsPath(repo, rel);
		if (!abs) {
			failedFiles.push(rel);
			continue;
		}
		try {
			await rm(abs, { recursive: true, force: true });
			restoredFiles.push(rel);
		} catch {
			failedFiles.push(rel);
		}
	}

	const afterRestoreSnapshot = restoredFiles.length > 0 ? await snapshotWorktree(pi, repo) : beforeRestoreSnapshot;
	return {
		beforeRestoreSnapshot,
		afterRestoreSnapshot,
		changedFiles,
		restoredFiles,
		alreadyOkFiles,
		skippedConflicts,
		failedFiles,
	};
}

function customData(entry: SessionEntry, customType: string): unknown | undefined {
	if (entry.type !== "custom") return undefined;
	const maybe = entry as SessionEntry & { customType?: string; data?: unknown };
	return maybe.customType === customType ? maybe.data : undefined;
}

function asCodeState(entry: SessionEntry, repoRoot?: string): CodeStateData | undefined {
	const data = customData(entry, CODE_STATE_TYPE) as Partial<CodeStateData> | undefined;
	if (!data || data.kind !== "code_state" || data.version !== VERSION) return undefined;
	if (repoRoot && data.repoRoot !== repoRoot) return undefined;
	if (
		typeof data.targetId !== "string" ||
		typeof data.beforeSnapshot !== "string" ||
		typeof data.afterSnapshot !== "string" ||
		!Array.isArray(data.changedFiles)
	) {
		return undefined;
	}
	return data as CodeStateData;
}

function asRestore(entry: SessionEntry, repoRoot?: string): RestoreData | undefined {
	const data = customData(entry, CODE_RESTORE_TYPE) as Partial<RestoreData> | undefined;
	if (!data || data.kind !== "code_restore" || data.version !== VERSION) return undefined;
	if (repoRoot && data.repoRoot !== repoRoot) return undefined;
	if (
		typeof data.baseSnapshot !== "string" ||
		typeof data.targetSnapshot !== "string" ||
		typeof data.afterRestoreSnapshot !== "string"
	) {
		return undefined;
	}
	return data as RestoreData;
}

function branchEntries(sessionManager: SessionManagerLike, leafId?: string | null): SessionEntry[] {
	if (leafId === null) return [];
	return leafId === undefined ? sessionManager.getBranch() : sessionManager.getBranch(leafId);
}

function firstCodeState(sessionManager: SessionManagerLike, repoRoot: string): CodeStateRecord | undefined {
	for (const entry of sessionManager.getEntries()) {
		const data = asCodeState(entry, repoRoot);
		if (data) return { entry, data };
	}
	return undefined;
}

function snapshotForLeaf(
	sessionManager: SessionManagerLike,
	leafId: string | null | undefined,
	repoRoot: string,
): { snapshot: string; source: "before-first" | "code_state" | "restore"; targetId?: string } | undefined {
	const first = firstCodeState(sessionManager, repoRoot);
	let current = leafId === null ? first?.data.beforeSnapshot : undefined;
	let source: "before-first" | "code_state" | "restore" = "before-first";
	let targetId: string | undefined;

	for (const entry of branchEntries(sessionManager, leafId)) {
		const state = asCodeState(entry, repoRoot);
		if (state) {
			current = state.afterSnapshot;
			source = "code_state";
			targetId = state.targetId;
			continue;
		}
		const restore = asRestore(entry, repoRoot);
		if (restore) {
			current = restore.afterRestoreSnapshot || restore.targetSnapshot;
			source = "restore";
			targetId = restore.stateTargetId ?? restore.userMessageId;
		}
	}

	if (!current && first) {
		current = first.data.beforeSnapshot;
		source = "before-first";
	}
	return current ? { snapshot: current, source, targetId } : undefined;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => {
			if (!part || typeof part !== "object") return false;
			const maybe = part as { type?: unknown; text?: unknown };
			return maybe.type === "text" && typeof maybe.text === "string";
		})
		.map((part) => part.text)
		.join("");
}

function userPromptForEntry(entry: SessionEntry | undefined): string | undefined {
	if (!entry || entry.type !== "message" || entry.message.role !== "user") return undefined;
	return textFromContent(entry.message.content);
}

function findUndoTarget(
	sessionManager: SessionManagerLike,
	repoRoot: string,
): { state: CodeStateRecord; userMessageId: string; promptText: string; oldLeafId: string | null } | undefined {
	const branch = branchEntries(sessionManager);
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i]!;
		const data = asCodeState(entry, repoRoot);
		if (!data) continue;
		const promptText = userPromptForEntry(sessionManager.getEntry(data.targetId));
		if (promptText === undefined) continue;
		return {
			state: { entry, data },
			userMessageId: data.targetId,
			promptText,
			oldLeafId: sessionManager.getLeafId(),
		};
	}
	return undefined;
}

function findRedoTarget(sessionManager: SessionManagerLike, repoRoot: string): RestoreRecord | undefined {
	const branch = branchEntries(sessionManager);
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i]!;
		if (asCodeState(entry, repoRoot)) return undefined;
		if (entry.type === "message" || entry.type === "custom_message") return undefined;

		const data = asRestore(entry, repoRoot);
		if (!data) continue;
		if (data.action === "tree") return undefined;
		if (data.action === "undo" && data.oldLeafId !== undefined) return { entry, data };
	}
	return undefined;
}

function composerTextForLeaf(sessionManager: SessionManagerLike, leafId: string | null | undefined, repoRoot: string): string {
	if (!leafId) return "";
	const entry = sessionManager.getEntry(leafId);
	if (!entry) return "";
	const restore = asRestore(entry, repoRoot);
	if (restore && typeof restore.composerText === "string") return restore.composerText;
	if (restore?.action === "undo" && typeof restore.promptText === "string") return restore.promptText;
	return userPromptForEntry(entry) ?? "";
}

function findTargetUserId(sessionManager: SessionManagerLike, preTurnLeafId: string | null): string | undefined {
	const branch = sessionManager.getBranch();
	const startIndex = preTurnLeafId !== null ? branch.findIndex((entry) => entry.id === preTurnLeafId) : -1;
	if (preTurnLeafId !== null && startIndex === -1) {
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i]!;
			if (entry.type === "message" && entry.message.role === "user") return entry.id;
		}
		return undefined;
	}
	for (const entry of branch.slice(startIndex + 1)) {
		if (entry.type === "message" && entry.message.role === "user") return entry.id;
	}
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i]!;
		if (entry.type === "message" && entry.message.role === "user") return entry.id;
	}
	return undefined;
}

function parseForce(args: string): boolean {
	return args
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.some((arg) => arg === "--force" || arg === "-f");
}

function forceCompletion(prefix: string): Array<{ value: string; label: string; description?: string }> | null {
	const item = { value: "--force", label: "--force", description: "overwrite conflicting user-owned changes" };
	return item.value.startsWith(prefix.trim()) ? [item] : null;
}

function restoreSummary(action: string, result: RestoreSnapshotResult, force: boolean): string {
	const parts = [
		`${action}: restored ${result.restoredFiles.length} file(s)`,
		result.alreadyOkFiles.length ? `${result.alreadyOkFiles.length} already at target` : undefined,
		result.skippedConflicts.length ? `${result.skippedConflicts.length} conflict(s) skipped` : undefined,
		result.failedFiles.length ? `${result.failedFiles.length} failed` : undefined,
	]
		.filter(Boolean)
		.join(", ");
	return result.skippedConflicts.length && !force ? `${parts}. Use --force to overwrite conflicts.` : parts;
}

function appendRestoreEntry(
	pi: ExtensionAPI,
	action: RestoreData["action"],
	repo: SnapshotRepo,
	baseSnapshot: string,
	targetSnapshot: string,
	result: RestoreSnapshotResult,
	forced: boolean,
	metadata: RestoreEntryMetadata = {},
): void {
	pi.appendEntry<RestoreData>(CODE_RESTORE_TYPE, {
		kind: "code_restore",
		version: VERSION,
		action,
		repoRoot: repo.root,
		stateEntryId: metadata.stateEntryId,
		stateTargetId: metadata.stateTargetId,
		userMessageId: metadata.userMessageId,
		promptText: metadata.promptText,
		composerText: metadata.composerText,
		oldLeafId: metadata.oldLeafId,
		restoreFromLeafId: metadata.restoreFromLeafId,
		restoreToLeafId: metadata.restoreToLeafId,
		navigationCancelled: metadata.navigationCancelled,
		baseSnapshot,
		targetSnapshot,
		beforeRestoreSnapshot: result.beforeRestoreSnapshot,
		afterRestoreSnapshot: result.afterRestoreSnapshot,
		changedFiles: result.changedFiles,
		restoredFiles: result.restoredFiles,
		alreadyOkFiles: result.alreadyOkFiles,
		skippedConflicts: result.skippedConflicts,
		failedFiles: result.failedFiles,
		forced,
		createdAt: new Date().toISOString(),
	});
}

async function handleUndoRedo(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	action: "undo" | "redo",
	args: string,
	navigateTreeQuietly: QuietNavigateTree,
): Promise<void> {
	await ctx.waitForIdle();
	const repo = await resolveGitRepo(pi, ctx.cwd);
	if (!repo) {
		ctx.ui.notify("Code undo is unavailable outside a git worktree.", "warning");
		return;
	}

	const force = parseForce(args);
	if (action === "undo") {
		const target = findUndoTarget(ctx.sessionManager, repo.root);
		if (!target) {
			ctx.ui.notify("No code state to undo on this branch.", "info");
			return;
		}

		const baseSnapshot = target.state.data.afterSnapshot;
		const targetSnapshot = target.state.data.beforeSnapshot;
		const result = await restoreSnapshot(pi, repo, {
			baseSnapshot,
			targetSnapshot,
			paths: target.state.data.changedFiles,
			force,
		});

		const navigation = await navigateTreeQuietly(target.userMessageId);
		appendRestoreEntry(pi, "undo", repo, baseSnapshot, targetSnapshot, result, force, {
			stateEntryId: target.state.entry.id,
			stateTargetId: target.state.data.targetId,
			userMessageId: target.userMessageId,
			promptText: target.promptText,
			composerText: target.promptText,
			oldLeafId: target.oldLeafId,
			restoreFromLeafId: target.oldLeafId,
			restoreToLeafId: ctx.sessionManager.getLeafId(),
			navigationCancelled: navigation.cancelled,
		});

		if (!navigation.cancelled) ctx.ui.setEditorText(target.promptText);
		const summary = restoreSummary("Undo", result, force);
		ctx.ui.notify(
			navigation.cancelled ? `${summary}. Conversation navigation was cancelled; code was restored only.` : summary,
			navigation.cancelled || result.failedFiles.length ? "warning" : "info",
		);
		return;
	}

	const undo = findRedoTarget(ctx.sessionManager, repo.root);
	if (!undo) {
		ctx.ui.notify("No code state to redo on this branch.", "info");
		return;
	}
	if (!undo.data.oldLeafId) {
		ctx.ui.notify("Cannot redo this code state: the saved branch leaf is missing.", "warning");
		return;
	}
	if (!ctx.sessionManager.getEntry(undo.data.oldLeafId)) {
		ctx.ui.notify("Cannot redo this code state: the saved branch leaf no longer exists.", "warning");
		return;
	}

	const baseSnapshot = undo.data.targetSnapshot;
	const targetSnapshot = undo.data.baseSnapshot;
	const preRedoLeafId = ctx.sessionManager.getLeafId();
	const editorText = composerTextForLeaf(ctx.sessionManager, undo.data.oldLeafId, repo.root);
	const result = await restoreSnapshot(pi, repo, {
		baseSnapshot,
		targetSnapshot,
		paths: undo.data.changedFiles,
		force,
	});

	const navigation = await navigateTreeQuietly(undo.data.oldLeafId);
	appendRestoreEntry(pi, "redo", repo, baseSnapshot, targetSnapshot, result, force, {
		stateEntryId: undo.data.stateEntryId,
		stateTargetId: undo.data.stateTargetId ?? undo.data.userMessageId,
		userMessageId: undo.data.userMessageId ?? undo.data.stateTargetId,
		promptText: undo.data.promptText,
		composerText: editorText,
		oldLeafId: undo.data.oldLeafId,
		restoreFromLeafId: preRedoLeafId,
		restoreToLeafId: ctx.sessionManager.getLeafId(),
		navigationCancelled: navigation.cancelled,
	});

	if (!navigation.cancelled) ctx.ui.setEditorText(editorText);
	const summary = restoreSummary("Redo", result, force);
	ctx.ui.notify(
		navigation.cancelled ? `${summary}. Conversation navigation was cancelled; code was restored only.` : summary,
		navigation.cancelled || result.failedFiles.length ? "warning" : "info",
	);
}

async function handleTreeRestore(pi: ExtensionAPI, event: { oldLeafId: string | null; newLeafId: string | null }, ctx: ExtensionContext) {
	if (!ctx.hasUI) return;
	const repo = await resolveGitRepo(pi, ctx.cwd);
	if (!repo) return;

	const from = snapshotForLeaf(ctx.sessionManager, event.oldLeafId, repo.root);
	const to = snapshotForLeaf(ctx.sessionManager, event.newLeafId, repo.root);
	if (!from || !to || from.snapshot === to.snapshot) return;

	const diff = await diffSummary(pi, repo, from.snapshot, to.snapshot);
	if (diff.changedFiles.length === 0) return;

	const choice = await ctx.ui.select(`Restore code for selected branch? (${diff.changedFiles.length} file(s) differ)`, [
		"Yes, restore non-conflicting files",
		"Yes, force restore all files",
		"No, keep current code",
	]);
	if (!choice || choice.startsWith("No")) return;

	const force = choice.includes("force");
	const result = await restoreSnapshot(pi, repo, {
		baseSnapshot: from.snapshot,
		targetSnapshot: to.snapshot,
		paths: diff.changedFiles,
		force,
	});
	appendRestoreEntry(pi, "tree", repo, from.snapshot, to.snapshot, result, force, {
		stateTargetId: to.targetId,
		restoreFromLeafId: event.oldLeafId,
		restoreToLeafId: event.newLeafId,
	});
	ctx.ui.notify(restoreSummary("Tree restore", result, force), result.failedFiles.length ? "warning" : "info");
}

export default function codeStateExtension(pi: ExtensionAPI) {
	let pendingTurn: PendingTurnSnapshot | undefined;
	let warnedSnapshotFailure = false;
	let internalTreeNavigationDepth = 0;

	const navigateTreeQuietly = async (ctx: ExtensionCommandContext, targetId: string): Promise<{ cancelled: boolean }> => {
		internalTreeNavigationDepth++;
		try {
			return await ctx.navigateTree(targetId, { summarize: false });
		} finally {
			internalTreeNavigationDepth = Math.max(0, internalTreeNavigationDepth - 1);
		}
	};

	pi.on("before_agent_start", async (_event, ctx) => {
		pendingTurn = undefined;
		const repo = await resolveGitRepo(pi, ctx.cwd);
		if (!repo) return;
		try {
			pendingTurn = {
				repo,
				beforeSnapshot: await snapshotWorktree(pi, repo, ctx.signal),
				preTurnLeafId: ctx.sessionManager.getLeafId(),
			};
		} catch (error) {
			if (!warnedSnapshotFailure) {
				warnedSnapshotFailure = true;
				ctx.ui.notify(`Code snapshot before turn failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
			}
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		const pending = pendingTurn;
		pendingTurn = undefined;
		if (!pending) return;
		try {
			const afterSnapshot = await snapshotWorktree(pi, pending.repo, ctx.signal);
			const summary = await diffSummary(pi, pending.repo, pending.beforeSnapshot, afterSnapshot);
			const targetId = findTargetUserId(ctx.sessionManager, pending.preTurnLeafId);
			if (!targetId) return;

			// Record every completed user prompt, even when no files changed. This keeps
			// /undo message-based: the latest code_state always maps to the latest turn,
			// with empty changedFiles/zero patchStats for no-code checkpoints.
			pi.appendEntry<CodeStateData>(CODE_STATE_TYPE, {
				kind: "code_state",
				version: VERSION,
				targetId,
				repoRoot: pending.repo.root,
				snapshotGitDir: pending.repo.gitDir,
				beforeSnapshot: pending.beforeSnapshot,
				afterSnapshot,
				changedFiles: summary.changedFiles,
				patchStats: summary.patchStats,
				createdAt: new Date().toISOString(),
			});
		} catch (error) {
			ctx.ui.notify(`Code snapshot after turn failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	});

	pi.on("session_tree", async (event, ctx) => {
		if (internalTreeNavigationDepth > 0) return;
		try {
			await handleTreeRestore(pi, event, ctx);
		} catch (error) {
			ctx.ui.notify(`Tree code restore failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	});

	pi.on("session_shutdown", () => {
		pendingTurn = undefined;
	});

	pi.registerCommand("undo", {
		description: "Restore previous code state and navigate to before its user prompt (skips conflicts by default)",
		getArgumentCompletions: forceCompletion,
		handler: async (args, ctx) => {
			try {
				await handleUndoRedo(pi, ctx, "undo", args, (targetId) => navigateTreeQuietly(ctx, targetId));
			} catch (error) {
				ctx.ui.notify(`Undo failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.registerCommand("redo", {
		description: "Re-apply a code state undone by /undo and return to its saved branch leaf",
		getArgumentCompletions: forceCompletion,
		handler: async (args, ctx) => {
			try {
				await handleUndoRedo(pi, ctx, "redo", args, (targetId) => navigateTreeQuietly(ctx, targetId));
			} catch (error) {
				ctx.ui.notify(`Redo failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
