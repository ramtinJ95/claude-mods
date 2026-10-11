# notes-compaction

Keep working across fresh context windows. The agent saves checkpoint notes, starts a new window that contains only a pointer to those notes, and can still search what happened in earlier windows.

## Install

```
/plugin install notes-compaction --marketplace ramtinJ95/claude-mods
```

## What the agent gets

- `notes`: list, read, search, write and append on virtual paths. `write_file` replaces; `append_to_file` adds.
- `new_context`: ends the turn once its tool batch has run, then opens a new context window with the agent name, window IDs and recent note paths, and tells the agent to continue.
- `history`: lists, searches and reads earlier windows of this session, or a subagent's transcript. Loaded on demand.
- `get_context_remaining`: remaining tokens in the current window. Loaded on demand.

Tool calls with no arguments return help. The `notes` tool's description explains how to keep checkpoints, so a fresh session needs no extra instructions.

## Agents

The main conversation is `/root`; a subagent is `/root/<agentId>`. Relative note paths belong to the calling agent. `<agent>/notes/<path>` reads another agent's notes in the same session, so a parent reads what its subagent saved and a subagent reads its parent's checkpoint. Writes stay in the caller's own notes. `history` takes the same names as `agent_name`. Only the main conversation starts new windows.

## Windows and compaction

A new window replaces the conversation with one marker message; no summary is generated. The full transcript stays in the session, which `history` reads.

- Reminders ride on tool results, or on your message when a turn starts, at 85% and 90% of the context Claude Code compacts at, once each per window. With an auto-compact window set (for example 400k), that is its threshold, so the checkpoint comes first; otherwise it is the model's window. Use counts the tool results of the current batch and the size of your message, so a run of large file reads or a large paste still triggers them. `get_context_remaining` measures against the same limit.
- Ask the agent for a new window in plain words; it saves a checkpoint and calls `new_context`.
- `/compact` asks the agent to save a checkpoint, then opens a new window only if that turn completed with a saved note. If the latest turn already saved notes and no instructions were given, it opens the new window at once. Instructions after `/compact` become checkpoint guidance.
- Automatic compaction stays Claude Code's own summary.
- Interrupting a turn that called `new_context`, or the checkpoint turn, cancels the rollover and keeps the old context.

## Management

`/notes` opens a panel with continuity status and storage counts. Changes save immediately; with the panel focused (ctrl+x tab), the bracketed letters press its buttons.

- **Normal compaction before new windows** (`n`): off by default. On, each new window keeps Claude Code's summary ahead of the window message, and `/compact` is Claude Code's own.
- **Prune missing sessions** (`p`, then `y` to confirm): removes stored notes and fork records of sessions whose Claude Code transcript no longer exists, and subagent notes no remaining session names. The active session stays. Uses the `rm` command.

## Sessions and storage

Notes belong to one session: resuming keeps them, `/clear` starts empty. A fork (`--fork-session`, `/branch`) starts with the notes as they stood at the fork point and continues the window chain; afterwards the fork and its parent write independently.

Everything is plaintext JSON under `$XDG_DATA_HOME/claude-notes-compaction/`, defaulting to `~/.local/share`: `sessions/<session id>/` holds the main conversation's notes and window state, `agents/<agentId>/` a subagent's notes, and `revisions/` one record per write, which forks rebuild from.

`history` reads the newest 4096 messages Claude Code keeps for the session and says so once a session is longer.
