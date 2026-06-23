# memory

Hermes-style persistent memory for pi: the agent keeps small, self-curated
notes that survive across sessions, so it improves over time — both inside the
current project and in general behavior.

Inspired by the [Hermes agent memory system](https://hermes-agent.org/):
bounded curated memory that is always in the prompt, plus periodic
self-review.

## Memory types

| Target    | File                                  | Holds                                                    | Default cap |
|-----------|---------------------------------------|----------------------------------------------------------|-------------|
| `user`    | `~/.pi/memory/USER.md`                | Who the user is, preferences, how they like to work      | 1,400 chars |
| `global`  | `~/.pi/memory/GLOBAL.md`              | Agent behavior + environment facts, applies everywhere   | 2,400 chars |
| `project` | `~/.pi/memory/projects/<slug>.md`     | Conventions, commands, quirks of the current project     | 2,400 chars |

The project file is keyed by the project root (nearest ancestor with `.git`,
else the cwd), so running pi anywhere inside a repo shares one memory.

Capacity is deliberately small: bounded memory forces curation instead of
accumulation. Entries are dense, single-line, declarative bullets — no
timestamps, no narration, never secrets (basic credential patterns are
rejected, and invisible/control characters are stripped).

## How it works

- **Prompt injection** — at session start the three files are snapshotted and
  injected into the system prompt (with usage percentages and maintenance
  rules). The snapshot is frozen for the session: byte-identical across turns,
  which preserves provider prefix caching and keeps the model from chasing its
  own mid-session edits. Writes hit disk immediately and load next session.
- **`memory` tool** — `add` / `replace` / `remove` against a target. Exact
  duplicates are rejected; writes that would exceed the cap fail with an
  instruction to consolidate; results past 80% carry a consolidation warning.
- **Self-improvement** — if `reviewInterval` user prompts pass without any
  memory write, the extension either attaches a curation nudge to the next
  turn (default) or forks a quiet background reviewer: a `pi -p --no-session`
  subprocess that reads the recent transcript and curates memory with the
  same tool, then reports a one-line summary. The reviewer runs with
  `PI_MEMORY_REVIEWER=1` so it can never recurse.

## Commands

```
/memory             status: usage, paths, review settings
/memory show [t]    print memory contents (all targets or one)
/memory edit [t]    edit a target in the editor (default: project)
/memory review      ask the agent to curate memory from this conversation now
/memory reload      re-read files into this session's prompt snapshot
```

`t` is one of `user | global | project`.

## Flag

`pi --no-memory` — disable injection and self-review for the run (the tools
stay available).

## Config

Optional `~/.pi/memory/config.json`:

```json
{
  "inject": true,
  "review": "nudge",
  "reviewInterval": 8,
  "limits": { "user": 1400, "global": 2400, "project": 2400 }
}
```

- `review`: `"nudge"` (in-band reminder, default) · `"background"` (fork a
  quiet reviewer process — costs an extra model call) · `"off"`
- `reviewInterval`: user prompts without a memory write before a review
- `limits`: per-target char caps (200–20,000)

## Notes

- Files are plain markdown — edit them by hand freely; `/memory reload`
  pulls edits into the current session.
- Two pi processes writing the same target concurrently are not coordinated
  across processes (last write wins per operation); within a process all
  writes go through pi's file-mutation queue.
- The background reviewer uses your default provider/model and respects
  `--no-session`, so it never pollutes the session list.
