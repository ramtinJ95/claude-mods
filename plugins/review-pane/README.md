# review-pane

Review code changes, or Claude's last response, in a pane beside the conversation. Move through the diff line by line, attach comments, suggestions and issues to lines or ranges, ask questions that are answered right in the pane, and turn the review into a prompt you edit and send yourself. Nothing is submitted automatically.

A port of [pi-comment-editor](https://github.com/ramtinJ95/pi-comment-editor) to Claude Code, extended from responses to diffs.

## Install

```
/plugin install review-pane --marketplace ramtinJ95/claude-mods
```

## Commands

- `/review-diff` opens the uncommitted changes against `HEAD`, untracked files included (ignored files are not). `/review-diff base` opens everything since the merge-base with the default branch (`origin/HEAD`, else `origin/main`, `origin/master`, `main` or `master`).
- `/review-response` opens Claude's last response, line by line.

In fullscreen the pane docks beside the transcript; otherwise it opens above the prompt. One review is open at a time. Running the same command again while the review has annotations or an open draft resumes it; a different command, or `/review-diff` with the other base, is refused until you finish or discard that review. With no work in the review, a command reloads.

Code is highlighted with Claude Code's own highlighter, by file name in diffs and by the fence's language in responses. Responses, annotations and answers render their markdown (emphasis, inline code, headings, lists, quotes, tables) one source line per row, so line numbers still match what you annotate. All colours come from your Claude Code theme; with an "ANSI colors only" theme they are your terminal's palette.

## Keys

The pane takes the keyboard when it opens. `Esc` hands the keys back to the prompt and keeps the review; run the command again, or click the pane, to continue. Keys that do not apply right now are drawn dim and say why when pressed.

| Key | Action |
| --- | --- |
| `j` / `k` | Next / previous line |
| `d` / `u` | Half a page down / up |
| `g` / `b` | First / last line |
| `n` / `p` | Next / previous file (diffs) |
| `v` | Start or end a range |
| `c` / `s` / `i` | Comment, suggestion or issue on the line or range |
| `a` | Ask a question about the line or range |
| `o` | Comment on the changes or response as a whole |
| `h` / `l` | Previous / next annotation |
| `r` / `x` | Edit / delete the annotation under the cursor |
| `e` | Read the annotation in full: `j`/`k`/`d`/`u` scroll it, `e` returns to the diff |
| `f` | Switch between `HEAD` and the branch's merge-base (diffs, before annotating) |
| `y` | Finish: put the review in the prompt |
| `q` | Close; with annotations, `y` confirms the discard and `n` keeps them |

Annotations are typed on one line: `Enter` saves, and an empty `Enter` cancels. A half-typed annotation survives `Esc` and comes back when you resume. Hotkeys are lowercase letters only, because Claude Code passes only those to a pane without a click.

## Questions

`a` asks a question about the selected lines. The answer comes from a fork of the conversation (`$.model.fork`): the same model and context the main thread has, but no tools, and nothing is added to the conversation. The question carries the hunks it touches. In a session with no response yet there is nothing to fork, so the answer comes from the excerpt alone and says so.

Questions stay in the pane and are left out of the prepared prompt. Editing a question asks it again; an answer to the old text is dropped.

## Prepared review

`y` puts the review into the prompt, after any text already there:

````markdown
I reviewed the uncommitted changes. Please address these annotations.

1. **[ISSUE]** `src/cache.ts` lines 12-14

   ```diff
   +  if (!response.ok) return cachedValue;
   +  await save(response.body);
   +  return response.body;
   ```

   This silently returns stale data for every server error.
````

Overall comments come first, then line annotations in file order. Each one quotes the exact diff lines it targets.
