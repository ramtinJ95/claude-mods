# review-pane

Review code changes in Neovim beside Claude Code, or Claude's last response in a pane. Attach comments, suggestions and issues to lines or ranges, ask questions that are answered where you asked them, and turn the review into a prompt you edit and send yourself. Nothing is submitted automatically.

A port of [pi-comment-editor](https://github.com/ramtinJ95/pi-comment-editor) to Claude Code, extended from responses to diffs.

## Install

```
/plugin install review-pane --marketplace ramtinJ95/claude-mods
```

`/review-diff` needs Neovim 0.10 or newer on `PATH`.

## Commands

- `/review-diff` opens the uncommitted changes against `HEAD` in Neovim, untracked files included (ignored files are not). `/review-diff base` opens everything since the merge-base with the default branch (`origin/HEAD`, else `origin/main`, `origin/master`, `main` or `master`).
- `/review-response` opens Claude's last response in a pane, line by line.

## Reviewing a diff in Neovim

`/review-diff` opens Neovim in a split to the right of Claude Code: in [Herdr](https://herdr.dev) when it runs there, else in tmux, else in kitty with remote control enabled. Anywhere else it prints a `sh …/open.sh` command to run in a terminal of your own. Neovim starts with your own config; the mod adds its Lua module and nothing else.

You review the real files, not a diff. The quickfix list holds every run of changes (`:cnext`, `:cprev`, `:Review files` brings it back), and with [gitsigns.nvim](https://github.com/lewis6991/gitsigns.nvim) the changes are marked against the same base. Annotations are tied to lines and follow them as you edit. Lines a change removed are not in the file; annotate the line beside them.

| Command | Key | Action |
| --- | --- | --- |
| `:Review comment` | `<leader>rc` | Comment on the line or visual range |
| `:Review suggest` | `<leader>rs` | Suggestion on the line or range |
| `:Review issue` | `<leader>ri` | Issue on the line or range |
| `:Review ask` | `<leader>ra` | Ask a question about the line or range |
| `:Review overall` | `<leader>ro` | Comment on the changes as a whole (one; empty removes it) |
| `:Review edit` / `delete` | `<leader>re` / `<leader>rx` | Edit or delete the annotation under the cursor |
| `:Review show` | `<leader>rv` | Read the annotation and its answer in full |
| `:Review next` / `prev` | `]r` / `[r` | Next or previous annotation |
| `:Review list` | `<leader>rl` | All annotations in the location list |
| `:Review files` | `<leader>rf` | The changes in the quickfix list |
| `:Review finish` | `<leader>ry` | Put the review in Claude Code's prompt and close Neovim |
| `:Review discard` | `<leader>rq` | Drop the annotations and close Neovim |

A key your config already maps is left alone; `:Review` always works. Quitting Neovim keeps the annotations: `/review-diff` reopens them, against either base.

## Reviewing a response in the pane

In fullscreen the pane docks beside the transcript; otherwise it opens above the prompt. Running `/review-response` again while the review has annotations or an open draft resumes it; with no work in it, the command reloads the latest response.

Responses, annotations and answers render their markdown (emphasis, inline code, headings, lists, quotes, tables, fenced code highlighted by its language) one source line per row, so line numbers still match what you annotate. All colours come from your Claude Code theme.

The pane takes the keyboard when it opens. `Esc` hands the keys back to the prompt and keeps the review; run the command again, or click the pane, to continue. Keys that do not apply right now are drawn dim and say why when pressed.

| Key | Action |
| --- | --- |
| `j` / `k` | Next / previous line |
| `d` / `u` | Half a page down / up |
| `g` / `b` | First / last line |
| `v` | Start or end a range |
| `c` / `s` / `i` | Comment, suggestion or issue on the line or range |
| `a` | Ask a question about the line or range |
| `o` | Comment on the response as a whole |
| `h` / `l` | Previous / next annotation |
| `r` / `x` | Edit / delete the annotation under the cursor |
| `e` | Read the annotation in full: `j`/`k`/`d`/`u` scroll it, `e` returns to the response |
| `y` | Finish: put the review in the prompt |
| `q` | Close; with annotations, `y` confirms the discard and `n` keeps them |

Annotations are typed on one line: `Enter` saves, and an empty `Enter` cancels. A half-typed annotation survives `Esc` and comes back when you resume. Hotkeys are lowercase letters only, because Claude Code passes only those to a pane without a click.

## Questions

A question is answered by a fork of the conversation (`$.model.fork`): the same model and context the main thread has, but no tools, and nothing is added to the conversation. From Neovim it carries the lines asked about and the ten lines around them as the file stands; in the pane, the lines of the response. In a session with no response yet there is nothing to fork, so the answer comes from the excerpt alone and says so.

Answers appear under the question (in Neovim the first lines; `:Review show` reads the rest). Questions are left out of the prepared prompt. Editing a question asks it again; an answer to the old text is dropped.

## Prepared review

Finishing puts the review into the prompt, after any text already there:

````markdown
I reviewed the uncommitted changes. Please address these annotations.

1. **[ISSUE]** `src/cache.ts` lines 12-14

   ```ts
     if (!response.ok) return cachedValue;
     await save(response.body);
     return response.body;
   ```

   This silently returns stale data for every server error.
````

Overall comments come first, then line annotations in file order. Each one quotes the lines it targets as they stand when you finish.
