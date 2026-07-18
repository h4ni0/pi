import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, Text, isKeyRelease, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	CONTEXT_MESSAGE_TYPE,
	INFO_MESSAGE_TYPE,
	PANEL_ENTRY_TYPE,
	WORKFLOW_PHASE_RESULT_TOOL_NAME,
	WORKFLOW_TOOL_NAME,
	buildReport,
	capParentText,
	discoverWorkflows,
	isStructuredOutputConfig,
	parseOutputConfig,
	workflowIdFromFilename,
	workflowListMarkdown,
	workflowPromptList,
	type PhaseRunState,
	type PhaseStatus,
	type WorkflowDefinition,
	type WorkflowDiscovery,
	type WorkflowOutputDataFieldConfig,
	type WorkflowOutputDataFieldType,
	type WorkflowPhaseResult,
	type WorkflowRunState,
	type WorkflowStatus,
	type WorkflowStructuredOutputConfig,
} from "./schema.ts";
import {
	WorkflowRunError,
	WorkflowRunner,
	addLog,
	formatStructuredOutputContract,
	snapshotRunState,
	workflowFailureMessage,
} from "./runner.ts";

interface WorkflowPanelDetails {
	runId: string;
}

let cachedDiscovery: WorkflowDiscovery = { workflows: [], diagnostics: [] };
let lastPhaseNavigation: { key: "left" | "right"; at: number } | undefined;

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

function getPhaseOutputConfigFromEnv(): WorkflowStructuredOutputConfig | undefined {
	const raw = process.env.PI_WORKFLOW_PHASE_OUTPUT_CONFIG;
	if (!raw) return undefined;
	const config = parseOutputConfig(JSON.parse(raw), "workflow phase output config");
	if (!isStructuredOutputConfig(config)) throw new Error("workflow phase output config must be structured");
	return config;
}

function schemaForDataField(config: WorkflowOutputDataFieldConfig): any {
	const options = config.description ? { description: config.description } : {};
	switch (config.type) {
		case "string": return Type.String(options);
		case "number": return Type.Number(options);
		case "integer": return Type.Integer(options);
		case "boolean": return Type.Boolean(options);
		case "array": return Type.Array(Type.Any(), options);
		case "object": return Type.Record(Type.String(), Type.Any(), options);
		case "any":
		case undefined: return Type.Any(options);
	}
}

function buildDataSchema(config: WorkflowStructuredOutputConfig): any {
	const description = config.dataDescription ?? "Optional machine-readable details for later phases or next-rule conditions.";
	const fields = config.dataFields ?? {};
	if (Object.keys(fields).length === 0) return Type.Optional(Type.Record(Type.String(), Type.Any(), { description }));
	const properties: Record<string, any> = {};
	for (const [name, field] of Object.entries(fields)) properties[name] = Type.Optional(schemaForDataField(field));
	return Type.Optional(Type.Object(properties, { description, additionalProperties: true }));
}

function dataFieldMatchesType(value: unknown, type: WorkflowOutputDataFieldType | undefined): boolean {
	switch (type) {
		case undefined:
		case "any": return true;
		case "string": return typeof value === "string";
		case "number": return typeof value === "number" && Number.isFinite(value);
		case "integer": return Number.isInteger(value);
		case "boolean": return typeof value === "boolean";
		case "array": return Array.isArray(value);
		case "object": return !!value && typeof value === "object" && !Array.isArray(value);
	}
}

function validateOutputData(data: Record<string, unknown> | undefined, config: WorkflowStructuredOutputConfig | undefined): void {
	if (!data || !config?.dataFields) return;
	for (const [name, field] of Object.entries(config.dataFields)) {
		if (name in data && !dataFieldMatchesType(data[name], field.type)) throw new Error(`workflow_phase_result.data.${name} must be ${field.type ?? "any"}`);
	}
}

function registerPhaseResultTool(pi: ExtensionAPI): void {
	const config = getPhaseOutputConfigFromEnv();
	const statusDescription = config?.statusDescription ?? "Short machine-readable status label, for example PASS, FAIL, APPROVED, or CHANGES_REQUESTED.";
	const statusSchema = config?.statuses?.length
		? StringEnum(config.statuses as [string, ...string[]], { description: statusDescription })
		: Type.String({ description: statusDescription });
	pi.registerTool({
		name: WORKFLOW_PHASE_RESULT_TOOL_NAME,
		label: "Workflow Phase Result",
		description: "Return the one terminal structured result for a workflow phase.",
		promptSnippet: "Emit the terminal workflow phase status, report, and optional data",
		promptGuidelines: [
			"Use workflow_phase_result exactly once as the final action of a structured workflow phase, without sibling tool calls or later output.",
			config ? `Follow this workflow output contract: ${formatStructuredOutputContract(config, { id: "phase", prompt: "" })}` : "Set workflow_phase_result.status and workflow_phase_result.report to non-empty values.",
		],
		parameters: Type.Object({
			status: statusSchema,
			report: Type.String({ description: config?.reportDescription ?? "Complete human-readable Markdown report for this workflow phase." }),
			data: buildDataSchema(config ?? { type: "structured" }),
		}),
		async execute(_toolCallId, params) {
			const status = String(params.status ?? "").trim();
			const report = String(params.report ?? "").trim();
			if (!status) throw new Error("workflow_phase_result.status is required");
			if (config?.statuses?.length && !config.statuses.includes(status)) throw new Error(`workflow_phase_result.status must be one of: ${config.statuses.join(", ")}`);
			if (!report) throw new Error("workflow_phase_result.report is required");
			const data = params.data && typeof params.data === "object" && !Array.isArray(params.data) ? params.data as Record<string, unknown> : undefined;
			validateOutputData(data, config);
			const details: WorkflowPhaseResult = data ? { status, report, data } : { status, report };
			return { content: [{ type: "text", text: `Recorded workflow phase result: ${status}` }], details, terminate: true };
		},
		renderResult(result, _options, theme) {
			const details = normalizeStructuredPhaseResult(result.details);
			if (!details) return new Text(sanitizeTerminalText(result.content.find((part) => part.type === "text")?.text ?? ""), 0, 0);
			return new Text(`${theme.fg("toolTitle", theme.bold(sanitizeTerminalText(details.status)))}\n${sanitizeTerminalText(details.report)}`, 0, 0);
		},
	});
}

function setStatusForRender(ctx: any, runner: WorkflowRunner, state?: WorkflowRunState): void {
	if (!ctx?.ui?.setStatus) return;
	if (!state) {
		ctx.ui.setStatus("workflow", undefined);
		return;
	}
	const active = state.activePhaseId ? `:${state.activePhaseId}` : "";
	const focus = runner.focusedRunId === state.runId ? " focused" : "";
	ctx.ui.setStatus("workflow", `workflow ${state.workflowId}${active} ${state.status}${focus}`);
}

function getSelectedPhase(state: WorkflowRunState): PhaseRunState | undefined {
	return state.phases.find((phase) => phase.id === (state.selectedPhaseId ?? state.activePhaseId)) ?? state.phases[0];
}

function phaseIndex(state: WorkflowRunState): number {
	const id = state.selectedPhaseId ?? state.activePhaseId;
	return Math.max(0, state.phases.findIndex((phase) => phase.id === id));
}

function selectPhase(state: WorkflowRunState, delta: number): void {
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

function removeLastGrapheme(text: string): string {
	if (!text) return text;
	const segments = Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text));
	return text.slice(0, segments.at(-1)?.index ?? 0);
}

function handleWorkflowInput(data: string, ctx: any, runner: WorkflowRunner): { consume?: boolean; data?: string } | undefined {
	const active = runner.getActiveState();
	const focused = runner.getFocusedState();
	if (isKeyRelease(data)) return focused ? { consume: true } : undefined;
	if (matchesKey(data, "ctrl+c") && active) {
		active.abort?.();
		setStatusForRender(ctx, runner, active);
		return { consume: true };
	}
	if (matchesKey(data, "ctrl+w") && active) {
		runner.focusedRunId = active.runId;
		active.focused = true;
		setStatusForRender(ctx, runner, active);
		return { consume: true };
	}
	if (!focused) return undefined;
	if (matchesKey(data, "escape")) {
		focused.focused = false;
		runner.focusedRunId = undefined;
		setStatusForRender(ctx, runner, focused);
		return { consume: true };
	}
	if (matchesKey(data, "enter") || matchesKey(data, "return")) {
		const text = focused.composer.trim();
		focused.composer = "";
		if (text) void focused.steer?.(text).catch((error) => {
			const phase = getSelectedPhase(focused);
			if (phase) addLog(phase, "error", `Steer failed: ${error instanceof Error ? error.message : String(error)}`);
			setStatusForRender(ctx, runner, focused);
		});
		setStatusForRender(ctx, runner, focused);
		return { consume: true };
	}
	if (matchesKey(data, "backspace") || matchesKey(data, "ctrl+h")) focused.composer = removeLastGrapheme(focused.composer);
	else if (matchesKey(data, "ctrl+u")) focused.composer = "";
	else if (matchesKey(data, "up")) focused.scrollOffset += 1;
	else if (matchesKey(data, "down")) focused.scrollOffset = Math.max(0, focused.scrollOffset - 1);
	else if (matchesKey(data, "pageUp")) focused.scrollOffset += 8;
	else if (matchesKey(data, "pageDown")) focused.scrollOffset = Math.max(0, focused.scrollOffset - 8);
	else if (matchesKey(data, "left")) {
		if (acceptPhaseNavigation("left")) selectPhase(focused, -1);
	} else if (matchesKey(data, "right") || matchesKey(data, "tab")) {
		if (acceptPhaseNavigation("right")) selectPhase(focused, 1);
	} else {
		let text = data;
		const paste = /^\x1b\[200~([\s\S]*)\x1b\[201~$/.exec(text);
		if (paste) text = paste[1];
		if (text && !/^\x1b/.test(text)) focused.composer += text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
	}
	setStatusForRender(ctx, runner, focused);
	return { consume: true };
}

export function sanitizeTerminalText(text: string): string {
	return text
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b[P_X^][\s\S]*?\x1b\\/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b[@-_]/g, "")
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
}

function padAnsi(text: string, width: number): string {
	const visible = visibleWidth(text);
	return visible >= width ? truncateToWidth(text, width, "") : text + " ".repeat(width - visible);
}

function padColumn(text: string, width: number, padStart: number, padEnd: number): string {
	return " ".repeat(padStart) + padAnsi(text, Math.max(1, width - padStart - padEnd)) + " ".repeat(padEnd);
}

function paintPanelLine(line: string, width: number, theme: any): string {
	const padded = padAnsi(truncateToWidth(line, width, ""), width);
	const bg = theme.getBgAnsi?.("customMessageBg");
	if (!bg) return theme.bg("customMessageBg", padded);
	return `${bg}${padded.replace(/\x1b\[(?:0|49)m/g, (reset) => `${reset}${bg}`)}\x1b[49m`;
}

function renderMarkdownLines(text: string, width: number, theme: any): string[] {
	return new Markdown(sanitizeTerminalText(text), 0, 0, getMarkdownTheme(), { color: (segment: string) => theme.fg("toolOutput", segment) }, { preserveOrderedListMarkers: true }).render(width);
}

function wrapPlainWithPrefix(text: string, width: number, prefix = ""): string[] {
	const out: string[] = [];
	for (const rawLine of sanitizeTerminalText(text).split("\n")) {
		const wrapped = wrapTextWithAnsi(rawLine || " ", Math.max(1, width - visibleWidth(prefix)));
		out.push(...(wrapped.length ? wrapped.map((line) => prefix + line) : [prefix]));
	}
	return out;
}

function statusIcon(status: PhaseStatus | WorkflowStatus, theme: any): string {
	switch (status) {
		case "pending": return theme.fg("dim", "○");
		case "running": return theme.fg("warning", "▶");
		case "succeeded": return theme.fg("success", "✓");
		case "failed": return theme.fg("error", "✗");
		case "aborted": return theme.fg("warning", "⊘");
		case "interrupted": return theme.fg("warning", "◫");
	}
}

function getWorkflowStateFromToolDetails(details: unknown, runner: WorkflowRunner): WorkflowRunState | undefined {
	if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
	const maybe = details as Partial<WorkflowRunState>;
	if (typeof maybe.runId !== "string") return undefined;
	const live = runner.runStates.get(maybe.runId);
	if (live) return live;
	if (typeof maybe.workflowId !== "string" || typeof maybe.status !== "string" || !Array.isArray(maybe.phases)) return undefined;
	return { ...maybe, composer: "", scrollOffset: maybe.scrollOffset ?? 0, focused: false } as WorkflowRunState;
}

export function renderWorkflowPanel(state: WorkflowRunState, width: number, theme: any, focusedRunId?: string): string[] {
	const minWidth = 52;
	if (width < minWidth) {
		const lines = [theme.fg("accent", `Workflow ${state.workflowId}: ${state.status}`)];
		if (focusedRunId === state.runId && state.status === "running") lines.push(`> ${state.composer}${theme.fg("accent", "▌")}`);
		return lines.map((line) => paintPanelLine(line, width, theme));
	}
	const inner = width - 2;
	const leftW = Math.min(30, Math.max(20, Math.floor(inner * 0.26)));
	const rightW = inner - leftW - 1;
	const rightContentW = Math.max(1, rightW - 4);
	const selected = getSelectedPhase(state);
	const focused = focusedRunId === state.runId;
	const borderColor = focused ? (text: string) => theme.fg("accent", text) : (text: string) => theme.fg("border", text);
	const left = [theme.bold("Phases"), "", ...state.phases.map((phase) => {
		const label = `${statusIcon(phase.status, theme)} ${phase.id}`;
		return phase.id === selected?.id ? theme.fg("accent", theme.bold(label)) : label;
	})];
	const right = [
		theme.bold(selected?.id === "report" ? "Report" : selected ? `Phase: ${selected.id}` : "Workflow"),
		theme.fg("dim", `Workflow ${state.workflowId} · ${state.status}`),
		...(selected?.sessionFile ? [theme.fg("dim", `Session: ${sanitizeTerminalText(selected.sessionFile)}`)] : []),
		"",
	];
	if (!selected || selected.logs.length === 0) right.push(theme.fg("dim", "No progress yet."));
	else for (const log of selected.logs) {
		if (log.kind === "assistant") right.push(...renderMarkdownLines(log.text || " ", rightContentW, theme));
		else {
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
	if (maxScroll > 0 && visibleRight.length) {
		visibleRight[0] = theme.fg("dim", `↑ ${start}/${right.length}`);
		visibleRight[visibleRight.length - 1] = theme.fg("dim", `↓ ${Math.min(start + bodyH, right.length)}/${right.length}`);
	}
	const heavy = "━";
	const lines = [borderColor(`┏${heavy.repeat(leftW)}┯${heavy.repeat(rightW)}┓`)];
	for (let index = 0; index < bodyH; index++) lines.push(borderColor("┃") + padColumn(left[index] ?? "", leftW, 2, 1) + borderColor("│") + padColumn(visibleRight[index] ?? "", rightW, 2, 2) + borderColor("┃"));
	lines.push(borderColor(`┣${heavy.repeat(leftW)}┷${heavy.repeat(rightW)}┫`));
	let composerText: string;
	if (state.status !== "running") composerText = theme.fg("dim", "Workflow finished · panel retained in chat");
	else if (focused) composerText = state.composer ? `${state.composer}${theme.fg("accent", "▌")}` : `${theme.fg("accent", "▌")} ${theme.fg("dim", "Enter steer · Esc normal composer · ←/→ phase · ↑/↓ scroll · Ctrl+C abort")}`;
	else composerText = theme.fg("dim", "Ctrl+W focus panel composer · Ctrl+C abort active workflow");
	lines.push(borderColor("┃") + padColumn(composerText, inner, 2, 2) + borderColor("┃"));
	lines.push(borderColor(`┗${heavy.repeat(inner)}┛`));
	return lines.map((line) => paintPanelLine(line, width, theme));
}

function parseWorkflowArgs(args: string): { id?: string; task?: string } {
	const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args.trim());
	return { id: match?.[1], task: match?.[2]?.trim() };
}

function findWorkflow(id: string, discovery: WorkflowDiscovery): WorkflowDefinition {
	const workflow = discovery.workflows.find((item) => item.id === id);
	if (workflow) return workflow;
	const matchingDiagnostics = discovery.diagnostics.filter((diagnostic) => workflowIdFromFilename(diagnostic.path) === id);
	const diagnosticText = matchingDiagnostics.length
		? `\n\nDefinition errors:\n${matchingDiagnostics.map((diagnostic) => `- ${diagnostic.path}: ${diagnostic.message}`).join("\n")}`
		: "";
	throw new WorkflowRunError(capParentText(`Unknown or invalid workflow: ${id}${diagnosticText}\n\n${workflowPromptList(discovery)}`));
}

export function isDirectWorkflowChild(): boolean {
	if (process.env.PI_WORKFLOW_CHILD !== "1") return false;
	const expectedParent = Number(process.env.PI_WORKFLOW_PARENT_PID);
	return Number.isSafeInteger(expectedParent) && expectedParent > 0 && process.ppid === expectedParent;
}

export default function workflowExtension(pi: ExtensionAPI): void {
	if (isDirectWorkflowChild()) {
		registerPhaseResultTool(pi);
		return;
	}
	let unsubscribeInput: (() => void) | undefined;
	let runner!: WorkflowRunner;
	runner = new WorkflowRunner(pi, { onStateChanged: (ctx, state) => setStatusForRender(ctx, runner, state) });

	pi.registerEntryRenderer(PANEL_ENTRY_TYPE, (entry, _options, theme) => {
		const details = entry.data as WorkflowPanelDetails | undefined;
		const state = details?.runId ? runner.runStates.get(details.runId) : undefined;
		if (!state) return new Text(`Workflow run not found: ${details?.runId ?? "unknown"}`, 0, 0);
		return { render: (width: number) => renderWorkflowPanel(state, width, theme, runner.focusedRunId), invalidate: () => undefined };
	});
	pi.registerMessageRenderer(INFO_MESSAGE_TYPE, (message) => new Markdown(sanitizeTerminalText(typeof message.content === "string" ? message.content : ""), 0, 0, getMarkdownTheme()));
	pi.registerMessageRenderer(CONTEXT_MESSAGE_TYPE, () => new Text("", 0, 0));

	pi.registerCommand("workflow", {
		description: "List or run a predefined workflow",
		getArgumentCompletions(prefix) {
			const first = prefix.trimStart();
			if (first.includes(" ")) return null;
			return cachedDiscovery.workflows.filter((workflow) => workflow.id.startsWith(first)).map((workflow) => ({ value: workflow.id, label: workflow.id, description: workflow.description }));
		},
		handler: async (args, ctx) => {
			cachedDiscovery = discoverWorkflows(ctx.cwd, ctx.isProjectTrusted());
			const parsed = parseWorkflowArgs(args);
			if (!parsed.id) {
				pi.sendMessage({ customType: INFO_MESSAGE_TYPE, content: workflowListMarkdown(cachedDiscovery), display: true }, { triggerTurn: false });
				return;
			}
			let workflow: WorkflowDefinition;
			try { workflow = findWorkflow(parsed.id, cachedDiscovery); }
			catch (error) {
				pi.sendMessage({ customType: INFO_MESSAGE_TYPE, content: error instanceof Error ? error.message : String(error), display: true }, { triggerTurn: false });
				return;
			}
			let task = parsed.task;
			if (!task) {
				if (ctx.mode !== "tui") {
					pi.sendMessage({ customType: INFO_MESSAGE_TYPE, content: `Workflow ${workflow.id} requires explicit task text in ${ctx.mode} mode.`, display: true }, { triggerTurn: false });
					return;
				}
				task = await ctx.ui.editor(`Task for workflow ${workflow.id}`, "");
				if (!task?.trim()) return;
			}
			try {
				const cleanTask = task.trim();
				const state = await runner.run({ workflow, input: cleanTask, ctx, displayPanel: true, recordCommandContext: ctx.mode === "tui" });
				if (ctx.mode !== "tui") pi.sendMessage({ customType: INFO_MESSAGE_TYPE, content: capParentText(`Workflow task:\n${cleanTask}\n\n${state.report ?? buildReport(state)}`), display: true }, { triggerTurn: false });
			} catch (error) {
				pi.sendMessage({ customType: INFO_MESSAGE_TYPE, content: error instanceof Error ? error.message : String(error), display: true }, { triggerTurn: false });
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		runner.restore(ctx);
		cachedDiscovery = discoverWorkflows(ctx.cwd, ctx.isProjectTrusted());
		unsubscribeInput?.();
		if (ctx.mode === "tui") unsubscribeInput = ctx.ui.onTerminalInput((data) => handleWorkflowInput(data, ctx, runner));
		const available = workflowPromptList(cachedDiscovery);
		pi.registerTool({
			name: WORKFLOW_TOOL_NAME,
			label: "Workflow Run",
			description: `Run one predefined sequential workflow by id. Failed or aborted workflows throw tool errors. Available workflows:\n${available}`,
			promptSnippet: "Run a predefined multi-phase workflow by id",
			promptGuidelines: [
				"Use workflow_run when the user asks to run one of the predefined workflows listed in the tool description.",
				"Treat any workflow_run tool error as orchestration failure; do not continue as though its workflow succeeded.",
			],
			parameters: Type.Object({
				workflow: Type.String({ description: "Workflow id (filename without .yaml/.yml)" }),
				input: Type.String({ description: "Task/input passed to the workflow as {{input}}" }),
			}),
			async execute(_toolCallId, params, signal, onUpdate, toolCtx) {
				const discovery = discoverWorkflows(toolCtx.cwd, toolCtx.isProjectTrusted());
				const workflow = findWorkflow(params.workflow, discovery);
				const state = await runner.run({ workflow, input: params.input, ctx: toolCtx, signal, onUpdate, displayPanel: false });
				if (state.status !== "succeeded") throw new WorkflowRunError(workflowFailureMessage(state), state);
				return { content: [{ type: "text", text: state.report ?? buildReport(state) }], details: snapshotRunState(state, false) };
			},
			renderCall(args, theme) {
				return new Text(theme.fg("toolTitle", theme.bold("workflow_run ")) + theme.fg("accent", String(args.workflow ?? "")), 0, 0);
			},
			renderResult(result, options, theme) {
				const state = getWorkflowStateFromToolDetails(result.details, runner);
				if (state) return { render: (width: number) => renderWorkflowPanel(state, width, theme, runner.focusedRunId), invalidate: () => undefined };
				const text = sanitizeTerminalText(result.content.find((part) => part.type === "text")?.text ?? "");
				return new Markdown(options.expanded ? text : text.split("\n").slice(0, 16).join("\n"), 0, 0, getMarkdownTheme());
			},
		});
	});

	pi.on("session_shutdown", async () => {
		unsubscribeInput?.();
		unsubscribeInput = undefined;
		await runner.shutdown();
	});
}
