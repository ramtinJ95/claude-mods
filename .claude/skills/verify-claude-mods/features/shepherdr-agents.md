# Shepherdr agents

shepherdr lets the agent spawn, delegate to and watch Pi and Claude Code workers in Herdr through one `agents` tool, pushes their results back into the session without polling, and gives the user `/shepherdr` for status and orchestration mode.

## Sub-features

- `agents-help` returns profiles, request shapes and rules when `agents` is called with `{}`.
- `agents-list` lists agents on this machine, marking watched ones.
- `agents-spawn-claude` spawns a Claude Code worker from a bundled `claude-*` profile in a new tab and returns its reply (`delivery: "session"`).
- `agents-nonblocking` spawns with `blocking: false` and receives the result later as an `agent_report`.
- `agents-quit` closes a worker with the `/quit` message.
- `shepherdr-status` shows watched agents, machines and the orchestration mode with `/shepherdr`.
- `shepherdr-orchestrate` switches modes with `/shepherdr orchestrate` and `/shepherdr normal`.

## How to get to it (user POV)

- Ask the agent to delegate work to an agent, list agents, or close one; it calls the `agents` tool.
- Type `/shepherdr`, `/shepherdr orchestrate` or `/shepherdr normal`.
- Read the status line, which shows `shepherdr: <n> watched, <m> working` while agents are watched.

## Driving it with vmod

Preconditions:

- `RUN=$($V launch shepherdr)` and `$V doctor "$RUN"` pass. The instance runs inside Herdr in your workspace, so workers it spawns open tabs there.
- Node.js 22.18 or newer on `PATH` (`node --version`).
- Pi journeys additionally need `pi` with pi-shepherdr installed; the Claude worker journeys below do not.

- **Status, empty.** Run `$V type "$RUN" /shepherdr`, `$V wait "$RUN" "Orchestration:"`, `$V snap "$RUN" shepherdr-status-01`. The row reads `Shepherdr watches no agents.`, lists saved machines (if any) and `Orchestration: off`.
- **Help.** Run `$V prompt "$RUN" "Call the agents tool with {} and list the profile names it returns, comma separated."`. The reply includes `claude-general`, `claude-explorer` and `claude-reviewer` (or your own profiles from `$XDG_CONFIG_HOME/claude-shepherdr/profiles`).
- **Spawn a Claude worker.** Run `$V prompt "$RUN" "Use the agents tool to spawn agent_type claude-explorer with placement new_tab, label 'verify worker', cwd set to the current directory, and message 'Reply with the first line of notes.txt and nothing else.' Wait for its reply and quote it, plus the worker's pane ID."`, then `$V snap "$RUN" agents-spawn-claude-01`. A new tab appears in your workspace, and the reply quotes `alpha` with the worker's pane ID and `delivery: "session"` in the tool result.
- **Second view.** Run `herdr agent list` from your own shell. The worker's pane is listed as a `claude` agent. Run `$V type "$RUN" /shepherdr` and `$V wait "$RUN" "Orchestration:"`. The worker is listed as watched with its status.
- **Quit.** Run `$V prompt "$RUN" "Use the agents tool to send '/quit' to that worker."`. The worker's tab closes; `herdr pane get <worker pane>` returns `pane_not_found`.
- **Orchestrate.** Run `$V type "$RUN" "/shepherdr orchestrate"` and `$V wait "$RUN" "Orchestration on."`, then `$V type "$RUN" "/shepherdr normal"` and `$V wait "$RUN" "Orchestration off."`.
- **Proof.** Run `$V snap "$RUN" shepherdr-orchestrate-01`, close any worker tab still open (`herdr tab close <tab>`), then `$V cleanup "$RUN"`. `.verify/$RUN/transcript.jsonl` holds the spawn call and its result, and `data/claude-shepherdr/sessions/<session>.json` the watch state.

## Gotchas

- Workers are outside the run's tab. `cleanup` does not close them; close each worker tab by the pane or tab ID the spawn reported, never by name or process.
- A spawned Claude worker loads your installed shepherdr, not the development build. To verify the worker side (`AskUserQuestion` answering), give it the dev build through a temporary Claude profile in `$XDG_CONFIG_HOME/claude-shepherdr/profiles` whose `claude_args` pass `--plugin-dir <repo>/plugins/shepherdr`, and remove that profile afterwards. A profile dir there replaces the bundled set while it exists.
- A worker started in a folder Claude Code has not trusted stops at the trust prompt and spawn reports that. The run's scratch folder is trusted at launch, so keep `cwd` there.
- A spawn waits up to the worker's settle; one `prompt` can take minutes. `prompt` caps at 5 minutes and reports a timeout, which does not prove the spawn failed: read the screen before retrying.
- Watch state and orchestration mode live under the run's `XDG_DATA_HOME`, so they start empty each run.
