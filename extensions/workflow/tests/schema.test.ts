import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	MAX_WORKFLOW_BYTES,
	buildReport,
	discoverWorkflows,
	parseYamlText,
	renderTemplate,
	resolveNextPhase,
	validateWorkflow,
	valuesEqual,
	type WorkflowRunState,
} from "../schema.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-schema-test-"));
	roots.push(root);
	return root;
}

function write(dir: string, name: string, content: string): string {
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, name);
	fs.writeFileSync(file, content);
	return file;
}

const minimal = (prompt = "Do {{input}}") => `description: test\nphases:\n  - id: run\n    prompt: ${JSON.stringify(prompt)}\n`;

describe("secure YAML compiler and discovery", () => {
	test("compiles the shipped example and active pipeline without Python", () => {
		for (const file of [path.join(import.meta.dir, "..", "EXAMPLE.yml"), "/home/h4ni0/.pi/workflows/pipeline.yaml"]) {
			const raw = parseYamlText(fs.readFileSync(file, "utf8"), path.basename(file));
			const validationPath = file.endsWith("EXAMPLE.yml") ? path.join(path.dirname(file), "example.yml") : file;
			expect(validateWorkflow(raw, validationPath, "global").phases.length).toBeGreaterThan(0);
		}
	});

	test("compiles every documented complete workflow block", () => {
		for (const file of [path.join(import.meta.dir, "..", "EXAMPLE.md"), "/home/h4ni0/.pi/SPECS.md"]) {
			const markdown = fs.readFileSync(file, "utf8");
			const blocks = Array.from(markdown.matchAll(/```yaml\n([\s\S]*?)```/g), (match) => match[1]);
			let compiled = 0;
			for (const [index, block] of blocks.entries()) {
				const raw = parseYamlText(block, `${path.basename(file)} block ${index + 1}`);
				if (!raw || typeof raw !== "object" || !Array.isArray((raw as any).phases)) continue;
				validateWorkflow(raw, `/tmp/documented-${compiled}.yaml`, "global");
				compiled++;
			}
			expect(compiled).toBeGreaterThan(0);
		}
	});

	test("retains YAML 1.1 scalars and rejects duplicate keys and documents", () => {
		expect((parseYamlText("flag: yes\n") as any).flag).toBe(true);
		expect(() => parseYamlText("a: 1\na: 2\n")).toThrow(/Map keys must be unique|duplicate/i);
		expect(() => parseYamlText("---\na: 1\n---\nb: 2\n")).toThrow(/exactly one/i);
	});

	test("enforces alias and input limits", () => {
		const bomb = ["a: &a [x, x, x, x, x, x, x, x, x, x]", "b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]", "c: [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]"].join("\n");
		expect(() => parseYamlText(bomb)).toThrow(/alias|resource/i);
		expect(() => parseYamlText("x".repeat(MAX_WORKFLOW_BYTES + 1))).toThrow(/exceeds/i);
	});

	test("never imports CWD-controlled Python modules during pre-trust global discovery", () => {
		const root = tempRoot();
		const globalDir = path.join(root, "global");
		const cwd = path.join(root, "untrusted");
		fs.mkdirSync(cwd);
		for (const module of ["json.py", "yaml.py"]) write(cwd, module, `open(${JSON.stringify(path.join(root, `${module}.marker`))}, 'w').write('owned')\n`);
		write(globalDir, "safe.yaml", minimal());
		const result = discoverWorkflows(cwd, false, { globalDir, projectDir: path.join(cwd, ".pi", "workflows") });
		expect(result.workflows.map((item) => item.id)).toEqual(["safe"]);
		expect(fs.existsSync(path.join(root, "json.py.marker"))).toBe(false);
		expect(fs.existsSync(path.join(root, "yaml.py.marker"))).toBe(false);
	});

	test("rejects symlinks, FIFOs, oversized files, and duplicate suffix IDs promptly", () => {
		const root = tempRoot();
		const globalDir = path.join(root, "global");
		fs.mkdirSync(globalDir);
		write(root, "outside.yaml", minimal());
		fs.symlinkSync(path.join(root, "outside.yaml"), path.join(globalDir, "linked.yaml"));
		fs.symlinkSync(path.join(root, "missing.yaml"), path.join(globalDir, "broken.yaml"));
		Bun.spawnSync(["mkfifo", path.join(globalDir, "pipe.yaml")]);
		const huge = path.join(globalDir, "huge.yaml");
		const fd = fs.openSync(huge, "w");
		fs.ftruncateSync(fd, MAX_WORKFLOW_BYTES + 1);
		fs.closeSync(fd);
		write(globalDir, "dupe.yaml", minimal());
		write(globalDir, "dupe.yml", minimal());
		const started = Date.now();
		const result = discoverWorkflows(root, false, { globalDir });
		expect(Date.now() - started).toBeLessThan(1000);
		expect(result.workflows).toHaveLength(0);
		expect(result.diagnostics.map((item) => item.message).join("\n")).toMatch(/non-symlink|regular|exceeds|Duplicate/);
		const linkedDir = path.join(root, "linked-dir");
		fs.symlinkSync(globalDir, linkedDir, "dir");
		const directoryResult = discoverWorkflows(root, false, { globalDir: linkedDir });
		expect(directoryResult.workflows).toHaveLength(0);
		expect(directoryResult.diagnostics[0]?.message).toMatch(/non-symlink directory/);
	});

	test("detects a workflow entry replacement race instead of parsing changed bytes", () => {
		const root = tempRoot();
		const globalDir = path.join(root, "global");
		const original = write(globalDir, "race.yaml", minimal("original"));
		const replacement = write(root, "replacement.yaml", minimal("replacement"));
		let replaced = false;
		const result = discoverWorkflows(root, false, {
			globalDir,
			beforeRead(filePath) {
				if (replaced || filePath !== original) return;
				replaced = true;
				fs.renameSync(replacement, original);
			},
		});
		expect(result.workflows).toHaveLength(0);
		expect(result.diagnostics[0]?.message).toMatch(/changed while it was being opened/);
	});

	test("an invalid trusted project definition shadows a valid global ID", () => {
		const root = tempRoot();
		const globalDir = path.join(root, "global");
		const projectDir = path.join(root, "project");
		write(globalDir, "build.yaml", minimal());
		write(projectDir, "build.yaml", "phases: []\n");
		const result = discoverWorkflows(root, true, { globalDir, projectDir });
		expect(result.workflows.find((item) => item.id === "build")).toBeUndefined();
		expect(result.diagnostics.some((item) => item.path === path.join(projectDir, "build.yaml"))).toBe(true);
	});
});

describe("schema compatibility, templates, routing, and reports", () => {
	test("accepts max thinking and rejects reserved IDs, no-op conditions, and malformed descriptions", () => {
		const file = "/tmp/test.yaml";
		expect(validateWorkflow({ phases: [{ id: "run", prompt: "x", thinking: "max" }] }, file, "global").phases[0].thinking).toBe("max");
		expect(() => validateWorkflow({ phases: [{ id: "report", prompt: "x" }] }, file, "global")).toThrow(/reserved/);
		expect(() => validateWorkflow({ phases: [{ id: "run", prompt: "x", output: "structured", next: [{ if: { field: "data.x" }, end: true }] }] }, file, "global")).toThrow(/field alone/);
		expect(() => validateWorkflow({ phases: [{ id: "run", prompt: "x", output: { type: "structured", report: { description: 3 } } }] }, file, "global")).toThrow(/must be a string/);
	});

	test("validates every placeholder before execution", () => {
		const file = "/tmp/test.yaml";
		expect(() => validateWorkflow({ phases: [{ id: "run", prompt: "{{typo?}}" }] }, file, "global")).toThrow(/unknown optional|unknown template/);
		expect(() => validateWorkflow({ phases: [{ id: "run", prompt: "{{phase.missing.output}}" }] }, file, "global")).toThrow(/unknown phase/);
		expect(() => validateWorkflow({ phases: [{ id: "run", prompt: "{{phase.run.status}}" }] }, file, "global")).toThrow(/structured/);
		expect(() => validateWorkflow({ phases: [{ id: "run", prompt: "{{input}" }] }, file, "global")).toThrow(/unclosed/);
		const workflow = validateWorkflow({ phases: [{ id: "run", prompt: "{{phase.run.data.maybe?}}", output: { type: "structured", data: {} } }] }, file, "global");
		expect(workflow.phases).toHaveLength(1);
	});

	test("required missing nested data throws while valid optional data renders empty", () => {
		const outputs = new Map([["verify", { output: "ok", structured: { status: "PASS", report: "ok", data: {} } }]]);
		expect(() => renderTemplate("{{phase.verify.data.missing}}", "task", outputs)).toThrow(/Missing structured/);
		expect(renderTemplate("{{phase.verify.data.missing?}}", "task", outputs)).toBe("");
	});

	test("deep equality ignores object insertion order and routing uses it", () => {
		expect(valuesEqual({ a: 1, b: { c: 2 } }, { b: { c: 2 }, a: 1 })).toBe(true);
		const workflow = validateWorkflow({ phases: [
			{ id: "one", prompt: "x", output: "structured", next: [{ if: { field: "data.value", equals: { a: 1, b: 2 } }, goto: "two" }, { end: true }] },
			{ id: "two", prompt: "y" },
		] }, "/tmp/route.yaml", "global");
		expect(resolveNextPhase(workflow, workflow.phases[0], { output: "ok", structured: { status: "PASS", report: "ok", data: { value: { b: 2, a: 1 } } } }).phase?.id).toBe("two");
	});

	test("report has the compact specified shape and omits unvisited phases", () => {
		const state: WorkflowRunState = {
			runId: "r", workflowId: "pipeline", description: "", input: "task", status: "succeeded", startedAt: 1,
			composer: "", scrollOffset: 0, focused: false,
			phases: [{ id: "plan", status: "succeeded", logs: [], output: "done" }, { id: "skipped", status: "pending", logs: [] }],
		};
		expect(buildReport(state)).toBe("Workflow: pipeline\nStatus: succeeded\n\n## plan\n\ndone");
	});
});
