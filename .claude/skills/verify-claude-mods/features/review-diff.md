# Review a diff in Neovim

review-pane opens the uncommitted changes (or everything since the merge-base) as real files in Neovim beside Claude Code, where the user annotates lines, asks questions answered in place, and finishes by loading the review into Claude Code's prompt.

## Sub-features

- `diff-open` opens `/review-diff` in Neovim with the changes in the quickfix list, untracked files included: in a split under tmux, kitty or the older Herdr TUI, else by printing the script to run.
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
- `. ".verify/$RUN/run.env"` is sourced, for `$TERMINAL`, `$SCRATCH` and `$EVIDENCE`.

- **Usage error.** Run `$V type "$RUN" "/review-diff nonsense"` and `$V wait "$RUN" "Usage: /review-diff [base]"`.
- **Open.** Run `$V type "$RUN" /review-diff` and `$V wait "$RUN" "in a terminal to open the review"`. Under Core the mod opens no split: the row reads ``Run `sh '<dir>/open.sh'` in a terminal to open the review in Neovim.`` Take `<dir>` from `$V screen "$RUN" 60` (call it `DIR`), then open the script in a terminal of its own: `NV=$(hc run --json --bg --no-notify --name "vm-review-nvim-${RUN##*-}" --cwd "$SCRATCH" -- sh "$DIR/open.sh" | jq -r .address)`. Run `hc read "$NV" > "$EVIDENCE/diff-open-01.txt"`. Neovim shows the first stop, `new.txt`, a `Review` notice, and the quickfix list with `new.txt|1|` and `notes.txt|2|`, in git's path order.
- **Comment.** Go to the edited line explicitly (`nvim --server "$DIR/nvim.sock" --remote-send ':edit notes.txt | 2<CR>'`; never `:cfirst`, which lands in `new.txt`), then send `':Review comment<CR>'`. `hc read "$NV"` shows a `Comment on notes.txt line 2` input. Send `'Use lowercase like the other lines<CR>'`. The line shows `• Comment: Use lowercase like the other lines` beneath it.
- **Finish.** Send `':Review finish<CR>'`. Neovim exits (`hc get "$NV" --json` reads `"state":"finished"`, exit code 0) and `<dir>` is removed. In the instance, `$V wait "$RUN" "Review loaded into the prompt."` and `$V snap "$RUN" diff-finish-01`. The prompt starts `I reviewed the uncommitted changes. Please address these annotations.` and lists the comment on `notes.txt` line 2 with the quoted line `BETA changed`.
- **Not submitted.** `hc get "$TERMINAL" --json | jq -r .status.state` still reports `idle`. Clear the prompt with `$V keys "$RUN" ctrl+c`.
- **No changes.** Commit everything in the scratch repo (`git -C "$SCRATCH" add -A && git -C "$SCRATCH" -c user.name=verify -c user.email=verify@localhost commit -qm all`), run `$V type "$RUN" /review-diff`; the row reads `review-pane: No uncommitted changes.`
- **Proof.** Run `hc rm "$NV"` (`hc kill "$NV"` first if Neovim is still open), then `$V cleanup "$RUN"`.

## Gotchas

- The mod opens a split only under tmux, kitty or the older Herdr TUI. Under Core it prints the script, and the journey opens it itself. The Neovim terminal is a child of this session, not of the run: `cleanup` neither closes nor lists it.
- `hc keys` has no name for `:` and `hc send` pastes, which Neovim's normal mode puts into the buffer. Type into Neovim through its own socket (`nvim --server "$DIR/nvim.sock" --remote-send`), and read it with `hc read "$NV"`. A sandboxed shell that cannot reach the socket has no way to drive this journey: report that.
- A review closed with annotations keeps its directory under the system temp dir for `/review-diff` to reopen; finish or discard every review a journey opens.
- `:Review` prompts for the annotation text in a floating input. Wait for it on `hc read "$NV"` before sending the text.
- The scratch repo has no remote, so `/review-diff base` reports `No default branch found (origin/HEAD, main or master) to diff against.` unless the branch is `main` or `master`. Check `git -C "$SCRATCH" branch --show-current` before treating that message as a failure.
- Your Neovim config loads too. A config that maps a `<leader>r…` key wins over the mod's; drive with `:Review` commands, which always work.
