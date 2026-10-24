import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface, Timer } from 'claude-code'

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
  NexusStrip,
  NexusTab,
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
  parseUnpreviewed,
  parseWatchEvent,
  sentence,
  stripChips,
  transcript,
} from './model'
import { COMPOSE, type Effect, FILTER, type MenuAction, fieldKey, fieldOf, press, putFields, ringMoved } from './keys'
import { StripView } from './strip'
import { needsHuman, portFacts, TOOLS } from './tools'
import { type Draw, ListView, type PaneActions, START_KEYS, type Scene, StartView, ThreadView, ringOf } from './view'

const PANE = 'nexus'
const POLL_MS = 5_000
/** How often the strip reads the list while the pane does not. */
const STRIP_MS = 10_000
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
  tab: 'conversation',
  selected: null,
  mode: 'normal',
  overlay: null,
  pending: null,
  listCursor: null,
  listTop: 0,
  scroll: null,
  detailsTop: 0,
  portCursor: null,
  toggled: {},
  filter: '',
  draft: '',
  start: null,
  fields: {},
  notice: null,
  portChanges: {},
})
const STRIP = { plugin: 'nexus', key: 'strip' } as const
/** What `$.store` keeps under `strip`, mirrored here so a change draws the strip again. */
const stripAtom = atom(STRIP, { isOn: true, seen: {}, since: 0 })
const STRIP_CURSOR = { plugin: 'nexus', key: 'stripCursor' } as const
const stripCursorAtom = atom(STRIP_CURSOR, null)

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
/** The strip's poll of the list, which runs while the pane is closed or shows a thread. */
let stripper: Timer | undefined
let isStripBusy = false
/** The pane taking the keys back after Esc left a field or an overlay, scheduled from a drawing. */
let recovering: Timer | undefined
/**
 * The pane's element the ring is on, as far as the mod knows: where its own focus or the engine's `ui.focus` last put
 * it. Null for one of the engine's stops; undefined before either says.
 */
let ringAt: string | null | undefined
/** The ring being taken home after a drawing left it on nothing, scheduled from that drawing. */
let rehoming: Timer | undefined
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

/** Closes the pane and, if no hook kept it open, stops its processes. */
async function closePane($: EngineInterface) {
  await $.ui.close({ id: PANE })
  if ((await $.ui.panes()).some(one => one.id === PANE)) return false
  stopPane()
  return true
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
    // A reply the person sees in the pane is not news on the strip.
    if (detail.ok && pane.isShown) void markSeen($, thread, detail.value.thread.lastAgentActivityAt)
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
  await themeNotice($)
  // `focus` is only granted over an empty composer, which an immediate command may still be clearing. Asking once
  // more is refused in turn if the person has started typing, so it never takes keys they are using.
  const pane = (await $.ui.panes()).find(one => one.id === PANE)
  if (pane?.isFocused) return ''
  refocus?.cancel()
  refocus = $.clock.after(REFOCUS_MS, () => void refocusPane($))
  return ''
}

/** Says once, the first time the pane opens, how to draw it on the terminal's own background. */
async function themeNotice($: EngineInterface) {
  if (await $.store.get('themeNotice')) return
  await $.store.set('themeNotice', true)
  await update($, paneAtom, (pane): NexusPane => ({
    ...pane,
    notice: { text: `Tip: pick "${THEME_NAME}" in /theme to draw this pane on your terminal's background.`, tone: 'dim' },
  }))
}

const THEME_NAME = 'Dark (ANSI), Nexus pane on the terminal background'

/**
 * The pane opened by `/nexus` with nothing shown opens on the thread whose agent works, the newest when several do,
 * reading the list first when no poll has.
 */
async function openWorking($: EngineInterface) {
  const pane = await read($, paneAtom)
  if (pane.selected || pane.view !== 'list') return
  let threads = (await read($, listAtom)).threads
  if (!threads) {
    const got = threadsFrom(await nexus($, ['threads', '--all']))
    if (!got.ok) return
    const now = await $.clock.now()
    await update($, listAtom, (): NexusList => ({ threads: got.value, failure: null, polledAt: now }))
    threads = got.value
  }
  const working = threads
    .filter(thread => thread.agentTurnRunning && (thread.status === 'active' || thread.status === 'idle'))
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0]
  if (working) await showThread($, working.id)
}

async function setPane($: EngineInterface, change: (pane: NexusPane) => Partial<NexusPane>) {
  await update($, paneAtom, pane => ({ ...pane, notice: null, ...change(pane) }))
}

/** The pane showing `thread`, keeping what the person opened, closed and chose in it when it was shown already. */
const threadView = (pane: NexusPane, thread: string): Partial<NexusPane> => {
  const isSame = pane.selected === thread
  return {
    view: 'thread',
    selected: thread,
    tab: isSame ? pane.tab : 'conversation',
    mode: 'normal',
    overlay: null,
    pending: null,
    scroll: isSame ? pane.scroll : null,
    detailsTop: isSame ? pane.detailsTop : 0,
    portCursor: isSame ? pane.portCursor : null,
    listCursor: thread,
    draft: '',
    fields: putFields(pane.fields, { [COMPOSE]: '' }),
    start: null,
    notice: null,
    toggled: isSame ? pane.toggled : {},
  }
}

/** Shows a thread: its watch, and its details polled, the first of which records the visit as the dashboard's page does. */
async function showThread($: EngineInterface, thread: string) {
  await setPane($, pane => threadView(pane, thread))
  void markSeen($, thread)
  await followThread($, thread)
}

/** The strip's state as `$.store` kept it, and its start the first time: replies before then are not news. */
async function loadStrip($: EngineInterface) {
  const stored = (await $.store.get('strip')) as Partial<NexusStrip> | undefined
  const strip: NexusStrip = { isOn: stored?.isOn ?? true, seen: stored?.seen ?? {}, since: stored?.since ?? (await $.clock.now()) }
  await $.state.set(STRIP, strip)
  if (stored?.since === undefined) await $.store.set('strip', strip)
}

async function saveStrip($: EngineInterface, change: (strip: NexusStrip) => NexusStrip) {
  await $.store.set('strip', await update($, stripAtom, change))
}

/**
 * Records that the person saw `thread` now, so the strip shows no new reply for it. Given the thread's last reply, it
 * writes only when that is news, so a poll of the thread shown writes once a reply. The threads the list no longer
 * has are dropped, so the store does not grow.
 */
async function markSeen($: EngineInterface, thread: string, reply?: number) {
  const strip = await read($, stripAtom)
  if (reply !== undefined && reply <= (strip.seen[thread] ?? strip.since)) return
  const now = await $.clock.now()
  const { threads } = await read($, listAtom)
  const kept = new Set(threads?.map(one => one.id) ?? Object.keys(strip.seen))
  await saveStrip($, was => ({ ...was, seen: { ...Object.fromEntries(Object.entries(was.seen).filter(([id]) => kept.has(id))), [thread]: Math.max(now, reply ?? 0) } }))
}

/**
 * The strip's poll of the list, one `threads --all` at a time, while the strip is on. Skipped while the pane polls the
 * list itself, so the two never both run.
 */
async function pollStrip($: EngineInterface) {
  if (isStripBusy || !(await read($, stripAtom)).isOn) return
  if (poller && (await read($, paneAtom)).view === 'list' && (await $.ui.panes()).some(one => one.id === PANE && one.isShown)) return
  isStripBusy = true
  try {
    const asked = await $.clock.now()
    const threads = threadsFrom(await nexus($, ['threads', '--all']))
    // The pane may have read the list while this poll ran, or the strip been turned off: then this answer is stale.
    if (!(await read($, stripAtom)).isOn) return
    await update($, listAtom, (list): NexusList => (list.polledAt !== null && list.polledAt >= asked ? list : threads.ok ? { threads: threads.value, failure: null, polledAt: asked } : { ...list, failure: threads.failure }))
  } finally {
    isStripBusy = false
  }
}

/**
 * A chip pressed: the pane opens on that thread. The band holds the keys during the press, so the open's focus is
 * refused (live test, 2.1.310) and the pane's mode line says how to hand it the keys.
 */
async function openFromStrip($: EngineInterface, id: string) {
  await showThread($, id)
  await openPane($)
}

/**
 * Esc in a field or an overlay hands the keys to the prompt and raises no event, so a drawing that finds the pane
 * unfocused in insert mode, filter mode or under an overlay sends it here: back to normal mode, the filter cleared,
 * and the keys asked back. The prompt refuses them while it holds a draft; the mode line then says how to take them.
 */
async function recover($: EngineInterface) {
  recovering = undefined
  const pane = await update($, paneAtom, (was): NexusPane =>
    was.mode === 'normal' && !was.overlay ? was : { ...was, mode: 'normal', overlay: null, pending: null, ...(was.mode === 'filter' ? { filter: '', fields: putFields(was.fields, { [FILTER]: '' }) } : {}) },
  )
  // A pane closed since stays closed; asking for the keys it holds already changes nothing.
  if (!(await $.ui.panes()).some(one => one.id === PANE)) return
  await $.ui.open(OPEN)
  await focusRing($, pane)
}

/** Puts the ring where normal mode wants it: the list's cursor row, or the thread's tab, whose Enter acts as o. */
function focusRing($: EngineInterface, pane: NexusPane) {
  const key = pane.view === 'list' ? pane.listCursor : pane.view === 'thread' ? `tab-${pane.tab}` : null
  return key ? focusOn($, key) : Promise.resolve()
}

/**
 * After a drawing: an element taken away while it held the ring (a port published into a preview, rows the help or
 * a closed menu hid, a form left) leaves the keys with nothing until Tab, and the composer or filter holding it in
 * normal mode takes letters as text. Either way the ring goes home: the view's cursor, else its tab. Insert and
 * filter mode keep it, the field being where the person put it; a pane without the keys has none to move.
 */
function rehome($: EngineInterface, tree: unknown, pane: NexusPane, isFocused: boolean) {
  if (!isFocused || pane.mode !== 'normal' || !ringAt || rehoming) return
  const { keys, home } = ringOf(tree)
  const isLost = !keys.has(ringAt) || fieldOf(ringAt) === COMPOSE || fieldOf(ringAt) === FILTER
  if (!isLost || !home || home === ringAt) return
  const lost = ringAt
  rehoming = $.clock.after(0, () => {
    rehoming = undefined
    // The mod may have put the ring somewhere since (a form's field put back under a new key): that stands.
    if (ringAt === lost) void focusOn($, home)
  })
}

/**
 * The list filtered by `text`. Each change of the filter opens the closed groups it matches afresh, as the dashboard's
 * does, so a group the person folded or opened before follows the new filter.
 */
const filtered = (pane: NexusPane, text: string): NexusPane =>
  text === pane.filter ? pane : { ...pane, filter: text, toggled: Object.fromEntries(Object.entries(pane.toggled).filter(([key]) => !key.startsWith(closedKey('')))) }

/**
 * Enter in a form's field: once the submit's hooks are done, the engine empties the field it delivered, unless it was
 * typed in since (2.1.310's field store). A form that stays (a refusal, a field missing) must still show what it
 * would send, so the field is put again with its text, under a new key, and the ring follows it there. A field
 * typed in since holds `form`'s newer text, which the engine keeps: it is left alone.
 */
async function putBack<Field extends string>(
  $: EngineInterface,
  keys: Record<Field, string>,
  change: Partial<Record<Field, string>>,
  form: (pane: NexusPane) => Partial<Record<NoInfer<Field>, unknown>> | null,
) {
  let name: string | undefined
  const pane = await update($, paneAtom, was => {
    const held = form(was)
    const texts = Object.fromEntries(Object.entries(change).flatMap(([field, text]) => (held?.[field as Field] === text ? [[keys[field as Field], text as string]] : [])))
    name = Object.keys(texts)[0]
    return name ? { ...was, fields: putFields(was.fields, texts) } : was
  })
  if (name) await focusOn($, fieldKey(pane.fields, name))
}

/** Whether the field drawn as `key` is still drawn so: a put draws it anew, and keys typed into the old one go with it. */
const isDrawn = (pane: NexusPane, key: string) => fieldKey(pane.fields, fieldOf(key)) === key

/** Asks for the ring on `key`; a refusal (not drawn yet, or the pane lacks the keys) leaves it where it is. */
const focusOn = ($: EngineInterface, key: string) =>
  $.ui.focus({ requestId: PANE, key }).then(
    result => {
      if (!result.deny) ringAt = key
    },
    () => undefined,
  )


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
  if (!got || got.ok) return got && parsed(got, parseUnpreviewed)
  // A CLI before 0.3.0 has no unpreview, and says only that it does not know the command.
  if (got.failure.message === 'unknown command unpreview') {
    return { ok: false, failure: { kind: got.failure.kind, message: `${cli} has no unpreview command: unpublishing a preview needs Nexus CLI 0.3.0 or later (nexus --version)` } }
  }
  return got
}

/**
 * The ports with a publish or unpublish under way, as `thread:port`, whether the pane, /nexus or a model tool started
 * it. A second operation on one is refused rather than queued: the two could finish in either order, so an unpublish
 * that ends first would be undone by the publish it raced.
 */
const changing = new Set<string>()

/** Runs `operation` while it holds the port, or says why it cannot: another operation holds it. */
async function holdingPort<T>(thread: string, port: number, operation: () => Promise<T>): Promise<{ value: T } | { refused: string }> {
  const key = `${thread}:${port}`
  if (changing.has(key)) return { refused: `Port ${port} on ${thread} is already being published or unpublished. Try again when it finishes.` }
  changing.add(key)
  try {
    return { value: await operation() }
  } finally {
    changing.delete(key)
  }
}

/**
 * Publishes or unpublishes a port of the thread shown, saying so while the CLI runs, then what it did until the
 * details show it, or why it failed. A port with an operation under way takes no other: the pane offers none.
 * Closing the pane kills the CLI; the port changes or is refused all the same.
 */
async function changePort($: EngineInterface, selected: string, port: number, action: 'open' | 'close') {
  const current = poller
  if (!current || (await read($, paneAtom)).selected !== selected) return
  const key = String(port)
  const write = (change: (was: NexusPortChange) => NexusPortChange) =>
    update($, paneAtom, (pane): NexusPane => {
      const ports = pane.portChanges[selected] ?? {}
      return { ...pane, portChanges: { ...pane.portChanges, [selected]: { ...ports, [key]: change(ports[key] ?? NO_CHANGE) } } }
    })
  const held = await holdingPort(selected, port, async () => {
    await write(was => ({ ...was, pending: action, failure: null }))
    const got = action === 'open' ? await previewPort($, selected, port, current.stopped) : await unpreviewPort($, selected, port, current.stopped)
    if (!got) return write(was => ({ ...was, pending: null }))
    if (!got.ok) return write(was => ({ ...was, pending: null, failure: { action, message: sentence(got.failure.message) } }))
    sequence += 1
    const seq = sequence
    await write(() => ({ confirmed: { preview: got.value, seq }, pending: null, failure: null }))
    // The details list the port afresh: under Previews once opened, under Ports once closed.
    void poll($)
  })
  // The pane offers no second operation of its own, so what holds the port is /nexus or a model tool.
  if ('refused' in held) await setPane($, () => ({ notice: { text: held.refused, tone: 'error' } }))
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
      if (!(await $.ui.panes()).some(one => one.id === PANE)) await openWorking($)
      return `Nexus pane open.${await openPane($)}`
    case 'strip':
      await saveStrip($, strip => ({ ...strip, isOn: command.isOn }))
      if (command.isOn) void pollStrip($)
      return command.isOn ? 'The Nexus strip above the prompt is on.' : 'The Nexus strip above the prompt is off. /nexus strip on shows it again.'
    case 'close':
      return (await closePane($)) ? 'Nexus pane closed.' : 'The Nexus pane stays open: another hook kept it.'
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
      const held = await holdingPort(id.value, command.port, () => unpreviewPort($, id.value, command.port, new Promise(() => {})))
      if ('refused' in held) return held.refused
      const closed = held.value
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
      const held = await holdingPort(id.value, input.port, () => previewPort($, id.value, input.port as number, new Promise(resolve => signal.addEventListener('abort', () => resolve()))))
      if ('refused' in held) return { deny: held.refused }
      const got = held.value
      if (!got) return { deny: 'nexus: cancelled while waiting for the preview; the port may be published already' }
      return answer(got.ok ? { ok: true, value: { thread: id.value, port: input.port, url: got.value.url, ready: got.value.ready } } : got)
    }
    case 'unpublish': {
      const id = await toolThread($, input)
      if (!id.ok) return answer(id)
      if (typeof input.port !== 'number') return { deny: 'port is required' }
      if (signal.aborted) return { deny: 'nexus: cancelled before the preview was closed' }
      const held = await holdingPort(id.value, input.port, () => unpreviewPort($, id.value, input.port as number, new Promise(resolve => signal.addEventListener('abort', () => resolve()))))
      if ('refused' in held) return { deny: held.refused }
      const got = held.value
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

const emptyStart = (project = '', title = ''): NexusStartDraft => ({ title, project, node: '', branch: '', message: '', error: null, isStarting: false, request: 0, focused: null })

/** The start form's texts by field, as `putFields` takes them. */
const startTexts = (start: NexusStartDraft) => ({ [START_KEYS.title]: start.title, [START_KEYS.branch]: start.branch, [START_KEYS.message]: start.message })

/** The pane with each field put again with the text it holds for it: a closed pane's fields forget what was typed. */
const refilled = (pane: NexusPane): NexusPane => ({
  ...pane,
  fields: putFields(pane.fields, { [COMPOSE]: pane.draft, [FILTER]: pane.filter, ...(pane.start ? startTexts(pane.start) : {}) }),
})

/** Opens the start form, its project and title given for Start again, and reads the projects and nodes it offers. */
async function openStart($: EngineInterface, project?: string, title?: string) {
  await setPane($, pane => {
    const start = emptyStart(project, title)
    return { view: 'start', mode: 'normal', overlay: null, start, fields: putFields(pane.fields, startTexts(start)) }
  })
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
async function submitStart($: EngineInterface, draft: NexusStartDraft | null) {
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

/** The handlers the pane's keys, buttons and fields run, each with the render hook's `$`. */
function paneActions($: EngineInterface, surface: RenderSurface): PaneActions {
  const notify = (outcome: Outcome<string>) =>
    setPane($, () => ({ notice: outcome.ok ? { text: outcome.value, tone: 'dim' } : { text: sentence(outcome.failure.message), tone: 'error' } }))
  const onShown = async (fn: (id: string) => Promise<Outcome<string>>) => {
    const { selected } = await read($, paneAtom)
    if (selected) await notify(await fn(selected))
  }
  const run = (fn: () => Promise<unknown>) => void fn()
  const copy = async (text: string) => {
    const copied = await $.ui.copy({ text, surface })
    await setPane($, () => ({
      notice: copied.isCopied ? { text: `Copied: ${text}`, tone: 'dim' } : { text: `Not copied (${copied.reason}); select it by hand.`, tone: 'error' },
    }))
  }
  const back = async () => {
    const { view, selected } = await read($, paneAtom)
    if (view === 'start' && selected) {
      await setPane($, () => ({ view: 'thread', mode: 'normal', start: null }))
      return focusRing($, await read($, paneAtom))
    }
    watcher?.stop()
    if (selected) void markSeen($, selected)
    // The cursor goes back to the thread just left.
    const pane = await update($, paneAtom, (was): NexusPane => ({
      ...was,
      view: 'list',
      selected: null,
      mode: 'normal',
      overlay: null,
      pending: null,
      notice: null,
      draft: '',
      start: null,
      toggled: {},
      scroll: null,
      detailsTop: 0,
      portCursor: null,
      listCursor: selected ?? was.listCursor,
    }))
    await Promise.all([$.state.set(WATCH, null), $.state.set(LIVE, null), $.state.set(SHOWN, null)])
    void poll($)
    await focusRing($, pane)
  }
  const refresh = async () => {
    const { selected, view } = await read($, paneAtom)
    if (selected && view !== 'list') watchInPane($, selected)
    await Promise.all([poll($), loadCatalog($, { projects: false })])
  }
  const startAgain = async () => {
    const { selected } = await read($, paneAtom)
    const thread = (await read($, shownAtom))?.detail?.thread ?? (await read($, listAtom)).threads?.find(one => one.id === selected)
    await openStart($, thread?.project, thread?.title)
  }
  const runAction = async (action: MenuAction) => {
    switch (action) {
      case 'start-again':
        return startAgain()
      case 'copy-attach': {
        const detail = (await read($, shownAtom))?.detail
        return detail ? copy(detail.attach) : setPane($, () => ({ notice: { text: "The thread's details have not loaded yet.", tone: 'error' } }))
      }
      case 'rewatch':
        return refresh()
      case 'delete':
        return onShown(id => confirmDelete($, id))
      default:
        return onShown(id => act($, action, id))
    }
  }
  const showTab = async (tab: NexusTab) => {
    await focusOn($, `tab-${tab}`)
    if (tab !== 'conversation') await Promise.all([poll($), loadCatalog($, { projects: false })])
  }
  const perform = async (effect: Effect): Promise<unknown> => {
    switch (effect.kind) {
      case 'open':
        return showThread($, effect.thread)
      case 'back':
        return back()
      case 'tab':
        return showTab(effect.tab)
      case 'focus':
        return focusOn($, effect.key)
      case 'publish':
        return changePort($, effect.thread, effect.port, 'open')
      case 'unpublish':
        return changePort($, effect.thread, effect.port, 'close')
      case 'copy':
        return copy(effect.text)
      case 'say':
        return setPane($, () => ({ notice: { text: effect.text, tone: 'dim' } }))
      case 'run':
        await setPane($, () => ({ overlay: null }))
        return runAction(effect.action)
      // The field's autoFocus takes the ring as it is drawn; this asks for it too, where it is drawn already.
      case 'insert':
        return focusOn($, fieldKey((await read($, paneAtom)).fields, COMPOSE))
      case 'filter':
        return focusOn($, fieldKey((await read($, paneAtom)).fields, FILTER))
      case 'new':
        return openStart($)
      case 'refresh':
        return refresh()
      case 'close':
        return closePane($)
    }
  }
  return {
    key: (command, nav) =>
      run(async () => {
        let effects: Effect[] = []
        // `update` runs its function again when its write loses a race: the effects are those of the write that won.
        await update($, paneAtom, pane => {
          const step = press(pane, command, nav)
          effects = step.effects
          return step.pane
        })
        for (const effect of effects) await perform(effect)
      }),
    effect: effect => run(() => perform(effect)),
    toggle: (key, isOpen) => run(() => update($, paneAtom, pane => ({ ...pane, toggled: { ...pane.toggled, [key]: !isOpen } }))),
    tab: tab =>
      run(async () => {
        await setPane($, () => ({ tab, mode: 'normal', overlay: null, pending: null }))
        await showTab(tab)
      }),
    // Each change of the filter opens the closed groups it matches afresh, as the dashboard's does, so a group the
    // person folded or opened before follows the new filter.
    filter: (text, at) => run(() => update($, paneAtom, pane => (isDrawn(pane, at) ? filtered(pane, text) : pane))),
    filterDone: (text, first) =>
      run(async () => {
        // Enter's text is the filter, though its last change may not have landed yet; the first match drawn is then
        // another filter's. Enter emptied the field, so f would edit nothing: it is put again with that text.
        const pane = await update($, paneAtom, (was): NexusPane => ({
          ...filtered(was, text),
          mode: 'normal',
          listCursor: (text === was.filter ? first : null) ?? was.listCursor,
          listTop: 0,
          fields: putFields(was.fields, { [FILTER]: text }),
        }))
        await focusRing($, pane)
      }),
    draft: text => run(() => update($, paneAtom, pane => ({ ...pane, draft: text }))),
    submit: text =>
      run(async () => {
        // An empty Enter is back to normal mode; a sent message keeps the composer, as Claude Code's prompt does.
        if (!text.trim()) {
          await setPane($, () => ({ mode: 'normal' }))
          return focusRing($, await read($, paneAtom))
        }
        await setPane($, () => ({ draft: '' }))
        await onShown(id => send($, id, text.trim()))
      }),
    back: () => run(back),
    startDraft: (change, at) =>
      run(() => update($, paneAtom, pane => (pane.start && (at === undefined || isDrawn(pane, at)) ? { ...pane, start: { ...pane.start, ...change, error: null } } : pane))),
    startProject: project =>
      run(() =>
        update($, paneAtom, pane =>
          pane.start ? { ...pane, start: { ...pane.start, project, node: '', branch: '', error: null }, fields: putFields(pane.fields, { [START_KEYS.branch]: '' }) } : pane,
        ),
      ),
    startSubmit: change =>
      run(async () => {
        // What starts is the form as Enter left it: the engine empties the field at once, and typing there after Enter
        // is the next draft's.
        const { start: sent } = await setStart($, change ?? {})
        if (change) await putBack($, START_KEYS, change, pane => pane.start)
        await submitStart($, sent)
      }),
  }
}

/** Rows an inline pane takes at most: above the prompt it shares the screen with the transcript. */
const INLINE_ROWS = 24

export const register: Register = (on, options) => {
  if (typeof options.cli === 'string' && options.cli.trim()) cli = options.cli.trim()

  on('session.start', async ($, e, next) => {
    await Promise.all([
      $.command.register({ name: 'nexus', description: 'Drive Nexus threads: the pane, new, send, open, unpublish, archive, abort, retry, delete, strip', argumentHint: '[help]', immediate: true }),
      ...Object.values(TOOLS).map(spec => $.tool.register(spec)),
      loadStrip($),
    ])
    stripper?.cancel()
    stripper = $.clock.every(STRIP_MS, () => void pollStrip($))
    void pollStrip($)
    // A reload ended the pane's processes while the pane stayed open.
    if ((await $.ui.panes()).some(pane => pane.id === PANE)) await startPane($)
    return next(e)
  })

  on('ui.close', async ($, e, next) => {
    if (e.id !== PANE) return next(e)
    // A hook beneath may keep the pane open: only a close that happened stops its processes.
    const closed = await next(e)
    if ((await $.ui.panes()).some(one => one.id === PANE)) return closed
    stopPane()
    await update($, paneAtom, refilled)
    return closed
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

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const [strip, list, watch, shown, now, cursor] = await Promise.all([
      read($, stripAtom),
      read($, listAtom),
      read($, watchAtom),
      read($, shownAtom),
      read($, nowAtom),
      read($, stripCursorAtom),
    ])
    if (!strip.isOn) return next(e)
    // The list has no parked tasks: only the thread the pane watches is known to hold them.
    const parked = new Set([...(watch?.state?.run === 'parked' ? [watch.thread] : []), ...(shown?.detail?.agent?.parkedTasks ? [shown.thread] : [])])
    const chips = stripChips(list.threads ?? [], strip, Math.max(now, list.polledAt ?? 0), parked)
    if (chips.length === 0 && !(list.failure && !list.threads)) return next(e)
    return StripView($.ui.resolve(e), list, chips, e.props.bodyColumns, cursor, id => void openFromStrip($, id))
  })

  on('ui.focus', { component: 'AbovePrompt' }, async ($, e, next) => {
    await $.state.set(STRIP_CURSOR, e.plugin === 'nexus' ? (e.element ?? null) : null)
    return next(e)
  })

  // The arrows, Tab and a click move the ring themselves: the cursor and the mode follow it.
  on('ui.focus', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const element = e.element
    if (e.origin.kind === 'person' && element) await update($, paneAtom, pane => ringMoved(pane, element))
    const moved = await next(e)
    if (!moved.deny) ringAt = element ?? null
    return moved
  })

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
    // A drawing may not write: Esc out of a field or an overlay is taken up after it.
    if (!e.props.isFocused && (pane.mode !== 'normal' || pane.overlay) && !recovering) recovering = $.clock.after(0, () => void recover($))
    const scene: Scene = {
      list,
      watch,
      live: live && live.thread === pane.selected ? live.live : null,
      shown,
      catalog,
      pane,
      now: Math.max(now, list.polledAt ?? 0),
      width: Math.max(24, e.props.bodyColumns),
      rows: e.props.placement === 'dock' ? e.props.scroll.bodyRows : Math.min(e.props.scroll.bodyRows, INLINE_ROWS),
      placement: e.props.placement,
      isFocused: e.props.isFocused,
      surface: e.surface,
    }
    const actions = paneActions($, e.surface)
    const tree = pane.view === 'start' ? StartView(draw, scene, actions) : !pane.selected || pane.view === 'list' ? ListView(draw, scene, actions) : ThreadView(draw, scene, actions)
    rehome($, tree, pane, e.props.isFocused)
    return tree
  })
}
