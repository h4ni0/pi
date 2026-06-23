# Pi code-state extension

Project-local Pi extension for git-backed message/branch-based code undo/redo.

## What it does

- Captures an isolated git tree snapshot before each user prompt and after the agent finishes.
- Stores append-only `custom` session entries with `customType: "code_state"`, linked to the user message entry id, for every completed user prompt (including no-code turns with empty file lists and zero stats).
- Adds `/undo` and `/redo` commands. Conflicting files are skipped by default; use `--force` to overwrite them.
- `/undo` restores code to the snapshot before the latest recorded user turn on the active branch, navigates the conversation to before that user message, and refills the composer with the original prompt.
- `/redo` restores the after-snapshot from the latest undo marker and navigates back to the branch leaf that was active before that undo. The undone path remains available in `/tree`.
- Hooks `session_tree` so `/tree` keeps Pi's normal branch-summary prompt first, then asks whether to restore code for the selected branch. Internal `/undo`/`/redo` navigation suppresses this restore-code prompt.

Snapshots are stored in an isolated git dir under:

```text
~/.pi/snapshots/<repo-root-hash>/git
```

Legacy stores under `~/.pi/agent/snapshots/` are moved into the new location on first use (copy fallback if needed). The project `.git` index is not modified.

## Usage

- Run `/undo` to move one Pi-recorded user turn back on the active branch; no-code turns restore zero files but still navigate before that prompt and refill the composer.
- Run `/redo` to return to the branch leaf saved by the most recent redoable `/undo`.
- Add `--force` (or `-f`) to `/undo`, `/redo`, or a `/tree` restore choice when you want conflicting files overwritten instead of skipped.
- Use `/tree` for arbitrary branch navigation; after Pi's normal branch-summary flow, choose whether to restore matching code state.

## Limitations

- Git worktrees only. Outside git repos the extension is inert and `/undo`/`/redo` report unavailable.
- Git-only V1: snapshots are git trees stored in an isolated git dir; no non-git fallback exists.
- Whole-turn net snapshots only; individual tool calls are not separately attributed.
- Pi's extension API does not replace the built-in `/tree` selector or editor population. This extension uses the post-navigation `session_tree` hook, which is why the restore-code prompt appears after Pi's own branch-summary flow.
- Gitignored files are not snapshotted. Local `.git/info/exclude` is copied into the isolated snapshot repo's excludes.
