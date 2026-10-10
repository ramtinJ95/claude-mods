# shepherdr

Spawn, delegate to and monitor Pi agents running in [Herdr](https://herdr.dev) from Claude Code, on this machine or on Herdr's saved SSH machines. It is the Claude Code controller for [pi-shepherdr](https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/main/packages/pi-shepherdr): results of background work arrive in the session on their own, so the agent never polls.

## Install

```
/plugin install shepherdr --marketplace ramtinJ95/claude-mods
```

Requires Claude Code running inside Herdr, Node.js 22.18 or newer on `PATH`, and the Herdr Pi integration (`herdr integration install pi`). Install pi-shepherdr in the Pi workers too:

```
pi install npm:@howaboua/pi-shepherdr
```

Without it, messages still reach a worker, but through Herdr's terminal prompt, which can mix with text typed into that worker's editor, and the worker cannot list its commands. Results report which path was used as `delivery: "peer"` or `"terminal"`.

## What the agent gets

One tool, `agents`. Called with `{}` it returns the available profiles, request shapes and rules.

| Action | Result |
| --- | --- |
| `list` | Agents on this machine and every enabled remote machine, or on one `machine`, optionally filtered by `query` or `status`; watched ones are marked and unreachable machines listed |
| `spawn` | Start a profiled Pi worker in a new tab (or `new_workspace`, or an existing `pane`) and give it a task |
| `assign` | Give an existing Pi agent a task whose result is needed |
| `send` | Deliver a message without waiting or watching |
| `answer` | Answer a worker's Pi Ask question by its `ask_id` |
| `read` | The worker's latest reply, or its `visible` or `recent` terminal output |
| `watch` / `unwatch` | Start or stop reporting an agent's work |
| `{commands: true, target}` | The slash commands that worker accepts, without running any |

`spawn` and `assign` wait for the worker's reply by default. With `blocking: false` they return at once, and the result arrives later as an `agent_report` message: added before the running turn's next model request, or starting a new turn when the session is idle. Watched agents also report questions, blockage and closed panes; reports of failed or blocked workers say how to inspect and recover them. Delegation keeps a watch until `unwatch` or the pane closes. Messages starting with `/` run as the worker's slash commands; `/quit` closes it.

A worker's Pi Ask question is reported with its `ask_id` and prompts. A blocking question stops the worker; a background one (asked while it continues) is reported at once and the worker keeps going. `answer` takes one entry per prompt, in order: `selections` with exact choice labels, `other` for a custom answer, and an optional `comment`. It types the answers into the Ask, checking the dialog at every step and stopping rather than guessing, then reports what Pi recorded: `accepted`, `rejected`, or `unknown` when it differs from the answers sent. If Pi records nothing, the call fails instead. A blocking question's answer then waits for the worker to settle; a background one's returns at once. Retrying an answer Pi already recorded sends no input.

## Remote machines

Remote agents are those on the SSH machines saved in Herdr on the host running Claude Code (`herdr machine add`, `herdr machine list`). Pass the machine's ID from `list` as `machine` with every request about its agents; labels and hostnames are not accepted. Omitting `machine` means this machine.

Each machine needs `node` on its noninteractive SSH `PATH`, Herdr with the Pi integration and a running Herdr session. Shepherdr copies its bridge once per version to `~/.local/share/claude-shepherdr/bridge/` there and runs each operation over `ssh -o BatchMode=yes`; OpenSSH owns authentication and nothing keeps running except the monitor while agents there are watched. Profiles and their preparation run on this machine; a remote worker gets its profile prompt as text. A spawn on another machine without `workspace` opens a new workspace there.

## Orchestration mode

`/shepherdr orchestrate` tells the agent to orchestrate: fan out suitable work to agents, synthesize their results and report the outcome. `/shepherdr normal` switches back. Each switch reaches the model as one note without starting a turn, and the mode is restored after compaction and on resume.

## Status

`/shepherdr` lists watched agents, the saved machines and the orchestration mode, and restarts monitoring that stopped on any machine. The status line shows how many agents are watched and working.

## Profiles

Profiles set a worker's model, thinking level, system prompt and optional message preparation. When pi-shepherdr is installed, its profiles in `~/.pi/agent/shepherdr/profiles/` are used, so both controllers launch the same agent types. Otherwise the bundled copies of its defaults are used: `general` for implementation, `explorer` for read-only discovery, `reviewer` for read-only review.

## Sessions and storage

Watches and the orchestration mode belong to one Claude Code session and survive resuming it. A fork starts with none. After compaction, including a notes-compaction window, the agent is reminded of agents with assigned work before its next model request. State is stored as plaintext JSON under `$XDG_DATA_HOME/claude-shepherdr/sessions/<session id>.json`, defaulting to `~/.local/share`.
