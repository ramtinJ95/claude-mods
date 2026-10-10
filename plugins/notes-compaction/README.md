# notes-compaction

Keep working across fresh context windows. The agent saves checkpoint notes, starts a new window that contains only a pointer to those notes, and can still search what happened in earlier windows.

## Install

```
/plugin install notes-compaction --marketplace ramtinJ95/claude-mods
```

## What the agent gets

- `notes`: help, list, read, search, write and append on virtual paths. `write_file` replaces; `append_to_file` adds.
- `new_context`: starts a new context window after the current turn. The new window opens with the agent name, window IDs and recent note paths, then the agent is told to continue.
- `history`: lists, searches and reads earlier windows of this session, or a subagent's transcript. Loaded on demand.
- `get_context_remaining`: remaining tokens in the current window. Loaded on demand.

Tool calls with no arguments return help. A system-prompt section explains how to keep checkpoints.

## Agents

The main conversation is `/root`; a subagent is `/root/<agentId>`. Relative note paths belong to the calling agent. `<agent>/notes/<path>` reads another agent's notes in the same session, so a parent reads what its subagent saved and a subagent reads its parent's checkpoint. Writes stay in the caller's own notes. `history` takes the same names as `agent_name`. Only the main conversation starts new windows.

## Windows and compaction

A new window replaces the conversation with one marker message; no summary is generated. The full transcript stays in the session, which `history` reads.

- Reminders ride on tool results at 85% and 90% context use, once each per window.
- `/compact` asks the agent to save a checkpoint, then opens a new window only if that turn completed with a saved note. If the latest turn already saved notes and no instructions were given, it opens the new window at once. Instructions after `/compact` become checkpoint guidance.
- Automatic compaction stays Claude Code's own summary.
- Interrupting a turn that called `new_context`, or the checkpoint turn, cancels the rollover and keeps the old context.

## Sessions and storage

Notes belong to one session: resuming keeps them, `/clear` starts empty. A fork (`--fork-session`, `/branch`) starts with the notes as they stood at the fork point and continues the window chain; afterwards the fork and its parent write independently.

Everything is plaintext JSON under `$XDG_DATA_HOME/claude-notes-compaction/`, defaulting to `~/.local/share`: `sessions/<session id>/` holds the main conversation's notes and window state, `agents/<agentId>/` a subagent's notes, and `revisions/` one record per write, which forks rebuild from.

`history` reads the newest 4096 messages Claude Code keeps for the session and says so once a session is longer.
