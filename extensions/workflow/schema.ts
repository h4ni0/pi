import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { CONFIG_DIR_NAME, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@earendil-works/pi-coding-agent";
import { parseAllDocuments } from "yaml";

export type WorkflowSource = "global" | "project";
export type PhaseStatus = "pending" | "running" | "succeeded" | "failed" | "aborted" | "interrupted";
export type WorkflowStatus = PhaseStatus;
export type WorkflowPhaseOutputKind = "text" | "structured";
export type WorkflowOutputDataFieldType = "string" | "number" | "integer" | "boolean" | "array" | "object" | "any";

export interface WorkflowPattern {
	pattern: string;
	flags?: string;
}

export interface WorkflowNextCondition {
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

export interface WorkflowNextRule {
	if?: WorkflowNextCondition;
	goto?: string;
	end?: boolean;
}

export interface WorkflowOutputDataFieldConfig {
	type?: WorkflowOutputDataFieldType;
	description?: string;
}

export interface WorkflowStructuredOutputConfig {
	type: "structured";
	statuses?: string[];
	statusDescription?: string;
	reportDescription?: string;
	dataDescription?: string;
	dataFields?: Record<string, WorkflowOutputDataFieldConfig>;
}

export interface WorkflowTextOutputConfig {
	type: "text";
	description?: string;
}

export type WorkflowPhaseOutputConfig = WorkflowTextOutputConfig | WorkflowStructuredOutputConfig;

export interface WorkflowPhaseResult {
	status: string;
	report: string;
	data?: Record<string, unknown>;
}

export interface PhaseOutputRecord {
	output: string;
	structured?: WorkflowPhaseResult;
}

export interface WorkflowPhase {
	id: string;
	system?: string;
	prompt: string;
	model?: string;
	tools?: string[];
	thinking?: ThinkingLevel;
	output?: WorkflowPhaseOutputConfig;
	next?: WorkflowNextRule[];
}

export interface WorkflowDefinition {
	id: string;
	description: string;
	phases: WorkflowPhase[];
	path: string;
	source: WorkflowSource;
	maxTransitions: number;
}

export interface WorkflowDiagnostic {
	path: string;
	message: string;
}

export interface WorkflowDiscovery {
	workflows: WorkflowDefinition[];
	diagnostics: WorkflowDiagnostic[];
}

export interface LogEntry {
	kind: "info" | "tool" | "assistant" | "steer" | "error";
	text: string;
	timestamp: number;
}

export interface PhaseRunState {
	id: string;
	status: PhaseStatus;
	logs: LogEntry[];
	output?: string;
	structuredOutput?: WorkflowPhaseResult;
	error?: string;
	sessionFile?: string;
}

export interface WorkflowRunState {
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

export const WORKFLOW_TOOL_NAME = "workflow_run";
export const WORKFLOW_PHASE_RESULT_TOOL_NAME = "workflow_phase_result";
export const RUN_STATE_ENTRY = "workflow-run-state";
export const PANEL_ENTRY_TYPE = "workflow-panel";
export const INFO_MESSAGE_TYPE = "workflow-info";
export const CONTEXT_MESSAGE_TYPE = "workflow-context";
export const SNAPSHOT_VERSION = 1;
export const DEFAULT_MAX_TRANSITIONS = 50;
export const MAX_MAX_TRANSITIONS = 500;
export const MAX_WORKFLOW_BYTES = 1024 * 1024;
export const PHASE_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VALID_THINKING = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function getGlobalWorkflowDir(): string {
	return path.join(os.homedir(), ".pi", "workflows");
}

export function getProjectWorkflowDir(cwd: string): string {
	return path.join(cwd, CONFIG_DIR_NAME, "workflows");
}

function isWorkflowFile(name: string): boolean {
	return name.endsWith(".yaml") || name.endsWith(".yml");
}

export function workflowIdFromFilename(filePath: string): string {
	return path.basename(filePath).replace(/\.ya?ml$/, "");
}

function strictDescription(value: unknown, context: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error(`${context} must be a string`);
	return value.trim() || undefined;
}

function parseOutputKind(raw: unknown, context: string): WorkflowPhaseOutputKind {
	if (raw !== "text" && raw !== "structured") throw new Error(`${context}: output type must be "text" or "structured"`);
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
	for (const key of Object.keys(obj)) if (!allowed.has(key)) throw new Error(`${context}: status unknown field: ${key}`);
	const values = obj.enum ?? obj.values ?? obj.options;
	return {
		statuses: values === undefined ? undefined : parseStringArray(values, `${context}: status enum`),
		statusDescription: strictDescription(obj.description, `${context}: status.description`),
	};
}

function parseOutputDescription(raw: unknown, context: string, fieldName: string): string | undefined {
	if (raw === undefined) return undefined;
	if (typeof raw === "string") return raw.trim() || undefined;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${context}: ${fieldName} must be a string or mapping/object`);
	const obj = raw as Record<string, unknown>;
	for (const key of Object.keys(obj)) if (key !== "description") throw new Error(`${context}: ${fieldName} unknown field: ${key}`);
	return strictDescription(obj.description, `${context}: ${fieldName}.description`);
}

function parseDataField(raw: unknown, context: string): WorkflowOutputDataFieldConfig {
	if (typeof raw === "string") return { description: raw.trim() || undefined };
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${context} must be a string or mapping/object`);
	const obj = raw as Record<string, unknown>;
	for (const key of Object.keys(obj)) if (key !== "type" && key !== "description") throw new Error(`${context}: unknown field: ${key}`);
	const config: WorkflowOutputDataFieldConfig = {};
	if (obj.type !== undefined) {
		const valid = new Set<WorkflowOutputDataFieldType>(["string", "number", "integer", "boolean", "array", "object", "any"]);
		if (typeof obj.type !== "string" || !valid.has(obj.type as WorkflowOutputDataFieldType)) {
			throw new Error(`${context}: type must be one of ${Array.from(valid).join(", ")}`);
		}
		config.type = obj.type as WorkflowOutputDataFieldType;
	}
	config.description = strictDescription(obj.description, `${context}: description`);
	return config;
}

function parseOutputData(raw: unknown, context: string): Pick<WorkflowStructuredOutputConfig, "dataDescription" | "dataFields"> {
	if (raw === undefined) return {};
	if (typeof raw === "string") return { dataDescription: raw.trim() || undefined };
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${context}: data must be a string or mapping/object`);
	const obj = raw as Record<string, unknown>;
	const allowed = new Set(["description", "fields", "properties"]);
	for (const key of Object.keys(obj)) if (!allowed.has(key)) throw new Error(`${context}: data unknown field: ${key}`);
	if (obj.fields !== undefined && obj.properties !== undefined) throw new Error(`${context}: use only one of data.fields or data.properties`);
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
		dataDescription: strictDescription(obj.description, `${context}: data.description`),
		dataFields,
	};
}

export function parseOutputConfig(raw: unknown, context: string): WorkflowPhaseOutputConfig | undefined {
	if (raw === undefined) return undefined;
	if (typeof raw === "string") return { type: parseOutputKind(raw, context) };
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${context}: output must be a string or mapping/object`);
	const obj = raw as Record<string, unknown>;
	const allowed = new Set(["type", "description", "status", "statuses", "report", "data"]);
	for (const key of Object.keys(obj)) if (!allowed.has(key)) throw new Error(`${context}: output unknown field: ${key}`);
	const type = parseOutputKind(obj.type ?? "structured", context);
	if (type === "text") {
		for (const key of Object.keys(obj)) if (key !== "type" && key !== "description") throw new Error(`${context}: output type "text" cannot define ${key}`);
		return { type: "text", description: strictDescription(obj.description, `${context}: output.description`) };
	}
	if (obj.description !== undefined) throw new Error(`${context}: output type "structured" cannot define description; use report/status/data descriptions`);
	if (obj.status !== undefined && obj.statuses !== undefined) throw new Error(`${context}: use only one of output.status or output.statuses`);
	return {
		type: "structured",
		...parseOutputStatus(obj.status ?? obj.statuses, context),
		reportDescription: parseOutputDescription(obj.report, context, "report"),
		...parseOutputData(obj.data, context),
	};
}

export function isStructuredOutputConfig(output: WorkflowPhaseOutputConfig | undefined): output is WorkflowStructuredOutputConfig {
	return output?.type === "structured";
}

function parsePattern(raw: unknown, context: string): WorkflowPattern {
	let pattern: unknown;
	let flags: unknown;
	if (typeof raw === "string") pattern = raw;
	else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
		const obj = raw as Record<string, unknown>;
		for (const key of Object.keys(obj)) if (key !== "pattern" && key !== "flags") throw new Error(`${context}: unknown pattern field: ${key}`);
		pattern = obj.pattern;
		flags = obj.flags;
	} else throw new Error(`${context}: pattern must be a string or { pattern, flags }`);
	if (typeof pattern !== "string" || !pattern) throw new Error(`${context}: pattern must be a non-empty string`);
	if (flags !== undefined && (typeof flags !== "string" || !/^[dgimsuvy]*$/.test(flags))) throw new Error(`${context}: pattern flags must contain only JavaScript RegExp flags`);
	try {
		new RegExp(pattern, flags as string | undefined);
	} catch (error) {
		throw new Error(`${context}: invalid regular expression: ${error instanceof Error ? error.message : String(error)}`);
	}
	return flags === undefined ? { pattern } : { pattern, flags: flags as string };
}

function parseStatusList(raw: unknown, context: string): string[] {
	if (typeof raw === "string" && raw.trim()) return [raw.trim()];
	if (Array.isArray(raw) && raw.length > 0 && raw.every((item) => typeof item === "string" && item.trim())) return raw.map((item) => String(item).trim());
	throw new Error(`${context}: status must be a non-empty string or array of strings`);
}

function parseNextCondition(raw: unknown, context: string): WorkflowNextCondition {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${context}: if must be a mapping/object`);
	const obj = raw as Record<string, unknown>;
	const allowed = new Set(["status", "field", "equals", "not_equals", "notEquals", "contains", "matches", "exists", "output_contains", "outputContains", "output_matches", "outputMatches"]);
	for (const key of Object.keys(obj)) if (!allowed.has(key)) throw new Error(`${context}: if unknown field: ${key}`);
	const condition: WorkflowNextCondition = {};
	if (obj.status !== undefined) condition.status = parseStatusList(obj.status, `${context}: status`);
	if (obj.field !== undefined) {
		if (typeof obj.field !== "string" || !obj.field.trim()) throw new Error(`${context}: field must be a non-empty string`);
		condition.field = obj.field.trim();
	}
	if (obj.equals !== undefined) condition.equals = obj.equals;
	if (obj.not_equals !== undefined && obj.notEquals !== undefined) throw new Error(`${context}: use only one of not_equals or notEquals`);
	const notEquals = obj.not_equals ?? obj.notEquals;
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
	if (obj.output_contains !== undefined && obj.outputContains !== undefined) throw new Error(`${context}: use only one of output_contains or outputContains`);
	const outputContains = obj.output_contains ?? obj.outputContains;
	if (outputContains !== undefined) {
		if (typeof outputContains !== "string" || !outputContains) throw new Error(`${context}: output_contains must be a non-empty string`);
		condition.outputContains = outputContains;
	}
	if (obj.output_matches !== undefined && obj.outputMatches !== undefined) throw new Error(`${context}: use only one of output_matches or outputMatches`);
	const outputMatches = obj.output_matches ?? obj.outputMatches;
	if (outputMatches !== undefined) condition.outputMatches = parsePattern(outputMatches, `${context}: output_matches`);
	if (Object.keys(condition).length === 0) throw new Error(`${context}: if must contain at least one condition field`);
	const hasFieldOperator = condition.equals !== undefined || condition.notEquals !== undefined || condition.contains !== undefined || condition.matches !== undefined || condition.exists !== undefined;
	if (hasFieldOperator && !condition.field) throw new Error(`${context}: field is required with equals/not_equals/contains/matches/exists`);
	if (condition.field && !hasFieldOperator) throw new Error(`${context}: field alone is not a condition; add equals/not_equals/contains/matches/exists`);
	return condition;
}

function parseNextRule(raw: unknown, context: string): WorkflowNextRule {
	if (typeof raw === "string") {
		const target = raw.trim();
		if (!target) throw new Error(`${context}: next target must be non-empty`);
		return target === "end" || target === "$end" ? { end: true } : { goto: target };
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${context}: next rule must be a mapping/object`);
	const obj = raw as Record<string, unknown>;
	for (const key of Object.keys(obj)) if (key !== "if" && key !== "goto" && key !== "end") throw new Error(`${context}: next rule unknown field: ${key}`);
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
	return !!condition.field && condition.field !== "output" && condition.field !== "report";
}

function validatePhaseNextRules(phase: WorkflowPhase, phaseIds: Set<string>): void {
	for (const [index, rule] of (phase.next ?? []).entries()) {
		if (rule.goto && !phaseIds.has(rule.goto)) throw new Error(`phase ${phase.id}: next ${index + 1}: unknown goto phase: ${rule.goto}`);
		if (rule.if && conditionRequiresStructuredOutput(rule.if) && !isStructuredOutputConfig(phase.output)) {
			throw new Error(`phase ${phase.id}: next ${index + 1}: status/data field conditions require output: structured`);
		}
		if (rule.if?.status && isStructuredOutputConfig(phase.output) && phase.output.statuses) {
			for (const status of rule.if.status) if (!phase.output.statuses.includes(status)) throw new Error(`phase ${phase.id}: next ${index + 1}: status ${status} is not listed in output.status enum`);
		}
	}
}

interface TemplateReference {
	name: string;
	optional: boolean;
}

export function parseTemplateReferences(template: string, context: string): TemplateReference[] {
	const references: TemplateReference[] = [];
	let cursor = 0;
	while (cursor < template.length) {
		const open = template.indexOf("{{", cursor);
		const strayClose = template.indexOf("}}", cursor);
		if (strayClose !== -1 && (open === -1 || strayClose < open)) throw new Error(`${context}: malformed template delimiter near offset ${strayClose}`);
		if (open === -1) {
			if (template.indexOf("{{", cursor) !== -1 || template.indexOf("}}", cursor) !== -1) throw new Error(`${context}: malformed template delimiter`);
			break;
		}
		const close = template.indexOf("}}", open + 2);
		if (close === -1) throw new Error(`${context}: unclosed template delimiter near offset ${open}`);
		const inner = template.slice(open + 2, close).trim();
		if (!inner || inner.includes("{") || inner.includes("}")) throw new Error(`${context}: malformed template variable near offset ${open}`);
		const optional = inner.endsWith("?");
		const name = optional ? inner.slice(0, -1).trim() : inner;
		if (!name || name.includes("?")) throw new Error(`${context}: malformed template variable {{${inner}}}`);
		references.push({ name, optional });
		cursor = close + 2;
	}
	if (template.includes("{{") && references.length === 0) throw new Error(`${context}: malformed template delimiter`);
	return references;
}

function validateTemplateReference(ref: TemplateReference, workflow: WorkflowDefinition, context: string): void {
	if (ref.name === "input") {
		if (ref.optional) throw new Error(`${context}: unknown optional template variable: {{input?}}`);
		return;
	}
	const match = /^phase\.([a-z0-9]+(?:-[a-z0-9]+)*)\.([a-zA-Z0-9_.-]+)$/.exec(ref.name);
	if (!match) throw new Error(`${context}: unknown template variable: {{${ref.name}${ref.optional ? "?" : ""}}}`);
	const phase = workflow.phases.find((item) => item.id === match[1]);
	if (!phase) throw new Error(`${context}: unknown phase in template variable: {{${ref.name}}}`);
	const field = match[2];
	if (field === "output" || field === "report" || field === "json") return;
	if (field === "status" || field === "data" || field.startsWith("data.")) {
		if (!isStructuredOutputConfig(phase.output)) throw new Error(`${context}: {{${ref.name}}} requires phase ${phase.id} to use output: structured`);
		if (field.startsWith("data.") && phase.output.dataFields) {
			const topField = field.slice(5).split(".")[0];
			if (!(topField in phase.output.dataFields)) throw new Error(`${context}: unknown data field in template variable: {{${ref.name}}}`);
		}
		return;
	}
	throw new Error(`${context}: unknown phase output field in template variable: {{${ref.name}}}`);
}

export function validateWorkflowTemplates(workflow: WorkflowDefinition): void {
	for (const phase of workflow.phases) {
		for (const ref of parseTemplateReferences(phase.prompt, `phase ${phase.id}: prompt`)) validateTemplateReference(ref, workflow, `phase ${phase.id}: prompt`);
	}
}

export function validateWorkflow(raw: unknown, filePath: string, source: WorkflowSource): WorkflowDefinition {
	const id = workflowIdFromFilename(filePath);
	if (!PHASE_ID_RE.test(id)) throw new Error(`Workflow filename must be lowercase letters/numbers/hyphens: ${path.basename(filePath)}`);
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Workflow YAML must be a mapping/object");
	const obj = raw as Record<string, unknown>;
	for (const key of Object.keys(obj)) if (key !== "description" && key !== "phases" && key !== "maxTransitions") throw new Error(`Unknown top-level field: ${key}`);
	if (obj.description !== undefined && typeof obj.description !== "string") throw new Error("description must be a string when provided");
	let maxTransitions = DEFAULT_MAX_TRANSITIONS;
	if (obj.maxTransitions !== undefined) {
		if (!Number.isInteger(obj.maxTransitions) || (obj.maxTransitions as number) < 1 || (obj.maxTransitions as number) > MAX_MAX_TRANSITIONS) {
			throw new Error(`maxTransitions must be an integer between 1 and ${MAX_MAX_TRANSITIONS}`);
		}
		maxTransitions = obj.maxTransitions as number;
	}
	if (!Array.isArray(obj.phases) || obj.phases.length === 0) throw new Error("phases must be a non-empty array");
	const seen = new Set<string>();
	const phases = obj.phases.map((phaseRaw, index): WorkflowPhase => {
		if (!phaseRaw || typeof phaseRaw !== "object" || Array.isArray(phaseRaw)) throw new Error(`phase ${index + 1} must be a mapping/object`);
		const phaseObj = phaseRaw as Record<string, unknown>;
		for (const key of Object.keys(phaseObj)) if (!["id", "system", "prompt", "model", "tools", "thinking", "output", "next"].includes(key)) throw new Error(`phase ${index + 1}: unknown field: ${key}`);
		if (typeof phaseObj.id !== "string" || !PHASE_ID_RE.test(phaseObj.id)) throw new Error(`phase ${index + 1}: id must be lowercase letters/numbers/hyphens with no leading/trailing hyphen`);
		if (phaseObj.id === "report") throw new Error(`phase ${index + 1}: id "report" is reserved for the workflow report`);
		if (seen.has(phaseObj.id)) throw new Error(`duplicate phase id: ${phaseObj.id}`);
		seen.add(phaseObj.id);
		if (typeof phaseObj.prompt !== "string" || !phaseObj.prompt.trim()) throw new Error(`phase ${phaseObj.id}: prompt is required and must be a non-empty string`);
		if (phaseObj.system !== undefined && typeof phaseObj.system !== "string") throw new Error(`phase ${phaseObj.id}: system must be a string`);
		if (phaseObj.model !== undefined && (typeof phaseObj.model !== "string" || !/^.+\/.+$/.test(phaseObj.model))) throw new Error(`phase ${phaseObj.id}: model must be provider/model`);
		let tools: string[] | undefined;
		if (phaseObj.tools !== undefined) {
			if (!Array.isArray(phaseObj.tools) || !phaseObj.tools.every((tool) => typeof tool === "string" && tool.trim())) throw new Error(`phase ${phaseObj.id}: tools must be an array of strings`);
			tools = phaseObj.tools.map((tool) => String(tool).trim());
		}
		let thinking: ThinkingLevel | undefined;
		if (phaseObj.thinking !== undefined) {
			const value = phaseObj.thinking === false ? "off" : phaseObj.thinking;
			if (typeof value !== "string" || !VALID_THINKING.has(value as ThinkingLevel)) throw new Error(`phase ${phaseObj.id}: thinking must be one of ${Array.from(VALID_THINKING).join(", ")}`);
			thinking = value as ThinkingLevel;
		}
		return {
			id: phaseObj.id,
			prompt: phaseObj.prompt,
			system: phaseObj.system as string | undefined,
			model: phaseObj.model as string | undefined,
			tools,
			thinking,
			output: parseOutputConfig(phaseObj.output, `phase ${phaseObj.id}`),
			next: parseNextRules(phaseObj.next, `phase ${phaseObj.id}`),
		};
	});
	const phaseIds = new Set(phases.map((phase) => phase.id));
	for (const phase of phases) validatePhaseNextRules(phase, phaseIds);
	const workflow: WorkflowDefinition = { id, description: (obj.description as string | undefined) ?? "", phases, path: filePath, source, maxTransitions };
	validateWorkflowTemplates(workflow);
	return workflow;
}

export function parseYamlText(text: string, sourceName = "workflow YAML"): unknown {
	if (Buffer.byteLength(text, "utf8") > MAX_WORKFLOW_BYTES) throw new Error(`${sourceName} exceeds ${MAX_WORKFLOW_BYTES} bytes`);
	const documents = parseAllDocuments(text, { version: "1.1", schema: "yaml-1.1", uniqueKeys: true, strict: true, prettyErrors: true });
	if (documents.length !== 1) throw new Error(`${sourceName} must contain exactly one YAML document (found ${documents.length})`);
	const document = documents[0];
	if (document.errors.length > 0) throw new Error(document.errors.map((error) => error.message).join("; "));
	try {
		return document.toJS({ maxAliasCount: 100 });
	} catch (error) {
		throw new Error(error instanceof Error ? error.message : String(error));
	}
}

function readRegularFileNoFollow(filePath: string, beforeOpen?: (filePath: string) => void): Buffer {
	const before = fs.lstatSync(filePath);
	beforeOpen?.(filePath);
	if (before.isSymbolicLink() || !before.isFile()) throw new Error("Workflow entry must be a regular non-symlink file");
	const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
	const nonBlock = typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0;
	const fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow | nonBlock);
	try {
		const opened = fs.fstatSync(fd);
		const after = fs.lstatSync(filePath);
		if (!opened.isFile() || after.isSymbolicLink() || !after.isFile()) throw new Error("Workflow entry must be a regular non-symlink file");
		if (before.dev !== opened.dev || before.ino !== opened.ino || after.dev !== opened.dev || after.ino !== opened.ino) {
			throw new Error("Workflow entry changed while it was being opened; retry discovery");
		}
		if (opened.size > MAX_WORKFLOW_BYTES) throw new Error(`Workflow file exceeds ${MAX_WORKFLOW_BYTES} bytes`);
		const data = fs.readFileSync(fd);
		if (data.length > MAX_WORKFLOW_BYTES) throw new Error(`Workflow file exceeds ${MAX_WORKFLOW_BYTES} bytes`);
		return data;
	} finally {
		fs.closeSync(fd);
	}
}

interface ScopeFiles {
	byId: Map<string, string[]>;
	diagnostics: WorkflowDiagnostic[];
}

function inspectScope(dir: string): ScopeFiles {
	const diagnostics: WorkflowDiagnostic[] = [];
	const byId = new Map<string, string[]>();
	let dirStat: fs.Stats;
	try {
		dirStat = fs.lstatSync(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { byId, diagnostics };
		return { byId, diagnostics: [{ path: dir, message: error instanceof Error ? error.message : String(error) }] };
	}
	if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return { byId, diagnostics: [{ path: dir, message: "Workflow directory must be a non-symlink directory" }] };
	let names: string[];
	try {
		names = fs.readdirSync(dir).filter(isWorkflowFile).sort((a, b) => a.localeCompare(b));
	} catch (error) {
		return { byId, diagnostics: [{ path: dir, message: error instanceof Error ? error.message : String(error) }] };
	}
	for (const name of names) {
		const filePath = path.join(dir, name);
		const id = workflowIdFromFilename(name);
		const paths = byId.get(id) ?? [];
		paths.push(filePath);
		byId.set(id, paths);
		try {
			const stat = fs.lstatSync(filePath);
			if (stat.isSymbolicLink() || !stat.isFile()) diagnostics.push({ path: filePath, message: "Workflow entry must be a regular non-symlink file" });
			else if (stat.size > MAX_WORKFLOW_BYTES) diagnostics.push({ path: filePath, message: `Workflow file exceeds ${MAX_WORKFLOW_BYTES} bytes` });
		} catch (error) {
			diagnostics.push({ path: filePath, message: error instanceof Error ? error.message : String(error) });
		}
	}
	return { byId, diagnostics };
}

export function discoverWorkflows(cwd: string, projectTrusted: boolean, directories: { globalDir?: string; projectDir?: string; beforeRead?: (filePath: string) => void } = {}): WorkflowDiscovery {
	const diagnostics: WorkflowDiagnostic[] = [];
	const byId = new Map<string, WorkflowDefinition>();
	const loadScope = (dir: string, source: WorkflowSource, shadowExisting: boolean) => {
		const inspected = inspectScope(dir);
		diagnostics.push(...inspected.diagnostics);
		for (const [id, paths] of inspected.byId) {
			if (shadowExisting) byId.delete(id);
			if (paths.length > 1) {
				for (const filePath of paths) diagnostics.push({ path: filePath, message: `Duplicate workflow id "${id}" in ${source} scope (${paths.map((item) => path.basename(item)).join(", ")})` });
				continue;
			}
			const filePath = paths[0];
			if (inspected.diagnostics.some((item) => item.path === filePath)) continue;
			try {
				const raw = parseYamlText(readRegularFileNoFollow(filePath, directories.beforeRead).toString("utf8"), path.basename(filePath));
				byId.set(id, validateWorkflow(raw, filePath, source));
			} catch (error) {
				diagnostics.push({ path: filePath, message: error instanceof Error ? error.message : String(error) });
			}
		}
	};
	loadScope(directories.globalDir ?? getGlobalWorkflowDir(), "global", false);
	if (projectTrusted) loadScope(directories.projectDir ?? getProjectWorkflowDir(cwd), "project", true);
	return { workflows: Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id)), diagnostics };
}

function stringifyTemplateValue(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
	return JSON.stringify(value, null, 2);
}

export function getPathValue(value: unknown, pathParts: string[]): unknown {
	let current = value;
	for (const part of pathParts) {
		if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
		current = (current as Record<string, unknown>)[part];
	}
	return current;
}

export function renderTemplate(template: string, input: string, outputs: Map<string, PhaseOutputRecord>): string {
	parseTemplateReferences(template, "template");
	return template.replace(/{{\s*([^{}]+?)\s*}}/g, (_match, rawName: string) => {
		const raw = rawName.trim();
		const optional = raw.endsWith("?");
		const name = optional ? raw.slice(0, -1).trim() : raw;
		if (name === "input") return input;
		const match = /^phase\.([a-z0-9]+(?:-[a-z0-9]+)*)\.([a-zA-Z0-9_.-]+)$/.exec(name);
		if (!match) throw new Error(`Unknown template variable: {{${name}}}`);
		const record = outputs.get(match[1]);
		if (!record) {
			if (optional) return "";
			throw new Error(`Missing template variable: {{${name}}}`);
		}
		const field = match[2];
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
			const value = getPathValue(record.structured?.data, field.slice(5).split("."));
			if (value === undefined) {
				if (optional) return "";
				throw new Error(`Missing structured template variable: {{${name}}}`);
			}
			return stringifyTemplateValue(value);
		}
		throw new Error(`Unknown template variable: {{${name}}}`);
	});
}

function compilePattern(pattern: WorkflowPattern): RegExp {
	return new RegExp(pattern.pattern, pattern.flags);
}

export function valuesEqual(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (Array.isArray(a) || Array.isArray(b)) {
		return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => valuesEqual(value, b[index]));
	}
	if (a && b && typeof a === "object" && typeof b === "object") {
		const aObj = a as Record<string, unknown>;
		const bObj = b as Record<string, unknown>;
		const aKeys = Object.keys(aObj).sort();
		const bKeys = Object.keys(bObj).sort();
		return aKeys.length === bKeys.length && aKeys.every((key, index) => key === bKeys[index] && valuesEqual(aObj[key], bObj[key]));
	}
	return false;
}

function getConditionFieldValue(condition: WorkflowNextCondition, record: PhaseOutputRecord): unknown {
	if (!condition.field) return undefined;
	if (condition.field === "output" || condition.field === "report") return record.output;
	if (condition.field === "status") return record.structured?.status;
	if (condition.field === "data") return record.structured?.data;
	if (condition.field.startsWith("data.")) return getPathValue(record.structured?.data, condition.field.slice(5).split("."));
	return getPathValue(record.structured, condition.field.split("."));
}

export function matchesNextCondition(condition: WorkflowNextCondition, record: PhaseOutputRecord): boolean {
	if (condition.status && !condition.status.includes(record.structured?.status ?? "")) return false;
	if (condition.outputContains !== undefined && !record.output.includes(condition.outputContains)) return false;
	if (condition.outputMatches !== undefined && !compilePattern(condition.outputMatches).test(record.output)) return false;
	const hasFieldOperator = condition.equals !== undefined || condition.notEquals !== undefined || condition.contains !== undefined || condition.matches !== undefined || condition.exists !== undefined;
	if (!hasFieldOperator) return true;
	const value = getConditionFieldValue(condition, record);
	if (condition.exists !== undefined && (value !== undefined && value !== null) !== condition.exists) return false;
	if (condition.equals !== undefined && !valuesEqual(value, condition.equals)) return false;
	if (condition.notEquals !== undefined && valuesEqual(value, condition.notEquals)) return false;
	if (condition.contains !== undefined && !String(value ?? "").includes(condition.contains)) return false;
	if (condition.matches !== undefined && !compilePattern(condition.matches).test(String(value ?? ""))) return false;
	return true;
}

export interface NextResolution {
	phase?: WorkflowPhase;
	reason: string;
}

export function resolveNextPhase(workflow: WorkflowDefinition, phase: WorkflowPhase, record: PhaseOutputRecord): NextResolution {
	const phaseById = new Map(workflow.phases.map((item) => [item.id, item]));
	const sequential = () => {
		const index = workflow.phases.findIndex((item) => item.id === phase.id);
		return index >= 0 ? workflow.phases[index + 1] : undefined;
	};
	if (!phase.next?.length) {
		const next = sequential();
		return next ? { phase: next, reason: `Next phase: ${next.id} (sequential)` } : { reason: "Workflow ended after final phase" };
	}
	for (const [index, rule] of phase.next.entries()) {
		if (rule.if && !matchesNextCondition(rule.if, record)) continue;
		if (rule.end) return { reason: `Workflow ended by next rule ${index + 1}` };
		const next = rule.goto ? phaseById.get(rule.goto) : undefined;
		if (!next) throw new Error(`Phase ${phase.id} resolved unknown next phase: ${rule.goto ?? "(missing)"}`);
		return { phase: next, reason: `Next phase: ${next.id} (matched next rule ${index + 1})` };
	}
	const next = sequential();
	return next ? { phase: next, reason: `Next phase: ${next.id} (no next rule matched; sequential fallback)` } : { reason: "Workflow ended (no next rule matched)" };
}

export function capParentText(text: string): string {
	const result = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES - 200, maxLines: DEFAULT_MAX_LINES - 2 });
	if (!result.truncated) return text;
	const marker = `[Truncated workflow output: showing ${result.outputLines} of ${result.totalLines} lines, ${result.outputBytes} of ${result.totalBytes} bytes.]`;
	return `${result.content}${result.content ? "\n\n" : ""}${marker}`;
}

export function buildReport(state: WorkflowRunState): string {
	const lines = [`Workflow: ${state.workflowId}`, `Status: ${state.status}`, ""];
	if (state.error) lines.push(`Error: ${state.error}`, "");
	for (const phase of state.phases.filter((item) => item.id !== "report" && item.status !== "pending")) {
		lines.push(`## ${phase.id}`, "");
		if (phase.status === "succeeded") {
			if (phase.structuredOutput) lines.push(`Structured status: ${phase.structuredOutput.status}`, "");
			lines.push((phase.output ?? "(no output)").trim(), "");
		} else {
			lines.push(`Status: ${phase.status}`);
			if (phase.error) lines.push(`Error: ${phase.error}`);
			lines.push("");
		}
	}
	return capParentText(lines.join("\n").trimEnd());
}

export function workflowPromptList(discovery: WorkflowDiscovery): string {
	if (discovery.workflows.length === 0) return "No workflows are currently available.";
	return discovery.workflows.map((workflow) => `- ${workflow.id}${workflow.description ? `: ${workflow.description}` : ""}`).join("\n");
}

export function workflowListMarkdown(discovery: WorkflowDiscovery): string {
	const lines = ["# Workflows", "", "Author and validate global workflows with the installed `pi-workflow` command.", ""];
	if (discovery.workflows.length === 0) lines.push("No workflows found.", "", `Global directory: \`${getGlobalWorkflowDir()}\``);
	else for (const workflow of discovery.workflows) {
		lines.push(`- **${workflow.id}**${workflow.description ? ` — ${workflow.description}` : ""}`);
		lines.push(`  - ${workflow.source}: \`${workflow.path}\``);
	}
	if (discovery.diagnostics.length) {
		lines.push("", "## Workflow errors", "");
		for (const diagnostic of discovery.diagnostics) lines.push(`- \`${diagnostic.path}\`: ${diagnostic.message}`);
	}
	return capParentText(lines.join("\n"));
}
