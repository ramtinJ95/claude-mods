# shepherdr

Spawn, delegate to and monitor Pi agents running in [Herdr](https://herdr.dev) from Claude Code. It is the Claude Code controller for [pi-shepherdr](https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/main/packages/pi-shepherdr): results of background work arrive in the session on their own, so the agent never polls.

## Install

```
/plugin install shepherdr --marketplace ramtinJ95/claude-mods
```

Requires Claude Code running inside Herdr, Node.js 22.18 or newer on `PATH`, and the Herdr Pi integration (`herdr integration install pi`). Install pi-shepherdr in the Pi workers too:

```
pi install npm:@howaboua/pi-shepherdr
```

Without it, messages still reach a worker, but through Herdr's terminal prompt, which can mix with text typed into that worker's editor. Results report which path was used as `delivery: "peer"` or `"terminal"`.

## What the agent gets

One tool, `agents`. Called with `{}` it returns the available profiles, request shapes and rules.

| Action | Result |
| --- | --- |
| `list` | Agents in this Herdr session, optionally filtered by `query` or `status`; watched ones are marked |
| `spawn` | Start a profiled Pi worker in a new tab (or `new_workspace`, or an existing `pane`) and give it a task |
| `assign` | Give an existing Pi agent a task whose result is needed |
| `send` | Deliver a message without waiting or watching |
| `answer` | Answer a worker's Pi Ask question by its `ask_id`, then wait for the worker to settle |
| `read` | The worker's latest reply, or its `visible` or `recent` terminal output |
| `watch` / `unwatch` | Start or stop reporting an agent's work |

`spawn` and `assign` wait for the worker's reply by default. With `blocking: false` they return at once, and the result arrives later as an `agent_report` message: added to a running turn, or starting a new turn when the session is idle. Watched agents also report questions, blockage and closed panes. Delegation keeps a watch until `unwatch` or the pane closes. Messages starting with `/` run as the worker's slash commands; `/quit` closes it.

A worker's Pi Ask question is reported with its `ask_id` and prompts. `answer` takes one entry per prompt, in order: `selections` with exact choice labels, `other` for a custom answer, and an optional `comment`. It types the answers into the Ask, checking the dialog at every step and stopping rather than guessing, then reports whether Pi recorded them: `accepted`, `rejected` or `unknown`. Retrying an answer Pi already recorded sends no input. Asks that run in the background while the worker continues are not answered through the tool; they wait in the worker's pane.

`/shepherdr` lists watched agents and restarts monitoring if it stopped. The status line shows how many are watched and working.

## Profiles

Profiles set a worker's model, thinking level, system prompt and optional message preparation. When pi-shepherdr is installed, its profiles in `~/.pi/agent/shepherdr/profiles/` are used, so both controllers launch the same agent types. Otherwise the bundled copies of its defaults are used: `general` for implementation, `explorer` for read-only discovery, `reviewer` for read-only review.

## Sessions and storage

Watches belong to one Claude Code session and survive resuming it. A fork starts with none. They are stored as plaintext JSON under `$XDG_DATA_HOME/claude-shepherdr/sessions/<session id>.json`, defaulting to `~/.local/share`.
