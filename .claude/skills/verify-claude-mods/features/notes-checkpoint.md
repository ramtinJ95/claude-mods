# Notes checkpoints

notes-compaction gives the model a `notes` tool for checkpoint notes that belong to the session, and the user a `/notes` panel that shows continuity status and how many notes the session holds.

## Sub-features

- `checkpoint-write` saves a note at a relative path through `notes` `write_file`.
- `checkpoint-append` adds to an existing note through `append_to_file`.
- `checkpoint-read` reads a note back and lists notes by prefix.
- `checkpoint-panel` opens `/notes` with status, counts and the two settings buttons.
- `checkpoint-help` returns help when `notes` is called with no arguments.

## How to get to it (user POV)

- Ask the agent in plain words to save, read or list notes; it calls the `notes` tool.
- Type `/notes` at the prompt.

## Driving it with vmod

Preconditions:

- `RUN=$($V launch notes-compaction)` and `$V doctor "$RUN"` pass.
- The session has no notes yet (fresh launch).

- **Write.** Ask for a note. Run `$V prompt "$RUN" "Use the notes tool to write_file path checkpoint/verify.md with text 'Verification checkpoint: step 1 done'. Then reply with exactly: saved"`, then `$V snap "$RUN" checkpoint-write-01`. The screen shows `notes-compaction - notes (MCP)(action: "write_file", path: "checkpoint/verify.md", ...)` with a result naming `"/root/notes/checkpoint/verify.md"` and `"chars": 36`, then `saved`.
- **Stored.** Check the side effect. Run `cat "$DATA"/claude-notes-compaction/sessions/$SESSION/notes/*.json`. It holds `"path":"checkpoint/verify.md","text":"Verification checkpoint: step 1 done"`. The folder name is this run's `$SESSION`.
- **Append.** Run `$V prompt "$RUN" "Use the notes tool to append_to_file path checkpoint/verify.md with text ' step 2 done'. Then reply with exactly: appended"`. The stored `text` now ends with ` step 2 done`.
- **Read back.** Run `$V prompt "$RUN" "Use the notes tool to read_file path checkpoint/verify.md and quote its text verbatim."`. The reply quotes both steps.
- **Panel.** Run `$V type "$RUN" /notes`, `$V wait "$RUN" "Continuity active"`, then `$V snap "$RUN" checkpoint-panel-01`. The panel reads `Continuity active · window 1 · 1 notes in this session` and `1 sessions · 2 fork records` (one per write or append, so 2 after the steps above, 1 when only **Write** ran), with buttons `[ Normal compaction before new windows: off ]` (or `on`, see Gotchas), `[ Prune missing sessions ]` and `[ Close ]`. The transcript row reads `notes-compaction: Notes panel opened.`
- **Close panel.** Run `$V keys "$RUN" esc`. The prompt takes keys again.
- **Help.** Run `$V prompt "$RUN" "Call the notes tool with no arguments and quote the first line of its result."`. The reply quotes the tool's help text.
- **Proof.** Run `$V cleanup "$RUN"`. `.verify/$RUN/` holds both snaps, `transcript.jsonl` with the `write_file` call and result, and `data/claude-notes-compaction/sessions/<session>/notes/*.json`.

## Gotchas

- Stored note files are named by a hash of the path; match the `path` field inside them, not the file name.
- `1 sessions` in the panel counts the run's own data dir only. A higher count means `XDG_DATA_HOME` did not reach the instance and it is reading your real notes: stop and relaunch.
- On a Team or Enterprise account, or a machine with managed settings, the panel adds `Claude Code keeps plugins out of compaction here...`. That is the mod's reduced mode, expected there; it changes window behavior, not notes.
- The `Normal compaction before new windows` setting is stored in your real Claude Code config, not the run's data dir, so the run inherits your choice and pressing `n` changes it for every session. Assert whatever it reads, and never toggle it in a journey.
- The panel's bracketed-letter keys work only with the panel focused (`ctrl+x tab`). `p` then `y` prunes stored sessions whose transcripts are gone; in the run's isolated data dir that touches nothing of yours, but never press it in an instance launched without the helper.
- `prompt` returns `"done"` when the turn settles, not when the tool succeeded. Assert the tool result on screen or in the transcript.
