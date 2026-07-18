import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { RpcPhaseClient, type RpcPhaseTransport } from "./rpc-client.ts";
import {
	CONTEXT_MESSAGE_TYPE,
	PANEL_ENTRY_TYPE,
	RUN_STATE_ENTRY,
	SNAPSHOT_VERSION,
	WORKFLOW_PHASE_RESULT_TOOL_NAME,
	WORKFLOW_TOOL_NAME,
	buildReport,
	capParentText,
	isStructuredOutputConfig,
	renderTemplate,
	resolveNextPhase,
	validateWorkflowTemplates,
	type LogEntry,
	type PhaseOutputRecord,
	type PhaseRunState,
	type WorkflowDefinition,
	type WorkflowOutputDataFieldConfig,
	type WorkflowPhase,
	type WorkflowPhaseResult,
	type WorkflowRunState,
	type WorkflowStructuredOutputConfig,
} from "./schema.ts";

const MAX_LOG_ENTRIES = 400;
const MAX_LOG_TEXT = 6000;
const UI_UPDATE_INTERVAL_MS = 50;

export interface PersistedRunSnapshot {
	version: typeof SNAPSHOT_VERSION;
	state: Omit<WorkflowRunState, "steer" | "abort">;
}

export interface WorkflowRunnerHooks {
	onStateChanged?: (ctx: ExtensionContext, state?: WorkflowRunState) => void;
}

export interface WorkflowRunnerDependencies {
	createClient?: (command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) => RpcPhaseTransport;
	getInvocation?: (args: string[]) => { command: string; args: string[] };
	writeSystemPrompt?: (filePath: string, content: string) => void;
}

export interface RunWorkflowOptions {
	workflow: WorkflowDefinition;
	input: string;
	ctx: ExtensionContext;
	signal?: AbortSignal;
	onUpdate?: (result: AgentToolResult<any>) => void;
	displayPanel?: boolean;
	recordCommandContext?: boolean;
}

export class WorkflowRunError extends Error {
	constructor(message: string, public readonly state?: WorkflowRunState) {
		super(message);
		this.name = "WorkflowRunError";
	}
}

class WorkflowAbortError extends Error {
	constructor() {
		super("Aborted by user");
		this.name = "WorkflowAbortError";
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function addLog(phase: PhaseRunState, kind: LogEntry["kind"], text: string): void {
	const clean = text.length > MAX_LOG_TEXT ? `${text.slice(0, MAX_LOG_TEXT)}…` : text;
	phase.logs.push({ kind, text: clean, timestamp: Date.now() });
	if (phase.logs.length > MAX_LOG_ENTRIES) phase.logs.splice(0, phase.logs.length - MAX_LOG_ENTRIES);
}

function truncateUtf8(text: string, maxBytes: number): string {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= maxBytes) return text;
	const marker = "… [truncated]";
	let end = Math.max(0, maxBytes - Buffer.byteLength(marker));
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return `${bytes.subarray(0, end).toString("utf8")}${marker}`;
}

export function snapshotRunState(state: WorkflowRunState, includeLogs = true): Omit<WorkflowRunState, "steer" | "abort"> {
	const phases = includeLogs
		? state.phases.map((phase) => ({ ...phase, logs: [...phase.logs], output: phase.output ? capParentText(phase.output) : undefined }))
		: state.phases.filter((phase) => phase.status !== "pending").map((phase) => ({
			id: truncateUtf8(phase.id, 256),
			status: phase.status,
			logs: [],
			error: phase.error ? truncateUtf8(phase.error, 1000) : undefined,
			sessionFile: phase.sessionFile ? truncateUtf8(phase.sessionFile, 1000) : undefined,
		}));
	const snapshot: Omit<WorkflowRunState, "steer" | "abort"> = {
		runId: state.runId,
		workflowId: truncateUtf8(state.workflowId, 256),
		description: includeLogs ? state.description : truncateUtf8(state.description, 1000),
		input: includeLogs ? capParentText(state.input) : truncateUtf8(state.input, 4000),
		status: state.status,
		phases,
		activePhaseId: state.activePhaseId ? (includeLogs ? state.activePhaseId : truncateUtf8(state.activePhaseId, 256)) : undefined,
		selectedPhaseId: state.selectedPhaseId ? (includeLogs ? state.selectedPhaseId : truncateUtf8(state.selectedPhaseId, 256)) : undefined,
		report: state.report ? (includeLogs ? capParentText(state.report) : truncateUtf8(capParentText(state.report), 40_000)) : undefined,
		error: state.error ? (includeLogs ? state.error : truncateUtf8(state.error, 2000)) : undefined,
		startedAt: state.startedAt,
		endedAt: state.endedAt,
		composer: "",
		scrollOffset: state.scrollOffset,
		focused: false,
	};
	if (!includeLogs) {
		while (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > 50 * 1024 && snapshot.phases.length > 1) snapshot.phases.shift();
		if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > 50 * 1024) snapshot.report = snapshot.report ? truncateUtf8(snapshot.report, 20_000) : undefined;
	}
	return snapshot;
}

function formatToolCall(toolName: string, args: Record<string, unknown>): string {
	switch (toolName) {
		case "bash": return `$ ${String(args.command ?? "")}`;
		case "read": return `read ${String(args.path ?? args.file_path ?? "")}`;
		case "edit": return `edit ${String(args.path ?? args.file_path ?? "")}`;
		case "write": return `write ${String(args.path ?? args.file_path ?? "")}`;
		case "grep": return `grep ${String(args.pattern ?? "")} in ${String(args.path ?? ".")}`;
		case "find": return `find ${String(args.pattern ?? "*")} in ${String(args.path ?? ".")}`;
		case "ls": return `ls ${String(args.path ?? ".")}`;
		case WORKFLOW_PHASE_RESULT_TOOL_NAME: return `workflow phase result ${String(args.status ?? "")}`;
		default: return `${toolName} ${truncatePlain(JSON.stringify(args), 120)}`;
	}
}

function truncatePlain(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

function normalizeStructuredPhaseResult(value: unknown): WorkflowPhaseResult | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const obj = value as Record<string, unknown>;
	if (typeof obj.status !== "string" || !obj.status.trim() || typeof obj.report !== "string" || !obj.report.trim()) return undefined;
	const result: WorkflowPhaseResult = { status: obj.status.trim(), report: obj.report.trim() };
	if (obj.data && typeof obj.data === "object" && !Array.isArray(obj.data)) result.data = obj.data as Record<string, unknown>;
	return result;
}

function getFinalAssistant(messages: readonly any[]): any | undefined {
	for (let index = messages.length - 1; index >= 0; index--) if (messages[index]?.role === "assistant") return messages[index];
	return undefined;
}

function getFinalText(messages: readonly any[]): string {
	const assistant = getFinalAssistant(messages);
	if (!assistant || !Array.isArray(assistant.content)) return "";
	return assistant.content.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("\n").trim();
}

export function extractTerminalStructuredResult(messages: readonly any[]): WorkflowPhaseResult {
	const results = messages.map((message, index) => ({ message, index })).filter(({ message }) => message?.role === "toolResult" && message.toolName === WORKFLOW_PHASE_RESULT_TOOL_NAME && !message.isError);
	if (results.length !== 1) throw new Error(`Expected exactly one successful ${WORKFLOW_PHASE_RESULT_TOOL_NAME} call; found ${results.length}`);
	const { message: resultMessage, index: resultIndex } = results[0];
	if (resultIndex !== messages.length - 1) throw new Error(`${WORKFLOW_PHASE_RESULT_TOOL_NAME} must be the terminal conversation activity`);
	const callId = resultMessage.toolCallId;
	const matchingAssistants = messages.filter((message) => message?.role === "assistant" && Array.isArray(message.content) && message.content.some((part: any) => part?.type === "toolCall" && part.id === callId && part.name === WORKFLOW_PHASE_RESULT_TOOL_NAME));
	if (matchingAssistants.length !== 1) throw new Error(`${WORKFLOW_PHASE_RESULT_TOOL_NAME} result is not correlated with exactly one assistant tool call`);
	const calls = matchingAssistants[0].content.filter((part: any) => part?.type === "toolCall");
	if (calls.length !== 1) throw new Error(`${WORKFLOW_PHASE_RESULT_TOOL_NAME} must be the only tool in its terminal tool batch`);
	const structured = normalizeStructuredPhaseResult(resultMessage.details);
	if (!structured) throw new Error(`${WORKFLOW_PHASE_RESULT_TOOL_NAME} returned invalid status/report details`);
	return structured;
}

function firstFailedToolFromMessages(messages: readonly any[]): { name: string; id?: string; detail?: string } | undefined {
	const message = messages.find((item) => item?.role === "toolResult" && item.isError);
	if (!message) return undefined;
	const detail = Array.isArray(message.content) ? message.content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join("\n") : undefined;
	return { name: String(message.toolName ?? "unknown"), id: typeof message.toolCallId === "string" ? message.toolCallId : undefined, detail: detail ? truncatePlain(detail, 500) : undefined };
}

function collectStatusConditions(phase: WorkflowPhase): string[] {
	const statuses = new Set<string>();
	for (const rule of phase.next ?? []) for (const status of rule.if?.status ?? []) statuses.add(status);
	return Array.from(statuses).sort((a, b) => a.localeCompare(b));
}

function formatNextRules(phase: WorkflowPhase): string {
	if (!phase.next?.length) return "No custom next rules; the workflow advances sequentially.";
	return phase.next.map((rule, index) => `${index + 1}. if ${rule.if ? JSON.stringify(rule.if) : "always"} -> ${rule.end ? "END" : rule.goto}`).join("\n");
}

function formatDataFieldConfig(name: string, config: WorkflowOutputDataFieldConfig): string {
	return `- data.${name} (${config.type ?? "any"})${config.description ? `: ${config.description}` : ""}`;
}

export function serializeStructuredOutputConfigForChild(output: WorkflowStructuredOutputConfig): string {
	const status = output.statuses?.length || output.statusDescription
		? { ...(output.statuses?.length ? { enum: output.statuses } : {}), ...(output.statusDescription ? { description: output.statusDescription } : {}) }
		: undefined;
	const data = output.dataDescription || output.dataFields
		? { ...(output.dataDescription ? { description: output.dataDescription } : {}), ...(output.dataFields ? { fields: output.dataFields } : {}) }
		: undefined;
	return JSON.stringify({
		type: "structured",
		...(status ? { status } : {}),
		...(output.reportDescription ? { report: { description: output.reportDescription } } : {}),
		...(data ? { data } : {}),
	});
}

export function formatStructuredOutputContract(output: WorkflowStructuredOutputConfig, phase: WorkflowPhase): string {
	const nextStatuses = collectStatusConditions(phase).filter((status) => !output.statuses?.includes(status));
	const lines = [
		`This phase must end by calling the ${WORKFLOW_PHASE_RESULT_TOOL_NAME} tool exactly once as its final action.`,
		`- Do not batch ${WORKFLOW_PHASE_RESULT_TOOL_NAME} with another tool.`,
		`- Do not emit a separate assistant response or accept steering after calling ${WORKFLOW_PHASE_RESULT_TOOL_NAME}.`,
		`- status${output.statuses?.length ? `: one of ${output.statuses.join(", ")}` : ": short machine-readable label"}${output.statusDescription ? ` — ${output.statusDescription}` : ""}`,
		`- report: complete human-readable Markdown report${output.reportDescription ? ` — ${output.reportDescription}` : ""}`,
	];
	if (output.dataDescription || output.dataFields) {
		lines.push(`- data: optional machine-readable object${output.dataDescription ? ` — ${output.dataDescription}` : ""}`);
		for (const [name, config] of Object.entries(output.dataFields ?? {})) lines.push(formatDataFieldConfig(name, config));
	} else lines.push("- data: optional machine-readable object for later phases or next-rule conditions.");
	if (nextStatuses.length) lines.push(`- Additional status values referenced by next rules: ${nextStatuses.join(", ")}.`);
	return lines.join("\n");
}

export function buildPhaseSystemPrompt(workflow: WorkflowDefinition, phase: WorkflowPhase): string {
	const chunks: string[] = [];
	if (phase.system?.trim()) chunks.push(`# Workflow phase-specific instructions\n\n${phase.system.trim()}`);
	if (phase.output?.type === "text" && phase.output.description?.trim()) chunks.push(`# Workflow output contract\n\nAt the end of this phase, produce non-empty text output matching this YAML-configured contract:\n${phase.output.description.trim()}`);
	if (isStructuredOutputConfig(phase.output)) chunks.push(`# Structured workflow output contract\n\n${formatStructuredOutputContract(phase.output, phase)}\n\nNext-rule summary after this phase completes:\n${formatNextRules(phase)}`);
	chunks.push(`# Workflow runner invariants

You are running a predefined Pi workflow phase.

Workflow: ${workflow.id}
Phase: ${phase.id}

Rules:
- Do not invoke workflows, /workflow, or workflow_run from inside this phase.
- Focus only on this phase's prompt and task.
- Failed tool executions fail the phase even if you later produce a report.
- Your final assistant text or structured workflow_phase_result report is the phase output exposed to later phases.
- Do not include raw tool logs unless they are essential to the result.`);
	return chunks.join("\n\n");
}

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) return { command: process.execPath, args: [currentScript, ...args] };
	const execName = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
	return { command: "pi", args };
}

export function resolveEffectiveAppendSystemPrompt(cwd: string, projectTrusted: boolean): string | undefined {
	const projectPath = path.join(cwd, CONFIG_DIR_NAME, "APPEND_SYSTEM.md");
	if (projectTrusted && fs.existsSync(projectPath)) return projectPath;
	const globalPath = path.join(getAgentDir(), "APPEND_SYSTEM.md");
	return fs.existsSync(globalPath) ? globalPath : undefined;
}

function assertResponse(response: any, command: string): any {
	if (!response?.success) throw new Error(response?.error || `RPC ${command} failed`);
	return response;
}

function assertNotAborted(signal: AbortSignal): void {
	if (signal.aborted) throw new WorkflowAbortError();
}

export class WorkflowRunner {
	readonly runStates = new Map<string, WorkflowRunState>();
	activeRunId?: string;
	focusedRunId?: string;
	private activePromise?: Promise<WorkflowRunState>;
	private activeController?: AbortController;
	private activeClient?: RpcPhaseTransport;
	private activeSlot = false;
	private readonly createClient: NonNullable<WorkflowRunnerDependencies["createClient"]>;
	private readonly invocation: NonNullable<WorkflowRunnerDependencies["getInvocation"]>;
	private readonly writeSystemPrompt: NonNullable<WorkflowRunnerDependencies["writeSystemPrompt"]>;

	constructor(private readonly pi: ExtensionAPI, private readonly hooks: WorkflowRunnerHooks = {}, dependencies: WorkflowRunnerDependencies = {}) {
		this.createClient = dependencies.createClient ?? ((command, args, cwd, env) => new RpcPhaseClient(command, args, cwd, env));
		this.invocation = dependencies.getInvocation ?? getPiInvocation;
		this.writeSystemPrompt = dependencies.writeSystemPrompt ?? ((filePath, content) => fs.writeFileSync(filePath, content, { encoding: "utf8", mode: 0o600 }));
	}

	get activeRunPromise(): Promise<WorkflowRunState> | undefined {
		return this.activePromise;
	}

	getActiveState(): WorkflowRunState | undefined {
		return this.activeRunId ? this.runStates.get(this.activeRunId) : undefined;
	}

	getFocusedState(): WorkflowRunState | undefined {
		return this.focusedRunId ? this.runStates.get(this.focusedRunId) : undefined;
	}

	private changed(ctx: ExtensionContext, state?: WorkflowRunState): void {
		this.hooks.onStateChanged?.(ctx, state);
	}

	private persist(state: WorkflowRunState): void {
		const snapshot: PersistedRunSnapshot = { version: SNAPSHOT_VERSION, state: snapshotRunState(state, false) };
		this.pi.appendEntry(RUN_STATE_ENTRY, snapshot);
	}

	restore(ctx: ExtensionContext): void {
		this.runStates.clear();
		this.activeRunId = undefined;
		this.focusedRunId = undefined;
		this.activePromise = undefined;
		this.activeController = undefined;
		this.activeClient = undefined;
		this.activeSlot = false;
		const latest = new Map<string, WorkflowRunState>();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== RUN_STATE_ENTRY) continue;
			const snapshot = entry.data as Partial<PersistedRunSnapshot> | undefined;
			if (snapshot?.version !== SNAPSHOT_VERSION || !snapshot.state || typeof snapshot.state.runId !== "string" || !Array.isArray(snapshot.state.phases)) continue;
			latest.set(snapshot.state.runId, snapshot.state as WorkflowRunState);
		}
		for (const raw of latest.values()) {
			const state: WorkflowRunState = { ...raw, composer: "", scrollOffset: raw.scrollOffset ?? 0, focused: false, phases: raw.phases.map((phase) => ({ ...phase, logs: [...(phase.logs ?? [])] })) };
			const savedReport = state.phases.find((phase) => phase.id === "report");
			if (savedReport && state.report && savedReport.logs.length === 0) {
				savedReport.output = state.report;
				savedReport.logs = [{ kind: state.status === "succeeded" ? "assistant" : "error", text: state.report, timestamp: state.endedAt ?? Date.now() }];
			}
			let interrupted = state.status === "pending" || state.status === "running";
			for (const phase of state.phases) {
				if (phase.status === "running") {
					phase.status = "interrupted";
					phase.error = phase.error ?? "Interrupted when the previous Pi runtime ended";
					interrupted = true;
				}
			}
			if (interrupted) {
				state.status = "interrupted";
				state.activePhaseId = undefined;
				state.error = state.error ?? "Workflow interrupted when the previous Pi runtime ended";
				state.endedAt = state.endedAt ?? Date.now();
				state.phases = state.phases.filter((phase) => phase.id !== "report");
				state.report = buildReport(state);
				state.phases.push({ id: "report", status: "interrupted", logs: [{ kind: "error", text: state.report, timestamp: Date.now() }], output: state.report, error: state.error });
				state.selectedPhaseId = "report";
			}
			this.runStates.set(state.runId, state);
			if (interrupted) this.persist(state);
		}
	}

	run(options: RunWorkflowOptions): Promise<WorkflowRunState> {
		if (this.activeSlot) throw new WorkflowRunError("Another workflow is already active; wait for it to finish or abort it first");
		this.activeSlot = true;
		const promise = this.executeWorkflow(options);
		this.activePromise = promise;
		void promise.finally(() => {
			if (this.activePromise === promise) this.activePromise = undefined;
			this.activeSlot = false;
		}).catch(() => undefined);
		return promise;
	}

	private async executeWorkflow(options: RunWorkflowOptions): Promise<WorkflowRunState> {
		const { workflow, input, ctx, signal, onUpdate } = options;
		validateWorkflowTemplates(workflow);
		const state: WorkflowRunState = {
			runId: randomUUID(), workflowId: workflow.id, description: workflow.description, input,
			status: "pending", phases: workflow.phases.map((phase) => ({ id: phase.id, status: "pending", logs: [] })),
			selectedPhaseId: workflow.phases[0]?.id, startedAt: Date.now(), composer: "", scrollOffset: 0, focused: false,
		};
		const controller = new AbortController();
		this.activeController = controller;
		this.runStates.set(state.runId, state);
		this.activeRunId = state.runId;
		const abort = () => {
			if (controller.signal.aborted) return;
			controller.abort();
			state.status = "aborted";
			state.error = state.activePhaseId ? `Phase ${state.activePhaseId} aborted by user` : "Workflow aborted by user";
			const phase = state.phases.find((item) => item.id === state.activePhaseId);
			if (phase && (phase.status === "running" || phase.status === "pending")) {
				phase.status = "aborted";
				phase.error = "Aborted by user";
				addLog(phase, "error", "Abort requested");
			}
			void this.activeClient?.abort().catch((error) => {
				if (phase) addLog(phase, "error", `Child teardown failed: ${errorMessage(error)}`);
			});
			this.changed(ctx, state);
		};
		state.abort = abort;
		const externalAbort = () => abort();
		signal?.addEventListener("abort", externalAbort, { once: true });
		if (signal?.aborted) abort();
		if (options.displayPanel !== false) this.pi.appendEntry(PANEL_ENTRY_TYPE, { runId: state.runId });
		this.persist(state);
		this.changed(ctx, state);

		const outputs = new Map<string, PhaseOutputRecord>();
		const visits = new Map<string, number>();
		const parentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
		const parentThinking = this.pi.getThinkingLevel();
		const parentTools = this.pi.getActiveTools().filter((tool) => tool !== WORKFLOW_TOOL_NAME);
		const emitUpdate = () => onUpdate?.({
			content: [{ type: "text", text: `${workflow.id}: ${state.status}${state.activePhaseId ? ` (${state.activePhaseId})` : ""}` }],
			details: snapshotRunState(state, false),
		});

		try {
			assertNotAborted(controller.signal);
			state.status = "running";
			emitUpdate();
			let phase: WorkflowPhase | undefined = workflow.phases[0];
			let transitions = 0;
			while (phase) {
				assertNotAborted(controller.signal);
				if (transitions >= workflow.maxTransitions) throw new Error(`Workflow exceeded maxTransitions (${workflow.maxTransitions}); check for an infinite next loop`);
				transitions++;
				const visit = (visits.get(phase.id) ?? 0) + 1;
				visits.set(phase.id, visit);
				const phaseState = state.phases.find((item) => item.id === phase!.id)!;
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
					const message = errorMessage(error);
					phaseState.status = "failed";
					phaseState.error = message;
					state.status = "failed";
					state.activePhaseId = phase.id;
					state.selectedPhaseId = phase.id;
					state.error = `Phase ${phase.id} failed: ${message}`;
					addLog(phaseState, "error", message);
					this.changed(ctx, state);
					this.persist(state);
					throw error;
				}
				const result = await this.runPhase({ workflow, phase, phaseState, state, prompt, ctx, parentTools, parentModel, parentThinking, signal: controller.signal });
				await new Promise<void>((resolve) => setImmediate(resolve));
				assertNotAborted(controller.signal);
				outputs.set(phase.id, result);
				const next = resolveNextPhase(workflow, phase, result);
				assertNotAborted(controller.signal);
				addLog(phaseState, "info", next.reason);
				emitUpdate();
				phase = next.phase;
			}
			assertNotAborted(controller.signal);
			state.status = "succeeded";
			state.activePhaseId = undefined;
		} catch (error) {
			if (controller.signal.aborted || error instanceof WorkflowAbortError) state.status = "aborted";
			else if (state.status !== "aborted") state.status = "failed";
			state.error ??= errorMessage(error);
		} finally {
			signal?.removeEventListener("abort", externalAbort);
			state.steer = undefined;
			state.abort = undefined;
			state.endedAt = Date.now();
			state.activePhaseId = undefined;
			state.report = buildReport(state);
			state.phases.push({
				id: "report", status: state.status === "succeeded" ? "succeeded" : state.status === "aborted" ? "aborted" : state.status === "interrupted" ? "interrupted" : "failed",
				logs: [{ kind: state.status === "succeeded" ? "assistant" : "error", text: state.report, timestamp: Date.now() }], output: state.report,
				error: state.status === "succeeded" ? undefined : state.error,
			});
			state.selectedPhaseId = "report";
			if (this.activeRunId === state.runId) this.activeRunId = undefined;
			if (this.focusedRunId === state.runId) this.focusedRunId = undefined;
			this.activeController = undefined;
			this.activeClient = undefined;
			this.persist(state);
			this.changed(ctx, undefined);
			emitUpdate();
			if (options.recordCommandContext && state.report) {
				this.pi.sendMessage({ customType: CONTEXT_MESSAGE_TYPE, content: capParentText(`Workflow task:\n${input}\n\n${state.report}`), display: false }, { triggerTurn: false });
			}
		}
		return state;
	}

	private async runPhase(options: {
		workflow: WorkflowDefinition; phase: WorkflowPhase; phaseState: PhaseRunState; state: WorkflowRunState; prompt: string;
		ctx: ExtensionContext; parentTools: string[]; parentModel?: string; parentThinking: ThinkingLevel; signal: AbortSignal;
	}): Promise<PhaseOutputRecord> {
		const { workflow, phase, phaseState, state, prompt, ctx, signal } = options;
		assertNotAborted(signal);
		phaseState.status = "running";
		state.status = "running";
		state.activePhaseId = phase.id;
		state.selectedPhaseId = phase.id;
		state.scrollOffset = 0;
		addLog(phaseState, "info", `Starting phase ${phase.id}`);

		let tmpDir: string | undefined;
		let client: RpcPhaseTransport | undefined;
		let currentAssistantLog: LogEntry | undefined;
		let firstFailedTool: { name: string; id?: string } | undefined;
		let lastRenderAt = 0;
		let renderTimer: NodeJS.Timeout | undefined;
		let steeringOpen = false;
		let steerFailure: Error | undefined;
		const inFlightSteers = new Set<Promise<void>>();
		const scheduleRender = () => {
			const elapsed = Date.now() - lastRenderAt;
			if (elapsed >= UI_UPDATE_INTERVAL_MS) {
				lastRenderAt = Date.now();
				this.changed(ctx, state);
				return;
			}
			if (!renderTimer) renderTimer = setTimeout(() => {
				renderTimer = undefined;
				lastRenderAt = Date.now();
				this.changed(ctx, state);
			}, UI_UPDATE_INTERVAL_MS - elapsed);
		};

		try {
			this.changed(ctx, state);
			this.persist(state);
			tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-"));
			const systemPath = path.join(tmpDir, `system-${workflow.id}-${phase.id}.md`);
			this.writeSystemPrompt(systemPath, buildPhaseSystemPrompt(workflow, phase));
			assertNotAborted(signal);
			let tools = (phase.tools ?? options.parentTools).filter((tool) => tool !== WORKFLOW_TOOL_NAME);
			if (isStructuredOutputConfig(phase.output)) tools = Array.from(new Set([...tools, WORKFLOW_PHASE_RESULT_TOOL_NAME]));
			const parentPersisted = ctx.sessionManager.getSessionFile() !== undefined;
			const args = ["--mode", "rpc", "--name", `workflow:${workflow.id}:${phase.id}:${state.runId.slice(0, 8)}`];
			if (!parentPersisted) args.push("--no-session");
			const model = phase.model ?? options.parentModel;
			if (model) args.push("--model", model);
			const thinking = phase.thinking ?? options.parentThinking;
			if (thinking) args.push("--thinking", thinking);
			if (tools.length) args.push("--tools", tools.join(",")); else args.push("--no-tools");
			args.push(ctx.isProjectTrusted() ? "--approve" : "--no-approve");
			const normalAppend = resolveEffectiveAppendSystemPrompt(ctx.cwd, ctx.isProjectTrusted());
			if (normalAppend) args.push("--append-system-prompt", normalAppend);
			args.push("--append-system-prompt", systemPath);
			const invocation = this.invocation(args);
			assertNotAborted(signal);
			const createdClient = this.createClient(invocation.command, invocation.args, ctx.cwd, {
				...process.env,
				PI_WORKFLOW_CHILD: "1",
				PI_WORKFLOW_PARENT_PID: String(process.pid),
				PI_WORKFLOW_PHASE_OUTPUT_CONFIG: isStructuredOutputConfig(phase.output) ? serializeStructuredOutputConfigForChild(phase.output) : "",
			});
			client = createdClient;
			this.activeClient = createdClient;
			steeringOpen = true;
			createdClient.onEvent = (event) => {
				if (event.type === "agent_settled") {
					steeringOpen = false;
					state.steer = undefined;
				}
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
						currentAssistantLog.text = truncatePlain(currentAssistantLog.text + String(update.delta ?? ""), MAX_LOG_TEXT);
					} else if (update?.type === "error") addLog(phaseState, "error", `Transient model error: ${update.error?.errorMessage ?? update.errorMessage ?? update.reason ?? "model error"}`);
					scheduleRender();
					return;
				}
				if (event.type === "tool_execution_start") addLog(phaseState, "tool", formatToolCall(event.toolName, event.args ?? {}));
				else if (event.type === "tool_execution_end") {
					addLog(phaseState, event.isError ? "error" : "tool", `${event.isError ? "✗" : "✓"} ${event.toolName}`);
					if (event.isError && !firstFailedTool) firstFailedTool = { name: String(event.toolName ?? "unknown"), id: event.toolCallId };
					if (!event.isError && event.toolName === WORKFLOW_PHASE_RESULT_TOOL_NAME) {
						steeringOpen = false;
						state.steer = undefined;
					}
				} else if (event.type === "agent_end" && event.willRetry) addLog(phaseState, "info", "Low-level agent run ended; Pi will retry before settlement");
				else if (event.type === "auto_retry_start") addLog(phaseState, "info", `Pi retry ${event.attempt}/${event.maxAttempts} after transient error`);
				else if (event.type === "compaction_start") addLog(phaseState, "info", `Pi compaction started (${event.reason ?? "unknown"})`);
				else if (event.type === "compaction_end") addLog(phaseState, event.errorMessage ? "error" : "info", event.errorMessage ? `Pi compaction failed: ${event.errorMessage}` : `Pi compaction completed (${event.reason ?? "unknown"})`);
				else if (event.type === "extension_error") addLog(phaseState, "error", `Child extension error: ${event.error ?? "unknown"}`);
				scheduleRender();
			};
			state.steer = async (text: string) => {
				if (!steeringOpen) throw new Error(`Phase ${phase.id} is already settled and no longer accepts steering`);
				assertNotAborted(signal);
				addLog(phaseState, "steer", text);
				scheduleRender();
				const operation = (async () => {
					assertResponse(await createdClient.request({ type: "steer", message: text }), "steer");
					assertNotAborted(signal);
				})().catch((error) => {
					steerFailure ??= error instanceof Error ? error : new Error(String(error));
					throw error;
				});
				inFlightSteers.add(operation);
				try {
					await operation;
				} finally {
					inFlightSteers.delete(operation);
				}
			};

			assertResponse(await createdClient.request({ type: "prompt", message: prompt }), "prompt");
			assertNotAborted(signal);
			await createdClient.waitForSettled();
			steeringOpen = false;
			state.steer = undefined;
			assertNotAborted(signal);
			const pendingSteers = Array.from(inFlightSteers);
			if (pendingSteers.length) await Promise.allSettled(pendingSteers);
			if (steerFailure) throw steerFailure;
			if (pendingSteers.length) {
				await createdClient.waitForSettled();
				assertNotAborted(signal);
			}
			const messagesResponse = assertResponse(await createdClient.request({ type: "get_messages" }), "get_messages");
			assertNotAborted(signal);
			const messages = (messagesResponse.data?.messages ?? []) as Message[];
			const failedFromMessages = firstFailedToolFromMessages(messages);
			const failed = firstFailedTool ?? failedFromMessages;
			if (failed) throw new Error(`Tool ${failed.name}${failed.id ? ` (${failed.id})` : ""} failed${failedFromMessages?.detail ? `: ${failedFromMessages.detail}` : ""}`);
			const finalAssistant = getFinalAssistant(messages);
			if (finalAssistant?.stopReason === "length") throw new Error(`Phase ${phase.id} exceeded the model output limit`);
			if (finalAssistant?.stopReason === "error" || finalAssistant?.stopReason === "aborted") throw new Error(finalAssistant.errorMessage || `Phase model stopped with ${finalAssistant.stopReason}`);
			let structured: WorkflowPhaseResult | undefined;
			if (isStructuredOutputConfig(phase.output)) {
				structured = extractTerminalStructuredResult(messages);
				if (phase.output.statuses?.length && !phase.output.statuses.includes(structured.status)) throw new Error(`${WORKFLOW_PHASE_RESULT_TOOL_NAME}.status must be one of: ${phase.output.statuses.join(", ")}`);
				for (const [name, field] of Object.entries(phase.output.dataFields ?? {})) {
					if (!structured.data || !(name in structured.data)) continue;
					const value = structured.data[name];
					const valid = field.type === undefined || field.type === "any"
						|| (field.type === "string" && typeof value === "string")
						|| (field.type === "number" && typeof value === "number" && Number.isFinite(value))
						|| (field.type === "integer" && Number.isInteger(value))
						|| (field.type === "boolean" && typeof value === "boolean")
						|| (field.type === "array" && Array.isArray(value))
						|| (field.type === "object" && !!value && typeof value === "object" && !Array.isArray(value));
					if (!valid) throw new Error(`${WORKFLOW_PHASE_RESULT_TOOL_NAME}.data.${name} must be ${field.type}`);
				}
				structured = { ...structured, report: capParentText(structured.report) };
				if (Buffer.byteLength(JSON.stringify(structured), "utf8") > 50 * 1024) throw new Error(`Phase ${phase.id} structured output exceeds 50 KiB`);
			}
			const rawOutput = structured?.report ?? getFinalText(messages);
			if (!rawOutput.trim()) throw new Error(`Phase ${phase.id} produced empty required output`);
			const output = capParentText(rawOutput.trim());
			const stateResponse = assertResponse(await createdClient.request({ type: "get_state" }), "get_state");
			assertNotAborted(signal);
			if (parentPersisted && typeof stateResponse.data?.sessionFile === "string") phaseState.sessionFile = stateResponse.data.sessionFile;
			assertNotAborted(signal);
			phaseState.output = output;
			phaseState.structuredOutput = structured;
			phaseState.status = "succeeded";
			addLog(phaseState, "info", structured ? `Completed phase ${phase.id} with status ${structured.status}` : `Completed phase ${phase.id}`);
			return { output, structured };
		} catch (error) {
			const aborted = signal.aborted || error instanceof WorkflowAbortError;
			phaseState.status = aborted ? "aborted" : "failed";
			state.status = aborted ? "aborted" : "failed";
			phaseState.error = aborted ? "Aborted by user" : errorMessage(error);
			state.error = aborted ? `Phase ${phase.id} aborted by user` : `Phase ${phase.id} failed: ${phaseState.error}`;
			addLog(phaseState, "error", phaseState.error);
			throw error;
		} finally {
			steeringOpen = false;
			if (renderTimer) clearTimeout(renderTimer);
			state.steer = undefined;
			const phaseWasSuccessful = phaseState.status === "succeeded";
			let teardownError: Error | undefined;
			if (client) {
				try {
					await client.stop();
				} catch (error) {
					teardownError = error instanceof Error ? error : new Error(String(error));
					addLog(phaseState, "error", `Child teardown failed: ${teardownError.message}`);
					if (phaseWasSuccessful && !signal.aborted && state.status !== "aborted") {
						phaseState.status = "failed";
						state.status = "failed";
						phaseState.error = `Child teardown failed: ${teardownError.message}`;
						state.error = `Phase ${phase.id} failed: ${phaseState.error}`;
					}
				}
				if (this.activeClient === client) this.activeClient = undefined;
			}
			if (tmpDir) try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
			this.changed(ctx, state);
			this.persist(state);
			if (teardownError && phaseWasSuccessful && !signal.aborted && state.status !== "aborted") throw teardownError;
		}
	}

	async shutdown(): Promise<void> {
		this.getActiveState()?.abort?.();
		try {
			await this.activeClient?.stop();
		} catch {
			// The active run records teardown failure and persists it.
		}
		if (this.activePromise) await this.activePromise;
	}
}

export function workflowFailureMessage(state: WorkflowRunState): string {
	return capParentText(`${state.report ?? buildReport(state)}\n\nWorkflow execution did not succeed.`);
}
