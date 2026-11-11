# claude-mods verification map

This directory is the maintained source for verifying what users of the claude-mods mods see and do. Read this index first, then use the matching feature file as the recipe. Each file covers one mod's feature, driven in a separate Claude Code instance with only that mod's development build loaded.

## Baseline preconditions

- Run from the repository root inside a Herdr Core terminal, with `V=.claude/skills/verify-claude-mods/scripts/vmod`.
- Launch one run per mod under test: `RUN=$($V launch <mod>)`. The instance starts in a fresh scratch git repository (`notes.txt` committed then edited, `new.txt` untracked) with an empty `XDG_DATA_HOME`.
- `$V doctor "$RUN"` passes before any journey starts.
- Source `.verify/$RUN/run.env` when a step names `$SESSION`, `$DATA`, `$SCRATCH`, `$EVIDENCE` or `$TERMINAL`.
- Never drive an instance this run did not launch, and never drive your own session.

## Driving conventions

- Start every journey from a freshly launched, idle instance unless its preconditions say otherwise.
- Treat every command, prompt and quoted screen text as literal. Prompts that make the model call a mod tool name the tool and action and end with a fixed reply.
- Slash commands and pane `Input` text go through `$V type`. Keys go through `$V keys`. Prompts that start a model turn go through `$V prompt`.
- Wait on screen text with `$V wait`, not on fixed sleeps.
- Screens carry pane borders (`│`). Match on text fragments.
- Close anything a journey opened outside the run's terminal (shepherdr workers, the `/review-diff` Neovim terminal) before `$V cleanup`, which lists the workers left.

## Proof and skip reporting

- Capture the user action and the resulting state: `$V snap` after the action and at the end state.
- Pair the screen with a side effect: stored files under `$DATA/claude-<mod>/`, the tool call in `transcript.jsonl`, files in `$SCRATCH`, Core terminals a worker opened.
- Confirm a mutation through a second user-facing view when the feature has one.
- Record the feature ID and entry point with every artifact name (`snap "$RUN" checkpoint-write-01`).
- A journey whose precondition cannot be met is reported as a failure with the attempted command and the unmet precondition.
- Do not report an entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with vmod` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map unless a trap depends on them. Name only user paths, stable handles, required state, commands, and observable proof.

## Features

- [Notes checkpoints](./notes-checkpoint.md) (notes-compaction) covers saving, reading and listing notes and the `/notes` panel. Driven end to end on 2026-10-17 with Claude Code 2.1.302: `checkpoint-write` and `checkpoint-panel` passed. Driven again on 2026-11-11 with Claude Code 2.1.322 after the actions were renamed: `checkpoint-write`, `checkpoint-append`, `checkpoint-read`, `checkpoint-help` and `checkpoint-earlier-names` (with the `/branch` restore) passed; `checkpoint-panel` was not driven again.
- [New context windows](./notes-window.md) (notes-compaction) covers `new_context`, `/compact` rollover and `history` across windows. Driven on 2026-11-11 with Claude Code 2.1.322: `window-guard` (all four guard steps) and `window-request` passed, and `/compact` opened a waiting window at once after a turn that saved notes; `/compact` asking for a checkpoint first and `window-history` were not driven.
- [Reduced mode](./notes-reduced.md) (notes-compaction) covers the same rollovers on a machine with managed settings, reached with `launch --managed`. Driven on 2026-11-12 with Claude Code 2.1.322 and notes-compaction 0.3.0: `reduced-notice`, `reduced-request`, `reduced-guard`, `reduced-compact-fresh`, `reduced-compact-checkpoint` and `reduced-history` passed; the mod's idle rollover and threshold auto-compaction were not driven.
- [Shepherdr agents](./shepherdr-agents.md) (shepherdr) covers `/shepherdr`, spawning workers, their pushed results, answering, closing idle ones and reopening closed ones. Driven on 2026-11-11 with Claude Code 2.1.322, Herdr Core 0.1.20 and pi-shepherdr 1.0.0, through `hc` by hand before the helper was ported: non-blocking spawn, answer, close-idle, resume and quit passed for Pi and Claude Code workers; the blocking Claude spawn and the status second view were not driven.
- [Review a response](./review-response.md) (review-pane) covers `/review-response`, pane navigation, annotations, questions and finishing into the prompt. Not driven yet.
- [Review a diff in Neovim](./review-diff.md) (review-pane) covers `/review-diff`, annotating in Neovim and finishing into the prompt. Driven on 2026-11-11 with Claude Code 2.1.322, Herdr Core 0.1.20 and Neovim 0.12.6: `diff-open` (through the printed script, since the mod opens no split under Core), `diff-annotate` with one comment, `diff-finish` and the usage and no-changes errors passed; `diff-base`, `diff-ask`, `diff-reopen` and `discard` were not driven.
