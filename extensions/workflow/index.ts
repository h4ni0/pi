import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { StringEnum, type Message } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, Text, isKeyRelease, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
type WorkflowSource = "global" | "project";
type PhaseStatus = "pending" | "running" | "succeeded" | "failed" | "aborted";
type WorkflowStatus = "pending" | "running" | "succeeded" | "failed" | "aborted";
type WorkflowPhaseOutputKind = "text" | "structured";
type WorkflowOutputDataFieldType = "string" | "number" | "integer" | "boolean" | "array" | "object" | "any";

type LogKind = "info" | "tool" | "assistant" | "steer" | "error";

interface WorkflowPattern {
	pattern: string;
	flags?: string;
}

interface WorkflowNextCondition {
	status?: string[];
	field?: string;
	equals?: unknown;
	notEquals?: unknown;
	contains?: string;
	matches?: WorkflowPattern;
	exists?: boolean;
	outputContains?: string;
	outputMatches?: WorkflowPattern;
}

interface WorkflowNextRule {
	if?: WorkflowNextCondition;
	goto?: string;
	end?: boolean;
}

interface WorkflowOutputDataFieldConfig {
	type?: WorkflowOutputDataFieldType;
	description?: string;
}

interface WorkflowStructuredOutputConfig {
	type: "structured";
	statuses?: string[];
	statusDescription?: string;
	reportDescription?: string;
	dataDescription?: string;
	dataFields?: Record<string, WorkflowOutputDataFieldConfig>;
}

interface WorkflowTextOutputConfig {
	type: "text";
	description?: string;
}

type WorkflowPhaseOutputConfig = WorkflowTextOutputConfig | WorkflowStructuredOutputConfig;

interface WorkflowPhaseResult {
	status: string;
	report: string;
	data?: Record<string, unknown>;
}

interface PhaseOutputRecord {
	output: string;
	structured?: WorkflowPhaseResult;
}

interface WorkflowPhase {
	id: string;
	system?: string;
	prompt: string;
	model?: string;
	tools?: string[];
	thinking?: ThinkingLevel;
	output?: WorkflowPhaseOutputConfig;
	next?: WorkflowNextRule[];
}

interface WorkflowDefinition {
	id: string;
	description: string;
	phases: WorkflowPhase[];
	path: string;
	source: WorkflowSource;
	maxTransitions: number;
}

interface WorkflowDiagnostic {
	path: string;
	message: string;
}

interface WorkflowDiscovery {
	workflows: WorkflowDefinition[];
	diagnostics: WorkflowDiagnostic[];
}

interface LogEntry {
	kind: LogKind;
	text: string;
	timestamp: number;
}

interface PhaseRunState {
	id: string;
	status: PhaseStatus;
	logs: LogEntry[];
	output?: string;
	structuredOutput?: WorkflowPhaseResult;
	error?: string;
	sessionFile?: string;
}

interface WorkflowRunState {
	runId: string;
	workflowId: string;
	description: string;
	input: string;
	status: WorkflowStatus;
	phases: PhaseRunState[];
	activePhaseId?: string;
	selectedPhaseId?: string;
	report?: string;
	error?: string;
	startedAt: number;
	endedAt?: number;
	composer: string;
	scrollOffset: number;
	focused: boolean;
	steer?: (text: string) => Promise<void>;
	abort?: () => void;
}

interface WorkflowPanelDetails {
	runId: string;
}

const VALID_THINKING = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);
const PHASE_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_LOG_ENTRIES = 400;
const MAX_LOG_TEXT = 6000;
const WORKFLOW_TOOL_NAME = "workflow_run";
const WORKFLOW_PHASE_RESULT_TOOL_NAME = "workflow_phase_result";
const RUN_STATE_ENTRY = "workflow-run-state";
const PANEL_MESSAGE_TYPE = "workflow-panel";
const INFO_MESSAGE_TYPE = "workflow-info";
const DEFAULT_MAX_TRANSITIONS = 50;
const MAX_MAX_TRANSITIONS = 500;

const runStates = new Map<string, WorkflowRunState>();
let activeRunId: string | undefined;
let focusedRunId: string | undefined;
let cachedDiscovery: WorkflowDiscovery = { workflows: [], diagnostics: [] };
let lastPhaseNavigation: { key: "left" | "right"; at: number } | undefined;

function getGlobalWorkflowDir(): string {
	return path.join(os.homedir(), ".pi", "workflows");
}

function getProjectWorkflowDir(cwd: string): string {
	return path.join(cwd, ".pi", "workflows");
}

function isWorkflowFile(name: string): boolean {
	return name.endsWith(".yaml") || name.endsWith(".yml");
}

function workflowIdFromFilename(filePath: string): string {
	return path.basename(filePath).replace(/\.ya?ml$/i, "");
}

function listWorkflowFiles(dir: string): string[] {
	try {
		if (!fs.existsSync(dir)) return [];
		return fs
			.readdirSync(dir, { withFileTypes: true })
			.filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && isWorkflowFile(entry.name))
			.map((entry) => path.join(dir, entry.name))
			.sort((a, b) => a.localeCompare(b));
	} catch {
		return [];
	}
}

function parseYamlFile(filePath: string): unknown {
	const python = String.raw`
import json, sys
try:
    import yaml
except Exception as exc:
    print(json.dumps({"__pi_workflow_error__": "PyYAML is not available: %s" % exc}))
    sys.exit(0)
path = sys.argv[1]
try:
    with open(path, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f)
    print(json.dumps(data, ensure_ascii=False))
except Exception as exc:
    print(json.dumps({"__pi_workflow_error__": str(exc)}))
`;
	const result = spawnSyncText("python3", ["-c", python, filePath]);
	if (result.code !== 0) {
		throw new Error(result.stderr.trim() || `python3 exited with code ${result.code}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout || "null");
	} catch (error) {
		throw new Error(`Failed to parse YAML parser output: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (parsed && typeof parsed === "object" && "__pi_workflow_error__" in parsed) {
		throw new Error(String((parsed as Record<string, unknown>).__pi_workflow_error__));
	}
	return parsed;
}

function spawnSyncText(command: string, args: string[]): { stdout: string; stderr: string; code: number | null } {
	const result = spawnSync(command, args, { encoding: "utf8" });
	return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.status };
}

function parseOutputKind(raw: unknown, context: string): WorkflowPhaseOutputKind {
	if (raw !== "text" && raw !== "structured") {
		throw new Error(`${context}: output type must be "text" or "structured"`);
	}
	return raw;
}

function parseStringArray(raw: unknown, context: string): string[] {
	if (!Array.isArray(raw) || raw.length === 0 || !raw.every((item) => typeof item === "string" && item.trim())) {
		throw new Error(`${context} must be a non-empty array of strings`);
	}
	return raw.map((item) => String(item).trim());
}

function parseOutputStatus(raw: unknown, context: string): Pick<WorkflowStructuredOutputConfig, "statuses" | "statusDescription"> {
	if (raw === undefined) return {};
	if (typeof raw === "string") return { statusDescription: raw.trim() || undefined };
	if (Array.isArray(raw)) return { statuses: parseStringArray(raw, `${context}: status`) };
	if (!raw || typeof raw !== "object") throw new Error(`${context}: status must be a string, array, or mapping/object`);
	const obj = raw as Record<string, unknown>;
	const allowed = new Set(["enum", "values", "options", "description"]);
	for (const key of Object.keys(obj)) {
		if (!allowed.has(key)) throw new Error(`${context}: status unknown field: ${key}`);
	}
	const values = obj.enum ?? obj.values ?? obj.options;
	return {
		statuses: values === undefined ? undefined : parseStringArray(values, `${context}: status enum`),
		statusDescription: typeof obj.description === "string" && obj.description.trim() ? obj.description.trim() : undefined,
	};
}

function parseOutputDescription(raw: unknown, context: string, fieldName: string): string | undefined {
	if (raw === undefined) return undefined;
	if (typeof raw === "string") return raw.trim() || undefined;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${context}: ${fieldName} must be a string or mapping/object`);
	const obj = raw as Record<string, unknown>;
	const allowed = new Set(["description"]);
	for (const key of Object.keys(obj)) {
		if (!allowed.has(key)) throw new Error(`${context}: ${fieldName} unknown field: ${key}`);
	}
	return typeof obj.description === "string" && obj.description.trim() ? obj.description.trim() : undefined;
}

function parseDataField(raw: unknown, context: string): WorkflowOutputDataFieldConfig {
	if (typeof raw === "string") return { description: raw.trim() || undefined };
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${context} must be a string or mapping/object`);
	const obj = raw as Record<string, unknown>;
	const allowed = new Set(["type", "description"]);
	for (const key of Object.keys(obj)) {
		if (!allowed.has(key)) throw new Error(`${context}: unknown field: ${key}`);
	}
	const config: WorkflowOutputDataFieldConfig = {};
	if (obj.type !== undefined) {
		const valid = new Set<WorkflowOutputDataFieldType>(["string", "number", "integer", "boolean", "array", "object", "any"]);
		if (typeof obj.type !== "string" || !valid.has(obj.type as WorkflowOutputDataFieldType)) {
			throw new Error(`${context}: type must be one of ${Array.from(valid).join(", ")}`);
		}
		config.type = obj.type as WorkflowOutputDataFieldType;
	}
	if (obj.description !== undefined) {
		if (typeof obj.description !== "string") throw new Error(`${context}: description must be a string`);
		config.description = obj.description.trim() || undefined;
	}
	return config;
}

function parseOutputData(raw: unknown, context: string): Pick<WorkflowStructuredOutputConfig, "dataDescription" | "dataFields"> {
	if (raw === undefined) return {};
	if (typeof raw === "string") return { dataDescription: raw.trim() || undefined };
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${context}: data must be a string or mapping/object`);
	const obj = raw as Record<string, unknown>;
	const allowed = new Set(["description", "fields", "properties"]);
	for (const key of Object.keys(obj)) {
		if (!allowed.has(key)) throw new Error(`${context}: data unknown field: ${key}`);
	}
	const fieldsRaw = obj.fields ?? obj.properties;
	let dataFields: Record<string, WorkflowOutputDataFieldConfig> | undefined;
	if (fieldsRaw !== undefined) {
		if (!fieldsRaw || typeof fieldsRaw !== "object" || Array.isArray(fieldsRaw)) throw new Error(`${context}: data fields must be a mapping/object`);
		dataFields = {};
		for (const [name, value] of Object.entries(fieldsRaw as Record<string, unknown>)) {
			if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(name)) throw new Error(`${context}: invalid data field name: ${name}`);
			dataFields[name] = parseDataField(value, `${context}: data field ${name}`);
		}
	}
	return {
		dataDescription: typeof obj.description === "string" && obj.description.trim() ? obj.description.trim() : undefined,
		dataFields,
	};
}

function parseOutputConfig(raw: unknown, context: string): WorkflowPhaseOutputConfig | undefined {
	if (raw === undefined) return undefined;
	if (typeof raw === "string") return { type: parseOutputKind(raw, context) };
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${context}: output must be a string or mapping/object`);
	const obj = raw as Record<string, unknown>;
	const allowed = new Set(["type", "description", "status", "statuses", "report", "data"]);
	for (const key of Object.keys(obj)) {
		if (!allowed.has(key)) throw new Error(`${context}: output unknown field: ${key}`);
	}
	const type = parseOutputKind(obj.type ?? "structured", context);
	if (type === "text") {
		for (const key of Object.keys(obj)) {
			if (key !== "type" && key !== "description") throw new Error(`${context}: output type "text" cannot define ${key}`);
		}
		if (obj.description !== undefined && typeof obj.description !== "string") throw new Error(`${context}: output.description must be a string`);
		return { type: "text", description: typeof obj.description === "string" && obj.description.trim() ? obj.description.trim() : undefined };
	}
	if (obj.status !== undefined && obj.statuses !== undefined) throw new Error(`${context}: use only one of output.status or output.statuses`);
	const statusConfig = parseOutputStatus(obj.status ?? obj.statuses, context);
	return {
		type: "structured",
		...statusConfig,
		reportDescription: parseOutputDescription(obj.report, context, "report"),
		...parseOutputData(obj.data, context),
	};
}

function isStructuredOutputConfig(output: WorkflowPhaseOutputConfig | undefined): output is WorkflowStructuredOutputConfig {
	return output?.type === "structured";
}

function parsePattern(raw: unknown, context: string): WorkflowPattern {
	let pattern: unknown;
	let flags: unknown;
	if (typeof raw === "string") {
		pattern = raw;
	} else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
		const obj = raw as Record<string, unknown>;
		const allowed = new Set(["pattern", "flags"]);
		for (const key of Object.keys(obj)) {
			if (!allowed.has(key)) throw new Error(`${context}: unknown pattern field: ${key}`);
		}
		pattern = obj.pattern;
		flags = obj.flags;
	} else {
		throw new Error(`${context}: pattern must be a string or { pattern, flags }`);
	}
	if (typeof pattern !== "string" || pattern.length === 0) {
		throw new Error(`${context}: pattern must be a non-empty string`);
	}
	if (flags !== undefined && (typeof flags !== "string" || !/^[dgimsuvy]*$/.test(flags))) {
		throw new Error(`${context}: pattern flags must contain only JavaScript RegExp flags`);
	}
	try {
		new RegExp(pattern, flags as string | undefined);
	} catch (error) {
		throw new Error(`${context}: invalid regular expression: ${error instanceof Error ? error.message : String(error)}`);
	}
	return flags === undefined ? { pattern } : { pattern, flags: flags as string };
}

function parseStatusList(raw: unknown, context: string): string[] {
	if (typeof raw === "string" && raw.trim()) return [raw.trim()];
	if (Array.isArray(raw) && raw.length > 0 && raw.every((item) => typeof item === "string" && item.trim())) {
		return raw.map((item) => String(item).trim());
	}
	throw new Error(`${context}: status must be a non-empty string or array of strings`);
}

function parseNextCondition(raw: unknown, context: string): WorkflowNextCondition {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(`${context}: if must be a mapping/object`);
	}
	const obj = raw as Record<string, unknown>;
	const allowed = new Set([
		"status",
		"field",
		"equals",
		"not_equals",
		"notEquals",
		"contains",
		"matches",
		"exists",
		"output_contains",
		"outputContains",
		"output_matches",
		"outputMatches",
	]);
	for (const key of Object.keys(obj)) {
		if (!allowed.has(key)) throw new Error(`${context}: if unknown field: ${key}`);
	}
	const condition: WorkflowNextCondition = {};
	if (obj.status !== undefined) condition.status = parseStatusList(obj.status, `${context}: status`);
	if (obj.field !== undefined) {
		if (typeof obj.field !== "string" || !obj.field.trim()) throw new Error(`${context}: field must be a non-empty string`);
		condition.field = obj.field.trim();
	}
	if (obj.equals !== undefined) condition.equals = obj.equals;
	const notEquals = obj.not_equals !== undefined ? obj.not_equals : obj.notEquals;
	if (obj.not_equals !== undefined && obj.notEquals !== undefined) throw new Error(`${context}: use only one of not_equals or notEquals`);
	if (notEquals !== undefined) condition.notEquals = notEquals;
	if (obj.contains !== undefined) {
		if (typeof obj.contains !== "string" || !obj.contains) throw new Error(`${context}: contains must be a non-empty string`);
		condition.contains = obj.contains;
	}
	if (obj.matches !== undefined) condition.matches = parsePattern(obj.matches, `${context}: matches`);
	if (obj.exists !== undefined) {
		if (typeof obj.exists !== "boolean") throw new Error(`${context}: exists must be a boolean`);
		condition.exists = obj.exists;
	}
	const outputContains = obj.output_contains !== undefined ? obj.output_contains : obj.outputContains;
	if (obj.output_contains !== undefined && obj.outputContains !== undefined) throw new Error(`${context}: use only one of output_contains or outputContains`);
	if (outputContains !== undefined) {
		if (typeof outputContains !== "string" || !outputContains) throw new Error(`${context}: output_contains must be a non-empty string`);
		condition.outputContains = outputContains;
	}
	const outputMatches = obj.output_matches !== undefined ? obj.output_matches : obj.outputMatches;
	if (obj.output_matches !== undefined && obj.outputMatches !== undefined) throw new Error(`${context}: use only one of output_matches or outputMatches`);
	if (outputMatches !== undefined) condition.outputMatches = parsePattern(outputMatches, `${context}: output_matches`);
	if (Object.keys(condition).length === 0) throw new Error(`${context}: if must contain at least one condition field`);
	if ((condition.equals !== undefined || condition.notEquals !== undefined || condition.contains !== undefined || condition.matches !== undefined || condition.exists !== undefined) && !condition.field) {
		throw new Error(`${context}: field is required with equals/not_equals/contains/matches/exists`);
	}
	return condition;
}

function parseNextRule(raw: unknown, context: string): WorkflowNextRule {
	if (typeof raw === "string") {
		const target = raw.trim();
		if (!target) throw new Error(`${context}: next target must be non-empty`);
		return target === "end" || target === "$end" ? { end: true } : { goto: target };
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(`${context}: next rule must be a mapping/object`);
	}
	const obj = raw as Record<string, unknown>;
	const allowed = new Set(["if", "goto", "end"]);
	for (const key of Object.keys(obj)) {
		if (!allowed.has(key)) throw new Error(`${context}: next rule unknown field: ${key}`);
	}
	const rule: WorkflowNextRule = {};
	if (obj.if !== undefined) rule.if = parseNextCondition(obj.if, `${context}: if`);
	if (obj.goto !== undefined) {
		if (typeof obj.goto !== "string" || !obj.goto.trim()) throw new Error(`${context}: goto must be a non-empty string`);
		const target = obj.goto.trim();
		if (target === "$end") rule.end = true;
		else rule.goto = target;
	}
	if (obj.end !== undefined) {
		if (obj.end !== true) throw new Error(`${context}: end must be true when provided`);
		rule.end = true;
	}
	if (rule.goto && rule.end) throw new Error(`${context}: use only one of goto or end`);
	if (!rule.goto && !rule.end) throw new Error(`${context}: next rule must specify goto or end: true`);
	return rule;
}

function parseNextRules(raw: unknown, context: string): WorkflowNextRule[] | undefined {
	if (raw === undefined) return undefined;
	if (Array.isArray(raw)) {
		if (raw.length === 0) throw new Error(`${context}: next must not be an empty array`);
		return raw.map((item, index) => parseNextRule(item, `${context}: next ${index + 1}`));
	}
	return [parseNextRule(raw, `${context}: next`)];
}

function conditionRequiresStructuredOutput(condition: WorkflowNextCondition): boolean {
	if (condition.status !== undefined) return true;
	if (!condition.field) return false;
	return condition.field !== "output" && condition.field !== "report";
}

function validatePhaseNextRules(phase: WorkflowPhase, phaseIds: Set<string>) {
	if (!phase.next) return;
	for (const [index, rule] of phase.next.entries()) {
		if (rule.goto && !phaseIds.has(rule.goto)) {
			throw new Error(`phase ${phase.id}: next ${index + 1}: unknown goto phase: ${rule.goto}`);
		}
		if (rule.if && conditionRequiresStructuredOutput(rule.if) && !isStructuredOutputConfig(phase.output)) {
			throw new Error(`phase ${phase.id}: next ${index + 1}: status/data field conditions require output: structured`);
		}
		if (rule.if?.status && isStructuredOutputConfig(phase.output) && phase.output.statuses) {
			for (const status of rule.if.status) {
				if (!phase.output.statuses.includes(status)) throw new Error(`phase ${phase.id}: next ${index + 1}: status ${status} is not listed in output.status enum`);
			}
		}
	}
}

function validateWorkflow(raw: unknown, filePath: string, source: WorkflowSource): WorkflowDefinition {
	const id = workflowIdFromFilename(filePath);
	if (!PHASE_ID_RE.test(id)) {
		throw new Error(`Workflow filename must be lowercase letters/numbers/hyphens: ${path.basename(filePath)}`);
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("Workflow YAML must be a mapping/object");
	}
	const obj = raw as Record<string, unknown>;
	const allowedTop = new Set(["description", "phases", "maxTransitions"]);
	for (const key of Object.keys(obj)) {
		if (!allowedTop.has(key)) throw new Error(`Unknown top-level field: ${key}`);
	}
	const description = obj.description === undefined ? "" : obj.description;
	if (typeof description !== "string") throw new Error("description must be a string when provided");
	let maxTransitions = DEFAULT_MAX_TRANSITIONS;
	if (obj.maxTransitions !== undefined) {
		if (!Number.isInteger(obj.maxTransitions) || (obj.maxTransitions as number) < 1 || (obj.maxTransitions as number) > MAX_MAX_TRANSITIONS) {
			throw new Error(`maxTransitions must be an integer between 1 and ${MAX_MAX_TRANSITIONS}`);
		}
		maxTransitions = obj.maxTransitions as number;
	}
	if (!Array.isArray(obj.phases) || obj.phases.length === 0) {
		throw new Error("phases must be a non-empty array");
	}

	const seen = new Set<string>();
	const phases = obj.phases.map((phaseRaw, index): WorkflowPhase => {
		if (!phaseRaw || typeof phaseRaw !== "object" || Array.isArray(phaseRaw)) {
			throw new Error(`phase ${index + 1} must be a mapping/object`);
		}
		const phaseObj = phaseRaw as Record<string, unknown>;
		const allowedPhase = new Set(["id", "system", "prompt", "model", "tools", "thinking", "output", "next"]);
		for (const key of Object.keys(phaseObj)) {
			if (!allowedPhase.has(key)) throw new Error(`phase ${index + 1}: unknown field: ${key}`);
		}
		if (typeof phaseObj.id !== "string" || !PHASE_ID_RE.test(phaseObj.id)) {
			throw new Error(`phase ${index + 1}: id must be lowercase letters/numbers/hyphens with no leading/trailing hyphen`);
		}
		if (seen.has(phaseObj.id)) throw new Error(`duplicate phase id: ${phaseObj.id}`);
		seen.add(phaseObj.id);
		if (typeof phaseObj.prompt !== "string" || phaseObj.prompt.trim().length === 0) {
			throw new Error(`phase ${phaseObj.id}: prompt is required and must be a non-empty string`);
		}
		if (phaseObj.system !== undefined && typeof phaseObj.system !== "string") {
			throw new Error(`phase ${phaseObj.id}: system must be a string`);
		}
		if (phaseObj.model !== undefined) {
			if (typeof phaseObj.model !== "string" || !/^.+\/.+$/.test(phaseObj.model)) {
				throw new Error(`phase ${phaseObj.id}: model must be provider/model`);
			}
		}
		let tools: string[] | undefined;
		if (phaseObj.tools !== undefined) {
			if (!Array.isArray(phaseObj.tools) || !phaseObj.tools.every((tool) => typeof tool === "string" && tool.trim())) {
				throw new Error(`phase ${phaseObj.id}: tools must be an array of strings`);
			}
			tools = phaseObj.tools.map((tool) => String(tool).trim());
		}
		let thinking: ThinkingLevel | undefined;
		if (phaseObj.thinking !== undefined) {
			const thinkingValue = phaseObj.thinking === false ? "off" : phaseObj.thinking;
			if (typeof thinkingValue !== "string" || !VALID_THINKING.has(thinkingValue as ThinkingLevel)) {
				throw new Error(`phase ${phaseObj.id}: thinking must be one of ${Array.from(VALID_THINKING).join(", ")}`);
			}
			thinking = thinkingValue as ThinkingLevel;
		}
		const output = parseOutputConfig(phaseObj.output, `phase ${phaseObj.id}`);
		const next = parseNextRules(phaseObj.next, `phase ${phaseObj.id}`);
		return {
			id: phaseObj.id,
			prompt: phaseObj.prompt,
			system: phaseObj.system as string | undefined,
			model: phaseObj.model as string | undefined,
			tools,
			thinking,
			output,
			next,
		};
	});

	const phaseIds = new Set(phases.map((phase) => phase.id));
	for (const phase of phases) validatePhaseNextRules(phase, phaseIds);

	return { id, description, phases, path: filePath, source, maxTransitions };
}

function discoverWorkflows(cwd: string, projectTrusted: boolean): WorkflowDiscovery {
	const diagnostics: WorkflowDiagnostic[] = [];
	const byId = new Map<string, WorkflowDefinition>();

	const load = (filePath: string, source: WorkflowSource) => {
		try {
			const raw = parseYamlFile(filePath);
			const workflow = validateWorkflow(raw, filePath, source);
			byId.set(workflow.id, workflow);
		} catch (error) {
			diagnostics.push({ path: filePath, message: error instanceof Error ? error.message : String(error) });
		}
	};

	for (const filePath of listWorkflowFiles(getGlobalWorkflowDir())) load(filePath, "global");
	if (projectTrusted) {
		for (const filePath of listWorkflowFiles(getProjectWorkflowDir(cwd))) load(filePath, "project");
	}

	return { workflows: Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id)), diagnostics };
}

function workflowPromptList(discovery: WorkflowDiscovery): string {
	if (discovery.workflows.length === 0) return "No workflows are currently available.";
	return discovery.workflows
		.map((workflow) => `- ${workflow.id}${workflow.description ? `: ${workflow.description}` : ""}`)
		.join("\n");
}

function workflowListMarkdown(discovery: WorkflowDiscovery): string {
	const lines: string[] = ["# Workflows", ""];
	if (discovery.workflows.length === 0) {
		lines.push("No workflows found.", "", `Global directory: \`${getGlobalWorkflowDir()}\``);
	} else {
		for (const workflow of discovery.workflows) {
			lines.push(`- **${workflow.id}**${workflow.description ? ` — ${workflow.description}` : ""}`);
			lines.push(`  - ${workflow.source}: \`${workflow.path}\``);
		}
	}
	if (discovery.diagnostics.length > 0) {
		lines.push("", "## Workflow errors", "");
		for (const diagnostic of discovery.diagnostics) {
			lines.push(`- \`${diagnostic.path}\`: ${diagnostic.message}`);
		}
	}
	return lines.join("\n");
}

function snapshotRunState(state: WorkflowRunState): Omit<WorkflowRunState, "steer" | "abort"> {
	return {
		runId: state.runId,
		workflowId: state.workflowId,
		description: state.description,
		input: state.input,
		status: state.status,
		phases: state.phases.map((phase) => ({ ...phase, logs: [...phase.logs] })),
		activePhaseId: state.activePhaseId,
		selectedPhaseId: state.selectedPhaseId,
		report: state.report,
		error: state.error,
		startedAt: state.startedAt,
		endedAt: state.endedAt,
		composer: state.composer,
		scrollOffset: state.scrollOffset,
		focused: false,
	};
}

function restoreRunStates(ctx: { sessionManager: { getEntries(): readonly unknown[] } }) {
	for (const entry of ctx.sessionManager.getEntries()) {
		const maybe = entry as { type?: string; customType?: string; data?: unknown };
		if (maybe.type !== "custom" || maybe.customType !== RUN_STATE_ENTRY || !maybe.data) continue;
		const data = maybe.data as WorkflowRunState;
		if (!data.runId || !data.workflowId || !Array.isArray(data.phases)) continue;
		runStates.set(data.runId, { ...data, focused: false, composer: "", scrollOffset: data.scrollOffset ?? 0 });
	}
}

function addLog(phase: PhaseRunState, kind: LogKind, text: string) {
	const clean = text.length > MAX_LOG_TEXT ? `${text.slice(0, MAX_LOG_TEXT)}…` : text;
	phase.logs.push({ kind, text: clean, timestamp: Date.now() });
	if (phase.logs.length > MAX_LOG_ENTRIES) phase.logs.splice(0, phase.logs.length - MAX_LOG_ENTRIES);
}

function setStatusForRender(ctx: any, state?: WorkflowRunState) {
	if (!ctx?.ui?.setStatus) return;
	if (!state) {
		ctx.ui.setStatus("workflow", undefined);
		return;
	}
	const active = state.activePhaseId ? `:${state.activePhaseId}` : "";
	const focus = focusedRunId === state.runId ? " focused" : "";
	ctx.ui.setStatus("workflow", `workflow ${state.workflowId}${active} ${state.status}${focus}`);
}

function sendPanelMessage(pi: ExtensionAPI, state: WorkflowRunState) {
	pi.sendMessage<WorkflowPanelDetails>(
		{
			customType: PANEL_MESSAGE_TYPE,
			content: `Workflow ${state.workflowId}`,
			display: true,
			details: { runId: state.runId },
		},
		{ triggerTurn: false },
	);
}

function persistState(pi: ExtensionAPI, state: WorkflowRunState) {
	pi.appendEntry(RUN_STATE_ENTRY, snapshotRunState(state));
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		const parts = Array.isArray(msg.content) ? msg.content : [];
		const text = parts
			.filter((part: any) => part.type === "text" && typeof part.text === "string")
			.map((part: any) => part.text)
			.join("\n")
			.trim();
		if (text) return text;
	}
	return "";
}

function normalizeStructuredPhaseResult(value: unknown): WorkflowPhaseResult | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const obj = value as Record<string, unknown>;
	if (typeof obj.status !== "string" || !obj.status.trim()) return undefined;
	if (typeof obj.report !== "string" || !obj.report.trim()) return undefined;
	const result: WorkflowPhaseResult = { status: obj.status.trim(), report: obj.report.trim() };
	if (obj.data && typeof obj.data === "object" && !Array.isArray(obj.data)) {
		result.data = obj.data as Record<string, unknown>;
	}
	return result;
}

function getStructuredPhaseResult(messages: Message[]): WorkflowPhaseResult | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i] as any;
		if (msg.role !== "toolResult" || msg.toolName !== WORKFLOW_PHASE_RESULT_TOOL_NAME || msg.isError) continue;
		const result = normalizeStructuredPhaseResult(msg.details);
		if (result) return result;
	}
	return undefined;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeOutputLine(line: string): string {
	return line
		.replace(/\x1b\[[0-9;]*m/g, "")
		.replace(/^\s*[-*+]\s+/, "")
		.replace(/^\s*>\s*/, "")
		.replace(/[`*_]+/g, "")
		.trim();
}

function findConfiguredStatusInText(text: string, config: WorkflowStructuredOutputConfig): string | undefined {
	const statuses = config.statuses ?? [];
	const byLower = new Map(statuses.map((status) => [status.toLowerCase(), status]));
	const statusAlternation = statuses.length > 0 ? statuses.map(escapeRegExp).join("|") : "([A-Za-z][A-Za-z0-9_-]*)";
	const labelRe = new RegExp(`^(?:structured\\s+status|status|verdict|result|outcome)\\s*[:：-]\\s*(?:\\*\\*)?(${statusAlternation})\\b`, "i");
	const labelPrefixRe = /^(?:structured\s+status|status|verdict|result|outcome)\s*[:：-]\s*/i;
	const bareStatusRe = statuses.length > 0 ? new RegExp(`^(?:\\*\\*)?(${statusAlternation})\\b`, "i") : undefined;
	const anyStatusRe = statuses.length > 0 ? new RegExp(`\\b(${statusAlternation})\\b`, "i") : undefined;
	const headingRe = /^#{1,6}\s*(?:structured\s+status|status|verdict|result|outcome)\b/i;
	const lines = text.split("\n").slice(0, 80).map(normalizeOutputLine);

	const normalize = (raw: string | undefined): string | undefined => {
		if (!raw) return undefined;
		const value = raw.trim();
		return statuses.length > 0 ? byLower.get(value.toLowerCase()) : value;
	};

	for (const line of lines) {
		const match = labelRe.exec(line);
		let status = normalize(match?.[1]);
		if (!status && labelPrefixRe.test(line)) status = normalize(anyStatusRe?.exec(line.replace(labelPrefixRe, ""))?.[1]);
		if (status) return status;
	}

	for (let i = 0; i < lines.length; i++) {
		if (!headingRe.test(lines[i])) continue;
		for (const next of lines.slice(i + 1, i + 6)) {
			if (!next) continue;
			const status = normalize(bareStatusRe?.exec(next)?.[1]) ?? normalize(anyStatusRe?.exec(next)?.[1]);
			if (status) return status;
			break;
		}
	}

	for (const line of lines.slice(0, 8)) {
		const status = normalize(bareStatusRe?.exec(line)?.[1]);
		if (status) return status;
	}
	return undefined;
}

function inferStructuredPhaseResultFromText(text: string, config: WorkflowStructuredOutputConfig): WorkflowPhaseResult | undefined {
	const report = text.trim();
	if (!report) return undefined;
	const status = findConfiguredStatusInText(report, config);
	if (!status) return undefined;
	return { status, report };
}

function stringifyTemplateValue(value: unknown): string {
	if (value === undefined) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
	return JSON.stringify(value, null, 2);
}

function getPathValue(value: unknown, pathParts: string[]): unknown {
	let current = value;
	for (const part of pathParts) {
		if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
		current = (current as Record<string, unknown>)[part];
	}
	return current;
}

function renderTemplate(template: string, input: string, outputs: Map<string, PhaseOutputRecord>): string {
	return template.replace(/{{\s*([^}]+?)\s*}}/g, (_match, rawName: string) => {
		const raw = rawName.trim();
		const optional = raw.endsWith("?");
		const name = optional ? raw.slice(0, -1).trim() : raw;
		if (name === "input") return input;
		const phaseMatch = /^phase\.([a-z0-9]+(?:-[a-z0-9]+)*)\.([a-zA-Z0-9_.-]+)$/.exec(name);
		if (phaseMatch) {
			const record = outputs.get(phaseMatch[1]);
			if (record === undefined) {
				if (optional) return "";
				throw new Error(`Missing template variable: {{${name}}}`);
			}
			const field = phaseMatch[2];
			if (field === "output" || field === "report") return record.output;
			if (field === "json") return JSON.stringify(record.structured ?? { output: record.output }, null, 2);
			if (field === "status") {
				if (!record.structured) {
					if (optional) return "";
					throw new Error(`Missing structured template variable: {{${name}}}`);
				}
				return record.structured.status;
			}
			if (field === "data") {
				if (!record.structured?.data) {
					if (optional) return "";
					throw new Error(`Missing structured template variable: {{${name}}}`);
				}
				return JSON.stringify(record.structured.data, null, 2);
			}
			if (field.startsWith("data.")) {
				if (!record.structured?.data) {
					if (optional) return "";
					throw new Error(`Missing structured template variable: {{${name}}}`);
				}
				const value = getPathValue(record.structured.data, field.slice("data.".length).split("."));
				if (value === undefined && optional) return "";
				return stringifyTemplateValue(value);
			}
		}
		if (optional) return "";
		throw new Error(`Unknown template variable: {{${name}}}`);
	});
}

function collectStatusConditions(phase: WorkflowPhase): string[] {
	const statuses = new Set<string>();
	for (const rule of phase.next ?? []) {
		for (const status of rule.if?.status ?? []) statuses.add(status);
	}
	return Array.from(statuses).sort((a, b) => a.localeCompare(b));
}

function formatNextRules(phase: WorkflowPhase): string {
	if (!phase.next?.length) return "No custom next rules; the workflow advances sequentially.";
	return phase.next
		.map((rule, index) => {
			const target = rule.end ? "END" : rule.goto;
			const condition = rule.if ? JSON.stringify(rule.if) : "always";
			return `${index + 1}. if ${condition} -> ${target}`;
		})
		.join("\n");
}

function formatDataFieldConfig(name: string, config: WorkflowOutputDataFieldConfig): string {
	const type = config.type ?? "any";
	return `- data.${name} (${type})${config.description ? `: ${config.description}` : ""}`;
}

function formatStructuredOutputContract(output: WorkflowStructuredOutputConfig, phase: WorkflowPhase): string {
	const nextStatuses = collectStatusConditions(phase).filter((status) => !output.statuses?.includes(status));
	const lines: string[] = [
		`This phase must end by calling the ${WORKFLOW_PHASE_RESULT_TOOL_NAME} tool exactly once as its final action.`,
		`- Do not emit a separate final assistant response after calling ${WORKFLOW_PHASE_RESULT_TOOL_NAME}.`,
		`- Compatibility fallback only if the tool is unavailable: start the final text with \`Status: <status>\`, then include the full Markdown report.`,
		`- status${output.statuses?.length ? `: one of ${output.statuses.join(", ")}` : ": short machine-readable label"}${output.statusDescription ? ` — ${output.statusDescription}` : ""}`,
		`- report: complete human-readable Markdown report${output.reportDescription ? ` — ${output.reportDescription}` : ""}`,
	];
	if (output.dataDescription || output.dataFields) {
		lines.push(`- data: optional machine-readable object${output.dataDescription ? ` — ${output.dataDescription}` : ""}`);
		for (const [name, config] of Object.entries(output.dataFields ?? {})) lines.push(formatDataFieldConfig(name, config));
	} else {
		lines.push("- data: optional machine-readable object for later phases or next-rule conditions.");
	}
	if (nextStatuses.length > 0) lines.push(`- Additional status values referenced by next rules: ${nextStatuses.join(", ")}.`);
	return lines.join("\n");
}

function buildPhaseSystemPrompt(workflow: WorkflowDefinition, phase: WorkflowPhase): string {
	const chunks: string[] = [];
	if (phase.system?.trim()) {
		chunks.push(`# Workflow phase-specific instructions\n\n${phase.system.trim()}`);
	}
	if (phase.output?.type === "text" && phase.output.description?.trim()) {
		chunks.push(`# Workflow output contract\n\nAt the end of this phase, produce text output matching this YAML-configured contract:\n${phase.output.description.trim()}`);
	}
	if (isStructuredOutputConfig(phase.output)) {
		chunks.push(`# Structured workflow output contract

${formatStructuredOutputContract(phase.output, phase)}

Next-rule summary after this phase completes:
${formatNextRules(phase)}`);
	}
	chunks.push(`# Workflow runner invariants

You are running a predefined Pi workflow phase.

Workflow: ${workflow.id}
Phase: ${phase.id}

Rules:
- Do not invoke workflows, /workflow, or workflow_run from inside this phase.
- Focus only on this phase's prompt and task.
- Your final assistant message or structured workflow_phase_result report is the phase output exposed to later phases.
- At the end, follow the Workflow output contract when present; otherwise provide the phase output as a concise Markdown report unless structured workflow output is required.
- Do not include raw tool logs unless they are essential to the result.`);
	return chunks.join("\n\n");
}

function buildReport(state: WorkflowRunState): string {
	const lines: string[] = [`# Workflow report: ${state.workflowId}`, "", `**Status:** ${state.status}`, ""];
	if (state.error) lines.push(`Error: ${state.error}`, "");
	for (const phase of state.phases.filter((p) => p.id !== "report")) {
		lines.push(`## ${phase.id}`, "");
		if (phase.status === "succeeded") {
			if (phase.structuredOutput) lines.push(`Structured status: ${phase.structuredOutput.status}`, "");
			lines.push((phase.output || "(no output)").trim(), "");
		} else if (phase.error) {
			lines.push(`Status: ${phase.status}`, `Error: ${phase.error}`, "");
		} else {
			lines.push(`Status: ${phase.status}`, "");
		}
	}
	return lines.join("\n").trimEnd();
}

function compilePattern(pattern: WorkflowPattern): RegExp {
	return new RegExp(pattern.pattern, pattern.flags);
}

function valuesEqual(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (typeof a === "string" && typeof b === "string") return a === b;
	try {
		return JSON.stringify(a) === JSON.stringify(b);
	} catch {
		return false;
	}
}

function getConditionFieldValue(condition: WorkflowNextCondition, record: PhaseOutputRecord): unknown {
	if (!condition.field) return undefined;
	if (condition.field === "output" || condition.field === "report") return record.output;
	if (condition.field === "status") return record.structured?.status;
	if (condition.field === "data") return record.structured?.data;
	if (condition.field.startsWith("data.")) {
		return getPathValue(record.structured?.data, condition.field.slice("data.".length).split("."));
	}
	return getPathValue(record.structured, condition.field.split("."));
}

function matchesNextCondition(condition: WorkflowNextCondition, record: PhaseOutputRecord): boolean {
	if (condition.status && !condition.status.includes(record.structured?.status ?? "")) return false;
	if (condition.outputContains !== undefined && !record.output.includes(condition.outputContains)) return false;
	if (condition.outputMatches !== undefined && !compilePattern(condition.outputMatches).test(record.output)) return false;

	const hasFieldOperator = condition.equals !== undefined || condition.notEquals !== undefined || condition.contains !== undefined || condition.matches !== undefined || condition.exists !== undefined;
	if (!hasFieldOperator) return true;

	const value = getConditionFieldValue(condition, record);
	if (condition.exists !== undefined) {
		const exists = value !== undefined && value !== null;
		if (exists !== condition.exists) return false;
	}
	if (condition.equals !== undefined && !valuesEqual(value, condition.equals)) return false;
	if (condition.notEquals !== undefined && valuesEqual(value, condition.notEquals)) return false;
	if (condition.contains !== undefined && !String(value ?? "").includes(condition.contains)) return false;
	if (condition.matches !== undefined && !compilePattern(condition.matches).test(String(value ?? ""))) return false;
	return true;
}

interface NextResolution {
	phase?: WorkflowPhase;
	reason: string;
}

function sequentialNextPhase(workflow: WorkflowDefinition, phase: WorkflowPhase): WorkflowPhase | undefined {
	const index = workflow.phases.findIndex((item) => item.id === phase.id);
	return index >= 0 ? workflow.phases[index + 1] : undefined;
}

function resolveNextPhase(workflow: WorkflowDefinition, phase: WorkflowPhase, record: PhaseOutputRecord): NextResolution {
	const phaseById = new Map(workflow.phases.map((item) => [item.id, item]));
	if (!phase.next?.length) {
		const next = sequentialNextPhase(workflow, phase);
		return next ? { phase: next, reason: `Next phase: ${next.id} (sequential)` } : { reason: "Workflow ended after final phase" };
	}
	for (const [index, rule] of phase.next.entries()) {
		if (rule.if && !matchesNextCondition(rule.if, record)) continue;
		if (rule.end) return { reason: `Workflow ended by next rule ${index + 1}` };
		const next = rule.goto ? phaseById.get(rule.goto) : undefined;
		if (!next) throw new Error(`Phase ${phase.id} resolved unknown next phase: ${rule.goto ?? "(missing)"}`);
		return { phase: next, reason: `Next phase: ${next.id} (matched next rule ${index + 1})` };
	}
	const next = sequentialNextPhase(workflow, phase);
	return next ? { phase: next, reason: `Next phase: ${next.id} (no next rule matched; sequential fallback)` } : { reason: "Workflow ended (no next rule matched)" };
}

function phaseNeedsStructuredOutputTool(phase: WorkflowPhase): boolean {
	return isStructuredOutputConfig(phase.output);
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	return { command: "pi", args };
}

function attachJsonlReader(stream: NodeJS.ReadableStream, onLine: (line: string) => void) {
	let buffer = "";
	stream.setEncoding("utf8");
	stream.on("data", (chunk: string) => {
		buffer += chunk;
		while (true) {
			const idx = buffer.indexOf("\n");
			if (idx === -1) break;
			let line = buffer.slice(0, idx);
			buffer = buffer.slice(idx + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			onLine(line);
		}
	});
	stream.on("end", () => {
		if (buffer.length > 0) onLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
	});
}

class RpcPhaseClient {
	private proc: ChildProcessWithoutNullStreams;
	private nextId = 1;
	private pending = new Map<string, { resolve: (value: any) => void; reject: (err: Error) => void }>();
	private stderr = "";
	private closed = false;
	public onEvent?: (event: any) => void;
	public onClose?: (code: number | null, stderr: string) => void;

	constructor(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
		this.proc = spawn(command, args, { cwd, env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
		attachJsonlReader(this.proc.stdout, (line) => this.handleLine(line));
		this.proc.stderr.on("data", (data) => {
			this.stderr += data.toString();
		});
		this.proc.on("close", (code) => {
			this.closed = true;
			for (const pending of this.pending.values()) {
				pending.reject(new Error(`RPC child exited with code ${code}: ${this.stderr.trim()}`));
			}
			this.pending.clear();
			this.onClose?.(code, this.stderr);
		});
		this.proc.on("error", (error) => {
			this.closed = true;
			for (const pending of this.pending.values()) pending.reject(error instanceof Error ? error : new Error(String(error)));
			this.pending.clear();
		});
	}

	getStderr(): string {
		return this.stderr;
	}

	private handleLine(line: string) {
		if (!line.trim()) return;
		let event: any;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		if (event.type === "response" && event.id && this.pending.has(event.id)) {
			const pending = this.pending.get(event.id)!;
			this.pending.delete(event.id);
			pending.resolve(event);
			return;
		}
		if (event.type === "extension_ui_request") {
			this.handleExtensionUiRequest(event);
			return;
		}
		this.onEvent?.(event);
	}

	private handleExtensionUiRequest(event: any) {
		if (!["select", "confirm", "input", "editor"].includes(event.method)) return;
		this.write({ type: "extension_ui_response", id: event.id, cancelled: true });
	}

	private write(command: any) {
		if (this.closed || !this.proc.stdin.writable) return;
		this.proc.stdin.write(`${JSON.stringify(command)}\n`);
	}

	request(command: Record<string, unknown>): Promise<any> {
		if (this.closed) return Promise.reject(new Error(`RPC child is closed: ${this.stderr.trim()}`));
		const id = `wf-${this.nextId++}`;
		const payload = { id, ...command };
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.write(payload);
		});
	}

	abort() {
		this.write({ type: "abort" });
		setTimeout(() => this.kill(), 2500).unref?.();
	}

	kill() {
		try {
			if (!this.proc.killed) this.proc.kill("SIGTERM");
		} catch {
			// ignore
		}
	}
}

function formatToolCall(toolName: string, args: Record<string, unknown>): string {
	switch (toolName) {
		case "bash":
			return `$ ${String(args.command ?? "")}`;
		case "read":
			return `read ${String(args.path ?? args.file_path ?? "")}`;
		case "edit":
			return `edit ${String(args.path ?? args.file_path ?? "")}`;
		case "write":
			return `write ${String(args.path ?? args.file_path ?? "")}`;
		case "grep":
			return `grep ${String(args.pattern ?? "")} in ${String(args.path ?? ".")}`;
		case "find":
			return `find ${String(args.pattern ?? "*")} in ${String(args.path ?? ".")}`;
		case "ls":
			return `ls ${String(args.path ?? ".")}`;
		case WORKFLOW_PHASE_RESULT_TOOL_NAME:
			return `workflow phase result ${String(args.status ?? "")}`;
		default:
			return `${toolName} ${truncatePlain(JSON.stringify(args), 120)}`;
	}
}

function truncatePlain(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

function getPhaseOutputConfigFromEnv(): WorkflowStructuredOutputConfig | undefined {
	const raw = process.env.PI_WORKFLOW_PHASE_OUTPUT_CONFIG;
	if (!raw) return undefined;
	try {
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && (parsed as Record<string, unknown>).type === "structured") {
			return parsed as WorkflowStructuredOutputConfig;
		}
		const config = parseOutputConfig(parsed, "workflow phase output config");
		return isStructuredOutputConfig(config) ? config : undefined;
	} catch {
		return undefined;
	}
}

function schemaForDataField(config: WorkflowOutputDataFieldConfig): any {
	const options = config.description ? { description: config.description } : {};
	switch (config.type) {
		case "string":
			return Type.String(options);
		case "number":
			return Type.Number(options);
		case "integer":
			return Type.Integer(options);
		case "boolean":
			return Type.Boolean(options);
		case "array":
			return Type.Array(Type.Any(), options);
		case "object":
			return Type.Record(Type.String(), Type.Any(), options);
		case "any":
		case undefined:
			return Type.Any(options);
	}
}

function buildDataSchema(config: WorkflowStructuredOutputConfig): any {
	const description = config.dataDescription ?? "Optional machine-readable details for later phases or next-rule conditions.";
	const fields = config.dataFields ?? {};
	if (Object.keys(fields).length === 0) {
		return Type.Optional(Type.Record(Type.String(), Type.Any(), { description }));
	}
	const properties: Record<string, any> = {};
	for (const [name, field] of Object.entries(fields)) properties[name] = Type.Optional(schemaForDataField(field));
	return Type.Optional(Type.Object(properties, { description, additionalProperties: true }));
}

function dataFieldMatchesType(value: unknown, type: WorkflowOutputDataFieldType | undefined): boolean {
	switch (type) {
		case undefined:
		case "any":
			return true;
		case "string":
			return typeof value === "string";
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		case "integer":
			return Number.isInteger(value);
		case "boolean":
			return typeof value === "boolean";
		case "array":
			return Array.isArray(value);
		case "object":
			return !!value && typeof value === "object" && !Array.isArray(value);
	}
}

function validateOutputData(data: Record<string, unknown> | undefined, config: WorkflowStructuredOutputConfig | undefined) {
	if (!data || !config?.dataFields) return;
	for (const [name, field] of Object.entries(config.dataFields)) {
		if (!(name in data)) continue;
		if (!dataFieldMatchesType(data[name], field.type)) {
			throw new Error(`workflow_phase_result.data.${name} must be ${field.type ?? "any"}`);
		}
	}
}

function registerPhaseResultTool(pi: ExtensionAPI) {
	const config = getPhaseOutputConfigFromEnv();
	const statusDescription = config?.statusDescription ?? "Short machine-readable status label, for example PASS, FAIL, APPROVED, or CHANGES_REQUESTED.";
	const statusSchema = config?.statuses?.length
		? StringEnum(config.statuses as [string, ...string[]], { description: statusDescription })
		: Type.String({ description: statusDescription });
	const reportDescription = config?.reportDescription ?? "Complete human-readable Markdown report for this workflow phase.";
	pi.registerTool({
		name: WORKFLOW_PHASE_RESULT_TOOL_NAME,
		label: "Workflow Phase Result",
		description: "Return the final structured result for a workflow phase with separate status and report fields.",
		promptSnippet: "Emit a final workflow phase result with status, report, and optional data",
		promptGuidelines: [
			"Use workflow_phase_result as the final action for workflow phases that require structured output.",
			config ? `Follow the workflow YAML output contract: ${formatStructuredOutputContract(config, { id: "phase", prompt: "" })}` : "Set workflow_phase_result.status to a short machine-readable label and workflow_phase_result.report to the complete human-readable phase report.",
		],
		parameters: Type.Object({
			status: statusSchema,
			report: Type.String({ description: reportDescription }),
			data: buildDataSchema(config ?? { type: "structured" }),
		}),
		async execute(_toolCallId, params) {
			const status = String(params.status ?? "").trim();
			const report = String(params.report ?? "").trim();
			if (!status) throw new Error("workflow_phase_result.status is required");
			if (config?.statuses?.length && !config.statuses.includes(status)) {
				throw new Error(`workflow_phase_result.status must be one of: ${config.statuses.join(", ")}`);
			}
			if (!report) throw new Error("workflow_phase_result.report is required");
			const data = params.data && typeof params.data === "object" && !Array.isArray(params.data) ? params.data as Record<string, unknown> : undefined;
			validateOutputData(data, config);
			const details: WorkflowPhaseResult = data ? { status, report, data } : { status, report };
			return {
				content: [{ type: "text", text: `Recorded workflow phase result: ${status}` }],
				details,
				terminate: true,
			};
		},
		renderResult(result, _options, theme) {
			const details = normalizeStructuredPhaseResult(result.details);
			if (!details) {
				const text = result.content.find((part) => part.type === "text")?.text ?? "";
				return new Text(text, 0, 0);
			}
			return new Text(`${theme.fg("toolTitle", theme.bold(details.status))}\n${details.report}`, 0, 0);
		},
	});
}

async function runPhase(options: {
	workflow: WorkflowDefinition;
	phase: WorkflowPhase;
	phaseState: PhaseRunState;
	state: WorkflowRunState;
	prompt: string;
	ctx: any;
	pi: ExtensionAPI;
	parentTools: string[];
	parentModel?: string;
	parentThinking: ThinkingLevel;
	signal?: AbortSignal;
}): Promise<PhaseOutputRecord> {
	const { workflow, phase, phaseState, state, prompt, ctx, pi } = options;
	phaseState.status = "running";
	state.status = "running";
	state.activePhaseId = phase.id;
	state.selectedPhaseId = phase.id;
	state.scrollOffset = 0;
	addLog(phaseState, "info", `Starting phase ${phase.id}`);
	setStatusForRender(ctx, state);
	persistState(pi, state);

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-"));
	const systemPath = path.join(tmpDir, `system-${workflow.id}-${phase.id}.md`);
	fs.writeFileSync(systemPath, buildPhaseSystemPrompt(workflow, phase), "utf8");

	let tools = (phase.tools ?? options.parentTools).filter((tool) => tool !== WORKFLOW_TOOL_NAME);
	if (phaseNeedsStructuredOutputTool(phase)) {
		tools = Array.from(new Set([...tools, WORKFLOW_PHASE_RESULT_TOOL_NAME]));
	}
	const model = phase.model ?? options.parentModel;
	const thinking = phase.thinking ?? options.parentThinking;

	const args = ["--mode", "rpc", "--name", `workflow:${workflow.id}:${phase.id}:${state.runId.slice(0, 8)}`];
	if (model) args.push("--model", model);
	if (thinking) args.push("--thinking", thinking);
	if (tools.length > 0) args.push("--tools", tools.join(","));
	else args.push("--no-tools");
	args.push(ctx.isProjectTrusted?.() ? "--approve" : "--no-approve");
	args.push("--append-system-prompt", systemPath);

	const invocation = getPiInvocation(args);
	const client = new RpcPhaseClient(invocation.command, invocation.args, ctx.cwd, {
		...process.env,
		PI_WORKFLOW_CHILD: "1",
		PI_WORKFLOW_PHASE_OUTPUT_CONFIG: isStructuredOutputConfig(phase.output) ? JSON.stringify(phase.output) : "",
	});

	let currentAssistantLog: LogEntry | undefined;
	let finalMessages: Message[] = [];
	let phaseError: string | undefined;
	let aborted = false;
	const abort = () => {
		aborted = true;
		phaseState.status = "aborted";
		phaseState.error = "Aborted by user";
		state.status = "aborted";
		state.error = `Phase ${phase.id} aborted by user`;
		addLog(phaseState, "error", "Abort requested");
		client.abort();
		setStatusForRender(ctx, state);
	};
	state.abort = abort;
	state.steer = async (text: string) => {
		addLog(phaseState, "steer", text);
		setStatusForRender(ctx, state);
		const response = await client.request({ type: "steer", message: text });
		if (!response.success) throw new Error(response.error || "Failed to steer phase");
	};

	const onExternalAbort = () => abort();
	options.signal?.addEventListener("abort", onExternalAbort, { once: true });

	client.onEvent = (event) => {
		if (event.type === "message_update") {
			const update = event.assistantMessageEvent;
			if (update?.type === "text_start") {
				currentAssistantLog = { kind: "assistant", text: "", timestamp: Date.now() };
				phaseState.logs.push(currentAssistantLog);
			} else if (update?.type === "text_delta") {
				if (!currentAssistantLog) {
					currentAssistantLog = { kind: "assistant", text: "", timestamp: Date.now() };
					phaseState.logs.push(currentAssistantLog);
				}
				currentAssistantLog.text = truncatePlain(currentAssistantLog.text + update.delta, MAX_LOG_TEXT);
			} else if (update?.type === "error") {
				phaseError = update.errorMessage || update.reason || "Model error";
				addLog(phaseState, "error", phaseError);
			}
			setStatusForRender(ctx, state);
			return;
		}
		if (event.type === "tool_execution_start") {
			addLog(phaseState, "tool", formatToolCall(event.toolName, event.args ?? {}));
			setStatusForRender(ctx, state);
			return;
		}
		if (event.type === "tool_execution_end") {
			addLog(phaseState, event.isError ? "error" : "tool", `${event.isError ? "✗" : "✓"} ${event.toolName}`);
			setStatusForRender(ctx, state);
			return;
		}
		if (event.type === "message_end" && event.message?.role === "assistant") {
			const msg = event.message as Message;
			const stopReason = (msg as any).stopReason;
			if (stopReason === "error" || stopReason === "aborted") {
				phaseError = (msg as any).errorMessage || stopReason;
			}
		}
		if (event.type === "agent_end") {
			finalMessages = (event.messages ?? []) as Message[];
		}
	};

	try {
		const accepted = await client.request({ type: "prompt", message: prompt });
		if (!accepted.success) throw new Error(accepted.error || "Phase prompt rejected");

		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const finish = (fn: () => void) => {
				if (settled) return;
				settled = true;
				clearInterval(check);
				client.onClose = undefined;
				fn();
			};
			const check = setInterval(() => {
				if (finalMessages.length > 0 || phaseError || aborted) {
					finish(resolve);
				}
			}, 100);
			const originalOnEvent = client.onEvent;
			client.onEvent = (event) => {
				originalOnEvent?.(event);
				if (event.type === "agent_end") {
					finish(resolve);
				}
				if (event.type === "message_update" && event.assistantMessageEvent?.type === "error") {
					finish(() => reject(new Error(event.assistantMessageEvent.errorMessage || "Phase model error")));
				}
			};
			client.onClose = (code, stderr) => {
				if (finalMessages.length > 0) return finish(resolve);
				finish(() => reject(new Error(`RPC child exited before phase completed (code ${code}): ${stderr.trim()}`)));
			};
		});

		if (aborted) throw new Error("Aborted by user");
		if (phaseError) throw new Error(phaseError);

		try {
			const stateResponse = await client.request({ type: "get_state" });
			phaseState.sessionFile = stateResponse.data?.sessionFile;
		} catch {
			// ignore stats failure
		}

		const finalOutput = getFinalOutput(finalMessages);
		let structured = getStructuredPhaseResult(finalMessages);
		if (isStructuredOutputConfig(phase.output) && !structured) {
			structured = inferStructuredPhaseResultFromText(finalOutput, phase.output);
			if (structured) {
				addLog(phaseState, "info", `No ${WORKFLOW_PHASE_RESULT_TOOL_NAME} call found; inferred structured status ${structured.status} from final text`);
			}
		}
		if (isStructuredOutputConfig(phase.output) && !structured) {
			throw new Error(`Phase ${phase.id} requires structured output via ${WORKFLOW_PHASE_RESULT_TOOL_NAME}`);
		}
		const output = structured?.report ?? finalOutput;
		phaseState.output = output || "(no output)";
		phaseState.structuredOutput = structured;
		phaseState.status = "succeeded";
		addLog(phaseState, "info", structured ? `Completed phase ${phase.id} with status ${structured.status}` : `Completed phase ${phase.id}`);
		return { output: phaseState.output, structured };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (aborted) {
			phaseState.status = "aborted";
			state.status = "aborted";
		} else {
			phaseState.status = "failed";
			state.status = "failed";
		}
		phaseState.error = message;
		state.error = `Phase ${phase.id} failed: ${message}`;
		addLog(phaseState, "error", message);
		throw error;
	} finally {
		options.signal?.removeEventListener("abort", onExternalAbort);
		state.steer = undefined;
		state.abort = undefined;
		client.kill();
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
		setStatusForRender(ctx, state);
		persistState(pi, state);
	}
}

async function runWorkflow(options: {
	workflow: WorkflowDefinition;
	input: string;
	ctx: any;
	pi: ExtensionAPI;
	signal?: AbortSignal;
	onUpdate?: (result: AgentToolResult<any>) => void;
	displayMessages?: boolean;
}): Promise<WorkflowRunState> {
	const { workflow, input, ctx, pi, signal, onUpdate } = options;
	const runId = randomUUID();
	const state: WorkflowRunState = {
		runId,
		workflowId: workflow.id,
		description: workflow.description,
		input,
		status: "pending",
		phases: workflow.phases.map((phase) => ({ id: phase.id, status: "pending", logs: [] })),
		selectedPhaseId: workflow.phases[0]?.id,
		startedAt: Date.now(),
		composer: "",
		scrollOffset: 0,
		focused: false,
	};
	runStates.set(runId, state);
	activeRunId = runId;
	if (options.displayMessages !== false) sendPanelMessage(pi, state);
	persistState(pi, state);
	setStatusForRender(ctx, state);

	const outputs = new Map<string, PhaseOutputRecord>();
	const phaseVisits = new Map<string, number>();
	const parentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
	const parentThinking = (pi.getThinkingLevel?.() ?? "off") as ThinkingLevel;
	const parentTools = (pi.getActiveTools?.() ?? []).filter((tool) => tool !== WORKFLOW_TOOL_NAME);

	const emitUpdate = () => {
		onUpdate?.({
			content: [{ type: "text", text: `${workflow.id}: ${state.status}${state.activePhaseId ? ` (${state.activePhaseId})` : ""}` }],
			details: snapshotRunState(state),
		});
	};

	try {
		state.status = "running";
		emitUpdate();
		let phase: WorkflowPhase | undefined = workflow.phases[0];
		let executedPhases = 0;
		while (phase) {
			if (executedPhases >= workflow.maxTransitions) {
				throw new Error(`Workflow exceeded maxTransitions (${workflow.maxTransitions}); check for an infinite next loop`);
			}
			executedPhases++;
			const visit = (phaseVisits.get(phase.id) ?? 0) + 1;
			phaseVisits.set(phase.id, visit);
			const phaseState = state.phases.find((p) => p.id === phase!.id)!;
			if (visit > 1) {
				phaseState.status = "pending";
				phaseState.error = undefined;
				phaseState.output = undefined;
				phaseState.structuredOutput = undefined;
				addLog(phaseState, "info", `Re-entering phase ${phase.id} (visit ${visit}); latest output will replace previous output`);
			}
			let prompt: string;
			try {
				prompt = renderTemplate(phase.prompt, input, outputs);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				phaseState.status = "failed";
				phaseState.error = message;
				addLog(phaseState, "error", message);
				throw error;
			}
			const result = await runPhase({
				workflow,
				phase,
				phaseState,
				state,
				prompt,
				ctx,
				pi,
				parentTools,
				parentModel,
				parentThinking,
				signal,
			});
			outputs.set(phase.id, result);
			const next = resolveNextPhase(workflow, phase, result);
			addLog(phaseState, "info", next.reason);
			emitUpdate();
			phase = next.phase;
		}
		state.status = "succeeded";
		state.activePhaseId = undefined;
	} catch (error) {
		if (state.status !== "aborted") state.status = "failed";
		if (!state.error) state.error = error instanceof Error ? error.message : String(error);
	} finally {
		state.endedAt = Date.now();
		state.activePhaseId = undefined;
		state.report = buildReport(state);
		state.phases.push({
			id: "report",
			status: state.status === "succeeded" ? "succeeded" : state.status === "aborted" ? "aborted" : "failed",
			logs: [{ kind: state.status === "succeeded" ? "assistant" : "error", text: state.report, timestamp: Date.now() }],
			output: state.report,
			error: state.status === "succeeded" ? undefined : state.error,
		});
		state.selectedPhaseId = "report";
		activeRunId = activeRunId === runId ? undefined : activeRunId;
		focusedRunId = focusedRunId === runId ? undefined : focusedRunId;
		persistState(pi, state);
		if (options.displayMessages !== false && ctx.mode === "tui" && state.report) {
			pi.sendMessage({ customType: INFO_MESSAGE_TYPE, content: state.report, display: true }, { triggerTurn: false });
		}
		setStatusForRender(ctx, undefined);
		emitUpdate();
	}
	return state;
}

function getSelectedPhase(state: WorkflowRunState): PhaseRunState | undefined {
	return state.phases.find((phase) => phase.id === (state.selectedPhaseId ?? state.activePhaseId)) ?? state.phases[0];
}

function phaseIndex(state: WorkflowRunState): number {
	const id = state.selectedPhaseId ?? state.activePhaseId;
	return Math.max(0, state.phases.findIndex((phase) => phase.id === id));
}

function selectPhase(state: WorkflowRunState, delta: number) {
	const next = Math.max(0, Math.min(state.phases.length - 1, phaseIndex(state) + delta));
	state.selectedPhaseId = state.phases[next]?.id;
	state.scrollOffset = 0;
}

function acceptPhaseNavigation(key: "left" | "right"): boolean {
	const now = Date.now();
	if (lastPhaseNavigation?.key === key && now - lastPhaseNavigation.at < 75) return false;
	lastPhaseNavigation = { key, at: now };
	return true;
}

function handleWorkflowInput(data: string, ctx: any): { consume?: boolean; data?: string } | undefined {
	const active = activeRunId ? runStates.get(activeRunId) : undefined;
	const focused = focusedRunId ? runStates.get(focusedRunId) : undefined;
	if (isKeyRelease(data)) return focused ? { consume: true } : undefined;
	if (matchesKey(data, "ctrl+c") && active) {
		active.abort?.();
		setStatusForRender(ctx, active);
		return { consume: true };
	}
	if (matchesKey(data, "ctrl+w") && active) {
		focusedRunId = active.runId;
		active.focused = true;
		setStatusForRender(ctx, active);
		return { consume: true };
	}
	if (!focused) return undefined;

	if (matchesKey(data, "escape")) {
		focused.focused = false;
		focusedRunId = undefined;
		setStatusForRender(ctx, focused);
		return { consume: true };
	}
	if (matchesKey(data, "enter") || matchesKey(data, "return")) {
		const text = focused.composer.trim();
		focused.composer = "";
		if (text) {
			void focused.steer?.(text).catch((error) => {
				const phase = getSelectedPhase(focused);
				if (phase) addLog(phase, "error", `Steer failed: ${error instanceof Error ? error.message : String(error)}`);
				setStatusForRender(ctx, focused);
			});
		}
		setStatusForRender(ctx, focused);
		return { consume: true };
	}
	if (matchesKey(data, "backspace") || matchesKey(data, "ctrl+h")) {
		focused.composer = focused.composer.slice(0, -1);
		setStatusForRender(ctx, focused);
		return { consume: true };
	}
	if (matchesKey(data, "ctrl+u")) {
		focused.composer = "";
		setStatusForRender(ctx, focused);
		return { consume: true };
	}
	if (matchesKey(data, "up")) {
		focused.scrollOffset += 1;
		setStatusForRender(ctx, focused);
		return { consume: true };
	}
	if (matchesKey(data, "down")) {
		focused.scrollOffset = Math.max(0, focused.scrollOffset - 1);
		setStatusForRender(ctx, focused);
		return { consume: true };
	}
	if (matchesKey(data, "pageup")) {
		focused.scrollOffset += 8;
		setStatusForRender(ctx, focused);
		return { consume: true };
	}
	if (matchesKey(data, "pagedown")) {
		focused.scrollOffset = Math.max(0, focused.scrollOffset - 8);
		setStatusForRender(ctx, focused);
		return { consume: true };
	}
	if (matchesKey(data, "left")) {
		if (acceptPhaseNavigation("left")) selectPhase(focused, -1);
		setStatusForRender(ctx, focused);
		return { consume: true };
	}
	if (matchesKey(data, "right") || matchesKey(data, "tab")) {
		if (acceptPhaseNavigation("right")) selectPhase(focused, 1);
		setStatusForRender(ctx, focused);
		return { consume: true };
	}

	let text = data;
	const pasteMatch = /^\x1b\[200~([\s\S]*)\x1b\[201~$/.exec(text);
	if (pasteMatch) text = pasteMatch[1];
	if (text && !/^\x1b/.test(text)) {
		focused.composer += text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
		setStatusForRender(ctx, focused);
		return { consume: true };
	}
	return { consume: true };
}

function padAnsi(text: string, width: number): string {
	const visible = visibleWidth(text);
	if (visible >= width) return truncateToWidth(text, width, "");
	return text + " ".repeat(width - visible);
}

function padColumn(text: string, width: number, padStart: number, padEnd: number): string {
	const contentWidth = Math.max(1, width - padStart - padEnd);
	return " ".repeat(padStart) + padAnsi(text, contentWidth) + " ".repeat(padEnd);
}

function paintPanelLine(line: string, width: number, theme: any): string {
	const padded = padAnsi(truncateToWidth(line, width, ""), width);
	const bg = theme.getBgAnsi?.("customMessageBg");
	if (!bg) return theme.bg("customMessageBg", padded);
	return `${bg}${padded.replace(/\x1b\[(?:0|49)m/g, (reset) => `${reset}${bg}`)}\x1b[49m`;
}

function renderMarkdownLines(text: string, width: number, theme: any): string[] {
	return new Markdown(
		text,
		0,
		0,
		getMarkdownTheme(),
		{ color: (segment: string) => theme.fg("toolOutput", segment) },
		{ preserveOrderedListMarkers: true },
	).render(width);
}

function wrapPlainWithPrefix(text: string, width: number, prefix = ""): string[] {
	const out: string[] = [];
	for (const rawLine of text.split("\n")) {
		const wrapped = wrapTextWithAnsi(rawLine || " ", Math.max(1, width - visibleWidth(prefix)));
		if (wrapped.length === 0) out.push(prefix);
		else out.push(...wrapped.map((line) => prefix + line));
	}
	return out;
}

function statusIcon(status: PhaseStatus | WorkflowStatus, theme: any): string {
	switch (status) {
		case "pending":
			return theme.fg("dim", "○");
		case "running":
			return theme.fg("warning", "▶");
		case "succeeded":
			return theme.fg("success", "✓");
		case "failed":
			return theme.fg("error", "✗");
		case "aborted":
			return theme.fg("warning", "⊘");
	}
}

function getWorkflowStateFromToolDetails(details: unknown): WorkflowRunState | undefined {
	if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
	const maybe = details as Partial<WorkflowRunState>;
	if (typeof maybe.runId !== "string") return undefined;
	const live = runStates.get(maybe.runId);
	if (live) return live;
	if (typeof maybe.workflowId !== "string" || typeof maybe.status !== "string" || !Array.isArray(maybe.phases)) return undefined;
	return {
		...maybe,
		composer: maybe.composer ?? "",
		scrollOffset: maybe.scrollOffset ?? 0,
		focused: false,
	} as WorkflowRunState;
}

function renderWorkflowPanel(state: WorkflowRunState, width: number, theme: any): string[] {
	const minWidth = 52;
	if (width < minWidth) {
		return [paintPanelLine(theme.fg("accent", `Workflow ${state.workflowId}: ${state.status}`), width, theme)];
	}

	const outer = Math.max(minWidth, width);
	const inner = outer - 2;
	const leftW = Math.min(30, Math.max(20, Math.floor(inner * 0.26)));
	const rightW = inner - leftW - 1;
	const sidebarPadStart = 2;
	const sidebarPadEnd = 1;
	const bodyPadStart = 2;
	const bodyPadEnd = 2;
	const rightContentW = Math.max(1, rightW - bodyPadStart - bodyPadEnd);
	const selected = getSelectedPhase(state);
	const focused = focusedRunId === state.runId;
	const borderColor = focused ? (s: string) => theme.fg("accent", s) : (s: string) => theme.fg("border", s);

	const left: string[] = [];
	left.push(theme.bold("Phases"));
	left.push("");
	for (const phase of state.phases) {
		const isSelected = phase.id === selected?.id;
		const label = `${statusIcon(phase.status, theme)} ${phase.id}`;
		left.push(isSelected ? theme.fg("accent", theme.bold(label)) : label);
	}

	const right: string[] = [];
	const phaseTitle = selected?.id === "report" ? "Report" : selected ? `Phase: ${selected.id}` : "Workflow";
	right.push(theme.bold(phaseTitle));
	right.push(theme.fg("dim", `Workflow ${state.workflowId} · ${state.status}`));
	if (selected?.sessionFile) right.push(theme.fg("dim", `Session: ${selected.sessionFile}`));
	right.push("");
	if (!selected || selected.logs.length === 0) {
		right.push(theme.fg("dim", "No progress yet."));
	} else {
		for (const log of selected.logs) {
			if (log.kind === "assistant") {
				right.push(...renderMarkdownLines(log.text || " ", rightContentW, theme));
				continue;
			}
			const color = log.kind === "error" ? "error" : log.kind === "tool" ? "muted" : log.kind === "steer" ? "warning" : "dim";
			const prefix = log.kind === "tool" ? "→ " : log.kind === "steer" ? "↪ " : log.kind === "error" ? "✗ " : "• ";
			right.push(...wrapPlainWithPrefix(log.text, rightContentW, theme.fg(color, prefix)));
		}
	}

	const bodyH = Math.max(12, Math.min(26, Math.max(left.length, Math.min(right.length, 22))));
	const maxScroll = Math.max(0, right.length - bodyH);
	state.scrollOffset = Math.max(0, Math.min(state.scrollOffset, maxScroll));
	const start = Math.max(0, right.length - bodyH - state.scrollOffset);
	const visibleRight = right.slice(start, start + bodyH);
	if (maxScroll > 0) {
		visibleRight[0] = theme.fg("dim", `↑ ${start}/${right.length}`);
		visibleRight[visibleRight.length - 1] = theme.fg("dim", `↓ ${Math.min(start + bodyH, right.length)}/${right.length}`);
	}

	const heavy = "━";
	const lines: string[] = [];
	lines.push(borderColor(`┏${heavy.repeat(leftW)}┯${heavy.repeat(rightW)}┓`));
	for (let i = 0; i < bodyH; i++) {
		lines.push(
			borderColor("┃") +
				padColumn(left[i] ?? "", leftW, sidebarPadStart, sidebarPadEnd) +
				borderColor("│") +
				padColumn(visibleRight[i] ?? "", rightW, bodyPadStart, bodyPadEnd) +
				borderColor("┃"),
		);
	}
	lines.push(borderColor(`┣${heavy.repeat(leftW)}┷${heavy.repeat(rightW)}┫`));

	const composerW = inner;
	let composerText: string;
	if (state.status === "running") {
		if (focused) {
			composerText = state.composer.length > 0
				? `${state.composer}${theme.fg("accent", "▌")}`
				: `${theme.fg("accent", "▌")} ${theme.fg("dim", "Enter steer · Esc normal composer · ←/→ phase · ↑/↓ scroll · Ctrl+C abort")}`;
		} else {
			composerText = theme.fg("dim", "Ctrl+W focus panel composer · Ctrl+C abort active workflow");
		}
	} else {
		composerText = theme.fg("dim", "Workflow finished · panel retained in chat");
	}
	lines.push(borderColor("┃") + padColumn(composerText, composerW, 2, 2) + borderColor("┃"));
	lines.push(borderColor(`┗${heavy.repeat(composerW)}┛`));
	return lines.map((line) => paintPanelLine(line, width, theme));
}

function parseWorkflowArgs(args: string): { id?: string; task?: string } {
	const trimmed = args.trim();
	if (!trimmed) return {};
	const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
	return { id: match?.[1], task: match?.[2]?.trim() };
}

function findWorkflowOrMessage(id: string, discovery: WorkflowDiscovery): { workflow?: WorkflowDefinition; message?: string } {
	const workflow = discovery.workflows.find((item) => item.id === id);
	if (workflow) return { workflow };
	return { message: `Unknown workflow: ${id}\n\n${workflowPromptList(discovery)}` };
}

export default function workflowExtension(pi: ExtensionAPI): void {
	if (process.env.PI_WORKFLOW_CHILD === "1") {
		registerPhaseResultTool(pi);
		return;
	}

	let unsubscribeInput: (() => void) | undefined;

	pi.registerMessageRenderer<WorkflowPanelDetails>(PANEL_MESSAGE_TYPE, (message, _options, theme) => {
		const runId = message.details?.runId;
		const state = runId ? runStates.get(runId) : undefined;
		if (!state) return new Text(`Workflow run not found: ${runId ?? "unknown"}`, 0, 0);
		return {
			render: (width: number) => renderWorkflowPanel(state, width, theme),
			invalidate: () => undefined,
		};
	});

	pi.registerMessageRenderer(INFO_MESSAGE_TYPE, (message) => {
		const text = typeof message.content === "string" ? message.content : "";
		return new Markdown(text, 0, 0, getMarkdownTheme());
	});

	pi.registerCommand("workflow", {
		description: "List or run a predefined workflow",
		getArgumentCompletions(prefix) {
			const first = prefix.trimStart();
			if (first.includes(" ")) return null;
			return cachedDiscovery.workflows
				.filter((workflow) => workflow.id.startsWith(first))
				.map((workflow) => ({ value: workflow.id, label: workflow.id, description: workflow.description }));
		},
		handler: async (args, ctx) => {
			cachedDiscovery = discoverWorkflows(ctx.cwd, ctx.isProjectTrusted());
			const parsed = parseWorkflowArgs(args);
			if (!parsed.id) {
				pi.sendMessage({ customType: INFO_MESSAGE_TYPE, content: workflowListMarkdown(cachedDiscovery), display: true });
				return;
			}
			const { workflow, message } = findWorkflowOrMessage(parsed.id, cachedDiscovery);
			if (!workflow) {
				pi.sendMessage({ customType: INFO_MESSAGE_TYPE, content: message ?? "Unknown workflow", display: true });
				return;
			}
			let task = parsed.task;
			if (!task) {
				if (!ctx.hasUI) {
					pi.sendMessage({ customType: INFO_MESSAGE_TYPE, content: `Workflow ${workflow.id} requires a task.`, display: true });
					return;
				}
				task = await ctx.ui.editor(`Task for workflow ${workflow.id}`, "");
				if (!task?.trim()) return;
			}
			const state = await runWorkflow({ workflow, input: task.trim(), ctx, pi });
			if (ctx.mode !== "tui") {
				pi.sendMessage({ customType: INFO_MESSAGE_TYPE, content: state.report ?? buildReport(state), display: true });
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		restoreRunStates(ctx);
		cachedDiscovery = discoverWorkflows(ctx.cwd, ctx.isProjectTrusted());
		unsubscribeInput?.();
		unsubscribeInput = ctx.ui.onTerminalInput((data) => handleWorkflowInput(data, ctx));

		const available = workflowPromptList(cachedDiscovery);
		pi.registerTool({
			name: WORKFLOW_TOOL_NAME,
			label: "Workflow Run",
			description: `Run one predefined sequential workflow by id. Available workflows:\n${available}`,
			promptSnippet: "Run a predefined multi-phase workflow by id",
			promptGuidelines: [
				"Use workflow_run when the user asks to run one of the predefined workflows listed in the tool description.",
				"Do not invent workflow ids; workflow_run only accepts predefined workflows.",
			],
			parameters: Type.Object({
				workflow: Type.String({ description: "Workflow id (filename without .yaml/.yml)" }),
				input: Type.String({ description: "Task/input passed to the workflow as {{input}}" }),
			}),
			async execute(_toolCallId, params, signal, onUpdate, toolCtx) {
				const discovery = discoverWorkflows(toolCtx.cwd, toolCtx.isProjectTrusted());
				const { workflow, message } = findWorkflowOrMessage(params.workflow, discovery);
				if (!workflow) {
					return { content: [{ type: "text", text: message ?? `Unknown workflow: ${params.workflow}` }], details: { workflows: discovery.workflows } };
				}
				const state = await runWorkflow({ workflow, input: params.input, ctx: toolCtx, pi, signal, onUpdate, displayMessages: false });
				return { content: [{ type: "text", text: state.report ?? buildReport(state) }], details: snapshotRunState(state) };
			},
			renderCall(args, theme) {
				return new Text(theme.fg("toolTitle", theme.bold("workflow_run ")) + theme.fg("accent", String(args.workflow ?? "")), 0, 0);
			},
			renderResult(result, options, theme) {
				const state = getWorkflowStateFromToolDetails(result.details);
				if (state) {
					return {
						render: (width: number) => renderWorkflowPanel(state, width, theme),
						invalidate: () => undefined,
					};
				}
				const text = result.content.find((part) => part.type === "text")?.text ?? "";
				const rendered = options.expanded ? text : text.split("\n").slice(0, 16).join("\n");
				return new Markdown(rendered, 0, 0, getMarkdownTheme());
			},
		});
	});

	pi.on("session_shutdown", () => {
		unsubscribeInput?.();
		unsubscribeInput = undefined;
		const active = activeRunId ? runStates.get(activeRunId) : undefined;
		active?.abort?.();
	});
}
