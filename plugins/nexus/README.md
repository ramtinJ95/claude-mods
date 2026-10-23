# nexus

Drive [Nexus](https://github.com/ramtinJ95/nexus) from Claude Code instead of its dashboard. Nexus is a self-hosted control plane that runs coding agents in per-thread VMs (pylons) on home-lab nodes, with threads grouped by project. This mod gives you a live pane of those threads beside the chat, a `/nexus` command, and tools the session's model can call.

## Install

```
/plugin install nexus --marketplace ramtinJ95/claude-mods
```

Requires the Mac `nexus` CLI from the Nexus repository (`docs/cli.md` there is the contract this mod reads) on `PATH`, or its path in the mod's `cli` option (`/config`). The CLI owns the control plane's URL and proxy, so set those in its own config, not here. Every call goes through the CLI.

## The pane

`/nexus` opens it and asks for the keyboard. If the prompt keeps it, the pane says so: ctrl+x then tab, or a click, hands it the keys. It lists the threads by project, the most recently active first, each with whether its agent is working and how long ago anything happened. Archived threads are counted per project; `v` shows them. Press a thread's number (or Tab to it and Enter) to open it.

An open thread shows its status, its run (`working`, `idle` or `parked`), its pylon's state, queued messages and any pylon failure, then the tail of its conversation: your messages, the agent's replies and its tool calls, one line each with a mark for running, done or failed. Long runs of tool calls collapse to their last three under a count.

Keys in a thread: `m` writes a message (queued behind a running turn), `x` aborts the run after a `y`, `a` archives or unarchives, `r` restarts the watch, `b` goes back to the list, `q` closes the pane. Esc hands the keyboard back to the prompt and leaves the pane open.

When the control plane cannot be reached, the pane says so in red with the CLI's own message (a proxy that is down points to `ts-home status`) and keeps showing the last list it had.

While the pane is open it runs at most two CLI processes: one `nexus threads` poll every five seconds, skipped while the pane is behind another, and one `nexus watch` for the thread it shows. Both stop when the pane closes. The pane keeps updating while a turn runs, and `/nexus` runs at once rather than waiting for the turn to end.

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
pgrep -fl 'nexus.ts (watch|threads)'
```

While a thread is open there is one `watch`, and at most one `threads` poll, which comes and goes every five seconds. After the pane closes there are none.
