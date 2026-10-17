# New context windows

notes-compaction lets the agent start a fresh context window that carries only a marker pointing at its checkpoint notes, from a plain-words request or from `/compact`, and lets it search earlier windows with `history`.

## Sub-features

- `window-request` rolls over when the user asks for a new window: the agent writes a checkpoint, calls `new_context`, and the next window opens with `Continue.`.
- `window-guard` refuses `new_context` unless the latest call in the turn was a successful notes write.
- `window-compact` makes `/compact` ask for a checkpoint first, then open a new window that waits for the next prompt.
- `window-history` lists and searches earlier windows of the session with `history`.

## How to get to it (user POV)

- Ask the agent in plain words for a new context window.
- Type `/compact`, optionally followed by checkpoint guidance.
- Ask the agent what happened in an earlier window; it loads and calls `history`.

## Driving it with vmod

Preconditions:

- `RUN=$($V launch notes-compaction)` and `$V doctor "$RUN"` pass.
- Run `$V type "$RUN" /notes` and `$V snap "$RUN" window-mode-01` first. If the panel shows `Claude Code keeps plugins out of compaction here`, the account runs the reduced mode: expect a short Claude Code summary ahead of each new window, and record that in the report.
- The same panel shows `[ Normal compaction before new windows: off ]`. That setting lives in your real Claude Code config, not the run's data dir. If it reads `on`, `/compact` is Claude Code's own and the **Compact** step cannot pass: report the journey as failed on that precondition. Do not toggle it, since that changes the user's setting for every session.

- **Seed context.** Run `$V prompt "$RUN" "Remember the codeword PLUM-42 for later. Reply with exactly: noted"`.
- **Guard.** Run `$V prompt "$RUN" "Call new_context now without writing notes first, then quote the tool result."`. The reply quotes a denial that requires a notes write first, and `/notes` still shows `window 1`.
- **Request a window.** Run `$V prompt "$RUN" "Save a checkpoint note that includes the codeword, then start a new context window."`, then `$V snap "$RUN" window-request-01`. The transcript shows a `notes` `write_file` call followed by `new_context`.
- **New window.** Wait for the rollover: `$V wait "$RUN" "Continue." 180`. The new window opens with the marker (`Current context window id: ...`, visible in `$V screen "$RUN" 200`) and `Continue.`. After the agent settles, run `$V type "$RUN" /notes`, `$V wait "$RUN" "window 2"`, `$V snap "$RUN" window-request-02`. The panel reads `window 2`.
- **Continuity.** Run `$V keys "$RUN" esc` and `$V prompt "$RUN" "What is the codeword? Reply with only the codeword."`. The reply is `PLUM-42`, recovered from the notes.
- **History.** Run `$V prompt "$RUN" "Use the history tool to list the windows of this session and say how many there are."`. The reply names two windows.
- **Compact.** Run `$V type "$RUN" "/compact keep only the codeword"`, wait for the checkpoint turn to settle with `$V wait "$RUN" "Opening a new window" 180` or the agent's checkpoint reply, then `$V type "$RUN" /notes` and `$V wait "$RUN" "window 3"`. The new window waits for the next prompt instead of continuing on its own.
- **Proof.** Run `$V snap "$RUN" window-compact-01` and `$V cleanup "$RUN"`. `.verify/$RUN/transcript.jsonl` holds every window, and `data/claude-notes-compaction/sessions/<session>/state.json` shows the advanced window number.

## Gotchas

- The rollover runs in turns of its own; `prompt` may return after the checkpoint turn while the new window is still opening. Wait on screen text before asserting.
- Interrupting a checkpoint or `new_context` turn cancels the rollover with a toast (`Rollover cancelled by the interruption. The old context remains.`); never send `esc` while a rollover is in flight.
- Idle compaction and threshold auto-compaction are not reachable in a short run. Do not report them from this journey.
- In reduced mode the window starts from Claude Code's summary followed by the marker and `Continue.`; the codeword may survive through the summary alone. Assert the window number and the `new_context` call too, not only recall.
