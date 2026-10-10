# notes-compaction

Keep working across fresh context windows. The agent saves checkpoint notes, starts a new window that contains only a pointer to those notes, and can still search what happened in earlier windows.

## Install

```
/plugin install notes-compaction --marketplace ramtinJ95/claude-mods
```

## What the agent gets

- `notes`: help, list, read, search, write and append on relative virtual paths. `write_file` replaces; `append_to_file` adds.
- `new_context`: starts a new context window after the current turn. The new window opens with the window IDs and recent note paths, then the agent is told to continue.
- `history`: lists, searches and reads earlier windows of this session. Loaded on demand.
- `get_context_remaining`: remaining tokens in the current window. Loaded on demand.

Tool calls with no arguments return help. A system-prompt section explains how to keep checkpoints.

## Windows and compaction

A new window replaces the conversation with one marker message; no summary is generated. The full transcript stays in the session, which `history` reads.

- Reminders ride on tool results at 85% and 90% context use, once each per window.
- `/compact` asks the agent to save a checkpoint, then opens a new window only if that turn completed with a saved note. If the latest turn already saved notes and no instructions were given, it opens the new window at once. Instructions after `/compact` become checkpoint guidance.
- Automatic compaction stays Claude Code's own summary.
- Interrupting a turn that called `new_context` cancels the rollover.

## Storage

Notes and window state are plaintext JSON under `$XDG_DATA_HOME/claude-notes-compaction/sessions/<session id>/`, defaulting to `~/.local/share`. Notes belong to one session: resuming keeps them, `/clear` starts empty. A forked session (`--fork-session`, `/branch`) gets a new session ID and starts without the parent's notes; they remain in the parent.

`history` reads the newest 4096 messages Claude Code keeps for the session and says so once a session is longer.
