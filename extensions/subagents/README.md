# Pi persistent collaboration agents

This is Pi's single collaboration-manager entry point. Its canonical contract follows Codex multi-agent v2 through a session-root broker; process-local managers own direct RPC pipes only, never tree identity or routing authority.

## Canonical tools

- `spawn_agent`: asynchronously starts a persistent, reusable agent. `task_name` becomes a canonical path beneath the caller; `fork_turns` is omitted/`all`, `none`, or a positive integer string.
- `send_message`: sends to any same-tree target without waking an idle agent.
- `followup_task`: reuses an existing non-root agent and triggers a turn when idle.
- `wait_agent`: waits on an atomic identity/epoch snapshot. `{}`, `{target}`, and `{all:true}` wait indefinitely for ANY/target/ALL completion. Agent waits never take time limits. `{seconds:1..3600}` is a separate clock delay that does not inspect agents; later spawns are excluded from agent snapshots. A matching direct-child final returned by an explicit wait is acknowledged there and is not redelivered as a separate inbox turn.
- `interrupt_agent`: soft, non-cascading turn interrupt; the agent remains reusable.
- `list_agents`: lists only live/resident agents across the current root tree.

Relative paths resolve beneath the caller; absolute `/root/...` paths resolve exactly. Opaque Pi IDs remain compatibility aliases. Cross-root references are rejected. Canonical model results are intentionally sparse: spawn returns only `task_name`; send/follow-up return empty text; wait returns `message`, `timed_out`, terminal `completed` name/status pairs, and canonical `pending` names; interrupt returns only `previous_status`; list items contain only `agent_name`, `agent_status`, and `last_task_message`. Rich Pi metadata and terminal revisions stay in tool `details`. Target/all waits do not consume asynchronous final-answer mailbox content or ANY-mode terminal notifications.

The spawn schema uses Codex's hidden-metadata v2 profile: it exposes no nickname/agent-role, model, reasoning-effort, or service-tier overrides. Pi does not invent partial override semantics; child model/thinking configuration is inherited internally.

## Compatibility tools

- `delegate` is blocking, disposable, and one-shot. It returns its bounded result inline, then closes/removes the subprocess; it cannot be reused or targeted after return.
- `ask_parent` is child-only and routes exclusively through the authenticated broker to the immediate parent. Child-supplied identity, lineage, request IDs, and filesystem paths are not accepted. It does not ask the human user directly.

`agent_settled`, never `agent_end`, is the per-turn completion boundary. Inter-agent messages use exactly four headers: `Message Type`, `Task name`, `Sender`, and `Payload`.

## Pi behavior and shared workspace

Pi has two explicit intentional behavioral divergences from canonical Codex v2: its existing `PI_SUBAGENT_DEPTH` / `PI_SUBAGENT_MAX_DEPTH` gate is enforced before every spawn, and the user-requested `wait_agent` contract uses indefinite terminal ANY/target/ALL snapshots, with clock delay kept as a separate non-agent mode. All agents share cwd/filesystem; parallel writers need disjoint paths or separate worktrees, and no edit-lock guarantee exists.

Broker capabilities and connection generations enforce logical tree authorization between cooperative agents. They do **not** isolate hostile processes running as the same OS user: same-UID processes can inspect accessible files, environment, sockets, and process state. Hostile children require a separate UID, container, or equivalent OS sandbox.

Canonical capacity/residency is root-tree-wide (default sixteen total agents: root plus fifteen workers). Local `/agents` history and direct RPC records are UI state, separate from live `list_agents` results. Persistent RPC pipes close on session shutdown. A controller stays resident while any nonretired canonical descendant depends on its reload ownership; safe leaf eviction and lazy reload preserve identity/session without orphaning that chain.

## Settings

Global `~/.pi/agent/settings.json` and trusted project `.pi/settings.json` may configure the extension. Untrusted project settings are ignored. An explicitly supplied `PI_SUBAGENT_MAX_DEPTH` remains authoritative for root and child roles across settings refresh; otherwise root settings govern inherited max depth and capacities. Descendants cannot expand them. Capacities are totals for the entire root tree and include `/root`.

| Setting | Default | Meaning |
|---|---:|---|
| `maxDepth` | `2` | Pi-enforced maximum collaboration depth |
| `maxConcurrentAgents` | `16` | Root-tree total executing capacity: root plus fifteen workers |
| `maxPersistentAgents` | `16` | Root-tree total resident capacity: root plus fifteen workers |
| `defaultContext` | `"compact"` | Legacy `delegate` context only |
| `handoffTokenBudget` | `8000` | Legacy compact handoff budget |
| `handoffKeepRecentTokens` | `4000` | Recent parent context considered for handoff |
| `returnMaxBytes` | `50000` | Maximum UTF-8 bytes returned inline by `delegate` |
| `completionMessageMaxBytes` | `16384` | Per-completion model-facing message bound |
| `completionBurstMaxBytes` | `49152` | Aggregate completion burst bound |
| `completionOutboxLimit` | `32` | Bounded pending completion events |
| `statusHistoryLimit` | `100` | Bounded local `/agents` UI history; `0` disables history |
| `rpcStartupTimeoutMs` | `15000` | RPC readiness timeout |
| `rpcRequestTimeoutMs` | `30000` | RPC request timeout |
| `rpcShutdownTimeoutMs` | `2000` | Graceful RPC shutdown bound |
| `childEnvAllowlist` | bounded built-in list | Environment names inherited by child Pi processes; loader and subagent controls remain blocked |
| `persistSessions` | `true` | Persist child Pi sessions |
| `sessionDir` | `~/.pi/agent/sessions/subagents` | Session/artifact root |
| `showInNormalResume` | `false` | Restore bounded historical UI records |
| `killChildrenOnParentExit` | `true` | Legacy compatibility switch; v2 pipes always close |
| `allowChildSubagents` | `true` | Permit spawning below root within depth |
| `shortcut` | `"alt+s"` | Open local agents panel |
| `askParentConfidential` | `false` | Isolate blocking parent context and reject nonblocking relay |

`completionBurstMaxBytes` is always normalized to at least `completionMessageMaxBytes`; this prevents a valid single completion from entering an impossible retry loop. Configured resident/executing capacities are capped at 128 total agents, and executing capacity is normalized not to exceed resident capacity.

Broker-owned mailboxes are bounded before mutation to 64 items and 128 KiB serialized per target, plus 1 MiB for the root tree. Logical identities are permanently reserved within a runtime and new spawns stop at 4,096 lifetime identities rather than allowing unbounded tombstone growth. Each production RPC tree is supervised in its own delegated Linux cgroup v2 and hard teardown uses atomic `cgroup.kill`; when Pi starts in a non-delegated login-session cgroup, `/usr/bin/systemd-run --user --scope` acquires an isolated delegated scope automatically. `/usr/bin/bwrap` exposes only the owned subtree as writable inside the child. Startup fails closed only when these ownership primitives are unavailable. Identity-checked PID cleanup remains only for injected test transports.

`fork_turns` is independent: omitted/`all` forks every completed parent turn, `none` starts with no parent messages, and positive `N` forks the last N real user/trigger turn boundaries while preserving valid tool pairs. `compact | fresh` remains legacy `delegate` behavior and is not a transcript fork.

## Artifacts

Full outputs and rich metadata remain under:

```text
~/.pi/agent/sessions/subagents/<root-session-id>/<agent-id>/
  agent.json
  final-output.md
  turns/0001-final.md
  turns/0001.json
  completion-outbox/
    completion_<event>.md
    state/completion_<event>.md.json
```

Event IDs, delivery IDs, and rich output metadata remain in artifacts/tool `details`, not canonical structured tool projections. A truncated completion message may include its artifact path so the model can retrieve the full output. `delegate` returns at most `returnMaxBytes` UTF-8 bytes inline and writes the full output to its artifact; completion messages use `completionMessageMaxBytes`, and `ask_parent` answers are capped at 16 KiB. Live handles and local `/agents` history are session-runtime scoped; branch navigation does not recreate them, while a new/resumed/forked/reloaded runtime starts a fresh live registry. Safe lazy reload preserves an unloaded v2 agent's canonical identity/session through its owning controller chain.

## Broker socket maintenance

The broker verifies owner, mode, inode, and liveness before removing a socket. Startup scavenging applies this verifier automatically. Operators can inspect the default private socket directory without changing it, then explicitly apply the same cleanup:

```bash
bun extensions/subagents/bin/broker-socket-maintenance.ts --dry-run
bun extensions/subagents/bin/broker-socket-maintenance.ts --apply
```

Both commands emit JSON. Dry-run reports `stale` candidates and leaves them in place; apply reports only inode-stable removals in `removed`. `--directory <absolute-path>` is available for diagnostics/tests and still requires a real current-UID `0700` directory.

## Verification

```bash
extensions/subagents/tests/run-typecheck.sh
extensions/subagents/tests/run-tests.sh
extensions/subagents/tests/run-nested-env-regression.sh
bun build extensions/subagents/index.ts --target=node --packages=external --outfile=/tmp/subagents-v2-build.js
```
