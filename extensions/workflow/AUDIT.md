# Workflow Audit and Delivery Record

## Status vocabulary

- **Observed** — established by source/document review or a recorded verification run.
- **Implemented** — fixed in this delivery and covered by the final verification evidence below.
- **Deferred** — a nonblocking risk or proposal; not claimed as implemented.
- **Rejected/corrected** — an audit claim that was disproved, narrowed, or reclassified.

## Audit team and method

**Observed.** Seven specialist reviews covered architecture, security/trust, reliability, tests/performance, UI/UX, configurator design, and forward-looking product improvements. A lead synthesis read and deduplicated all seven reports. Separate implementation, adversarial review, remediation, release review, and final-verification passes were then completed for both the extension and configurator.

Evidence included complete review of:

- `/home/h4ni0/.pi/agent/extensions/workflow/{index.ts,schema.ts,rpc-client.ts,runner.ts,EXAMPLE.md,EXAMPLE.yml,DEPLOYMENT.md}`
- `/home/h4ni0/.pi/agent/extensions/workflow/tests/`
- `/home/h4ni0/.pi/SPECS.md`
- `/home/h4ni0/.pi/workflows/pipeline.yaml`
- `/home/h4ni0/.pi/workflow-ui/` and its installed binary
- installed Pi 0.80.7 documentation and RPC/resource-loader behavior

The method combined static review, direct parser/import probes, strict type checking, fake-RPC lifecycle and fault tests, clean-copy Pi RPC loading, differential compiler fixtures, isolated PTY workflows, transaction fault injection, filesystem/process adversarial tests, and a final isolated live-model smoke through the real headless `/workflow` command.

## Current verified inventory and strengths

**Observed after remediation.**

| Area | Current behavior and strength | Source |
|---|---|---|
| Discovery/compiler | Global and trusted-project lowercase YAML discovery; project precedence; invalid-project shadowing; duplicate-ID diagnostics; bounded regular-file reads; YAML 1.1, unique keys, one document, alias/input limits; no Python/PyYAML execution | `extensions/workflow/schema.ts`, `extensions/workflow/index.ts` |
| Contracts | Strict top-level/phase fields; text and structured output; status/report/typed data validation; `thinking: max`; reserved internal `report` ID | `extensions/workflow/schema.ts`, `extensions/workflow/index.ts` |
| Templates/routing | Preflighted prompt references; required/optional nested values; literal non-interpolated `system`; ordered conditions, deep equality, sequential fallback, explicit end, loops, and bounded transitions | `extensions/workflow/schema.ts`, `extensions/workflow/runner.ts` |
| Execution | One isolated Pi RPC child per phase visit; parent model/tools/thinking inheritance or configured overrides; normal `APPEND_SYSTEM.md` followed by phase instructions; child recursion defense | `extensions/workflow/runner.ts`, `extensions/workflow/index.ts` |
| RPC lifecycle | Completion on `agent_settled`; terminal message retrieval; bounded requests, settlement, JSONL, and stderr; strict protocol errors; awaited process-group TERM→KILL cleanup | `extensions/workflow/rpc-client.ts`, `extensions/workflow/runner.ts` |
| State safety | Sticky tool failures; unique terminal structured result; monotonic workflow-level abort; one active run; awaited shutdown; branch-only versioned recovery with interrupted-state reconciliation | `extensions/workflow/runner.ts`, `extensions/workflow/index.ts` |
| Privacy/context | Ephemeral children for ephemeral parents; bounded parent-facing output/details; non-context decorative panel entries; terminal-control sanitization | `extensions/workflow/runner.ts`, `extensions/workflow/index.ts` |
| Invocation/UI | `/workflow` and `workflow_run`; immediate headless missing-task diagnostics; retained panel, logs, steering, navigation, compact report, narrow-terminal and grapheme fixes; 50 ms stream coalescing | `extensions/workflow/index.ts`, `extensions/workflow/runner.ts` |
| Documentation/tests | Synchronized schema/spec/examples, valid documented blocks, pipeline placeholder cleanup, strict local typecheck and focused lifecycle/schema/state tests | `extensions/workflow/{EXAMPLE.md,EXAMPLE.yml,tests,tsconfig.json}`, `/home/h4ni0/.pi/SPECS.md`, `/home/h4ni0/.pi/workflows/pipeline.yaml` |
| Configurator | Standalone global-workflow list/validate/preview/create/raw-edit/clone/trash TUI with the authoritative embedded compiler and hardened transactions | `/home/h4ni0/.pi/workflow-ui/`, `/home/h4ni0/.local/bin/pi-workflow` |

The strongest retained design properties are strict validation, deterministic bounded routing, separate phase sessions, defense-in-depth against recursive workflows, safe non-shell child spawning, project-trust-aware discovery, structured terminating results, phase context isolation, and useful retained diagnostics.

## Deduplicated findings fixed in this delivery

**Implemented.** The synthesis IDs are retained for traceability.

1. **Parser/discovery security and integrity — D01, D17, D23, D27.** Removed pre-trust Python import execution and synchronous PyYAML; added bounded in-process parsing, duplicate/document/alias checks, symlink/special-file and replacement-race defenses, duplicate scope handling, invalid-project shadowing, source diagnostics, and synchronized format documentation.
2. **RPC correctness and cleanup — D02, D03.** Switched from premature `agent_end` completion to `agent_settled`; added terminal message retrieval, transport/request/settlement bounds, strict framing, stderr caps, stdin failures, and awaited process-group TERM→KILL cleanup, including descendants after leader exit.
3. **Phase/workflow state correctness — D04–D08, D12, D24.** Made failed tools sticky; enforced one terminal structured result with its configured enum/data schema; made cancellation monotonic across all async boundaries; rejected overlapping runs; awaited shutdown; returned parent tool errors for failed/aborted/unknown runs; bound child mode to the direct parent.
4. **Recovery, prompt policy, and privacy — D09, D11, D13.** Added versioned active-branch recovery and interrupted reconciliation, restored normal append-system ordering, preserved ephemeral parent semantics, and guarded all setup/cleanup paths.
5. **Templates/schema/report/context — D10, D14, D18, D20–D22.** Added placeholder preflight and runtime attribution, required nested-value failure, strict descriptions, `thinking: max`, deep equality, reserved `report`, literal system text, bounded reports/details/snapshots, terminal sanitization, one compact report, non-context panels, and immediate headless task handling.
6. **Quality and compatibility — D15, D26, D28.** Added strict typecheck and focused regression suites, corrected current Pi key IDs/narrow display/grapheme behavior, coalesced streaming updates, and removed unresolved pipeline methodology placeholders.
7. **Post-implementation blockers.** Fixed normalized child-contract loss, swallowed `get_state` protocol errors, orphaned descendants, setup leaks/inconsistent phase state, incomplete deployment instructions, missing runtime dependency installation, template-failure attribution, post-settlement steering races, and abort reversal during teardown.
8. **Configurator review findings C1–C9.** Regenerated the compiler, replaced truncated review with complete diff, rejected writable managed files, bounded reads before allocation, terminated editor process groups on signals, made first backup-directory creation durable, decoupled explicit-path validation from the managed root, isolated Node from loader environment injection, and added no-match/template preview information. All 25 transaction fault boundaries are covered.

## Remaining nonblocking gaps and risks

**Deferred; not release blockers in the final reviews.**

### Extension/runtime

- No enforceable read-only phase isolation. `bash` and delegation remain mutation-capable even when prompts say “read only.” Use a real read-only worktree/container for a security boundary.
- Phase tool/model overrides have no explicit capability/provider approval flow. Project trust and tool names are not a sandbox.
- Safe-regex/resource hardening and stronger directory-FD TOCTOU handling remain desirable.
- Persisted parents still create one child session per phase visit; no configurable retention policy exists.
- Panel Markdown/layout wrapping is not cached. Streaming is coalesced, but large retained views can still cost CPU.
- The steering composer is not yet a fully focused, IME- and configurable-keybinding-aware Pi input component.
- `extensions/workflow/package.json` supports directory deployment but not `npm pack --dry-run` because package metadata/version is intentionally incomplete.
- One deterministic one-phase live-model workflow passed through real headless Pi RPC; broader multi-phase live runs and manual interactive IME/accessibility testing remain deferred.
- Pre-remediation fake-child/configurator probe residue was identified by the audit and cleaned after the final smoke; final suites created no new residue.

### Configurator/operations

- Linux-only storage implementation (`openat`, `renameat2`, `flock`) and a trusted local Node runtime are required.
- Advisory locking plus optimistic identity/hash checks cannot eliminate the final race with a hostile same-user external writer.
- Fault injection proves ordering and restart states, not literal hardware power-loss behavior.
- Authoring is global-workflow-only and deliberately uses a private raw external-editor draft; project editing, field forms, graph editing, and manual IME/accessibility review are deferred.
- The broad pre-existing `/home/h4ni0` project-trust decision is an operational risk outside the extension; narrow it to audited project roots when practical.

## Separate potential-improvements audit

**Deferred proposals, not defect claims.** Ranked within each horizon; foundational items precede orchestration expansion.

### Now

1. Productize a versioned compiler: stable diagnostic codes/locations, canonical definition digest, JSON Schema, `validate/plan/explain`, model/tool registry preflight, and conformance CI. The current pure compiler and configurator parity are foundations, not the complete product surface.
2. Add an append-only phase/transition journal, committed phase boundaries, explicit interruption states, saved compiled definitions, and branch-aware resume.
3. Add typed workflow inputs, stronger bounded output schemas, explicit bindings, and immutable hashed artifact handles.
4. Add parent-owned durable approval gates with explicit headless `pause`/`fail` policy; never silently approve.
5. Add workflow/phase duration, token, cost, transition, and tool-call budgets with clear observed-versus-hard-limit semantics.

### Next

6. Add run list/show/export/fork, structured event telemetry, lineage, redaction, and retention controls. Distinguish resume, fork/rerun, and routing-only replay.
7. Improve portable paths and distribution; support configured/package workflow directories only after format versioning and provenance are stable.
8. Add typed reusable local/package workflows with compile-time expansion, namespacing, cycle detection, pinned provenance, and typed I/O.

### Later

9. Add bounded DAG parallelism only for enforceably read-only phases, with `needs`, deterministic joins, `maxParallel`, failure policy, and concurrency groups.
10. Add richer graph preview and authoring templates after compiler metadata and telemetry mature; a field-oriented editor may follow if raw editing proves insufficient.

### Explicit do-not-build items

- Temporal-style deterministic replay or “exactly once” claims for side-effecting agent phases.
- Unrestricted parallel writers in one checkout.
- Arbitrary JavaScript, shell, Jinja, CEL, or other general expression languages in YAML.
- Automatic retry of arbitrary failed or mutating phases, or a second model-retry subsystem over Pi’s retry behavior.
- A workflow-specific secrets vault or pseudo-sandbox based on prompts, project trust, or tool names.
- A cloud scheduler/control plane, marketplace, or distributed worker fleet.
- A drag-and-drop designer before compiler/telemetry maturity.
- Runtime remote includes or raw full-trace retention by default.
- LLM-generated dynamic graphs inside this deterministic runner.

## Rejected or corrected claims

**Rejected/corrected.**

- “No P0 existed” was false during the initial audit: pre-trust CWD Python import execution was reproduced. It is now fixed.
- Project-over-global shadowing is required behavior, not itself a defect. The fixed defect was fallback to a global definition when the same-ID trusted-project file was invalid; provenance visibility remains useful.
- Phase tool/model override was not accepted as an unconditional privilege-escalation defect because overrides are intentional. Explicit visibility and approval remain deferred policy work.
- Explicit append-system input did not replace Pi’s base system prompt; it suppressed the normally discovered `APPEND_SYSTEM.md`. That narrower defect is fixed.
- Text status fallback was not rejected universally; it is unsafe when the structured result tool is available. Current structured phases require the tool.
- Prompt-declared “read only” is not a Pi/project-trust sandbox and was classified as a configuration/isolation gap, not a trust-boundary exploit.
- Home-wide trust is a Pi configuration risk, not an extension implementation defect. Mouse support is an enhancement, not missing required behavior.
- Uppercase repository file `EXAMPLE.yml` is valid documentation source but intentionally not discoverable; deploy it under a lowercase filename.
- A subagent broker/cgroup startup failure affected audit orchestration only and is unrelated to this extension.

## Configurator decision and safety model

**Implemented decision:** standalone Go TUI sidecar, not Pi core and not a Pi extension.

- **Source:** `/home/h4ni0/.pi/workflow-ui/`
- **README:** `/home/h4ni0/.pi/workflow-ui/README.md`
- **Installed command:** `/home/h4ni0/.local/bin/pi-workflow`
- **Version:** `1.0.0`
- **Primary command:** `pi-workflow`
- **Noninteractive commands:** `pi-workflow list [--json]`, `pi-workflow validate [ID|PATH ...] [--json]`, `pi-workflow preview <ID|PATH> [--json]`

**Safety model.** It manages global workflows only; validates with an embedded bundle generated from `extensions/workflow/schema.ts`; does not invoke Pi, a model, workflow tools, Python, or network during validation/preview; edits a private `0600` draft; blocks invalid commits; preserves no-op and clone bytes; holds an owner-only advisory lock; rejects unsafe roots/entries/suffix conflicts; performs optimistic SHA-256/inode checks; uses no-follow directory-relative operations, durable backup, atomic rename, directory fsync, and atomic trash; and restores terminal/editor process state on signals.

Its limitations are the Linux/Node dependency, advisory-lock race, raw external-editor/global-only scope, no automatic recovery-file pruning, and no claim of hardware-power-loss proof or sandboxing.

## Exact final verification matrix

### Workflow extension

| Final check | Recorded result |
|---|---|
| `extensions/workflow/tests/run-typecheck.sh` | **PASS** |
| `extensions/workflow/tests/run-tests.sh` | **PASS — 44 tests, 140 assertions** |
| `bun build extensions/workflow/index.ts --target=node --packages=external` | **PASS — 101.69 KB bundle** |
| Clean release copy: `npm ci --omit=dev`, then typecheck/tests/build | **PASS** |
| Clean release copy loaded through Pi 0.80.7 RPC | **PASS** |
| Headless `/workflow pipeline` without a task | **PASS — immediate diagnostic, 0 editor requests, clean exit/stderr** |
| Direct final-schema validation | **PASS — `EXAMPLE.yml`: 5 phases/12 transitions; `pipeline.yaml`: 4 phases/16 transitions** |
| `npm ls --omit=dev` and `npm audit --omit=dev` | **PASS — pinned `yaml@2.9.0`, 0 vulnerabilities** |
| Config hashes before/after validation | **UNCHANGED** |
| Release diff/object integrity checks at verifier snapshot | **PASS** |
| RPC cleanup suite with PID comparison | **PASS — no new residual child processes** |
| Isolated live-model `/workflow` smoke | **PASS — real one-phase structured run, status `PASS`, report `LIVE_SMOKE_OK`, 3.342 s, clean process/temp cleanup, unchanged pipeline and repo status** |
| Manual interactive IME/accessibility run | **NOT RUN — deferred** |

### Standalone configurator

| Final check | Recorded result |
|---|---|
| `gofmt -l $(find . -name '*.go')` | **PASS — no files reported** |
| `go mod verify` | **PASS** |
| `go vet ./...` | **PASS** |
| `go test -count=1 ./...` | **PASS — all 5 packages** |
| `go test -race -count=1 ./...` | **PASS — all 5 packages** |
| `CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' ...` | **PASS — static Linux/amd64 binary** |
| Fresh build vs `dist/pi-workflow` vs installed binary | **PASS — byte-identical SHA-256 `deb490fd61ccd9ad1dce6912d6c0d9e98322d7536f8f1b1f09079874ad10fee6`** |
| Installed artifact | **Version 1.0.0; Go 1.26.4; statically linked** |
| Compiler identity | **PASS — current/embedded digest `be3b9a40d0a65857e0458844695306d20d68784fe07dc3ff25adaf997ac54ec6`** |
| Differential parity | **PASS — 10/10 fixtures matched acceptance, diagnostics, and normalized definitions** |
| Isolated PTY create/clone/edit/delete flow | **PASS — byte-identical clone, exact backup, trash delete** |
| Transaction fault injection | **PASS — all 25 boundaries (6 create, 14 replace/backup, 5 trash)** |
| External-change refusal | **PASS — edit/clone/delete produced no unintended side effect** |
| Path/mode/symlink/FIFO/root/lock safety probes | **PASS — failed closed** |
| Missing Node / parser rejection / operational exit codes | **PASS — validation `1`, operational/safety `2`** |
| Hostile `NODE_OPTIONS`/`NODE_PATH` | **PASS — hook did not execute** |
| SIGTERM during editor | **PASS — process group stopped, draft removed, terminal restored within 1.1 s** |
| Active pipeline integrity | **UNCHANGED — SHA-256 `e4335cd911d698db9d5360ab658760226d53641bdae2b1a3249a8999611abf5d`; mode `0600`** |
| Manual accessibility/IME review | **NOT RUN** |

## Operational and deployment notes

1. Deploy all files in `/home/h4ni0/.pi/agent/extensions/workflow/` except generated `node_modules/` content. Recreate dependencies from the lockfile:

   ```bash
   npm ci --omit=dev --prefix ~/.pi/agent/extensions/workflow
   ```

2. Run the release gate documented in `/home/h4ni0/.pi/agent/extensions/workflow/DEPLOYMENT.md`. Directory deployment is supported; `npm pack` is not currently the deployment path.
3. Carry operator-owned `/home/h4ni0/.pi/SPECS.md` and `/home/h4ni0/.pi/workflows/pipeline.yaml` separately when they are part of deployment.
4. If `extensions/workflow/schema.ts` changes, regenerate the configurator bundle with `/home/h4ni0/.pi/workflow-ui/scripts/generate-validator.sh`, rerun parity/race tests, rebuild, and reinstall `/home/h4ni0/.local/bin/pi-workflow`.
5. Workflow YAML edits are rediscovered on the next `/workflow` invocation, but this delivery changes extension modules and runtime dependencies. A full Pi **`/reload` is required** after deployment.
6. Do not deploy copied `node_modules`, modify installed Pi core, or treat project trust/tool lists as isolation. This final documentation pass staged nothing.
