# shepherdr

Spawn, delegate to and monitor Pi and Claude Code agents running in [Herdr](https://herdr.dev) Core terminals from Claude Code: Pi agents on this machine or on the machines added to its Core, Claude Code agents on this machine. It is the Claude Code controller for [pi-shepherdr](https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/main/packages/pi-shepherdr): results of background work arrive in the session on their own, so the agent never polls.

Ported from [pi-shepherdr](https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/main/packages/pi-shepherdr) by [howaboua](https://github.com/IgorWarzocha) in [howaboua-pi-stuff](https://github.com/IgorWarzocha/howaboua-pi-stuff); its bridge and profiles started as copies of that package.

## Install

```
/plugin install shepherdr --marketplace ramtinJ95/claude-mods
```

Requires Claude Code running in a Herdr Core terminal (a Herdr app window connected to Core, or `hc`), Herdr Core 0.1.18 or newer, and Node.js 22.18 or newer on `PATH`. The older Herdr TUI is no longer supported: start a fresh Claude Code in Core. Watches saved under the older Herdr report their agents closed. Install pi-shepherdr 0.2.25 or newer wherever Pi workers run:

```
pi install npm:@howaboua/pi-shepherdr
```

Pi workers need it: pi-shepherdr reports Pi's status and session to Core, which is how Shepherdr finds a Pi agent at all, and its receiver takes every message, past the editor and whatever is typed there (`delivery: "peer"`). A Pi without a receiver cannot be messaged: the call fails and says so, and nothing is typed into its terminal. Spawned workers start with its `--shepherdr-worker` flag, which tells their extensions to keep human-only features off. Pi refuses flags it does not know, so without pi-shepherdr a spawn fails and says why. A spawned Pi worker gets its first task once the receiver is up; one that publishes none within 30 seconds of starting is closed again and the spawn fails.

## What the agent gets

One tool, `agents`. Called with `{}` it returns the available profiles, request shapes and rules.

| Action | Result |
| --- | --- |
| `list` | Agents on this machine and every enabled remote machine, or on one `machine`, optionally filtered by `query` or `status`; watched ones are marked and unreachable machines listed |
| `spawn` | Start a profiled Pi or Claude Code worker in a new Core terminal and give it a task: a new tab beside this session, in another `workspace` (a Herdr space ID from `list`), a `new_workspace`, or a background `terminal` |
| `assign` | Give an existing Pi or Claude Code agent a task whose result is needed; a closed worker this session spawned is reopened first |
| `send` | Deliver a message without waiting or watching; it reopens a closed spawned worker too |
| `answer` | Answer a worker's question (Pi Ask or Claude Code's `AskUserQuestion`) by its `ask_id`; returns once the worker took the answer |
| `read` | The worker's latest reply, or its `visible` or `recent` terminal output |
| `watch` / `unwatch` | Start or stop reporting an agent's work |
| `{commands: true, target}` | The slash commands that worker accepts, without running any |

`spawn` and `assign` return once the task is delivered, as in pi-shepherdr, so several agents can be started one after another. The result arrives later as an `agent_report` message: added before the running turn's next model request, or starting a new turn when the session is idle. With `blocking: true` the call waits for the worker's reply instead; a profile's `blocking` setting overrides `spawn` (the bundled reviewers wait). Watched agents also report questions, blockage and closed terminals; reports of failed or blocked workers say how to inspect and recover them. Delegation keeps a watch until `unwatch` or the terminal closes. Messages starting with `/` run as the worker's slash commands; `/quit` closes it, and a worker this session closes that way ends its watch without a report.

Spawned workers are children of this session's terminal, so the Herdr window shows them beneath it, but they keep running when this Claude Code exits; close them with `/quit` or `/shepherdr close-idle`.

A worker this session spawned stays its own after it closes. `send` or `assign` to it, by its name or any terminal address it had, reopens its saved session in a new terminal before delivering, and the result says `resumed: true` with the new target. A Pi worker comes back with the model, thinking level and name its session saved; a Claude Code worker with its profile's arguments. `/quit` never reopens a worker. A worker whose profile opened an existing session (`--session`, `--resume`, `--continue` and the like) is not kept this way, and a name belongs to the newest worker that had it.

A worker's Pi Ask question is reported with its `ask_id` and Ask's own question text (prompts, for an older Ask). A blocking question stops the worker; a background one (asked while it continues) is reported at once and the worker keeps going. `answer` takes one entry per prompt, in order: `selections` with exact choice labels, `other` for a custom answer, and an optional `comment`. Pi Ask takes the answers directly through the worker's Shepherdr receiver and reports `accepted` or why it refused them; an Ask too old to publish its question that way is answered by the user in the worker's terminal. A handoff, an action only the user can take, is reported for the user to complete in the worker's terminal. `answer` returns once the worker took the answers; the work it resumes is reported through its watch. Retrying an answer Pi already recorded sends no input.

## Claude Code workers

Claude Code agents in Core terminals on this machine are workers too: spawned from a Claude profile or any Claude Code session already running there with this mod. Claude Code reports its own status to Core; the mod labels the terminal with its session ID, which is how a controller finds it. Tasks and messages arrive through Claude Code's own cross-session messages (`delivery: "session"`), so they show in the worker as a message from another session, never as typed input. Slash commands are typed into the worker when it is idle; `/quit` exits Claude Code and closes its terminal.

The worker needs this mod installed too. When it asks with `AskUserQuestion`, the question is reported like a Pi Ask, and `answer` settles the dialog in its place; whoever answers first, the person in the worker's terminal or the controller, wins. `selections` and `other` join into the question's answer and `comment` becomes its note. The status reported is what the worker recorded.

Spawned Claude Code workers accept their controller's messages whatever either side's permission mode, so tasks are never held for approval in the worker's terminal. A profile's own `--settings` (inline JSON or an absolute path) is merged in; setting `crossSessionInbound` there overrides this, as does managed policy. A Claude Code worker also stops at its folder trust prompt in a folder it has not been trusted in; spawn reports that instead of starting it.

## Remote machines

Remote agents are those on the machines added to the Core this Claude Code runs in (`hc machine add`, `hc machine ls`). Pass the machine's exact name or its stable ID from `list` as `machine` with every request about its agents; hostnames are not accepted, and a duplicated name needs the ID. Omitting `machine` means this machine. A machine that is not connected is listed as unavailable; reconnect it in Herdr.

Each machine needs Herdr Core, Node.js and Pi with pi-shepherdr. Core runs everything there: Shepherdr copies its bridge once per version to `~/.local/share/claude-shepherdr/bridge/` on the machine and runs each operation with `hc exec --on`, so Core owns the connection and its authentication. Status changes arrive through this Core's event stream; transcripts there are watched by short runs of the bridge that end at the first write. Profiles and their preparation run on this machine; a remote worker gets its profile prompt as text, formatting intact. A spawn on another machine runs as a background terminal unless given `workspace` (a space on that machine) or `new_workspace`.

## Orchestration mode

`/shepherdr orchestrate` tells the agent to orchestrate: fan out suitable work to agents, synthesize their results and report the outcome. `/shepherdr normal` switches back. Each switch reaches the model as one note without starting a turn, and the mode is restored after compaction and on resume.

## Status

`/shepherdr` lists watched agents, Core's machines and their connection state, and the orchestration mode, and restarts monitoring that stopped on any machine. The status line shows how many agents are watched and working.

`/shepherdr close-idle` closes the idle workers this session spawned and says which it left open and why. A worker with a blocking call waiting on it, a task whose result is still owed, or work running stays open, as does one that moved to another session; attached and merely watched agents are never touched. A Pi worker quits only if it is idle when its receiver takes the request. A Claude Code worker is checked, then sent `/exit`, so a message arriving in between is lost with the session. Closed workers send no report and can be reopened by `send` or `assign`.

## Profiles

Profiles set a worker's model, thinking level, prompt and optional message preparation. A Pi profile's prompt briefs the worker's first task rather than its system prompt, as in pi-shepherdr 1.0, so the worker can be given other work later. When pi-shepherdr is installed, its profiles in `~/.pi/agent/shepherdr/profiles/` are used, so both controllers launch the same agent types. Otherwise the bundled copies of its defaults are used: `general` for implementation, `explorer` for read-only discovery, `reviewer` for read-only review.

Claude Code profiles are separate, since pi-shepherdr does not read their fields. The bundled `claude-general`, `claude-explorer` and `claude-reviewer` mirror the Pi set on Claude Opus 5.5 with high effort in auto mode. To change them, put your own profiles in `$XDG_CONFIG_HOME/claude-shepherdr/profiles/` (default `~/.config`), which then replaces the bundled set. Each profile is a folder holding `profile.json`:

```json
{
	"description": "General implementation",
	"model": "claude-opus-5-5",
	"other_models": ["claude-fable-5-2"],
	"effort": "high",
	"permission_mode": "auto",
	"prompt": "prompt.md",
	"claude_args": []
}
```

`prompt` is appended to Claude Code's system prompt; `blocking`, `accepts` and `prepare` work as in Pi profiles, and `claude_args` are passed to `claude` as given.

A worker runs on its profile's `model`. `other_models` lists the models a `spawn` may name instead with its `model` field, which the agent is told to pass only when you explicitly ask for that model; any other name is refused. The worker keeps the profile's effort and other settings, and a reopened worker keeps the model it was spawned with. The bundled profiles offer Claude Fable 5.2 this way.

## Sessions and storage

Watches, the workers the session spawned and the orchestration mode belong to one Claude Code session and survive resuming it. A fork starts with none. After compaction, including a notes-compaction window, the agent is reminded of the agents it watches, idle ones included, each with its first task and latest instruction, before its next model request. State, including the arguments that reopen a spawned worker, is stored as plaintext JSON under `$XDG_DATA_HOME/claude-shepherdr/sessions/<session id>.json`, defaulting to `~/.local/share`.
