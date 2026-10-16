# notes-compaction

Keep working across fresh context windows. The agent saves checkpoint notes, starts a new window that contains only a pointer to those notes, and can still search what happened in earlier windows.

## Install

```
/plugin install notes-compaction --marketplace ramtinJ95/claude-mods
```

## What the agent gets

- `notes`: list, read, search, write and append on virtual paths. `write_file` replaces; `append_to_file` adds.
- `new_context`: accepted only directly after a successful notes write in the same turn, so a new window never starts from stale notes. It ends the turn once its tool batch has run, then opens a new context window with the agent name, window IDs and recent note paths, and tells the agent to continue.
- `history`: lists, searches and reads earlier windows of this session, or a subagent's transcript. Loaded on demand.
- `get_context_remaining`: remaining tokens in the current window. Loaded on demand.

Tool calls with no arguments return help. The `notes` tool's description explains how to keep checkpoints, so a fresh session needs no extra instructions.

## Agents

The main conversation is `/root`; a subagent is `/root/<agentId>`. Relative note paths belong to the calling agent. `<agent>/notes/<path>` reads another agent's notes in the same session, so a parent reads what its subagent saved and a subagent reads its parent's checkpoint. Writes stay in the caller's own notes. `history` takes the same names as `agent_name`. Only the main conversation starts new windows.

## Windows and compaction

A new window replaces the conversation with one marker message; no summary is generated. The full transcript stays in the session, which `history` reads.

- Reminders ride on tool results, or on your message when a turn starts, at 85% and 90% of the context Claude Code compacts at, once each per window. With an auto-compact window set (for example 400k), that is its threshold, so the checkpoint comes first; otherwise it is the model's window. Use counts the tool results of the current batch and the size of your message, so a run of large file reads or a large paste still triggers them. `get_context_remaining` measures against the same limit.
- Ask the agent for a new window in plain words; it saves a checkpoint and calls `new_context`.
- `/compact` asks the agent to save a checkpoint, then opens a new window only if that turn completed with a saved note. If the latest turn already saved notes and no instructions were given, it opens the new window at once. Instructions after `/compact` become checkpoint guidance. Like Claude Code's own `/compact`, the new window waits for your next prompt.
- Idle compaction, which Claude Code runs on a long conversation left idle until shortly before the prompt cache expires, opens a new window instead when the latest turn saved notes. Otherwise it asks the agent for a checkpoint and then opens one. That happens once per context: if the checkpoint fails, the next idle compaction is Claude Code's own. A window opened while idle waits for your next prompt. `"idleCompaction": false` in Claude Code's settings turns idle compaction off altogether.
- Compaction at the auto-compact threshold stays Claude Code's own summary. The window marker is put back ahead of it, so the agent keeps its window IDs and recent note paths, and is told to recover from history if no checkpoint covers the work.
- Interrupting a turn that called `new_context`, or the checkpoint turn, cancels the rollover and keeps the old context.

### Where Claude Code keeps plugins out of compaction

From 2.1.299, on a machine with managed settings and for Team and Enterprise organizations, Claude Code's built-in security plugin skips installed plugins' compaction hooks. The mod then runs in a reduced mode and says so once with a notice and in `/notes`:

- A new window starts from Claude Code's own summary, told to keep only what the notes lack, followed by the window marker and "Continue." in place of a notes-only window. The rollover costs one summarization request.
- `/compact` still asks for a checkpoint first, and instructions after it still become checkpoint guidance.
- Idle compaction and compaction at the auto-compact threshold are Claude Code's own, with no checkpoint before them. Reminders start over after them.

According to Claude Code's setting descriptions, an administrator can restore the full behavior by enabling the mod in managed settings and seating it with `"appendPlugins": ["notes-compaction@claude-mods"]`; this is untested. Claude Code reads only the highest-priority managed source, so on a machine with an MDM profile these keys belong in that profile.

## Management

`/notes` opens a panel with continuity status and storage counts. Changes save immediately; with the panel focused (ctrl+x tab), the bracketed letters press its buttons.

- **Normal compaction before new windows** (`n`): off by default. On, each new window keeps Claude Code's summary ahead of the window message, and `/compact` is Claude Code's own.
- **Prune missing sessions** (`p`, then `y` to confirm): removes stored notes and fork records of sessions whose Claude Code transcript no longer exists, and subagent notes no remaining session names. The active session stays. Uses the `rm` command.

## Sessions and storage

Notes belong to one session: resuming keeps them, `/clear` starts empty. A fork (`--fork-session`, `/branch`) starts with the notes as they stood at the fork point and continues the window chain; afterwards the fork and its parent write independently.

Everything is plaintext JSON under `$XDG_DATA_HOME/claude-notes-compaction/`, defaulting to `~/.local/share`: `sessions/<session id>/` holds the main conversation's notes and window state, `agents/<agentId>/` a subagent's notes, and `revisions/` one record per write, which forks rebuild from.

`history` reads the newest 4096 messages Claude Code keeps for the session and says so once a session is longer.
