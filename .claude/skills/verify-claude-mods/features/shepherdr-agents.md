# Shepherdr agents

shepherdr lets the agent spawn, delegate to and watch Pi and Claude Code workers in Herdr Core terminals through one `agents` tool, pushes their results back into the session without polling, and gives the user `/shepherdr` for status and orchestration mode.

## Sub-features

- `agents-help` returns profiles, request shapes and rules when `agents` is called with `{}`.
- `agents-list` lists agents on this machine, marking watched ones.
- `agents-spawn-claude` spawns a Claude Code worker from a bundled `claude-*` profile in a new tab (`delivery: "session"`); the call returns at once and the result arrives later as an `agent_report`.
- `agents-blocking` spawns or assigns with `blocking: true` and gets the worker's report as the call's result.
- `agents-answer` answers a worker's question; the call returns once the worker took it and the resumed work reports later.
- `agents-quit` closes a worker with the `/quit` message, without a `closed` report.
- `agents-resume` reopens a closed worker the session spawned when it is sent or assigned to (`resumed: true`, new target).
- `shepherdr-close-idle` closes the session's idle spawned workers with `/shepherdr close-idle` and names the ones left open.
- `shepherdr-status` shows watched agents, machines and the orchestration mode with `/shepherdr`.
- `shepherdr-orchestrate` switches modes with `/shepherdr orchestrate` and `/shepherdr normal`.

## How to get to it (user POV)

- Ask the agent to delegate work to an agent, list agents, or close one; it calls the `agents` tool.
- Type `/shepherdr`, `/shepherdr orchestrate`, `/shepherdr normal` or `/shepherdr close-idle`.
- Read the status line, which shows `shepherdr: <n> watched, <m> working` while agents are watched.

## Driving it with vmod

Preconditions:

- `RUN=$($V launch shepherdr)` and `$V doctor "$RUN"` pass. The instance runs in a Core terminal, in this session's Herdr space when it has one, so workers it spawns with `new_tab` open tabs there.
- Node.js 22.18 or newer on `PATH` (`node --version`).
- Pi journeys additionally need `pi` with pi-shepherdr installed; the Claude worker journeys below do not.

- **Status, empty.** Run `$V type "$RUN" /shepherdr`, `$V wait "$RUN" "Orchestration:"`, `$V snap "$RUN" shepherdr-status-01`. The row reads `Shepherdr watches no agents.`, lists saved machines (if any) and `Orchestration: off`.
- **Help.** Run `$V prompt "$RUN" "Call the agents tool with {} and list the profile names it returns, comma separated."`. The reply includes `claude-general`, `claude-explorer` and `claude-reviewer` (or your own profiles from `$XDG_CONFIG_HOME/claude-shepherdr/profiles`).
- **Spawn a Claude worker.** Run `$V prompt "$RUN" "Use the agents tool to spawn agent_type claude-explorer with placement new_tab, label 'verify worker', cwd set to the current directory, and message 'Reply with the first line of notes.txt and nothing else.' with blocking true. Quote its reply, plus the worker's target."`, then `$V snap "$RUN" agents-spawn-claude-01`. A new terminal appears in Core, and the reply quotes `alpha` with the worker's target (a terminal address such as `t3b`) and `delivery: "session"` in the tool result.
- **Second view.** Run `hc ls` from your own shell. The worker's terminal is listed with its name as a `claude-code` agent. Run `$V type "$RUN" /shepherdr` and `$V wait "$RUN" "Orchestration:"`. The worker is listed as watched with its status.
- **Quit.** Run `$V prompt "$RUN" "Use the agents tool to send '/quit' to that worker."`. The worker's terminal closes; `hc get <target>` reads `finished`, or fails with `not_found` once Core has dropped it.
- **Close idle and resume.** Spawn a second worker without `blocking`, wait for its `agent_report`, then run `$V type "$RUN" "/shepherdr close-idle"` and `$V wait "$RUN" "Closed 1 idle"`. Its terminal is gone and no `closed` report follows. Prompt the agent to assign that worker, by name, a question about its first task: the result carries `resumed: true` and a new target, and the reply shows it kept its session. Close it with `/quit`.
- **Orchestrate.** Run `$V type "$RUN" "/shepherdr orchestrate"` and `$V wait "$RUN" "Orchestration on."`, then `$V type "$RUN" "/shepherdr normal"` and `$V wait "$RUN" "Orchestration off."`.
- **Proof.** Run `$V snap "$RUN" shepherdr-orchestrate-01`, close any worker terminal still open (`hc kill <target>`, then `hc rm <target>`), then `$V cleanup "$RUN"`. `.verify/$RUN/transcript.jsonl` holds the spawn call and its result, and `data/claude-shepherdr/sessions/<session>.json` the watch state.

## Gotchas

- Workers are outside the run's terminal. `cleanup` does not close them, only lists the ones left; close each by the target the spawn reported, never by name or process.
- A spawned Claude worker loads your installed shepherdr, not the development build. To verify the worker side (`AskUserQuestion` answering), give it the dev build through a temporary Claude profile in `$XDG_CONFIG_HOME/claude-shepherdr/profiles` whose `claude_args` pass `--plugin-dir <repo>/plugins/shepherdr`, and remove that profile afterwards. A profile dir there replaces the bundled set while it exists.
- A worker started in a folder Claude Code has not trusted stops at the trust prompt and spawn reports that. The run's scratch folder is trusted at launch, so keep `cwd` there.
- A spawn with `blocking: true` (or a reviewer profile) waits up to the worker's settle; one `prompt` can take minutes. `prompt` caps at 5 minutes and reports a timeout, which does not prove the spawn failed: read the screen before retrying.
- Watch state and orchestration mode live under the run's `XDG_DATA_HOME`, so they start empty each run.
