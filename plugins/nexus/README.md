# nexus

Drive [Nexus](https://github.com/ramtinJ95/nexus) from Claude Code instead of its dashboard. Nexus is a self-hosted control plane that runs coding agents in per-thread VMs (pylons) on home-lab nodes, with threads grouped by project. This mod gives you a live pane of those threads beside the chat, a `/nexus` command, and tools the session's model can call.

## Install

```
/plugin install nexus --marketplace ramtinJ95/claude-mods
```

Requires the Mac `nexus` CLI 0.3.0 or later from the Nexus repository (`docs/cli.md` there is the contract this mod reads) on `PATH`, or its path in the mod's `cli` option (`/config`). The CLI owns the control plane's URL and proxy, so set those in its own config, not here. Every call goes through the CLI.

## The pane

`/nexus` opens it on the thread whose agent is working (the newest, when several are), else on the thread list, and asks for the keyboard. If the prompt keeps it, the pane's bottom line says so: ctrl+x then tab, or a click, hands it the keys. Docked beside a fullscreen transcript it takes as much width as Claude Code gives a pane, 45% of the terminal, and the full height; above the prompt it takes the full width and at most 24 rows. A title bar at the top says where you are, and the bottom line shows the mode (`NORMAL`, `INSERT` or `FILTER`) and the keys that matter there.

### Keys

The pane is driven like vim. Claude Code gives a pane only plain letters and digits, with Shift folded in, so `G`, ctrl+d, ctrl+u, `/` and `?` are spelled `g e`, `d`, `u`, `f` and `s`. The arrows, Tab, Enter and clicks work too.

| Key | What it does |
| --- | --- |
| `j` `k` (↓ ↑) | Move the cursor: a thread, a menu entry, a port, or a block of the conversation |
| `g g`, `g e` | Top, bottom. In a conversation `g e` follows its end again |
| `d` `u` | Half a page down, up |
| `l` `h` | Open, back. In a thread they walk the tabs Conversation, Details and Ports, and `h` on Conversation goes back to the list with the cursor on the thread you left |
| Enter, `o` | Open or press what is under the cursor: a thread, a fold or tool call, a menu entry, a port to publish, a preview's URL to copy |
| `i` `a` | Write to the agent (insert mode). Enter sends, or queues behind a working run; an empty Enter or Esc is back to normal mode |
| `f` | Filter the list by title (filter mode). Enter keeps the filter, Esc clears it |
| `x` | Unpublish the preview under the cursor, in Ports |
| `y` | Copy what is under the cursor: a thread's ID, a block's text, a URL, the attach command |
| `m` | The Actions menu: abort, retry, retry the pylon, start again, archive, unarchive, copy the attach command, watch again, delete |
| `n` | Start a thread |
| `r` | Refresh, or watch the thread again |
| `s` | The key help, which `j`/`k`, `d`/`u` and `g g`/`g e` scroll when the pane is too short for it |
| `q` | Close the help or the menu, else the pane |

Esc in normal mode hands the keyboard back to the prompt and leaves the pane open.

### Views

- **Threads**, by project, newest first, with the archived and deleted ones folded under each project (Enter on the fold opens it). Each row has the thread's state as a coloured pill (working is cyan, failed is red) and how long ago it was active. The row under the cursor opens a line with its node, `wants paused` when the pylon is not yet where the control plane wants it, when you and the agent were last active, and its ID. The title bar counts the working and open threads and the nodes online.
- **A thread**, under a title bar with the project and title, a pill with the thread's state and the run's clock, the node, the model and when it started. Three tabs sit under it, with the Actions menu on `m`, and the composer is always at the bottom.
  - **Conversation**, drawn as a Claude Code transcript draws its own and filling upward from the composer: your messages after `❯`, the agent's answers after `⏺` in Markdown, each tool call as `⏺ Bash(npm test)` with its result after `⎿`, an edit as a coloured diff, and a failed command with its exit code. Four or more calls in a row fold into one line, such as `Read 4 files, ran 1 command`, which opens itself while a step runs or failed. A bar marks the block under the cursor, which `o` opens and `y` copies; `k` walks back through older blocks and the window holds still as new ones arrive below, until `g e` follows the end again. While the run works, `✻ Working… (1m 12s · 6 tools this turn)` ticks above the composer, the answer streams in, queued messages show under it and a running command shows its latest output. The pane draws a streaming answer at most ten times a second, however fast the CLI prints it. A very long thread keeps its newest 90,000 characters and says how many older blocks it left out.
  - **Details**: the pylon's wanted and observed state, its node, when it was last seen, the thread's outputs, its sessions, and the command to attach to them, which `y` copies.
  - **Ports**: each port once, as rows the cursor moves over. A port with a preview is under Previews, as the URL the CLI gives, which is a link while it can be opened (opening a paused one wakes it); Enter or `y` copies it. A port without one is under Ports, where Enter publishes it: the row says so while the CLI waits for the node to serve it, up to two minutes, then the port moves under Previews with its link and the cursor goes with it, or the row shows the CLI's error. A preview stays published, open to every device on the home tailnet, until you unpublish it with `x`: its row says `closing…` while the CLI runs, which can take two minutes when the pylon is paused and has to wake first, and then the port is back under Ports. `x` says why it can't when the preview is a declared service's, the thread is archived, or a publish is still under way. Publishing the port again may give it a new URL. A port a declared service owns without a preview cannot be published, so its row only names the service. When nothing listens, Ports says why a server may be missing: one bound only to `::1` can't be previewed, so bind it to 0.0.0.0 or 127.0.0.1.
- **Start a thread**, on `n`: a title, the project, the node and branch it boots (the project's own by default) and a first message. Start again in the Actions menu of a thread whose pylon failed opens it with that thread's project and title.

Delete in the Actions menu asks first, naming the thread, with Keep as the default. Opening an open thread counts as a visit, which wakes its paused pylon, as the dashboard's page does.

When the control plane cannot be reached, the pane says so in red with the CLI's own message (a proxy that is down points to `ts-home status`) and keeps showing what it had.

### The strip

One row above the prompt shows a chip for each open thread that wants a look, most urgent first: `needs you` for a failed pylon (or parked tasks, for the thread the pane watches), `new reply` for an answer you have not seen in the pane, then the working ones with how long since you last wrote. Enter on a chip, or a click, opens that thread in the pane. Seeing a thread in the pane marks its replies seen; that record is kept between sessions. `/nexus strip off` hides the strip and stops its poll, and `/nexus strip on` brings it back. It is on by default.

### The pane's background

Claude Code paints a docked pane's gutter and edges with the theme's `composerSidebarBackground`, grey under the built-in themes, and no element can clear it. The pane paints its own body with the terminal's black, and the mod ships a theme that makes the edges match: pick "Dark (ANSI), Nexus pane on the terminal background" in `/theme` (its setting value is `custom:nexus:nexus-dark-ansi`). It is the built-in Dark (ANSI) theme with that one colour changed. The pane says this once, the first time it opens.

### Processes

While the pane is open it runs at most two CLI processes: one poll every five seconds, `nexus threads` for the list or `nexus show` for the thread shown, skipped while the pane is behind another, and one `nexus watch` for that thread. Publishing a port adds one `nexus preview --wait` until the node serves it, and unpublishing one adds one `nexus unpreview` until the preview is gone. All of them stop when the pane closes. It also runs `nexus nodes` when it opens, on a refresh and with the details or the start form, and `nexus projects` with the start form. The strip adds one `nexus threads` every ten seconds while it is on, one at a time, and none while the pane is polling the list itself. The pane keeps updating while a turn runs, and `/nexus` runs at once rather than waiting for the turn to end.

## /nexus

```
/nexus                          open the pane
/nexus close                    close it
/nexus open <id>                show a thread in the pane
/nexus new <project> ["title"] <message>
/nexus send <id> <message>      queued behind a running turn
/nexus unpublish <port> [id]    close the preview of a port
/nexus archive|unarchive|abort|retry|retry-pylon|delete [id]
/nexus strip on|off             show or hide the threads above the prompt
```

An ID may be a unique prefix, with or without `th-` (`4f2a`, `th-4f2a`). Without one, an action takes the thread open in the pane. `new` takes its title from the quoted text after the project, else the message's first line. `unpublish` closes the preview a linked port was published as, as `x` does in Ports. `retry` runs a thread's parked tasks again, `retry-pylon` clears a failed pylon so it boots again, and `delete` names the thread and asks before it deletes, with Keep as the default.

## Tools for the model

| Tool | What it does |
| --- | --- |
| `mcp__nexus__threads` | Lists threads, optionally for one project |
| `mcp__nexus__start` | Starts a thread on a project with a first message and returns its ID |
| `mcp__nexus__send` | Sends a message to a thread's agent |
| `mcp__nexus__read` | A thread's state, the ports its pylon listens on with any preview's URL, and the last 6,000 characters of its conversation |
| `mcp__nexus__wait` | Waits until the agent has answered and gone idle, its pylon has failed or the thread can no longer run, or a timeout passes (default 300 s, at most 600), then returns its state and its reply to the latest message (null when that turn wrote none). When parked tasks or a failed pylon stop the thread, `needs_human` says which `/nexus retry` command you must run |
| `mcp__nexus__preview` | Publishes a port the pylon listens on as a preview and returns its URL once the node serves it, waiting up to two minutes. The preview stays published until it is unpublished |
| `mcp__nexus__unpublish` | Closes the preview a linked port was published as, waking a paused pylon first. A declared service's preview can't be closed |
| `mcp__nexus__archive` | Archives a thread |

The model cannot delete a thread or retry a pylon. Both are left to you as `/nexus delete` and `/nexus retry-pylon`, because a delete cannot be undone and a pylon retry acts on a VM. The tools wait behind ToolSearch until the model asks for them, so sessions that never touch Nexus carry no tool text for them.

## Troubleshooting

The pane's red line carries the CLI's own error. A proxy that is down points to `ts-home status`, and a missing CLI names the `cli` option.

To see the pane's processes, look for the CLI's script rather than `nexus`. The Nexus repository's `nexus` shim runs `node …/src/cli/nexus.ts`, so a process list shows that:

```
pgrep -fl 'nexus.ts (watch|threads|show|preview|unpreview)'
```

While a thread is open there is one `watch`, and at most one `show` poll, which comes and goes every five seconds; on the list, a `threads` poll instead. After the pane closes there are none but the strip's `threads` poll every ten seconds, which `/nexus strip off` stops.
