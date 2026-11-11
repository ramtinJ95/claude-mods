# Reduced mode

On a machine with managed settings, and for Team and Enterprise organizations, Claude Code keeps installed plugins out of compaction. notes-compaction then opens each new window from a short Claude Code summary followed by its window marker, says so once in a notice and in `/notes`, and keeps its checkpoint rules.

## Sub-features

- `reduced-notice` shows `Claude Code keeps plugins out of compaction here` in `/notes` once the first rollover found the hook skipped.
- `reduced-request` rolls over on `new_context`: Claude Code's summary, then one prompt carrying the window marker and `Continue.`.
- `reduced-guard` keeps the `new_context` rules of full mode: no save, no window; a retried save rolls over; a save batched with another call rolls over; a write that fails later in the batch withdraws the request.
- `reduced-compact-fresh` makes `/compact` open a waiting window at once after a turn that saved notes; the marker leads the user's next prompt.
- `reduced-compact-checkpoint` makes `/compact <guidance>` ask for a checkpoint first, then open a waiting window.
- `reduced-history` still files rows under the right windows, read from the markers the prompts carried.

## How to get to it (user POV)

- Use Claude Code on a machine with managed settings or in a Team or Enterprise organization, then ask for a new context window or type `/compact`.
- Type `/notes` to see the notice.

## Driving it with vmod

Preconditions:

- `RUN=$($V launch notes-compaction --managed)` and `$V doctor "$RUN"` pass, including the `managed settings seated the built-in security plugin outermost` line. `bwrap` is on `PATH` and the machine has no `/etc/claude-code`.
- `. ".verify/$RUN/run.env"` is sourced, for `$DATA`, `$SESSION` and `$EVIDENCE`.
- `/notes` reads `[ Normal compaction before new windows: off ]`. If it reads `on`, report the journey as failed on that precondition; do not toggle it.

- **Seed context.** Run `$V prompt "$RUN" "Remember the codeword PLUM-42 for later. Reply with exactly: noted"`.
- **Retried save.** Run `$V prompt "$RUN" "Do these three steps in order, each as its own separate tool call, one per message, never in parallel. Step 1: call the notes tool with action write, path ../bad and text x (it will fail, that is expected, go on). Step 2: call the notes tool with action write, path checkpoint/a.md and text 'codeword PLUM-42'. Step 3: call new_context."`. The screen shows `/compact`, `Compacted`, then one prompt holding the marker (`Current context window id: ...`) and `Continue.`, and the agent reads its checkpoint. `grep -c "session.compact bypassed by cc-plugin-sec-default" "$EVIDENCE/debug.log"` is 1 or more.
- **Notice.** Run `$V type "$RUN" /notes`, `$V wait "$RUN" "window 2"`, `$V snap "$RUN" reduced-notice-01`, `$V keys "$RUN" esc`. The panel reads `window 2` and `Claude Code keeps plugins out of compaction here`.
- **Batched save.** Run `$V prompt "$RUN" "Step 1: in ONE message, make two parallel tool calls: the notes tool with action write, path checkpoint/a.md, text 'codeword PLUM-42 v2', and Bash running: echo hi. Step 2: in the next message call new_context alone."`. A third window opens the same way.
- **Withdrawal.** Run `$V prompt "$RUN" "In ONE single message make three tool calls in this exact order: (1) notes tool, action write, path checkpoint/a.md, text 'codeword PLUM-42 v3'; (2) new_context; (3) notes tool, action write, path ../bad, text x. Then do not retry anything: reply with exactly the result text of the third call."`. The reply ends `The requested new window will not open. Save again, then call new_context.`, and `jq .window.windowNumber "$DATA"/claude-notes-compaction/sessions/$SESSION/state.json` still reads `2`.
- **Compact after a save.** Run `$V prompt "$RUN" "Call notes with action write, path checkpoint/a.md, text 'codeword PLUM-42 v4'. Then reply with exactly: saved"`, then `$V type "$RUN" /compact`. Wait for `Compacted` (`$V wait "$RUN" "Compacted" 120`). No turn starts. `state.json` reads `windowNumber` 3 and holds an `unsentMarker`.
- **Marker on the next prompt.** Run `$V prompt "$RUN" "What is the codeword? Reply with only the codeword."`. The reply is `PLUM-42`, `state.json` no longer holds `unsentMarker`, and the transcript's user row for that prompt starts with `<context_window>`.
- **Compact with guidance.** Run `$V type "$RUN" "/compact keep only the codeword"`. The checkpoint prompt shows `Checkpoint guidance:` and the guidance, the agent writes a note, then `/compact` runs and `Compacted` shows. `state.json` reads `windowNumber` 4. No turn starts.
- **History.** Run `$V prompt "$RUN" "Load the history tool. Call it with action list_windows. Then call it with only query 'PLUM-42' and role user and limit 3. Reply with the number of windows and the window_id of each search item."`. The reply names five windows, and the items sit in the first window.
- **Proof.** Run `$V snap "$RUN" reduced-history-01` and `$V cleanup "$RUN"`. `.verify/$RUN/transcript.jsonl` holds each `This session is being continued` summary followed by a marker prompt, and `debug.log` one `bypassed` line per rollover.

## Gotchas

- The mod learns that compaction is blocked from its first rollover. With the development build's store still saying `hooked` from a full-mode run, that first rollover's `/compact` carries no summary instructions and Claude Code writes its full summary; later ones show the instructions after `/compact`. Both are expected.
- The development build keeps what it learned in its own store, apart from the installed copy's (`~/.claude/plugins/store/notes-compaction_inline-*.json`). After a `--managed` run it reads `blocked` until a full-mode run rolls over once; that run's first `/compact` then carries summary instructions. Nothing of the installed mod changes.
- The codeword can survive through Claude Code's summary alone. Assert the window number, the marker prompt and the `bypassed` debug line, not only recall.
- `/compact`'s reply (`Opening a new window from your notes.`) can wrap across lines beside an open panel; wait on `Compacted` instead.
- After a rollover the agent reads its checkpoint and often skips `history`, since the summary already carries the latest request. That is not a failure of the recovery guidance.
- The mod's own idle rollover (50 minutes, 200k tokens) and threshold auto-compaction are not reachable in a short run. Do not report them from this journey.
- Never create `/etc/claude-code` on the machine to reach this mode: it would put every Claude Code session there into it.
