import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type {
  NexusCatalog,
  NexusFailure,
  NexusList,
  NexusPane,
  NexusPortChange,
  NexusPreview,
  NexusRunState,
  NexusShown,
  NexusStartDraft,
  NexusThread,
  NexusThreadRow,
  NexusWatch,
} from '../types'
import {
  ACTIONS,
  type Action,
  type Reply,
  FULL_ID,
  NO_CHANGE,
  USAGE,
  type WatchEntry,
  type WatchEvent,
  ago,
  applyEvent,
  closedKey,
  isSettled,
  foldReply,
  leftOut,
  matchThread,
  parseCommand,
  parseDetail,
  parseFailure,
  parseNodes,
  parsePreview,
  parseProjects,
  parseStarted,
  parseThreads,
  parseWatchEvent,
  sentence,
  transcript,
} from './model'
import { needsHuman, portFacts, TOOLS } from './tools'
import { COMPOSE, type Draw, FILTER, ListView, type PaneActions, type Scene, StartView, ThreadView } from './view'

const PANE = 'nexus'
const POLL_MS = 5_000
/** How often the run clock ticks while the thread shown is working. */
const TICK_MS = 1_000
/** A `$.process.run` of the CLI: its own requests give up after 30 s without data, and `start` makes two. */
const RUN_MS = 70_000
const READ_CHARS = 6_000
const REPLY_CHARS = 4_000
/**
 * The most often the pane's watch writes what it read: a streaming answer prints a `live` event ten times a second,
 * and each write redraws the pane. The first event after a quiet spell is written at once.
 */
const FLUSH_MS = 100

const listAtom = atom({ plugin: 'nexus', key: 'list' } as const, { threads: null, failure: null, polledAt: null })
const WATCH = { plugin: 'nexus', key: 'watch' } as const
const watchAtom = atom(WATCH, null)
const LIVE = { plugin: 'nexus', key: 'live' } as const
const liveAtom = atom(LIVE, null)
const SHOWN = { plugin: 'nexus', key: 'shown' } as const
const shownAtom = atom(SHOWN, null)
const catalogAtom = atom({ plugin: 'nexus', key: 'catalog' } as const, { projects: null, nodes: null, nodesFailure: null, projectsFailure: null })
const NOW = { plugin: 'nexus', key: 'now' } as const
const nowAtom = atom(NOW, 0)
const paneAtom = atom({ plugin: 'nexus', key: 'pane' } as const, {
  view: 'list',
  selected: null,
  field: 'none',
  toggled: {},
  filter: '',
  draft: '',
  start: null,
  notice: null,
  portChanges: {},
  isPickingPreview: false,
})

/** The CLI to run, from the `cli` option. */
let cli = 'nexus'
/**
 * The pane's two processes at most: one poll at a time, of `threads` for the list or `show` for the thread shown,
 * and one watch of that thread. The ticker only reads the watch's state, to move the run clock while it works.
 */
let poller: { timer: Timer; ticker: Timer; isBusy: boolean; stop: () => void; stopped: Promise<void> } | undefined
/** The second ask for the keyboard after `/nexus`, cancelled when the pane closes first. */
let refocus: Timer | undefined
let watcher: { thread: string; stop: () => void } | undefined
/** The thread whose visit is still to be recorded, once its first `show` says whether it is open. */
let visit: string | undefined
/** Start submissions so far, which number each form's `request`. */
let starts = 0
/**
 * Orders each port change's confirmation and each `show` asked for, exactly where a clock could give two the same
 * millisecond: a `show` asked for after a confirmation lists what it confirmed, or what changed since.
 */
let sequence = 0

type Outcome<T> = { ok: true; value: T } | { ok: false; failure: NexusFailure }

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
const failed = (message: string): Outcome<never> => ({ ok: false, failure: { kind: 'failed', message } })
const couldNotRun = (error: unknown) =>
  `could not run ${cli} (${messageOf(error)}); install the Nexus CLI or set its path in the nexus plugin's cli option`

/** One CLI command with `--json` after its name: its parsed stdout, or how it failed. */
async function nexus($: EngineInterface, args: readonly string[]): Promise<Outcome<unknown>> {
  let ran: Awaited<ReturnType<EngineInterface['process']['run']>>
  try {
    ran = await $.process.run([cli, args[0]!, '--json', ...args.slice(1)], { timeoutMs: RUN_MS })
  } catch (error) {
    return failed(couldNotRun(error))
  }
  if (ran.exitCode !== 0) return { ok: false, failure: parseFailure(ran.exitCode, ran.stderr) }
  try {
    return { ok: true, value: JSON.parse(ran.stdout) }
  } catch {
    return failed(`nexus ${args[0]} printed something that is not JSON`)
  }
}

function threadsFrom(got: Outcome<unknown>): Outcome<NexusThreadRow[]> {
  if (!got.ok) return got
  try {
    return { ok: true, value: parseThreads(got.value) }
  } catch (error) {
    return failed(messageOf(error))
  }
}

async function listThreads($: EngineInterface, project?: string): Promise<Outcome<NexusThreadRow[]>> {
  return threadsFrom(await nexus($, ['threads', ...(project ? [`--project=${project}`] : [])]))
}

/** `parse` over a command's JSON, its throw a failure. */
function parsed<T>(got: Outcome<unknown>, parse: (json: unknown) => T): Outcome<T> {
  if (!got.ok) return got
  try {
    return { ok: true, value: parse(got.value) }
  } catch (error) {
    return failed(messageOf(error))
  }
}

type ChildEnd = { by: 'taker' } | { by: 'stop' } | { by: 'exit'; failure: NexusFailure | null }

/**
 * Runs the CLI as a child and hands its stdout to `take`, piece by piece, until `take` answers true, `stop` settles
 * or the child exits. Leaving the loop kills the child, even while a read is pending, so a stop ends it at once.
 */
async function runChild(
  $: EngineInterface,
  argv: readonly string[],
  take: (text: string) => boolean | Promise<boolean>,
  stop: Promise<void>,
): Promise<ChildEnd> {
  const child = $.process.spawn({ argv: [cli, ...argv] })
  const stopped = stop.then(() => 'stop' as const)
  let stderr = ''
  try {
    for (;;) {
      const pull = child.next()
      // A pull the stop outran settles after the loop has gone; nothing reads it.
      pull.catch(() => undefined)
      const got = await Promise.race([pull, stopped])
      if (got === 'stop') return { by: 'stop' }
      if (got.done) return { by: 'exit', failure: got.value.code === 0 ? null : parseFailure(got.value.code ?? 1, stderr) }
      if (got.value.stream === 'stderr') stderr += got.value.text
      else if (await take(got.value.text)) return { by: 'taker' }
    }
  } catch (error) {
    return { by: 'exit', failure: { kind: 'failed', message: couldNotRun(error) } }
  } finally {
    void child.return(undefined as never).catch(() => undefined)
  }
}

/**
 * Runs `nexus watch <thread> --json` and hands each event to `take` until it answers true, `stop` settles or the
 * child exits. The exit is clean (no failure) after the thread's deletion; a line that breaks the contract ends the
 * watch with a failure that says so.
 */
async function followWatch(
  $: EngineInterface,
  thread: string,
  take: (event: WatchEvent) => boolean | Promise<boolean>,
  stop: Promise<void>,
): Promise<ChildEnd> {
  let pending = ''
  let broken: NexusFailure | undefined
  const end = await runChild(
    $,
    ['watch', thread, '--json'],
    async text => {
      pending += text
      const lines = pending.split('\n')
      pending = lines.pop()!
      for (const line of lines) {
        let event: WatchEvent | undefined
        try {
          event = parseWatchEvent(line)
        } catch (error) {
          broken = { kind: 'failed', message: messageOf(error) }
          return true
        }
        if (event && (await take(event))) return true
      }
      return false
    },
    stop,
  )
  return broken ? { by: 'exit', failure: broken } : end
}

/** One CLI command as a child `stop` kills, such as a poll of the pane: a closed pane leaves none running. Undefined once stopped. */
async function childJson($: EngineInterface, argv: readonly string[], stop: Promise<void>): Promise<Outcome<unknown> | undefined> {
  let stdout = ''
  const end = await runChild(
    $,
    [argv[0]!, '--json', ...argv.slice(1)],
    text => {
      stdout += text
      return false
    },
    stop,
  )
  if (end.by !== 'exit') return undefined
  if (end.failure) return { ok: false, failure: end.failure }
  try {
    return { ok: true, value: JSON.parse(stdout) }
  } catch {
    return failed(`nexus ${argv[0]} printed something that is not JSON`)
  }
}

/** A promise `stop()` settles, for `runChild`. */
function stopper() {
  let stop = () => {}
  const promise = new Promise<void>(resolve => {
    stop = resolve
  })
  return { promise, stop }
}

/**
 * The thread open in the pane, watched until the pane leaves it. Events for a thread no longer shown are dropped.
 * What it reads is gathered and written at most every `FLUSH_MS`, in order.
 */
function watchInPane($: EngineInterface, thread: string) {
  watcher?.stop()
  const { promise, stop } = stopper()
  /** What this watch has written: only it writes the watch while it is the current one, so it needs no read back. */
  let watched: NexusWatch = { thread, rows: [], dropped: 0, state: null, model: null, outage: null, ended: null }
  let gathered: WatchEvent[] = []
  /** The write about to run, and the wait after a write during which events only gather. */
  let soon: Timer | undefined
  let cooling: Timer | undefined
  // A stopped watch may still hold lines it read: only the current one writes, so a rewatch of the same thread
  // never takes an older reader's entries or its exit.
  const mine = {
    thread,
    stop: () => {
      if (watcher === mine) watcher = undefined
      soon?.cancel()
      cooling?.cancel()
      stop()
    },
  }
  watcher = mine
  // The rows and state, then the newest live event, which stands for the others, are sent with no wait between
  // them, so no drawing reads one without the other: the CLI prints an answer's entry before the live event that
  // drops it from `partial`, and a drawing between the two writes would show the answer twice.
  const write = () => {
    soon?.cancel()
    soon = undefined
    const events = gathered
    gathered = []
    cooling = $.clock.after(FLUSH_MS, () => {
      cooling = undefined
      if (gathered.length > 0) void write()
    })
    if (watcher !== mine) return Promise.resolve()
    const rows = events.filter(event => event.type !== 'live')
    const live = events.findLast((event): event is Extract<WatchEvent, { type: 'live' }> => event.type === 'live')
    watched = rows.reduce(applyEvent, watched)
    return Promise.all([rows.length > 0 && $.state.set(WATCH, watched), live && $.state.set(LIVE, { thread, live: live.live })])
  }
  void (async () => {
    await Promise.all([$.state.set(WATCH, watched), $.state.set(LIVE, null)])
    const end = await followWatch(
      $,
      thread,
      event => {
        if (watcher !== mine) return true
        gathered.push(event)
        // A changed state may come with changed details: the pylon, its previews and ports, the parked tasks.
        if (event.type === 'state') void poll($)
        // A zero wait lets the rest of the lines read with this one join its write.
        if (!soon && !cooling) soon = $.clock.after(0, () => void write())
        return false
      },
      promise,
    )
    const last = write()
    cooling?.cancel()
    await last
    if (watcher !== mine || end.by !== 'exit') return
    watcher = undefined
    watched = { ...watched, ended: end.failure ? `The watch stopped: ${sentence(end.failure.message)} r watches again.` : 'The thread was deleted.' }
    await $.state.set(WATCH, watched)
  })()
}

function stopPane() {
  poller?.timer.cancel()
  poller?.ticker.cancel()
  poller?.stop()
  poller = undefined
  refocus?.cancel()
  refocus = undefined
  watcher?.stop()
}

/**
 * One poll of what the pane shows, skipped while one runs or the pane is behind another: `threads` for the list,
 * `show` for a thread. The pane gone stops every process. Closing the pane kills a poll in flight, and one that
 * ends as the pane closes writes nothing.
 */
async function poll($: EngineInterface) {
  const current = poller
  if (!current || current.isBusy) return
  current.isBusy = true
  try {
    const pane = (await $.ui.panes()).find(one => one.id === PANE)
    if (!pane) return stopPane()
    if (!pane.isShown) return
    const { view, selected } = await read($, paneAtom)
    if (view === 'start') return
    const thread = view === 'list' ? null : selected
    sequence += 1
    const askedSeq = sequence
    const got = await childJson($, thread ? ['show', thread] : ['threads', '--all'], current.stopped)
    const now = await $.clock.now()
    if (!got || poller !== current) return
    await $.state.set(NOW, now)
    if (!thread) {
      const threads = threadsFrom(got)
      await update($, listAtom, (list): NexusList => (threads.ok ? { threads: threads.value, failure: null, polledAt: now } : { ...list, failure: threads.failure }))
      return
    }
    const detail = parsed(got, parseDetail)
    if ((await read($, paneAtom)).selected !== thread) return
    if (detail.ok) void recordVisit($, detail.value.thread)
    await update($, shownAtom, (shown): NexusShown =>
      detail.ok
        ? { thread, detail: detail.value, askedSeq, failure: null }
        : shown?.thread === thread
          ? { ...shown, failure: detail.failure }
          : { thread, detail: null, askedSeq, failure: detail.failure },
    )
  } finally {
    current.isBusy = false
  }
}

/** Moves the run clock while the thread shown works, so its timer and spinner tick. */
async function tick($: EngineInterface) {
  const watch = await read($, watchAtom)
  if (watch?.state?.run === 'working') await $.state.set(NOW, await $.clock.now())
}

/** `projects` and `nodes` for the start form, the list's nodes line and the previews' links. */
async function loadCatalog($: EngineInterface, wanted: { projects: boolean }) {
  const [nodes, projects] = await Promise.all([
    nexus($, ['nodes']).then(got => parsed(got, parseNodes)),
    wanted.projects ? nexus($, ['projects']).then(got => parsed(got, parseProjects)) : undefined,
  ])
  await update($, catalogAtom, (catalog): NexusCatalog => ({
    ...catalog,
    ...(nodes.ok ? { nodes: nodes.value, nodesFailure: null } : { nodesFailure: nodes.failure }),
    ...(projects ? (projects.ok ? { projects: projects.value, projectsFailure: null } : { projectsFailure: projects.failure }) : {}),
  }))
}

/** Starts what an open pane needs, keeping what runs: the poll, polled now, the ticker and the watch of the thread it shows. */
async function startPane($: EngineInterface) {
  if (!poller) {
    const { promise, stop } = stopper()
    poller = {
      timer: $.clock.every(POLL_MS, () => void poll($)),
      ticker: $.clock.every(TICK_MS, () => void tick($)),
      isBusy: false,
      stop,
      stopped: promise,
    }
    void loadCatalog($, { projects: false })
    // A port's CLI ran under the poller before this one, or the module before a reload: none is under way now.
    await update($, paneAtom, pane => ({ ...pane, portChanges: {} }))
  }
  void poll($)
  const { selected, view } = await read($, paneAtom)
  if (selected && view !== 'list' && watcher?.thread !== selected) watchInPane($, selected)
}

/**
 * The dock is as wide as the engine allows, at most 45% of the terminal, so the conversation reads like the
 * transcript beside it. Seated above the prompt, the pane takes the full width.
 */
const OPEN = { id: PANE, title: 'Nexus', focus: true, columns: 200 } as const
/** How long after `/nexus` the pane asks for the keys again, once the composer has let go of the command line. */
const REFOCUS_MS = 300

/** Asks for the keyboard again, only for a pane still open and not yet focused: a closed one stays closed. */
async function refocusPane($: EngineInterface) {
  refocus = undefined
  const pane = (await $.ui.panes()).find(one => one.id === PANE)
  if (pane && !pane.isFocused) await $.ui.open(OPEN)
}

async function openPane($: EngineInterface): Promise<string> {
  const opened = await $.ui.open(OPEN)
  await startPane($)
  if (!opened.isPlaced) return ` It is not shown yet: ${opened.reason}.`
  // `focus` is only granted over an empty composer, which an immediate command may still be clearing. Asking once
  // more is refused in turn if the person has started typing, so it never takes keys they are using.
  const pane = (await $.ui.panes()).find(one => one.id === PANE)
  if (pane?.isFocused) return ''
  refocus?.cancel()
  refocus = $.clock.after(REFOCUS_MS, () => void refocusPane($))
  return ''
}

async function setPane($: EngineInterface, change: (pane: NexusPane) => Partial<NexusPane>) {
  await update($, paneAtom, pane => ({ ...pane, notice: null, ...change(pane) }))
}

/** The pane showing `thread`, keeping what the person opened and closed in it when it was shown already. */
const threadView = (pane: NexusPane, thread: string): Partial<NexusPane> => ({
  view: 'thread',
  selected: thread,
  field: 'none',
  draft: '',
  start: null,
  notice: null,
  toggled: pane.selected === thread ? pane.toggled : {},
})

/** Shows a thread: its watch, and its details polled, the first of which records the visit as the dashboard's page does. */
async function showThread($: EngineInterface, thread: string) {
  await setPane($, pane => threadView(pane, thread))
  await followThread($, thread)
}

/** What the thread just shown runs: its details polled afresh and its watch, while the pane is open. */
async function followThread($: EngineInterface, thread: string) {
  const shown = await read($, shownAtom)
  if (shown?.thread !== thread) await $.state.set(SHOWN, null)
  // The person may have moved on during those awaits: only the thread still shown is followed.
  const pane = await read($, paneAtom)
  if (pane.selected !== thread || pane.view === 'list' || pane.view === 'start') return
  visit = thread
  // A closed pane watches nothing: opening it again starts the watch of the thread it shows.
  if (poller) watchInPane($, thread)
  void poll($)
}

/** Records a visit to an open thread as human activity, which wakes its paused pylon; a closed one's stays paused. */
async function recordVisit($: EngineInterface, thread: NexusThread) {
  if (visit !== thread.id) return
  visit = undefined
  if (thread.status !== 'active' && thread.status !== 'idle') return
  const woken = await nexus($, ['wake', thread.id])
  if (!woken.ok) await setPane($, () => ({ notice: { text: `This visit was not recorded, so a paused pylon stays paused: ${sentence(woken.failure.message)}`, tone: 'error' } }))
}

/** A full thread ID for `arg`: as given, else the one thread whose ID starts with it, from the last poll or a fresh one. */
async function resolveThread($: EngineInterface, arg: string): Promise<Outcome<string>> {
  if (FULL_ID.test(arg)) return { ok: true, value: arg }
  const cached = (await read($, listAtom)).threads
  const first = cached ? matchThread(arg, cached) : { unknown: true as const }
  if ('id' in first) return { ok: true, value: first.id }
  if ('error' in first) return failed(first.error)
  const got = await listThreads($)
  if (!got.ok) return got
  const found = matchThread(arg, got.value)
  if ('id' in found) return { ok: true, value: found.id }
  return failed('error' in found ? found.error : `no thread starts with ${arg}`)
}

const titleOf = async ($: EngineInterface, id: string) =>
  (await read($, listAtom)).threads?.find(thread => thread.id === id)?.title

/** The thread's title from the last poll, else from a fresh list: a confirmation must name what it removes. */
async function lookUpTitle($: EngineInterface, id: string): Promise<string | undefined> {
  const cached = await titleOf($, id)
  if (cached) return cached
  const got = await listThreads($)
  return got.ok ? got.value.find(thread => thread.id === id)?.title : undefined
}

/** The thread an action names, else the one the pane shows. */
async function targetOf($: EngineInterface, arg: string | undefined): Promise<Outcome<string>> {
  if (arg) return resolveThread($, arg)
  const { selected } = await read($, paneAtom)
  return selected ? { ok: true, value: selected } : failed('name a thread, or open one in the pane first')
}

/** `nexus preview <thread> <port> --wait`: the port published, and its preview once the node serves it. Undefined once stopped. */
async function previewPort($: EngineInterface, thread: string, port: number, stop: Promise<void>): Promise<Outcome<NexusPreview> | undefined> {
  const got = await childJson($, ['preview', thread, String(port), '--wait'], stop)
  return got && parsed(got, json => parsePreview(json, 'preview'))
}

/** `nexus unpreview <thread> <port>`: the port's linked preview closed, waking a paused pylon first. Undefined once stopped. */
async function unpreviewPort($: EngineInterface, thread: string, port: number, stop: Promise<void>): Promise<Outcome<null> | undefined> {
  const got = await childJson($, ['unpreview', thread, String(port)], stop)
  if (!got || got.ok) return got && { ok: true, value: null }
  // A CLI before 0.3.0 has no unpreview, and says only that it does not know the command.
  if (got.failure.message === 'unknown command unpreview') {
    return { ok: false, failure: { kind: got.failure.kind, message: `${cli} has no unpreview command: unpublishing a preview needs Nexus CLI 0.3.0 or later (nexus --version)` } }
  }
  return got
}

/**
 * Publishes or unpublishes a port of the thread shown, saying so while the CLI runs, then what it did until the
 * details show it, or why it failed. A port with an operation under way takes no other: the pane offers none.
 * Closing the pane kills the CLI; the port changes or is refused all the same.
 */
async function changePort($: EngineInterface, port: number, action: 'open' | 'close') {
  const current = poller
  const { selected } = await read($, paneAtom)
  if (!current || !selected) return
  const key = String(port)
  const write = (change: (was: NexusPortChange) => NexusPortChange) =>
    update($, paneAtom, (pane): NexusPane => {
      const ports = pane.portChanges[selected] ?? {}
      return { ...pane, portChanges: { ...pane.portChanges, [selected]: { ...ports, [key]: change(ports[key] ?? NO_CHANGE) } } }
    })
  // Whether the port is free and this operation takes it are one update, so two presses never both start.
  let isStarted = false
  await write(was => {
    isStarted = !was.pending
    return isStarted ? { ...was, pending: action, failure: null } : was
  })
  if (!isStarted) return
  const got = action === 'open' ? await previewPort($, selected, port, current.stopped) : await unpreviewPort($, selected, port, current.stopped)
  if (!got) return write(was => ({ ...was, pending: null }))
  if (!got.ok) return write(was => ({ ...was, pending: null, failure: { action, message: sentence(got.failure.message) } }))
  sequence += 1
  const seq = sequence
  await write(() => ({ confirmed: { preview: got.value, seq }, pending: null, failure: null }))
  // The details list the port afresh: under Previews once opened, under Ports once closed.
  void poll($)
}

async function act($: EngineInterface, action: Action, id: string): Promise<Outcome<string>> {
  const got = await nexus($, [action, id])
  if (!got.ok) return got
  void poll($)
  const title = await titleOf($, id)
  return { ok: true, value: `${ACTIONS[action]} ${id}${title ? ` (${title})` : ''}.` }
}

/** Deletes a thread once the person says so, naming what it removes. Keep comes first: the dialog's default is the harmless answer. */
async function confirmDelete($: EngineInterface, id: string): Promise<Outcome<string>> {
  const title = await lookUpTitle($, id)
  const question = `${title ? `"${title}" (${id})` : id} and its pylon and conversation will be removed. Delete it?`
  const answer = await $.ui.ask(question, ['Keep', 'Delete']).catch(() => 'Keep')
  return answer === 'Delete' ? act($, 'delete', id) : { ok: true, value: `Kept ${id}.` }
}

/** A command's reply. The transcript heads it with the plugin's name, so a failure is its message alone. */
const say = (outcome: Outcome<string>) =>
  outcome.ok ? outcome.value : sentence(outcome.failure.message.replace(/^./, first => first.toUpperCase()))

async function send($: EngineInterface, id: string, text: string): Promise<Outcome<string>> {
  // `--` keeps a message that starts with a dash from reading as a flag.
  const got = await nexus($, ['send', id, '--', text])
  return got.ok ? { ok: true, value: `Sent to ${id}.` } : got
}

type StartFields = { project: string; title?: string | undefined; message?: string | undefined; node?: string | undefined; branch?: string | undefined }

async function start($: EngineInterface, fields: StartFields) {
  const got = await nexus($, [
    'start',
    `--project=${fields.project}`,
    ...(fields.title ? [`--title=${fields.title}`] : []),
    ...(fields.message ? [`--message=${fields.message}`] : []),
    ...(fields.node ? [`--node=${fields.node}`] : []),
    ...(fields.branch ? [`--branch=${fields.branch}`] : []),
  ])
  if (!got.ok) return got
  void poll($)
  return parsed(got, parseStarted)
}

async function runCommand($: EngineInterface, args: string): Promise<string> {
  const command = parseCommand(args)
  switch (command.verb) {
    case 'invalid':
      return command.reason
    case 'help':
      return USAGE
    case 'pane':
      return `Nexus pane open.${await openPane($)}`
    case 'close':
      stopPane()
      await $.ui.close({ id: PANE })
      return 'Nexus pane closed.'
    case 'open': {
      const id = await resolveThread($, command.thread)
      if (!id.ok) return say(id)
      await showThread($, id.value)
      return `Showing ${id.value}.${await openPane($)}`
    }
    case 'new': {
      const started = await start($, { project: command.project, message: command.message, title: command.title })
      if (!started.ok) return say(started)
      const thread = started.value
      if (poller) await showThread($, thread.id)
      return `Started ${thread.id} on ${thread.project}: ${thread.title}`
    }
    case 'send': {
      const id = await resolveThread($, command.thread)
      return say(id.ok ? await send($, id.value, command.text) : id)
    }
    case 'action': {
      const id = await targetOf($, command.thread)
      if (!id.ok) return say(id)
      if (command.action === 'delete') return say(await confirmDelete($, id.value))
      return say(await act($, command.action, id.value))
    }
    case 'unpublish': {
      const id = await targetOf($, command.thread)
      if (!id.ok) return say(id)
      const closed = await unpreviewPort($, id.value, command.port, new Promise(() => {}))
      if (closed && !closed.ok) return say(closed)
      void poll($)
      return `Unpublished port ${command.port} of ${id.value}. Publishing it again may give it a new URL.`
    }
  }
}

/** The thread's state and context as the watch's first poll reports them. */
async function snapshot($: EngineInterface, thread: string, signal: AbortSignal): Promise<Outcome<{ state: NexusRunState; entries: WatchEntry[] }>> {
  let entries: WatchEntry[] = []
  let state: NexusRunState | undefined
  let outage: NexusFailure | undefined
  const end = await followWatch(
    $,
    thread,
    event => {
      if (event.type === 'reset') entries = event.entries
      if (event.type === 'entry') entries = [...entries, event.entry]
      if (event.type === 'state') state = event.state
      if (event.type === 'error') outage = { kind: event.kind, message: event.message }
      return state !== undefined || outage !== undefined
    },
    new Promise(resolve => signal.addEventListener('abort', () => resolve())),
  )
  if (state) return { ok: true, value: { state, entries } }
  if (outage) return { ok: false, failure: outage }
  return { ok: false, failure: end.by === 'exit' && end.failure ? end.failure : { kind: 'failed', message: 'the watch ended before it reported the thread' } }
}

/** How long a watch stays quiet after an entry before the entry counts without a state behind it. */
const QUIET_MS = 1_000

/**
 * Follows the thread until `isSettled`, `ms` pass or the call is cancelled. One poll prints its new entries before
 * the state that changed with them, so an entry is judged against a state that may be stale: it settles the wait
 * only once the watch has been quiet for a moment, and a state settles it at once.
 */
async function waitFor($: EngineInterface, thread: string, ms: number, signal: AbortSignal) {
  let watch: NexusWatch = { thread, rows: [], dropped: 0, state: null, model: null, outage: null, ended: null }
  let reply: Reply | undefined
  const { promise, stop } = stopper()
  let timedOut = false
  let isQuiet = false
  let sawWorking = false
  let quiet: Timer | undefined
  const timer = $.clock.after(ms, () => {
    timedOut = true
    stop()
  })
  signal.addEventListener('abort', stop)
  try {
    const end = await followWatch(
      $,
      thread,
      event => {
        quiet?.cancel()
        watch = applyEvent(watch, event)
        reply = foldReply(reply, event, REPLY_CHARS)
        sawWorking ||= watch.state?.run === 'working'
        if (!isSettled(watch.state, watch.rows, sawWorking)) return false
        if (event.type === 'state') return true
        quiet = $.clock.after(QUIET_MS, () => {
          isQuiet = true
          stop()
        })
        return false
      },
      promise,
    )
    if (end.by === 'exit' && end.failure) return { ok: false as const, failure: end.failure }
    const settled = end.by !== 'stop' || isQuiet
    return { ok: true as const, value: { watch, reply, settled, timedOut: timedOut && !settled } }
  } finally {
    timer.cancel()
    quiet?.cancel()
    signal.removeEventListener('abort', stop)
  }
}

const str = (input: Record<string, unknown>, key: string) => {
  const value = input[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

const stateFields = (state: NexusRunState | null) =>
  state && {
    status: state.status,
    run: state.run,
    pylon: state.pylon,
    queued: state.queued,
    ...(state.failed ? { failed: state.failed } : {}),
    ports: state.ports && state.ports.map(portFacts),
  }

type ToolAnswer = { result: string } | { deny: string }

const answer = (outcome: Outcome<unknown>): ToolAnswer =>
  outcome.ok ? { result: JSON.stringify(outcome.value) } : { deny: `nexus (${outcome.failure.kind}): ${outcome.failure.message}` }

/** The thread a tool call names, required. */
async function toolThread($: EngineInterface, input: Record<string, unknown>): Promise<Outcome<string>> {
  const arg = str(input, 'thread')
  return arg ? resolveThread($, arg) : failed('thread is required')
}

async function callTool($: EngineInterface, tool: keyof typeof TOOLS, input: Record<string, unknown>, signal: AbortSignal): Promise<ToolAnswer> {
  try {
    return await runTool($, tool, input, signal)
  } catch (error) {
    return { deny: `nexus: ${messageOf(error)}` }
  }
}

async function runTool($: EngineInterface, tool: keyof typeof TOOLS, input: Record<string, unknown>, signal: AbortSignal): Promise<ToolAnswer> {
  switch (tool) {
    case 'threads': {
      const got = await listThreads($, str(input, 'project'))
      if (!got.ok) return answer(got)
      const now = await $.clock.now()
      return answer({
        ok: true,
        value: got.value.map(thread => ({
          id: thread.id,
          project: thread.project,
          title: thread.title,
          status: thread.status,
          working: thread.agentTurnRunning,
          active: `${ago(now - thread.lastActivityAt)} ago`,
        })),
      })
    }
    case 'start': {
      const project = str(input, 'project')
      const message = str(input, 'message')
      if (!project || !message) return { deny: 'project and message are required' }
      const started = await start($, { project, message, title: str(input, 'title') })
      return answer(started.ok ? { ok: true, value: { id: started.value.id, project: started.value.project, title: started.value.title } } : started)
    }
    case 'send': {
      const id = await toolThread($, input)
      const text = str(input, 'text')
      if (!id.ok || !text) return answer(id.ok ? failed('text is required') : id)
      const sent = await send($, id.value, text)
      return answer(sent.ok ? { ok: true, value: { thread: id.value, sent: true } } : sent)
    }
    case 'read': {
      const id = await toolThread($, input)
      if (!id.ok) return answer(id)
      const got = await snapshot($, id.value, signal)
      if (!got.ok) return answer(got)
      return answer({ ok: true, value: { thread: id.value, ...stateFields(got.value.state), conversation: transcript(got.value.entries, READ_CHARS) } })
    }
    case 'wait': {
      const id = await toolThread($, input)
      if (!id.ok) return answer(id)
      const seconds = typeof input.timeout_seconds === 'number' ? Math.min(600, Math.max(1, Math.round(input.timeout_seconds))) : 300
      const got = await waitFor($, id.value, seconds * 1000, signal)
      if (!got.ok) return answer(got)
      const { watch, reply, settled, timedOut } = got.value
      const human = needsHuman(watch.state)
      return answer({
        ok: true,
        value: {
          thread: id.value,
          settled,
          ...(timedOut ? { timed_out: true } : {}),
          ...(signal.aborted ? { cancelled: true } : {}),
          ...stateFields(watch.state),
          ...(watch.outage ? { outage: watch.outage } : {}),
          ...(human ? { needs_human: human } : {}),
          reply: reply ? leftOut(reply.tail, reply.dropped) : null,
        },
      })
    }
    case 'preview': {
      const id = await toolThread($, input)
      if (!id.ok) return answer(id)
      if (typeof input.port !== 'number') return { deny: 'port is required' }
      // An abort during the lookup above fired no event the wait below could hear: it would publish the port anyway.
      if (signal.aborted) return { deny: 'nexus: cancelled before the port was published' }
      const got = await previewPort($, id.value, input.port, new Promise(resolve => signal.addEventListener('abort', () => resolve())))
      if (!got) return { deny: 'nexus: cancelled while waiting for the preview; the port may be published already' }
      return answer(got.ok ? { ok: true, value: { thread: id.value, port: input.port, url: got.value.url, ready: got.value.ready } } : got)
    }
    case 'unpublish': {
      const id = await toolThread($, input)
      if (!id.ok) return answer(id)
      if (typeof input.port !== 'number') return { deny: 'port is required' }
      if (signal.aborted) return { deny: 'nexus: cancelled before the preview was closed' }
      const got = await unpreviewPort($, id.value, input.port, new Promise(resolve => signal.addEventListener('abort', () => resolve())))
      if (!got) return { deny: 'nexus: cancelled while closing the preview; it may be closed already' }
      if (!got.ok) return answer(got)
      void poll($)
      return answer({ ok: true, value: { thread: id.value, port: input.port, unpublished: true } })
    }
    case 'archive': {
      const id = await toolThread($, input)
      if (!id.ok) return answer(id)
      const got = await nexus($, ['archive', id.value])
      if (!got.ok) return answer(got)
      void poll($)
      return answer({ ok: true, value: { thread: id.value, status: 'archived' } })
    }
  }
}

function failedTool() {
  return { deny: 'nexus: the tool failed before it answered; try again.' }
}

const emptyStart = (project = '', title = ''): NexusStartDraft => ({ title, project, node: '', branch: '', message: '', error: null, isStarting: false, request: 0 })

/** Opens the start form, its project and title given for Start again, and reads the projects and nodes it offers. */
async function openStart($: EngineInterface, project?: string, title?: string) {
  await setPane($, () => ({ view: 'start', field: 'none', start: emptyStart(project, title) }))
  await loadCatalog($, { projects: true })
  const { projects } = await read($, catalogAtom)
  await update($, paneAtom, pane => {
    if (!pane.start) return pane
    const offered = projects?.some(one => one.id === pane.start!.project)
    if (pane.start.project && !offered && projects) return { ...pane, start: { ...pane.start, project: '', error: `Project ${pane.start.project} is not offered here.` } }
    return pane.start.project || !projects?.[0] ? pane : { ...pane, start: { ...pane.start, project: projects[0].id } }
  })
}

/** Starts the thread the form describes and shows it; a failure stays on the form. */
async function submitStart($: EngineInterface) {
  const { start: draft } = await read($, paneAtom)
  if (!draft || draft.isStarting) return
  const title = draft.title.trim()
  const message = draft.message.trim()
  if (!draft.project || (!title && !message)) {
    await setStart($, { error: draft.project ? 'Give the thread a title or a first message.' : 'Pick a project.' })
    return
  }
  starts += 1
  const request = starts
  await setStart($, { isStarting: true, error: null, request })
  const started = await start($, { project: draft.project, title, message, node: draft.node, branch: draft.branch.trim() })
  // The person may have left the form, or opened another, while the thread started: then the outcome is only said.
  // Whose form it is and what it becomes are one update, so no other change of the pane comes between them.
  const committed = await update($, paneAtom, (pane): NexusPane => {
    if (pane.view !== 'start' || pane.start?.request !== request) {
      const said = started.ok ? `Started ${started.value.title || started.value.id}.` : `The thread did not start: ${sentence(started.failure.message)}`
      return { ...pane, notice: { text: said, tone: started.ok ? 'dim' : 'error' } }
    }
    if (!started.ok) return { ...pane, start: { ...pane.start, isStarting: false, error: sentence(started.failure.message) } }
    return { ...pane, ...threadView(pane, started.value.id) }
  })
  // `update` runs its function again when its write loses a race, so what follows reads what it wrote.
  if (started.ok && committed.view === 'thread' && committed.selected === started.value.id) await followThread($, started.value.id)
}

const setStart = ($: EngineInterface, change: Partial<NexusStartDraft>) =>
  update($, paneAtom, pane => (pane.start ? { ...pane, start: { ...pane.start, ...change } } : pane))

/** The handlers the pane's buttons and fields run, each with the render hook's `$`. */
function paneActions($: EngineInterface): PaneActions {
  const notify = (outcome: Outcome<string>) =>
    setPane($, () => ({ notice: outcome.ok ? { text: outcome.value, tone: 'dim' } : { text: sentence(outcome.failure.message), tone: 'error' } }))
  const onShown = async (fn: (id: string) => Promise<Outcome<string>>) => {
    const { selected } = await read($, paneAtom)
    if (selected) await notify(await fn(selected))
  }
  const run = (fn: () => Promise<unknown>) => void fn()
  return {
    open: id => run(() => showThread($, id)),
    back: () =>
      run(async () => {
        const { view, selected } = await read($, paneAtom)
        if (view === 'details' || (view === 'start' && selected)) return setPane($, () => ({ view: 'thread', field: 'none', start: null }))
        watcher?.stop()
        await setPane($, () => ({ view: 'list', selected: null, field: 'none', draft: '', start: null, toggled: {} }))
        await Promise.all([$.state.set(WATCH, null), $.state.set(LIVE, null), $.state.set(SHOWN, null)])
        void poll($)
      }),
    refresh: () =>
      run(async () => {
        const { selected, view } = await read($, paneAtom)
        await setPane($, () => ({}))
        if (selected && view !== 'list') watchInPane($, selected)
        await Promise.all([poll($), loadCatalog($, { projects: false })])
      }),
    close: () =>
      run(async () => {
        stopPane()
        await $.ui.close({ id: PANE })
      }),
    toggle: (key, isOpen) => run(() => update($, paneAtom, pane => ({ ...pane, toggled: { ...pane.toggled, [key]: !isOpen } }))),
    field: field =>
      run(async () => {
        await setPane($, () => ({ field }))
        // The field's autoFocus takes the ring as it is drawn; this asks for it too, where a pane already holds the
        // keyboard. A refused ask leaves the field drawn for a click or Tab, so it is not an error.
        if (field !== 'none') await $.ui.focus({ requestId: PANE, key: field === 'compose' ? COMPOSE : FILTER }).catch(() => undefined)
      }),
    // Each change of the filter opens the closed groups it matches afresh, as the dashboard's does, so a group the
    // person folded or opened before follows the new filter.
    filter: text =>
      run(() =>
        update($, paneAtom, pane => ({ ...pane, filter: text, toggled: Object.fromEntries(Object.entries(pane.toggled).filter(([key]) => !key.startsWith(closedKey('')))) })),
      ),
    draft: text => run(() => update($, paneAtom, pane => ({ ...pane, draft: text }))),
    submit: text =>
      run(async () => {
        // An empty Enter hands the keys back; a sent message keeps the composer, as Claude Code's prompt does.
        if (!text.trim()) return setPane($, () => ({ field: 'none' }))
        await setPane($, () => ({ draft: '' }))
        await onShown(id => send($, id, text.trim()))
      }),
    // A key pressed means no field has the keys, so a composer the thread's change hid stays let go of after it.
    act: action =>
      run(async () => {
        await setPane($, () => ({ field: 'none' }))
        await onShown(id => act($, action, id))
      }),
    remove: () =>
      run(async () => {
        await setPane($, () => ({ field: 'none' }))
        await onShown(id => confirmDelete($, id))
      }),
    details: () =>
      run(async () => {
        await setPane($, pane => ({ view: pane.view === 'details' ? 'thread' : 'details', isPickingPreview: false }))
        await Promise.all([poll($), loadCatalog($, { projects: false })])
      }),
    openPort: port => run(() => changePort($, port, 'open')),
    pickPreview: () => run(() => setPane($, pane => ({ isPickingPreview: !pane.isPickingPreview }))),
    closePort: port =>
      run(async () => {
        await setPane($, () => ({ isPickingPreview: false }))
        await changePort($, port, 'close')
      }),
    newThread: () => run(() => openStart($)),
    startAgain: () =>
      run(async () => {
        const { selected } = await read($, paneAtom)
        const thread = (await read($, shownAtom))?.detail?.thread ?? (await read($, listAtom)).threads?.find(one => one.id === selected)
        await openStart($, thread?.project, thread?.title)
      }),
    startDraft: change => run(() => setStart($, { ...change, error: null })),
    startSubmit: change =>
      run(async () => {
        if (change) await setStart($, change)
        await submitStart($)
      }),
    copy: (text, surface) =>
      run(async () => {
        const copied = await $.ui.copy({ text, surface })
        await setPane($, () => ({
          notice: copied.isCopied ? { text: `Copied: ${text}`, tone: 'dim' } : { text: `Not copied (${copied.reason}); select it by hand.`, tone: 'error' },
        }))
      }),
  }
}

export const register: Register = (on, options) => {
  if (typeof options.cli === 'string' && options.cli.trim()) cli = options.cli.trim()

  on('session.start', async ($, e, next) => {
    await Promise.all([
      $.command.register({ name: 'nexus', description: 'Drive Nexus threads: the pane, new, send, open, unpublish, archive, abort, retry, delete', argumentHint: '[help]', immediate: true }),
      ...Object.values(TOOLS).map(spec => $.tool.register(spec)),
    ])
    // A reload ended the pane's processes while the pane stayed open.
    if ((await $.ui.panes()).some(pane => pane.id === PANE)) await startPane($)
    return next(e)
  })

  on('ui.close', ($, e, next) => {
    if (e.id === PANE) stopPane()
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'nexus' }, async ($, e) => ({ text: await runCommand($, e.args) }))

  const input = (e: object) => e as Record<string, unknown>
  on('tool.call', { tool: 'mcp__nexus__threads' }, ($, e, next) => callTool($, 'threads', input(e), next.signal)).catch(failedTool)
  on('tool.call', { tool: 'mcp__nexus__start' }, ($, e, next) => callTool($, 'start', input(e), next.signal)).catch(failedTool)
  on('tool.call', { tool: 'mcp__nexus__send' }, ($, e, next) => callTool($, 'send', input(e), next.signal)).catch(failedTool)
  on('tool.call', { tool: 'mcp__nexus__read' }, ($, e, next) => callTool($, 'read', input(e), next.signal)).catch(failedTool)
  on('tool.call', { tool: 'mcp__nexus__wait' }, ($, e, next) => callTool($, 'wait', input(e), next.signal)).catch(failedTool)
  on('tool.call', { tool: 'mcp__nexus__preview' }, ($, e, next) => callTool($, 'preview', input(e), next.signal)).catch(failedTool)
  on('tool.call', { tool: 'mcp__nexus__unpublish' }, ($, e, next) => callTool($, 'unpublish', input(e), next.signal)).catch(failedTool)
  on('tool.call', { tool: 'mcp__nexus__archive' }, ($, e, next) => callTool($, 'archive', input(e), next.signal)).catch(failedTool)

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface === 'mobile') {
      const { Text } = $.ui.resolve(e)
      return <Text dimColor>The Nexus pane needs a surface with text fields.</Text>
    }
    const draw: Draw = $.ui.resolve(e)
    const [list, watch, live, shown, catalog, pane, now] = await Promise.all([
      read($, listAtom),
      read($, watchAtom),
      read($, liveAtom),
      read($, shownAtom),
      read($, catalogAtom),
      read($, paneAtom),
      read($, nowAtom),
    ])
    const scene: Scene = {
      list,
      watch,
      live: live && live.thread === pane.selected ? live.live : null,
      shown,
      catalog,
      pane,
      now: Math.max(now, list.polledAt ?? 0),
      width: Math.max(24, e.props.bodyColumns),
      isFocused: e.props.isFocused,
      surface: e.surface,
    }
    const actions = paneActions($)
    if (pane.view === 'start') return StartView(draw, scene, actions)
    if (!pane.selected || pane.view === 'list') return ListView(draw, scene, actions)
    return ThreadView(draw, scene, actions)
  })
}
