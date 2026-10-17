# Review a response

review-pane opens Claude's last response in a pane beside the transcript, one source line per row, where the user annotates lines or ranges, asks questions answered in place, and finishes by loading the review into the prompt to edit and send themselves.

## Sub-features

- `response-open` opens the last response with `/review-response`, or reports there is none.
- `response-navigate` moves with `j`/`k`, `d`/`u`, `g`/`b`, and selects ranges with `v`.
- `response-annotate` adds comments (`c`), suggestions (`s`), issues (`i`) and an overall comment (`o`), typed in one line.
- `response-ask` asks a question (`a`) answered under it by a fork of the conversation.
- `response-edit` edits (`r`), deletes (`x`), reads (`e`) and steps between (`h`/`l`) annotations.
- `response-resume` keeps the review across `esc` and resumes it with the command.
- `response-finish` puts the review in the prompt with `y`; `q` closes, asking before discarding annotations.

## How to get to it (user POV)

- Type `/review-response` after Claude has answered at least once.
- Press the pane's hotkeys; the key row draws every key, dimming ones that do not apply.

## Driving it with vmod

Preconditions:

- `RUN=$($V launch review-pane)` and `$V doctor "$RUN"` pass.
- One response exists: `$V prompt "$RUN" "Reply with exactly these three lines and nothing else: first line, second line, third line, each on its own line."`.

- **No response yet.** On a second fresh launch only, `$V type "$RUN" /review-response` shows `No assistant response to review yet.` Skip this bullet in the main run.
- **Open.** Run `$V type "$RUN" /review-response`, `$V wait "$RUN" "Opened a review of the previous response."`, `$V snap "$RUN" response-open-01`. A pane titled `Review` shows the three lines numbered, with the key rows below.
- **Comment.** Run `$V keys "$RUN" j c`, then `$V type "$RUN" "Make this line bold"`. The second row carries a comment marker and the saved comment shows in the preview.
- **Issue on a range.** Run `$V keys "$RUN" g v j i`, then `$V type "$RUN" "These two lines repeat each other"`. An issue spans rows 1-2.
- **Question.** Run `$V keys "$RUN" b a`, then `$V type "$RUN" "Why three lines?"`. `Asking…` shows under the question, then an answer replaces it (`$V wait "$RUN" "Asking…"` then wait for it to disappear by re-reading `$V screen "$RUN"`).
- **Dim key.** Run `$V keys "$RUN" n`. A notice says `n answers the question q asks before discarding.` and nothing changes.
- **Resume.** Run `$V keys "$RUN" esc`, then `$V type "$RUN" /review-response` and `$V wait "$RUN" "Resumed the open review."`. Both annotations and the answer are still there.
- **Finish.** Run `$V keys "$RUN" y`, `$V wait "$RUN" "Review loaded into the prompt."`, `$V snap "$RUN" response-finish-01`. The prompt holds the prepared review: the issue and the comment with their quoted lines, and no question. Nothing was submitted: Herdr still reports the agent `idle` (`herdr agent get "$PANE"`).
- **Proof.** Run `$V screen "$RUN" 120 > "$EVIDENCE/response-finish-prompt.txt"`, clear the prompt with `$V keys "$RUN" ctrl+c`, then `$V cleanup "$RUN"`.

## Gotchas

- Hotkeys reach the pane only while it holds the keyboard. Opening from the command gives it the keyboard; after `esc` the next letter goes to the prompt. Resume with the command, never by clicking.
- Any key the pane does not bind falls through to the prompt and takes the keyboard with it. Send only the documented hotkeys while the pane is open.
- Annotation text is one line: `Enter` saves, an empty `Enter` cancels. `type` sends text plus Enter, so never `type` an empty string expecting a no-op.
- A question in a session with no response yet is answered from the excerpt alone and says so. The preconditions create a response so the fork path runs.
- Under the stock `dark-ansi` theme, highlighted comments in code blocks are invisible in the pane; do not read that as missing text.
- `ctrl+c` on a filled prompt clears it; a second `ctrl+c` would exit the instance.
