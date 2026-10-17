# Review a diff in Neovim

review-pane opens the uncommitted changes (or everything since the merge-base) as real files in Neovim beside Claude Code, where the user annotates lines, asks questions answered in place, and finishes by loading the review into Claude Code's prompt.

## Sub-features

- `diff-open` opens `/review-diff` in a Herdr split to the right with the changes in the quickfix list, untracked files included.
- `diff-base` opens `/review-diff base` against the merge-base with the default branch.
- `diff-annotate` adds comments, suggestions, issues and an overall comment with `:Review` subcommands.
- `diff-ask` asks a question answered in Neovim.
- `diff-finish` closes Neovim and puts the review in the prompt; `discard` drops it.
- `diff-reopen` reopens kept annotations after Neovim quits.
- `diff-errors` reports `Usage: /review-diff [base]`, a missing `nvim`, no changes, or no default branch.

## How to get to it (user POV)

- Type `/review-diff` or `/review-diff base` in a git repository.
- In Neovim, run `:Review <subcommand>` or the `<leader>r…` keys the README lists.

## Driving it with vmod

Preconditions:

- `RUN=$($V launch review-pane)` and `$V doctor "$RUN"` pass. The scratch repo has `notes.txt` edited (`beta` became `BETA changed`) and `new.txt` untracked.
- `nvim --version` is 0.10 or newer.

- **Usage error.** Run `$V type "$RUN" "/review-diff nonsense"` and `$V wait "$RUN" "Usage: /review-diff [base]"`.
- **Open.** Run `$V type "$RUN" /review-diff`, `$V wait "$RUN" "Opened the review in Neovim beside this pane."`. Find the Neovim pane: `herdr pane list --workspace "$HERDR_WORKSPACE_ID" | jq -r --arg t "$TAB" '.result.panes[] | select(.tab_id == $t and .pane_id != "'"$PANE"'") | .pane_id'` (call it `NV`). Run `herdr pane read "$NV" --source visible > "$EVIDENCE/diff-open-01.txt"`. Neovim shows `notes.txt` at the changed line.
- **Quickfix.** In Neovim, run `herdr pane send-text "$NV" ":Review files"` and `herdr pane send-keys "$NV" enter`. The quickfix list holds a stop in `new.txt` and one in `notes.txt`, in git's path order.
- **Comment.** Go to the edited line explicitly (`herdr pane send-text "$NV" ":edit notes.txt | 2"`, `enter`; never `:cfirst`, which lands in `new.txt`), then `:Review comment`, `enter`, type `Use lowercase like the other lines`, `enter`. The line shows the annotation.
- **Finish.** Send `:Review finish` and `enter`. Neovim closes and its pane goes away. In the instance, `$V wait "$RUN" "Review loaded into the prompt."` and `$V snap "$RUN" diff-finish-01`. The prompt starts `I reviewed the uncommitted changes. Please address these annotations.` and lists the comment on `notes.txt` line 2 with the quoted line `BETA changed`.
- **Not submitted.** `herdr agent get "$PANE"` still reports `idle`. Clear the prompt with `$V keys "$RUN" ctrl+c`.
- **No changes.** Commit everything in the scratch repo (`git -C "$SCRATCH" add -A && git -C "$SCRATCH" -c user.name=verify -c user.email=verify@localhost commit -qm all`), run `$V type "$RUN" /review-diff`; the reply starts `No ` and names the uncommitted changes.
- **Proof.** Run `$V cleanup "$RUN"`.

## Gotchas

- Herdr opens Neovim with focus, which can switch your Herdr view to the run's tab. Switch back yourself; keystrokes sent by pane ID still land correctly.
- The split belongs to the run's tab, so `cleanup` closes a Neovim left open. A review closed with annotations keeps its directory under the system temp dir for `/review-diff` to reopen; finish or discard every review a journey opens.
- `:Review` prompts for the annotation text in Neovim's command line. Wait for the prompt before typing; read the pane with `herdr pane read "$NV" --source visible`.
- The scratch repo has no remote, so `/review-diff base` reports `No default branch found (origin/HEAD, main or master) to diff against.` unless the branch is `main` or `master`. Check `git -C "$SCRATCH" branch --show-current` before treating that message as a failure.
- Your Neovim config loads too. A config that maps a `<leader>r…` key wins over the mod's; drive with `:Review` commands, which always work.
- A sandboxed shell cannot reach Neovim's socket. Drive Neovim only through Herdr keys.
