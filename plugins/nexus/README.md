# nexus

Drive [Nexus](https://github.com/ramtinJ95/nexus) from Claude Code instead of its dashboard. Nexus is a self-hosted control plane that runs coding agents in per-thread VMs (pylons) on home-lab nodes, with threads grouped by project. This mod gives you a live pane of those threads beside the chat, a `/nexus` command, and tools the session's model can call.

## Install

```
/plugin install nexus --marketplace ramtinJ95/claude-mods
```

Requires the Mac `nexus` CLI from the Nexus repository (`docs/cli.md` there is the contract this mod reads) on `PATH`, or its path in the mod's `cli` option (`/config`). The CLI owns the control plane's URL and proxy, so set those in its own config, not here. Every call goes through the CLI.

## The pane

`/nexus` opens it and asks for the keyboard. If the prompt keeps it, the pane says so: ctrl+x then tab, or a click, hands it the keys. Docked beside a fullscreen transcript it takes as much width as Claude Code gives a pane, 45% of the terminal; above the prompt it takes the full width. It draws with your theme's colours, and the engine scrolls it with the arrows while it has focus.

It does what the Nexus dashboard does, in four views:

- **Threads**, by project, newest first, with the archived and deleted ones folded under each project (Enter on the fold opens it). Each row says what the thread is doing (`agent working`, the pylon's state), its node, `wants paused` when the pylon is not yet where the control plane wants it, and how long ago you and the agent were last active. A line under the projects shows the nodes. `1` to `9` open a thread, `n` starts one, `f` filters by title (a filter opens the folds it matches), `r` refreshes, `q` closes.
- **A thread**, drawn as a Claude Code transcript draws its own: your messages after `❯`, the agent's answers after `⏺` in Markdown, each tool call as `⏺ Bash(npm test)` with its result after `⎿`, an edit as a coloured diff, and a failed command with its exit code. Four or more calls in a row fold into one line, such as `Read 4 files, ran 1 command`, which opens itself while a step runs or failed. Enter on a call shows all of it: the whole command, its other arguments and its output. While the run works, `✻ Working… (1m 12s · 6 tools this turn)` ticks above the prompt box, the answer streams in, queued messages show under it and a running command shows its latest output.
- **Details**, on `i`: the pylon's wanted and observed state, its node, when it was last seen, the previews (each a link while it can be opened; opening a paused one wakes it), the thread's outputs, its sessions, and the command to attach to them, which `c` copies.
- **Start a thread**, on `n`: a title, the project, the node and branch it boots (the project's own by default) and a first message. `s` on a thread whose pylon failed opens it with that thread's project and title.

Keys in a thread: `m` writes a message (Enter sends it, or queues it behind a run that is working; an empty Enter hands the keys back), `x` aborts the run, `t` retries parked tasks, `p` retries a failed pylon, `s` starts again, `a` archives, `u` unarchives, `d` deletes after asking (Keep is the default), `i` shows the details, `r` restarts the watch, `b` goes back, `q` closes. Esc hands the keyboard back to the prompt and leaves the pane open. Opening an open thread counts as a visit, which wakes its paused pylon, as the dashboard's page does.

When the control plane cannot be reached, the pane says so in red with the CLI's own message (a proxy that is down points to `ts-home status`) and keeps showing what it had.

While the pane is open it runs at most two CLI processes: one poll every five seconds, `nexus threads` for the list or `nexus show` for the thread shown, skipped while the pane is behind another, and one `nexus watch` for that thread. Both stop when the pane closes. It also runs `nexus nodes` when it opens, on a refresh and with the details or the start form, and `nexus projects` with the start form. The pane keeps updating while a turn runs, and `/nexus` runs at once rather than waiting for the turn to end.

## /nexus

```
/nexus                          open the pane
/nexus close                    close it
/nexus open <id>                show a thread in the pane
/nexus new <project> ["title"] <message>
/nexus send <id> <message>      queued behind a running turn
/nexus archive|unarchive|abort|retry|retry-pylon|delete [id]
```

An ID may be a unique prefix, with or without `th-` (`4f2a`, `th-4f2a`). Without one, an action takes the thread open in the pane. `new` takes its title from the quoted text after the project, else the message's first line. `retry` runs a thread's parked tasks again, `retry-pylon` clears a failed pylon so it boots again, and `delete` names the thread and asks before it deletes, with Keep as the default.

## Tools for the model

| Tool | What it does |
| --- | --- |
| `mcp__nexus__threads` | Lists threads, optionally for one project |
| `mcp__nexus__start` | Starts a thread on a project with a first message and returns its ID |
| `mcp__nexus__send` | Sends a message to a thread's agent |
| `mcp__nexus__read` | A thread's state and the last 6,000 characters of its conversation |
| `mcp__nexus__wait` | Waits until the agent has answered and gone idle, its pylon has failed or the thread can no longer run, or a timeout passes (default 300 s, at most 600), then returns its state and its reply to the latest message (null when that turn wrote none). When parked tasks or a failed pylon stop the thread, `needs_human` says which `/nexus retry` command you must run |
| `mcp__nexus__archive` | Archives a thread |

The model cannot delete a thread or retry a pylon. Both are left to you as `/nexus delete` and `/nexus retry-pylon`, because a delete cannot be undone and a pylon retry acts on a VM. The tools wait behind ToolSearch until the model asks for them, so sessions that never touch Nexus carry no tool text for them.

## Troubleshooting

The pane's red line carries the CLI's own error. A proxy that is down points to `ts-home status`, and a missing CLI names the `cli` option.

To see the pane's processes, look for the CLI's script rather than `nexus`. The Nexus repository's `nexus` shim runs `node …/src/cli/nexus.ts`, so a process list shows that:

```
pgrep -fl 'nexus.ts (watch|threads|show)'
```

While a thread is open there is one `watch`, and at most one `show` poll, which comes and goes every five seconds; on the list, a `threads` poll instead. After the pane closes there are none.
