---
name: verify-claude-mods
description: Prove a claude-mods mod (notes-compaction, shepherdr, review-pane) works by driving a development build in a separate Claude Code instance in a new Herdr Core terminal, through its real slash commands, panes and agent tools, and capturing screens, transcript and stored state. Use before reporting a mod change done, when reproducing a mod bug, or when asked to verify or demo a mod live.
---

# Verify claude-mods

The product here is Claude Code with one mod loaded. A user touches it through slash commands (`/notes`, `/shepherdr`, `/review-diff`, `/review-response`), panes and panels those commands open, toasts, the status line, and the tools the model calls (`notes`, `new_context`, `history`, `agents`). So verification means a second, separate Claude Code instance started with `--plugin-dir plugins/<mod>`, driven by keystrokes through Herdr Core (`hc`), with evidence read from its screen, its session transcript and the mod's own storage.

Never drive the session you are running in, and never let the instance under test compact or prompt your own session. Every run gets its own Core terminal, scratch repository, data directory and session ID, so several runs can go side by side.

`claude plugin validate plugins/<mod>` and `claude plugin validate .` are static checks, not proof; run them too, but a mod is verified only when a journey from `features/` passes live.

## Requirements

- This session runs inside a Herdr Core terminal (`HC_TERMINAL_ID` set), from the Herdr app or `hc`. The helper refuses otherwise. Outside Core there is no supported driver; say so instead of improvising. A tmux pane would inherit your shell's sandbox, and Claude Code cannot run inside it. The older Herdr TUI (`herdr`, `HERDR_ENV`) is not supported: shepherdr itself needs Core.
- `claude`, `hc`, `jq`, `git`, `uuidgen` on `PATH`. review-pane's `/review-diff` also needs `nvim` 0.10+. shepherdr's Pi features need `pi` with pi-shepherdr; its Claude worker features do not.
- Your logged-in Claude Code account. The instance uses your real `~/.claude` (auth, settings, other installed plugins), and each journey costs real model turns.

## Helper

Everything goes through `scripts/vmod`, run from the repository root:

```sh
V=.claude/skills/verify-claude-mods/scripts/vmod
$V help
```

| Command | Does |
| --- | --- |
| `$V launch <mod>` | Creates the run, starts the instance, accepts the trust prompt for its own scratch folder, waits until idle, prints the run ID |
| `$V doctor <run>` | Read-only health check (below) |
| `$V prompt <run> "<text>"` | Submits a prompt and waits for the turn to settle (5 min cap); prints `"done"`, `"idle"` or `"blocked"`, or fails when no turn starts within 30 s |
| `$V type <run> "<text>"` | Types text and Enter without waiting: slash commands, pane `Input`s |
| `$V keys <run> <key>...` | `hc keys` names: `esc`, `enter`, `down`, `up`, `tab`, `ctrl+x`, or a single letter |
| `$V wait <run> "<text>" [secs]` | Waits until the literal text is on screen (default 60 s); exits non-zero on timeout |
| `$V screen <run> [lines]` | Prints the visible screen, with `<lines>` of history above it when given |
| `$V snap <run> <name>` | Saves the visible screen to `<evidence>/<name>.txt` |
| `$V transcript <run>` | Copies the session's transcript to `<evidence>/transcript.jsonl` |
| `$V cleanup <run>` | Keeps transcript and stored state as evidence, closes the run's terminal, lists terminals the instance started that are still open, prints the scratch path to delete |

`<run>` is the ID `launch` printed (`<mod>-<yyyymmdd-hhmmss>-<4 hex>`) or its evidence directory. `.verify/<run>/run.env` holds the run's terminal, session ID and paths; source it to use `$TERMINAL`, `$SESSION`, `$DATA`, `$SCRATCH` or `$EVIDENCE` directly.

## Launch

```sh
RUN=$($V launch notes-compaction)   # or shepherdr, review-pane
$V doctor "$RUN"
```

`launch` does this, in order:

1. Scratch at `$TMPDIR/claude-mods-verify/<run>/`: `scratch/` is a fresh git repository with `notes.txt` committed and then edited and `new.txt` untracked, so diff features have a change and an untracked file. `data/` is the mod's `XDG_DATA_HOME`, so stored state starts empty and never mixes with yours.
2. Evidence at `.verify/<run>/` in this repository (gitignored): `run.env`, and `debug.log` from `--debug-file`.
3. A new Core terminal named `vm-<mod>-<suffix>` (`NAME` in `run.env`), cwd `scratch/`, started with `hc run --bg --no-notify` as a child of this session's terminal, so Core types no notes about it into this session. When this session's terminal is in a Herdr space, the instance gets a tab of its own there; otherwise it is a background terminal (`hc attach <address>` shows it).
4. In that terminal: `env XDG_DATA_HOME=<data> DISABLE_AUTOUPDATER=1 claude --plugin-dir <repo>/plugins/<mod> --settings '{"enabledPlugins":{"<mod>@claude-mods":false}}' --session-id <uuid> --debug-file <evidence>/debug.log`. The settings flag turns off the installed copy of the same mod, which would otherwise answer its commands. Installed copies of the other mods stay on, as in a user's real setup.
5. The trust prompt ("Quick safety check") is accepted only when it names this run's `scratch/` folder, which the run just created. Any other folder aborts the launch. Each run adds one trusted-folder entry to `~/.claude.json`.
6. Ready means Claude Code reports `idle` to Core and its banner is on screen.

Both environment variables are load-bearing. Setting `XDG_DATA_HOME` on a whole shell makes its tools follow it (atuin started a daemon in the scratch dir). Without `DISABLE_AUTOUPDATER=1`, Claude Code installs itself into `<data>/claude/versions/` and repoints the user's `claude` launcher symlink there, and deleting the scratch dir then breaks `claude` for the user. The doctor checks for both.

## Doctor

```sh
$V doctor "$RUN"
```

Read-only. Checks that the terminal hosts Claude Code (and prints its status), that its cwd is the run's scratch repo, that the debug log shows hooks registered only from `<repo>/plugins/<mod>` (the installed copy reads as `enabled=false`), that the mod's `plugin.json` version still matches the launch, that the `claude` launcher still points where it did at launch, and that Claude Code did not install into the run's data dir. Run it first, and again whenever a step behaves oddly. A `FAIL` on the launcher check is urgent: restore the symlink (the launch-time target is `LAUNCHER` in `run.env`) before deleting any scratch.

Edits to the mod reload between turns, so you can fix and re-drive without relaunching. If you change `hooks.json` or `plugin.json`, relaunch.

## Drive

Pick the feature in `features/README.md` and follow its file. These conventions apply to all of them:

- Prompts that should make the model call a mod tool name the tool and action outright and end with a fixed reply (`Then reply with exactly: saved`), so the turn is short and the result is easy to assert.
- Slash commands go through `type`, not `prompt`. A command that starts no model turn makes `prompt` fail after 30 s. Both type through Core's API rather than `hc send`, which wraps text for an agent in a `<hc from=…>` tag and so turns a slash command into a message.
- Wait on text with `wait`, never a fixed sleep. Wait for the end state the feature file names.
- Panes and panels open beside the transcript and take the keyboard. `keys <run> esc` hands keys back to the prompt.
- `screen` output carries the pane's box-drawing borders. Grep for the text, not whole lines.

## Evidence

Everything lands in `.verify/<run>/` and survives cleanup: `run.env`, `debug.log`, every `snap`, `transcript.jsonl`, and `data/` with a copy of the mod's stored state (`claude-*` folders of the run's `XDG_DATA_HOME`), all written by `cleanup`.

Proof standards:

- Drive the real user path: a slash command, a pane key, or a prompt that makes the model call the mod's tool. Never call the hooks module, write the mod's state files, or fake a transcript.
- Capture the action and the resulting state: a `snap` right after the action and one of the end state, not only the final screen.
- Verify side effects alongside the screen: the stored files under `$DATA/claude-<mod>/` for this `$SESSION`, the tool call and result in `transcript.jsonl`, files in `$SCRATCH`, Core terminals a worker opened.
- Confirm through a second view when the feature has one: the `/notes` panel after a write, `/shepherdr` after a spawn, the prompt text after a review finishes.
- Mocks have no place here. The only isolation is the separate instance, scratch repo and data dir.
- Report what each journey actually proved, with evidence paths. A journey whose precondition cannot be met is a failure with the reason, not a skip reported as a pass.

## Cleanup

```sh
$V cleanup "$RUN"
```

It copies the transcript and the mod's stored state into the evidence, closes only the terminal `launch` created (which ends the instance), lists the terminals the instance started that Core still has, warns if the launcher moved, and prints the scratch folder's `rm -rf` command. Run that command yourself. If a hook or the sandbox asks for approval, follow it; if the delete is refused, report the leftover path (it lives under `$TMPDIR` and holds only the scratch repo and the mod's data).

Cleanup never touches things the instance started outside its terminal: shepherdr workers it spawned (close each by the address the spawn reported, `hc kill <address>` then `hc rm <address>`, before cleanup), or `/review-diff` review directories under the system temp dir that kept annotations. Never kill by process name.

After every failed attempt, run cleanup before relaunching, so broken runs do not strand terminals.

## Feature map

`features/README.md` indexes the user-facing features and their journeys. Keep it current when a mod gains, renames or drops a command, key or tool; `/pstack:maintain-verification-skill` walks that.
