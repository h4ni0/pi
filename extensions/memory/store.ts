/**
 * Memory storage layer.
 *
 * Three curated memory scopes (hermes-style bounded markdown files):
 *   user    → ~/.pi/memory/USER.md               who the user is, how they like to work
 *   global  → ~/.pi/memory/GLOBAL.md             agent behavior + environment, all projects
 *   project → ~/.pi/memory/projects/<slug>.md    current project only, keyed by git root
 *
 * Capacity is deliberately bounded: limits force curation over accumulation.
 * All mutations are read-modify-write against disk; callers must wrap them in
 * withFileMutationQueue(file) so parallel tool calls don't clobber each other.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type MemoryScope = "user" | "global" | "project";
export const MEMORY_SCOPES: readonly MemoryScope[] = ["user", "global", "project"];

export const MEMORY_DIR = path.join(os.homedir(), ".pi", "memory");
const LEGACY_MEMORY_DIR = path.join(os.homedir(), ".pi", "agent", "memory");
const PROJECTS_DIR = path.join(MEMORY_DIR, "projects");
const CONFIG_PATH = path.join(MEMORY_DIR, "config.json");

export const MAX_ENTRY_CHARS = 500;

export interface MemoryConfig {
	/** Inject the memory snapshot into the system prompt. */
	inject: boolean;
	/** Self-improvement mode: in-band nudge, quiet background reviewer process, or off. */
	review: "nudge" | "background" | "off";
	/** User prompts without a memory write before a review is triggered. */
	reviewInterval: number;
	/** Char capacity per scope. */
	limits: Record<MemoryScope, number>;
}

export const DEFAULT_CONFIG: MemoryConfig = {
	inject: true,
	review: "nudge",
	reviewInterval: 8,
	limits: { user: 1400, global: 2400, project: 2400 },
};

function uniqueConflictPath(file: string): string {
	const parsed = path.parse(file);
	for (let i = 0; i < 1000; i++) {
		const suffix = i === 0 ? ".legacy" : `.legacy-${i}`;
		const candidate = path.join(parsed.dir, `${parsed.name}${suffix}${parsed.ext}`);
		if (!fs.existsSync(candidate)) return candidate;
	}
	return `${file}.legacy-${Date.now()}`;
}

function mergeMarkdownFiles(target: string, source: string): void {
	const lines: string[] = [];
	const seen = new Set<string>();
	for (const file of [target, source]) {
		const text = fs.readFileSync(file, "utf8");
		for (const rawLine of text.split(/\r?\n/)) {
			const line = rawLine.trim();
			if (!line) continue;
			const key = line.replace(/^[-*]\s+/, "").trim().toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			lines.push(line);
		}
	}
	fs.writeFileSync(target, lines.length ? `${lines.join("\n")}\n` : "");
}

function migrateDirectoryContents(sourceDir: string, targetDir: string): void {
	fs.mkdirSync(targetDir, { recursive: true });
	for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
		const source = path.join(sourceDir, entry.name);
		const target = path.join(targetDir, entry.name);
		if (entry.isDirectory()) {
			migrateDirectoryContents(source, target);
			fs.rmSync(source, { recursive: true, force: true });
			continue;
		}
		if (!entry.isFile()) continue;
		if (!fs.existsSync(target)) {
			fs.renameSync(source, target);
			continue;
		}
		const sourceBytes = fs.readFileSync(source);
		const targetBytes = fs.readFileSync(target);
		if (sourceBytes.equals(targetBytes)) {
			fs.rmSync(source);
		} else if (path.extname(entry.name).toLowerCase() === ".md") {
			mergeMarkdownFiles(target, source);
			fs.rmSync(source);
		} else {
			fs.renameSync(source, uniqueConflictPath(target));
		}
	}
}

function migrateLegacyMemoryDir(): void {
	try {
		if (!fs.existsSync(LEGACY_MEMORY_DIR)) return;
		if (!fs.existsSync(MEMORY_DIR)) {
			fs.mkdirSync(path.dirname(MEMORY_DIR), { recursive: true });
			fs.renameSync(LEGACY_MEMORY_DIR, MEMORY_DIR);
			return;
		}
		if (fs.realpathSync(LEGACY_MEMORY_DIR) === fs.realpathSync(MEMORY_DIR)) return;
		migrateDirectoryContents(LEGACY_MEMORY_DIR, MEMORY_DIR);
		fs.rmSync(LEGACY_MEMORY_DIR, { recursive: true, force: true });
	} catch {
		// Best-effort migration; normal reads/writes use the new path regardless.
	}
}

export function loadConfig(): MemoryConfig {
	migrateLegacyMemoryDir();
	let raw: Record<string, unknown> = {};
	try {
		raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
	} catch {
		// missing or invalid config falls back to defaults
	}
	const review =
		raw.review === "background" || raw.review === "off" || raw.review === "nudge"
			? raw.review
			: DEFAULT_CONFIG.review;
	const interval = Number(raw.reviewInterval);
	const reviewInterval =
		Number.isFinite(interval) && interval >= 1 ? Math.floor(interval) : DEFAULT_CONFIG.reviewInterval;
	const limits = { ...DEFAULT_CONFIG.limits };
	const rawLimits = (raw.limits ?? {}) as Record<string, unknown>;
	for (const scope of MEMORY_SCOPES) {
		const value = Number(rawLimits[scope]);
		if (Number.isFinite(value) && value >= 200 && value <= 20000) limits[scope] = Math.floor(value);
	}
	return { inject: raw.inject !== false, review, reviewInterval, limits };
}

export function ensureMemoryDirs(): void {
	migrateLegacyMemoryDir();
	fs.mkdirSync(PROJECTS_DIR, { recursive: true });
}

/** Walk up from cwd looking for a .git marker; fall back to cwd itself. */
export function findProjectRoot(cwd: string): string {
	let dir = path.resolve(cwd);
	while (true) {
		if (fs.existsSync(path.join(dir, ".git"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return path.resolve(cwd);
		dir = parent;
	}
}

export function projectSlug(projectRoot: string): string {
	return path.resolve(projectRoot).replace(/[\\/:]+/g, "-");
}

export function memoryFilePath(scope: MemoryScope, projectRoot: string): string {
	switch (scope) {
		case "user":
			return path.join(MEMORY_DIR, "USER.md");
		case "global":
			return path.join(MEMORY_DIR, "GLOBAL.md");
		case "project":
			return path.join(PROJECTS_DIR, `${projectSlug(projectRoot)}.md`);
	}
}

export function readMemory(scope: MemoryScope, projectRoot: string): string {
	try {
		return fs.readFileSync(memoryFilePath(scope, projectRoot), "utf8").trim();
	} catch {
		return "";
	}
}

export interface MemoryUsage {
	chars: number;
	limit: number;
	pct: number;
}

function usageOf(text: string, limit: number): MemoryUsage {
	return { chars: text.length, limit, pct: Math.round((text.length / limit) * 100) };
}

export function memoryUsage(scope: MemoryScope, projectRoot: string, config: MemoryConfig): MemoryUsage {
	return usageOf(readMemory(scope, projectRoot), config.limits[scope]);
}

// Control chars (except tab/newline), zero-width, bidi-override, and BOM chars:
// memory text must not smuggle invisible content into future system prompts.
const INVISIBLE_OR_CONTROL =
	/[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\ufeff]/g;

const SECRET_PATTERNS = [
	/-----BEGIN [A-Z ]*PRIVATE KEY/,
	/\bAKIA[0-9A-Z]{16}\b/,
	/\beyJ[A-Za-z0-9_-]{20,}\./,
	/\bssh-(?:rsa|ed25519|dss) AAAA/,
	/\b(?:api[_-]?key|secret|token|passwd|password)\b["']?\s*[:=]\s*["']?\S{12,}/i,
];

/** Collapse an entry to one dense line with no invisible characters. */
export function sanitizeEntry(text: string): string {
	return text.replace(INVISIBLE_OR_CONTROL, "").replace(/\s+/g, " ").trim();
}

function validateEntry(content: string): string {
	const entry = sanitizeEntry(content ?? "");
	if (!entry) throw new Error("content is required and must be non-empty.");
	if (entry.length > MAX_ENTRY_CHARS) {
		throw new Error(`Entry too long (${entry.length} > ${MAX_ENTRY_CHARS} chars). Condense to one dense line.`);
	}
	for (const pattern of SECRET_PATTERNS) {
		if (pattern.test(entry)) {
			throw new Error("Entry looks like it contains a secret or credential — memory must never store secrets.");
		}
	}
	return entry;
}

function writeMemoryFile(file: string, text: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const trimmed = text.trim();
	fs.writeFileSync(file, trimmed ? `${trimmed}\n` : "");
}

function enforceCapacity(scope: MemoryScope, next: string, config: MemoryConfig): void {
	const limit = config.limits[scope];
	if (next.length > limit) {
		throw new Error(
			`${scope} memory is full: write would be ${next.length}/${limit} chars. ` +
				`Consolidate first — merge related entries (replace) or drop stale ones (remove).`,
		);
	}
}

function describeCurrent(current: string): string {
	return current || "(empty)";
}

export function addEntry(
	scope: MemoryScope,
	projectRoot: string,
	content: string,
	config: MemoryConfig,
): MemoryUsage {
	const entry = validateEntry(content);
	const current = readMemory(scope, projectRoot);
	const normalized = entry.toLowerCase();
	for (const line of current.split("\n")) {
		if (line.replace(/^[-*]\s+/, "").trim().toLowerCase() === normalized) {
			throw new Error(`Duplicate: ${scope} memory already contains this exact entry.`);
		}
	}
	const next = current ? `${current}\n- ${entry}` : `- ${entry}`;
	enforceCapacity(scope, next, config);
	writeMemoryFile(memoryFilePath(scope, projectRoot), next);
	return usageOf(next, config.limits[scope]);
}

export function replaceText(
	scope: MemoryScope,
	projectRoot: string,
	oldText: string,
	content: string,
	config: MemoryConfig,
): MemoryUsage {
	if (!oldText?.trim()) throw new Error("replace requires old_text.");
	const newText = validateEntry(content);
	const current = readMemory(scope, projectRoot);
	const count = current.split(oldText).length - 1;
	if (count === 0) {
		throw new Error(
			`No match for old_text in ${scope} memory (the prompt snapshot may be stale). Current content:\n${describeCurrent(current)}`,
		);
	}
	if (count > 1) {
		throw new Error(`old_text matches ${count} places in ${scope} memory — provide a longer, unique snippet.`);
	}
	const next = current.replace(oldText, newText).trim();
	enforceCapacity(scope, next, config);
	writeMemoryFile(memoryFilePath(scope, projectRoot), next);
	return usageOf(next, config.limits[scope]);
}

export function removeEntry(
	scope: MemoryScope,
	projectRoot: string,
	oldText: string,
	config: MemoryConfig,
): MemoryUsage {
	if (!oldText?.trim()) throw new Error("remove requires old_text.");
	const current = readMemory(scope, projectRoot);
	const lines = current ? current.split("\n") : [];
	const hits = lines.filter((line) => line.includes(oldText));
	if (hits.length === 0) {
		throw new Error(
			`No entry matching old_text in ${scope} memory (the prompt snapshot may be stale). Current content:\n${describeCurrent(current)}`,
		);
	}
	if (hits.length > 1) {
		throw new Error(`old_text matches ${hits.length} entries — be more specific:\n${hits.join("\n")}`);
	}
	const next = lines.filter((line) => line !== hits[0]).join("\n");
	writeMemoryFile(memoryFilePath(scope, projectRoot), next);
	return usageOf(next.trim(), config.limits[scope]);
}

/** Full overwrite used by `/memory edit`. Keeps newlines, strips invisible chars. */
export function writeMemoryRaw(scope: MemoryScope, projectRoot: string, text: string): void {
	writeMemoryFile(memoryFilePath(scope, projectRoot), text.replace(INVISIBLE_OR_CONTROL, ""));
}
