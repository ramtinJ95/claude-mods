import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface, Timer } from 'claude-code'

import type {
  NexusCatalog,
  NexusFailure,
  NexusHarness,
  NexusList,
  NexusOpenedSession,
  NexusSession,
  NexusPane,
  NexusPortChange,
  NexusPreview,
  NexusProject,
  NexusProjectDraft,
  NexusRunState,
  NexusSessionChanges,
  NexusSessionDraft,
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
  HARNESS_LABEL,
  NO_CHANGE,
  NO_SESSION_CHANGES,
  SSH_HINT,
  USAGE,
  type WatchEntry,
  type WatchEvent,
  ago,
  attachCommand,
  applyEvent,
  closedKey,
  groupThreads,
  herdrError,
  isSettled,
  foldReply,
  inScope,
  leftOut,
  listOrder,
  matchThread,
  parseCommand,
  parseAdded,
  parseDetail,
  parseFailure,
  parseHerdrTab,
  parseNodes,
  parseOpenedSession,
  parsePreview,
  parseProjects,
  parseSessionClosed,
  parseVersion,
  isOlder,
  resumesOn,
  sessionPlace,
  parseStarted,
  parseThreads,
  parseUnpreviewed,
  parseWatchEvent,
  sentence,
  sessionName,
  settleSessions,
  stripChips,
  transcript,
} from './model'
import { COMPOSE, type Effect, FILTER, type MenuAction, fieldKey, fieldOf, press, putFields, ringMoved } from './keys'
import { StripView } from './strip'
import { needsHuman, portFacts, TOOLS } from './tools'
import { type Draw, ListView, PROJECT_KEYS, type PaneActions, ProjectView, SESSION_KEYS, START_KEYS, type Scene, SessionView, StartView, ThreadView, ringOf } from './view'

const PANE = 'nexus'
const POLL_MS = 5_000
/** How often the strip reads the list while the pane does not. */
const STRIP_MS = 10_000
/** How often the run clock ticks while the thread shown is working. */
const TICK_MS = 1_000
/** A `$.process.run` of the CLI: its own requests give up after 30 s without data, and `start` makes two. */
const RUN_MS = 70_000
/**
 * A `$.process.run` of `session open` or `close`: the CLI tries a paused pylon again once a second for up to 120 s, then
 * waits up to 120 s more for the agent to start.
 */
const SESSION_MS = 260_000
/** A `$.process.run` of herdr: a tab made, a command typed into it. */
const HERDR_MS = 10_000
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
  isRetaken: false,
  scroll: null,
  detailsTop: 0,
  portCursor: null,
  sessionCursor: null,
  toggled: {},
  filter: '',
  draft: '',
  start: null,
  project: null,
  session: null,
  fields: {},
  notice: null,
  portChanges: {},
  sessionChanges: {},
})
const STRIP = { plugin: 'nexus', key: 'strip' } as const
/** What `$.store` keeps under `strip`, mirrored here so a change draws the strip again. */
const stripAtom = atom(STRIP, { isOn: true, seen: {}, since: 0 })
const SCOPE = { plugin: 'nexus', key: 'scope' } as const
/** What `$.store` keeps under `project`, mirrored here so a change draws the list and the strip again. */
const scopeAtom = atom(SCOPE, null)
const STRIP_CURSOR = { plugin: 'nexus', key: 'stripCursor' } as const
const stripCursorAtom = atom(STRIP_CURSOR, null)

/** The CLI to run, from the `cli` option. */
let cli = 'nexus'
/** The Herdr workspace Claude Code runs in, read at session start: Enter's attach opens a tab there. Null outside Herdr. */
let herdrWorkspace: string | null = null
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
/** Project adds from the form so far, which number its `request`. */
let adds = 0
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

/**
 * One CLI command with `--json` after its name, `project add`, `session open` and `session close` being its names of
 * two words: its parsed stdout, or how it failed.
 */
async function nexus($: EngineInterface, args: readonly string[], timeoutMs = RUN_MS): Promise<Outcome<unknown>> {
  const words = args[0] === 'project' || args[0] === 'session' ? 2 : 1
  let ran: Awaited<ReturnType<EngineInterface['process']['run']>>
  try {
    ran = await $.process.run([cli, ...args.slice(0, words), '--json', ...args.slice(words)], { timeoutMs })
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
    // The opens and closes these details show, or that waited long enough for them, are drawn from the details now.
    const changes = (await read($, paneAtom)).sessionChanges[thread]
    if (detail.ok && changes && settleSessions(changes, detail.value.sessions, now) !== changes) {
      await changeSessions($, thread, was => settleSessions(was, detail.value.sessions, now))
    }
  } finally {
    current.isBusy = false
  }
}

/** Moves the run clock while the thread shown works, so its timer and spinner tick. */
async function tick($: EngineInterface) {
  const watch = await read($, watchAtom)
  if (watch?.state?.run === 'working') await $.state.set(NOW, await $.clock.now())
}

/** `projects` and `nodes` for the start form, the project picker, the list's nodes line and the previews' links. */
async function loadCatalog($: EngineInterface, wanted: { projects: boolean }) {
  const asked = scopeRevision
  const [nodes, projects] = await Promise.all([
    nexus($, ['nodes']).then(got => parsed(got, parseNodes)),
    wanted.projects ? nexus($, ['projects']).then(got => parsed(got, parseProjects)) : undefined,
  ])
  await update($, catalogAtom, (catalog): NexusCatalog => ({
    ...catalog,
    ...(nodes.ok ? { nodes: nodes.value, nodesFailure: null } : { nodesFailure: nodes.failure }),
    ...(projects ? (projects.ok ? { projects: projects.value, projectsFailure: null } : { projectsFailure: projects.failure }) : {}),
  }))
  if (projects?.ok) await checkScope($, projects.value, asked)
}

/** The scope as `$.store` kept it, and a check that its project still exists. */
async function loadScope($: EngineInterface) {
  const asked = scopeRevision
  const stored = await $.store.get('project')
  if (typeof stored !== 'string') return
  if ((await setScope($, stored, asked)).isSet) void loadCatalog($, { projects: true })
}

/** Counts the scope's writes, so a write decided on an older scope can tell that another came between. */
let scopeRevision = 0
let scopeTurn: Promise<unknown> = Promise.resolve()

/**
 * Shows `project`'s threads, or every project's for null, in this session and later ones. Every write of the scope
 * comes here and runs in turn, the atom and then `$.store`, so the store never ends on an older scope than the pane
 * shows. With `asked`, the revision its caller read, it writes only if no other write came since: comparing projects
 * would miss a choice undone, as api and then All again while an add asked from All ran. Says what the pane shows.
 */
function setScope($: EngineInterface, project: string | null, asked?: number): Promise<{ isSet: boolean; shown: string | null }> {
  const turn = scopeTurn.then(async () => {
    if (asked !== undefined && asked !== scopeRevision) return { isSet: false, shown: await read($, scopeAtom) }
    scopeRevision += 1
    await $.state.set(SCOPE, project)
    await $.store.set('project', project)
    return { isSet: true, shown: project }
  })
  scopeTurn = turn.catch(() => undefined)
  return turn
}

/**
 * Goes back to every project, saying so once, when the project shown is not among `projects`, as after it was
 * deleted; saving that keeps the notice from coming back. `asked` is the scope's revision when the list was asked for:
 * a list read before another project was chosen, or added, cannot tell whether that one exists.
 */
async function checkScope($: EngineInterface, projects: readonly NexusProject[], asked: number) {
  const gone = await read($, scopeAtom)
  if (gone === null || projects.some(project => project.id === gone)) return
  if ((await setScope($, null, asked)).isSet) await $.ui.toast(`The project ${gone} no longer exists, so Nexus shows every project again.`)
}

/**
 * Shows the project just added, unless the scope changed while the CLI added it, from `asked`, its revision then:
 * that choice is the newer one. Says which the pane shows.
 */
async function showAdded($: EngineInterface, asked: number, id: string) {
  const { isSet, shown } = await setScope($, id, asked)
  if (isSet) return 'Nexus shows its threads.'
  return `Nexus still shows ${shown === null ? 'every project' : `the project ${shown}`}, chosen while it was added.`
}

/**
 * `nexus project add`: the project added, its list read again. A CLI before 0.4.0 says only that it does not know the
 * command.
 */
async function addProject($: EngineInterface, add: { id: string; repoUrl: string; node: string; branch: string }): Promise<Outcome<NexusProject>> {
  // After `--` the CLI's parseArgs reads the ID and URL as given, though one starts with dashes.
  const got = await nexus($, ['project', 'add', `--node=${add.node}`, `--branch=${add.branch}`, '--', add.id, add.repoUrl])
  if (!got.ok && got.failure.message === 'unknown command project') {
    return { ok: false, failure: { kind: got.failure.kind, message: `${cli} has no project add command: adding a project needs Nexus CLI 0.4.0 or later (nexus --version)` } }
  }
  const added = parsed(got, parseAdded)
  if (added.ok) void loadCatalog($, { projects: true })
  return added
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
    // A port's CLI ran under the poller before this one, or the module before a reload: none is under way now. A
    // session's open or close outlives the pane, so only those a reload ended go.
    await update($, paneAtom, pane => ({
      ...pane,
      portChanges: {},
      sessionChanges: Object.fromEntries(
        Object.entries(pane.sessionChanges).map(([thread, changes]) => [
          thread,
          { ...changes, opening: changes.opening.filter(one => sessionOps.has(`open:${one.id}`)), closing: changes.closing.filter(pane => sessionOps.has(`close:${thread}:${pane}`)) },
        ]),
      ),
    }))
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
 * The pane opened by `/nexus` with nothing shown opens on the thread whose agent works in the project shown, the
 * newest when several do, reading the list first when no poll has.
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
  const working = inScope(threads, await read($, scopeAtom))
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
    sessionCursor: isSame ? pane.sessionCursor : null,
    listCursor: thread,
    draft: '',
    fields: putFields(pane.fields, { [COMPOSE]: '' }),
    start: null,
    session: null,
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
    was.mode === 'normal' && !was.overlay
      ? was
      : { ...was, mode: 'normal', overlay: null, pending: null, isRetaken: was.view === 'list', ...(was.mode === 'filter' ? { filter: '', fields: putFields(was.fields, { [FILTER]: '' }) } : {}) },
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

/**
 * Runs the pane's field changes one after another, in the order the engine delivered them. Each handler answers the
 * engine at once and writes later, and `update` tries again when its write misses: a burst (held backspace, fast
 * typing) could otherwise land out of order, the older text written last. A submit's snapshot queues here too.
 */
let fieldTurn: Promise<unknown> = Promise.resolve()
function inTurn<T>(fn: () => Promise<T>): Promise<T> {
  const turn = fieldTurn.then(fn)
  fieldTurn = turn.catch(() => undefined)
  return turn
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

/** `failure`, or for a CLI too old to have `command`, the version `doing` needs. */
const newer = (failure: NexusFailure, command: string, doing: string, version: string): NexusFailure =>
  failure.message === `unknown command ${command.split(' ')[0]}`
    ? { kind: failure.kind, message: `${cli} has no ${command} command: ${doing} needs Nexus CLI ${version} or later (nexus --version)` }
    : failure

/**
 * `nexus session open`: a Herdr workspace in the pylon with the harness's agent in it, Claude Code unless `harness`
 * names another, titled with the harness's name unless `title` is given. It wakes a paused pylon first and returns once
 * the agent is ready or waits for its human. `=` keeps a title that starts with a dash from reading as a flag.
 */
async function openSession($: EngineInterface, thread: string, open: { harness?: NexusHarness | undefined; title?: string | undefined }): Promise<Outcome<NexusOpenedSession>> {
  const flags = [...(open.harness ? [`--harness=${open.harness}`] : []), ...(open.title ? [`--title=${open.title}`] : [])]
  const got = await nexus($, ['session', 'open', ...flags, '--', thread], SESSION_MS)
  return got.ok ? parsed(got, parseOpenedSession) : { ok: false, failure: newer(got.failure, 'session open', 'opening a session', '0.5.0') }
}

/**
 * `nexus session close` by the session's `id`: its pane closed, which ends its agent, or a failed session in no pane
 * dropped, so no wake tries it again. The CLI never tries again: a paused session is refused (exit 5) and a pane not open
 * is not found (exit 4), each with the CLI's own message. Closing by an ID that is no pane (`isPaneless`) needs CLI
 * 0.8.0, so such a close that fails names the version when the CLI is older.
 */
async function closeSession($: EngineInterface, thread: string, id: string, isPaneless = false): Promise<Outcome<null>> {
  const got = await nexus($, ['session', 'close', '--', thread, id], SESSION_MS)
  if (got.ok) return parsed(got, parseSessionClosed)
  const failure = newer(got.failure, 'session close', 'closing a session', '0.5.0')
  if (failure !== got.failure || !isPaneless) return { ok: false, failure }
  const version = await cliVersion($)
  return {
    ok: false,
    failure: version && isOlder(version, [0, 8, 0]) ? { kind: failure.kind, message: `${cli} is ${version.join('.')}: closing a failed session needs Nexus CLI 0.8.0 or later (nexus --version)` } : failure,
  }
}

/** The CLI's version, or null when `--version` printed none or did not run. */
async function cliVersion($: EngineInterface): Promise<number[] | null> {
  try {
    const ran = await $.process.run([cli, '--version'], { timeoutMs: RUN_MS })
    return ran.exitCode === 0 ? parseVersion(ran.stdout) : null
  } catch {
    return null
  }
}

/**
 * The opens and closes this module runs, as `open:<n>` and `close:<thread>:<id>`: a pane started afresh drops the
 * rows of any other, which a reload ended. They run as `$.process.run`, so closing the pane does not end them.
 */
const sessionOps = new Set<string>()
/** Opens from the pane so far, which number each one's row. */
let sessionOpens = 0

const changeSessions = ($: EngineInterface, thread: string, change: (was: NexusSessionChanges) => NexusSessionChanges) =>
  update($, paneAtom, (pane): NexusPane => ({ ...pane, sessionChanges: { ...pane.sessionChanges, [thread]: change(pane.sessionChanges[thread] ?? NO_SESSION_CHANGES) } }))

/** A notice of how a session's open or close went: `here` while the pane shows `thread`, else `elsewhere`, which names it. */
const sayOf = ($: EngineInterface, thread: string, here: string, elsewhere: string, tone: 'dim' | 'error') =>
  update($, paneAtom, (pane): NexusPane => ({ ...pane, notice: { text: pane.selected === thread ? here : elsewhere, tone } }))

/** Opens a session from the pane, its row saying so while the CLI waits for the agent, then shown until the node reports it. */
async function openInPane($: EngineInterface, thread: string, harness: NexusHarness, title: string | null) {
  sessionOpens += 1
  const id = sessionOpens
  sessionOps.add(`open:${id}`)
  try {
    await changeSessions($, thread, was => ({ ...was, opening: [...was.opening, { id, harness, title }] }))
    await setPane($, () => ({ notice: { text: `Opening ${sessionName(harness, title)}. Its agent can take a minute to start.`, tone: 'dim' } }))
    const opened = await openSession($, thread, { harness, title: title ?? undefined })
    const at = await $.clock.now()
    // A wake can move the session to another pane before the node reports it: what is listed now tells it from those before.
    const shown = await read($, shownAtom)
    const listed = shown?.thread === thread && shown.detail ? shown.detail.sessions : null
    const before = listed && { ids: listed.map(one => one.id), harnessSessionIds: listed.flatMap(one => (one.harnessSessionId === null ? [] : [one.harnessSessionId])) }
    await changeSessions($, thread, was => ({ ...was, opening: was.opening.filter(one => one.id !== id), opened: opened.ok ? [...was.opened, { session: opened.value, at, before }] : was.opened }))
    if (!opened.ok) {
      const why = sentence(opened.failure.message)
      return await sayOf($, thread, `The session did not open: ${why}`, `The session in ${thread} did not open: ${why}`, 'error')
    }
    const { harness: opener, title: named, herdrPane } = opened.value
    const done = `Opened ${sessionName(opener, named)} in pane ${herdrPane}`
    const how = herdrWorkspace ? 'attaches to it in a new Herdr tab' : "copies nexus attach: run it in a terminal and pick the session's workspace in Herdr"
    await sayOf($, thread, `${done}. ⏎ in Sessions ${how}.`, `${done} of ${thread}.`, 'dim')
    void poll($)
  } finally {
    sessionOps.delete(`open:${id}`)
  }
}

/** The session `id` as the details list it, or as an open the pane confirmed; undefined when neither has it. */
async function sessionOf($: EngineInterface, thread: string, id: string): Promise<Pick<NexusSession, 'harness' | 'title' | 'herdrPane' | 'harnessSessionId' | 'state'> | undefined> {
  const shown = await read($, shownAtom)
  const listed = shown?.thread === thread ? shown.detail?.sessions.find(one => one.id === id) : undefined
  const opened = (await read($, paneAtom)).sessionChanges[thread]?.opened.find(one => one.session.herdrPane === id)?.session
  return listed ?? (opened && { ...opened, harnessSessionId: null, state: 'running' as const })
}

/**
 * Closes a running or failed session from the pane once the person says so; the Sessions tab offers no close of a
 * paused one. Keep comes first, so the dialog's default keeps it. A refusal shows the CLI's message as printed.
 */
async function closeInPane($: EngineInterface, thread: string, id: string) {
  const session = await sessionOf($, thread, id)
  const name = session ? sessionName(session.harness, session.title) : 'the session'
  const place = sessionPlace(id, session)
  const question = session?.state === 'failed' ? `Close ${name}, which the last wake did not bring back?` : `Close ${name} in ${place}? Its agent ends.`
  const answer = await $.ui.ask(question, ['Keep', 'Close']).catch(() => 'Keep')
  // The dialog leaves the keys at the prompt (live test, 2.1.310): the pane asks them back, onto its tab. Putting them
  // on the row as well gave them to the composer, in normal mode, when a quick close took the row away.
  if ((await $.ui.panes()).some(one => one.id === PANE)) await $.ui.open(OPEN)
  if (answer !== 'Close') return setPane($, () => ({ notice: { text: 'Kept the session.', tone: 'dim' } }))
  const op = `close:${thread}:${id}`
  const Place = place.replace(/^./, first => first.toUpperCase())
  if (sessionOps.has(op)) return setPane($, () => ({ notice: { text: `${Place} is already closing.`, tone: 'dim' } }))
  sessionOps.add(op)
  try {
    await changeSessions($, thread, was => ({ ...was, closing: [...was.closing, id] }))
    await setPane($, () => ({ notice: { text: `Closing ${place}…`, tone: 'dim' } }))
    const closed = await closeSession($, thread, id, session !== undefined && session.herdrPane !== id)
    const at = await $.clock.now()
    await changeSessions($, thread, was => ({
      ...was,
      closing: was.closing.filter(one => one !== id),
      ...(closed.ok
        ? { closed: { ...was.closed, [id]: { at, harnessSessionId: session?.harnessSessionId ?? null } }, opened: was.opened.filter(one => one.session.herdrPane !== id) }
        : {}),
    }))
    if (!closed.ok) {
      const why = sentence(closed.failure.message)
      return await sayOf($, thread, `${Place} was not closed: ${why}`, `${Place} of ${thread} was not closed: ${why}`, 'error')
    }
    await sayOf($, thread, `Closed ${place}.`, `Closed ${place} of ${thread}.`, 'dim')
    void poll($)
  } finally {
    sessionOps.delete(op)
  }
}

/**
 * The pane of the session `/nexus session close` without a pane closes: the person picks it, Keep them all first, so
 * the dialog's default and a dismissed dialog keep them. Else what to say instead.
 */
async function askSession($: EngineInterface, thread: string): Promise<Outcome<{ session: NexusSession } | { said: string }>> {
  const detail = parsed(await nexus($, ['show', thread]), parseDetail)
  if (!detail.ok) return detail
  // A paused session cannot be closed until it runs, so the dialog does not offer it.
  const sessions = detail.value.sessions.filter(one => one.state !== 'paused')
  const paused = detail.value.sessions.length - sessions.length
  if (sessions.length === 0) {
    const status = detail.value.thread.status
    return { ok: true, value: { said: paused ? `The sessions of ${thread} are paused: they resume on ${resumesOn(status)}, and can be closed once they run.` : `${thread} has no sessions.` } }
  }
  // The dialog takes four answers at most, Keep them all among them.
  if (sessions.length > 3) {
    return { ok: true, value: { said: `${thread} has ${sessions.length} sessions, more than the dialog lists. /nexus session close ${thread} <id> closes one of ${sessions.map(one => one.id).join(', ')}.` } }
  }
  const labels = sessions.map(one => `${sessionName(one.harness, one.title)} in ${sessionPlace(one.id, one)}, ${one.state === 'failed' ? 'failed' : one.status}`)
  const answer = await $.ui.ask(`Close which session of ${thread}?`, ['Keep them all', ...labels]).catch(() => 'Keep them all')
  const session = sessions[labels.indexOf(answer)]
  return { ok: true, value: session ? { session } : { said: `Kept the sessions of ${thread}.` } }
}

/** How to attach a terminal on this Mac to the thread's sessions: Claude Code cannot hand its own terminal over. */
const attachHow = (thread: string) =>
  `Claude Code cannot give its terminal to the attach, so run this in a terminal or a Herdr tab:\n\n  ${attachCommand(cli, thread)}\n\nEach session is a workspace in the pylon's Herdr: pick one there, and detach from Herdr to come back. ${SSH_HINT}`

/**
 * `nexus attach` in a new tab of the Herdr workspace Claude Code runs in, put in front: Claude Code cannot hand its
 * own terminal over, and a Herdr tab can. The tab's shell runs it, so the detach leaves the tab at its shell, with any
 * error of ssh's still there to read. Resolves the tab's label.
 */
async function attachInHerdr($: EngineInterface, workspace: string, thread: string): Promise<Outcome<string>> {
  // The ID is typed into a shell: only one of the CLI's own form goes there.
  if (!FULL_ID.test(thread)) return failed(`${thread} is not a thread ID`)
  const label = `nexus attach ${(await lookUpTitle($, thread)) ?? thread}`
  const created = await herdr($, ['tab', 'create', '--workspace', workspace, '--label', label, '--focus'])
  if (!created.ok) return created
  const pane = parseHerdrTab(created.value)
  if (!pane) return failed('herdr tab create printed no pane')
  const ran = await herdr($, ['pane', 'run', pane, attachCommand(cli, thread)])
  return ran.ok ? { ok: true, value: label } : ran
}

/** One herdr command: its stdout, or why it failed. */
async function herdr($: EngineInterface, args: string[]): Promise<Outcome<string>> {
  const name = `herdr ${args.slice(0, 2).join(' ')}`
  try {
    const ran = await $.process.run(['herdr', ...args], { timeoutMs: HERDR_MS })
    return ran.exitCode === 0 ? { ok: true, value: ran.stdout } : failed(`${name} failed: ${herdrError(ran.exitCode, ran.stdout, ran.stderr)}`)
  } catch (error) {
    return failed(`${name} did not run: ${messageOf(error)}`)
  }
}

/** Herdr sets both for what runs in its panes. */
async function readHerdr($: EngineInterface) {
  const [isHerdr, workspace] = await Promise.all([$.env.get('HERDR_ENV'), $.env.get('HERDR_WORKSPACE_ID')])
  herdrWorkspace = isHerdr === '1' && workspace ? workspace : null
}

/** Where the attach runs, and the way back from it. */
const tabOpened = (label: string) =>
  `Opened the Herdr tab "${label}" in this workspace, attaching to the pylon's Herdr: pick a session's workspace there. To come back, detach from the pylon's Herdr, then close that tab or switch back to this one.`

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
    case 'scope':
      return say(await scopeCommand($, command.project))
    case 'add-project': {
      const { verb: _, ...add } = command
      const asked = scopeRevision
      const added = await addProject($, { ...add, branch: add.branch ?? 'main' })
      // The transcript heads a reply with the plugin's name: a failure reads `nexus: <the CLI's message>`.
      if (!added.ok) return added.failure.message
      return `Added the project ${added.value.id} (${added.value.repoUrl}) on ${added.value.defaultNode}. ${await showAdded($, asked, added.value.id)}`
    }
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
    case 'session-open': {
      const id = await resolveThread($, command.thread)
      if (!id.ok) return say(id)
      $.ui.toast(`Opening ${sessionName(command.harness ?? 'claude-code', command.title)} in ${id.value}. Its agent can take a minute to start.`)
      const opened = await openSession($, id.value, command)
      if (!opened.ok) return say(opened)
      void poll($)
      return `Opened ${sessionName(opened.value.harness, opened.value.title)} in pane ${opened.value.herdrPane} of ${id.value}. /nexus session attach ${id.value} ${herdrWorkspace ? 'attaches to it in a new Herdr tab' : 'gives the command that attaches a terminal to it'}.`
    }
    case 'session-close': {
      const id = await resolveThread($, command.thread)
      if (!id.ok) return say(id)
      // A session named outright goes to the CLI as it is, which refuses a paused one and a pane that is not open.
      if (command.session) {
        const closed = await closeSession($, id.value, command.session, command.session.startsWith('failed-'))
        if (!closed.ok) return say(closed)
        void poll($)
        return `Closed session ${command.session} of ${id.value}.`
      }
      const asked = await askSession($, id.value)
      if (!asked.ok) return say(asked)
      if ('said' in asked.value) return asked.value.said
      const { session } = asked.value
      const closed = await closeSession($, id.value, session.id, session.herdrPane !== session.id)
      if (!closed.ok) return say(closed)
      void poll($)
      return `Closed ${sessionPlace(session.id, session)} of ${id.value}.`
    }
    case 'attach': {
      const id = await resolveThread($, command.thread)
      if (!id.ok) return say(id)
      if (!herdrWorkspace) return attachHow(id.value)
      const opened = await attachInHerdr($, herdrWorkspace, id.value)
      return opened.ok ? tabOpened(opened.value) : `The Herdr tab did not open: ${sentence(opened.failure.message)} ${attachHow(id.value)}`
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

/** `/nexus project [id|all]`: which project's threads show, or a switch to another, which must exist. */
async function scopeCommand($: EngineInterface, project: string | null | undefined): Promise<Outcome<string>> {
  if (project === undefined) {
    const shown = await read($, scopeAtom)
    return { ok: true, value: shown === null ? 'Nexus shows every project. /nexus project <id> shows one.' : `Nexus shows the project ${shown}. /nexus project all shows every project.` }
  }
  if (project === null) {
    await setScope($, null)
    return { ok: true, value: 'Nexus shows every project.' }
  }
  const projects = parsed(await nexus($, ['projects']), parseProjects)
  if (!projects.ok) return projects
  if (!projects.value.some(one => one.id === project)) {
    const known = projects.value.map(one => one.id)
    const list = known.length === 0 ? 'There are none yet' : `The projects are ${known.length === 1 ? known[0] : `${known.slice(0, -1).join(', ')} and ${known.at(-1)}`}`
    return failed(`there is no project ${project}. ${list}`)
  }
  await setScope($, project)
  return { ok: true, value: `Nexus shows the project ${project}.` }
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

/** The open a session form's title, as `putFields` takes it. */
const sessionTexts = (draft: NexusSessionDraft) => ({ [SESSION_KEYS.title]: draft.title })

/** The new project form's texts by field, as `putFields` takes them. */
const projectTexts = (draft: NexusProjectDraft) => ({ [PROJECT_KEYS.id]: draft.id, [PROJECT_KEYS.repoUrl]: draft.repoUrl, [PROJECT_KEYS.branch]: draft.branch })

/** The pane with each field put again with the text it holds for it: a closed pane's fields forget what was typed. */
const refilled = (pane: NexusPane): NexusPane => ({
  ...pane,
  fields: putFields(pane.fields, {
    [COMPOSE]: pane.draft,
    [FILTER]: pane.filter,
    ...(pane.start ? startTexts(pane.start) : {}),
    ...(pane.project ? projectTexts(pane.project) : {}),
    ...(pane.session ? sessionTexts(pane.session) : {}),
  }),
})

/**
 * Opens the start form, its project and title given for Start again, else on the project shown, and reads the projects
 * and nodes it offers. A project shown that no longer exists gives way to the first, as the scope goes back to all.
 */
async function openStart($: EngineInterface, project?: string, title?: string) {
  const scope = await read($, scopeAtom)
  await setPane($, pane => {
    const start = emptyStart(project ?? scope ?? '', title)
    return { view: 'start', mode: 'normal', overlay: null, start, fields: putFields(pane.fields, startTexts(start)) }
  })
  await loadCatalog($, { projects: true })
  const { projects } = await read($, catalogAtom)
  await update($, paneAtom, pane => {
    if (!pane.start) return pane
    const offered = projects?.some(one => one.id === pane.start!.project)
    if (pane.start.project && !offered && projects && project !== undefined) return { ...pane, start: { ...pane.start, project: '', error: `Project ${pane.start.project} is not offered here.` } }
    if (pane.start.project && !offered && projects) return projects[0] ? { ...pane, start: { ...pane.start, project: projects[0].id } } : { ...pane, start: { ...pane.start, project: '' } }
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

/** The node a new project's pylons boot on unless chosen: the first online, as pi-nexus picks, else the first. */
const firstNode = (catalog: NexusCatalog) => (catalog.nodes?.find(node => node.state === 'online') ?? catalog.nodes?.[0])?.name ?? ''

/** Opens the new project form over the view the picker was on, and reads the nodes it offers afresh. */
async function openProjectForm($: EngineInterface) {
  const draft: NexusProjectDraft = { id: '', repoUrl: '', node: firstNode(await read($, catalogAtom)), branch: '', error: null, isAdding: false, request: 0 }
  await setPane($, pane => ({ view: 'project', mode: 'normal', overlay: null, project: draft, fields: putFields(pane.fields, projectTexts(draft)) }))
  await loadCatalog($, { projects: false })
  const node = firstNode(await read($, catalogAtom))
  await update($, paneAtom, pane => (pane.project && !pane.project.node ? { ...pane, project: { ...pane.project, node } } : pane))
}

const setProjectDraft = ($: EngineInterface, change: Partial<NexusProjectDraft>) =>
  update($, paneAtom, pane => (pane.project ? { ...pane, project: { ...pane.project, ...change } } : pane))

/**
 * Adds the project the form describes and shows its threads; a failure stays on the form with the CLI's message as it
 * printed it, since it names what to fix. One that ends after the person left the form only says how it went.
 */
async function submitProject($: EngineInterface, draft: NexusProjectDraft | null) {
  if (!draft || draft.isAdding) return
  const add = { id: draft.id.trim(), repoUrl: draft.repoUrl.trim(), node: draft.node, branch: draft.branch.trim() || 'main' }
  const missing = !add.id ? 'A project needs an ID.' : !add.repoUrl ? 'A project needs a repo URL.' : !add.node ? 'Pick the node its pylons boot on.' : null
  if (missing) return void (await setProjectDraft($, { error: missing }))
  adds += 1
  const request = adds
  await setProjectDraft($, { isAdding: true, error: null, request })
  const asked = scopeRevision
  const added = await addProject($, add)
  const where = added.ok ? await showAdded($, asked, added.value.id) : ''
  let left: string | null | undefined
  const committed = await update($, paneAtom, (pane): NexusPane => {
    left = undefined
    if (pane.view !== 'project' || pane.project?.request !== request) {
      const said = added.ok ? `Added the project ${added.value.id}. ${where}` : `The project was not added: ${added.failure.message}`
      return { ...pane, notice: { text: said, tone: added.ok ? 'dim' : 'error' } }
    }
    if (!added.ok) return { ...pane, project: { ...pane.project, isAdding: false, error: added.failure.message } }
    left = pane.selected
    const { id, repoUrl, defaultNode } = added.value
    return { ...listView(pane), notice: { text: `Added the project ${id} (${repoUrl}) on ${defaultNode}. ${where}`, tone: 'dim' } }
  })
  if (left !== undefined) await listShown($, left, committed)
}

/** Opens the form that opens a session in the pylon of the thread shown, Claude Code chosen and no title. */
async function openSessionForm($: EngineInterface) {
  const draft: NexusSessionDraft = { harness: 'claude-code', title: '' }
  await setPane($, pane => (pane.selected ? { view: 'session', mode: 'normal', overlay: null, session: draft, fields: putFields(pane.fields, sessionTexts(draft)) } : {}))
}

/**
 * Opens the session the form describes: the form gives way to the Sessions tab at once, where the session shows as
 * opening while the CLI wakes the pylon and starts the agent, as pi-nexus does.
 */
async function submitSession($: EngineInterface, draft: NexusSessionDraft | null) {
  let thread: string | null = null
  await update($, paneAtom, (pane): NexusPane => {
    thread = pane.view === 'session' ? pane.selected : null
    return thread ? { ...pane, view: 'thread', tab: 'sessions', mode: 'normal', session: null } : pane
  })
  if (!thread || !draft) return
  await focusRing($, await read($, paneAtom))
  await openInPane($, thread, draft.harness, draft.title.trim() || null)
}

/** The pane on the list, the cursor on the thread it left. */
const listView = (was: NexusPane): NexusPane => ({
  ...was,
  view: 'list',
  selected: null,
  mode: 'normal',
  overlay: null,
  pending: null,
  notice: null,
  draft: '',
  start: null,
  project: null,
  session: null,
  toggled: {},
  scroll: null,
  detailsTop: 0,
  portCursor: null,
  sessionCursor: null,
  listCursor: was.selected ?? was.listCursor,
})

/** After the list took the place of the thread `left`: its watch stopped, what was read of it dropped, the list polled. */
async function listShown($: EngineInterface, left: string | null, pane: NexusPane) {
  watcher?.stop()
  if (left) void markSeen($, left)
  await Promise.all([$.state.set(WATCH, null), $.state.set(LIVE, null), $.state.set(SHOWN, null)])
  void poll($)
  await focusRing($, pane)
}

/** Back to the list from a thread, a form, or the list itself. */
async function showList($: EngineInterface) {
  let left: string | null = null
  const pane = await update($, paneAtom, was => {
    left = was.selected
    return listView(was)
  })
  await listShown($, left, pane)
}

/**
 * Shows the threads of `project`, or every project's for null, and puts the picker away: a thread view gives way to
 * the list. Enter on a row comes as the row's own press, which no key step closed the picker for.
 */
async function chooseScope($: EngineInterface, project: string | null) {
  await setScope($, project)
  const pane = await update($, paneAtom, was => (was.overlay?.kind === 'projects' ? { ...was, overlay: null } : was))
  if (pane.view !== 'list') await showList($)
}

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
    // The new project form goes back to the picker it was opened from, over the list or the thread.
    if (view === 'project') return setPane($, () => ({ view: selected ? 'thread' : 'list', mode: 'normal', project: null, overlay: { kind: 'projects', cursor: 'scope-new' } }))
    if (view === 'session' && selected) {
      await setPane($, () => ({ view: 'thread', mode: 'normal', session: null }))
      return focusRing($, await read($, paneAtom))
    }
    await showList($)
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
      case 'open-session':
        return openSessionForm($)
      case 'attach': {
        const { selected } = await read($, paneAtom)
        return selected ? attach(selected, false) : undefined
      }
      case 'delete':
        return onShown(id => confirmDelete($, id))
      default:
        return onShown(id => act($, action, id))
    }
  }
  /** Attaches in a Herdr tab inside Herdr, unless `isCopy`; else copies `nexus attach` and says where to run it. */
  const attach = async (thread: string, isCopy: boolean) => {
    const opened = !isCopy && herdrWorkspace ? await attachInHerdr($, herdrWorkspace, thread) : null
    if (opened?.ok) return setPane($, () => ({ notice: { text: tabOpened(opened.value), tone: 'dim' } }))
    const why = opened ? `The Herdr tab did not open: ${sentence(opened.failure.message)} ` : ''
    const command = attachCommand(cli, thread)
    const copied = await $.ui.copy({ text: command, surface })
    const how = "run it in a terminal or a Herdr tab, pick the session's workspace in Herdr, and detach from Herdr to come back."
    await setPane($, () => ({
      notice: copied.isCopied ? { text: `${why}Copied ${command}: ${how}`, tone: opened ? 'error' : 'dim' } : { text: `${why}Not copied (${copied.reason}), so type ${command}: ${how}`, tone: 'error' },
    }))
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
      case 'projects':
        return loadCatalog($, { projects: true })
      case 'scope':
        return chooseScope($, effect.project)
      case 'new-project':
        return openProjectForm($)
      case 'new-session':
        return openSessionForm($)
      case 'close-session':
        return closeInPane($, effect.thread, effect.id)
      case 'attach':
        return attach(effect.thread, effect.isCopy)
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
          return { ...step.pane, isRetaken: false }
        })
        for (const effect of effects) await perform(effect)
      }),
    effect: effect =>
      run(async () => {
        if (effect.kind === 'open') {
          let isHeld = false
          await update($, paneAtom, pane => {
            isHeld = pane.isRetaken
            return isHeld ? { ...pane, isRetaken: false } : pane
          })
          if (isHeld) {
            const title = (await read($, listAtom)).threads?.find(thread => thread.id === effect.thread)?.title ?? effect.thread
            return setPane($, () => ({ notice: { text: `The pane took the keys back after losing them, so that Enter opened nothing. Enter again opens ${title}.`, tone: 'dim' } }))
          }
        }
        return perform(effect)
      }),
    toggle: (key, isOpen) => run(() => update($, paneAtom, pane => ({ ...pane, toggled: { ...pane.toggled, [key]: !isOpen } }))),
    tab: tab =>
      run(async () => {
        await setPane($, () => ({ tab, mode: 'normal', overlay: null, pending: null }))
        await showTab(tab)
      }),
    // Each change of the filter opens the closed groups it matches afresh, as the dashboard's does, so a group the
    // person folded or opened before follows the new filter.
    filter: (text, at) => run(() => inTurn(() => update($, paneAtom, pane => (isDrawn(pane, at) ? filtered(pane, text) : pane)))),
    filterDone: text =>
      run(() => inTurn(async () => {
        const threads = inScope((await read($, listAtom)).threads ?? [], await read($, scopeAtom))
        // Enter's text is the filter, though its last change may not have landed yet, so its first match is read from
        // the list here, not from a drawing made for an older filter. An empty filter keeps every thread, so the cursor
        // stays where the person left it. Enter emptied the field, so f would edit nothing: it is put again.
        const pane = await update($, paneAtom, (was): NexusPane => {
          const next = filtered(was, text)
          const first = text.trim() === '' ? undefined : listOrder(groupThreads(threads, text, next.toggled)).find(one => !one.id.startsWith('closed-'))
          return { ...next, mode: 'normal', listCursor: first?.id ?? was.listCursor, listTop: 0, fields: putFields(was.fields, { [FILTER]: text }) }
        })
        await focusRing($, pane)
      })),
    draft: text => run(() => inTurn(() => update($, paneAtom, pane => ({ ...pane, draft: text })))),
    submit: text =>
      run(async () => {
        // An empty Enter is back to normal mode; a sent message keeps the composer, as Claude Code's prompt does.
        if (!text.trim()) {
          await inTurn(() => setPane($, () => ({ mode: 'normal' })))
          return focusRing($, await read($, paneAtom))
        }
        await inTurn(() => setPane($, () => ({ draft: '' })))
        await onShown(id => send($, id, text.trim()))
      }),
    back: () => run(back),
    startDraft: (change, at) =>
      run(() => inTurn(() => update($, paneAtom, pane => (pane.start && (at === undefined || isDrawn(pane, at)) ? { ...pane, start: { ...pane.start, ...change, error: null } } : pane)))),
    startProject: project =>
      run(() =>
        inTurn(() =>
          update($, paneAtom, pane =>
            pane.start ? { ...pane, start: { ...pane.start, project, node: '', branch: '', error: null }, fields: putFields(pane.fields, { [START_KEYS.branch]: '' }) } : pane,
          ),
        ),
      ),
    startSubmit: change =>
      run(async () => {
        // What starts is the form as Enter left it: the engine empties the field at once, and typing there after Enter
        // is the next draft's. A form still open once the start is answered gets Enter's text back, if not typed over.
        const { start: sent } = await inTurn(() => setStart($, change ?? {}))
        await submitStart($, sent)
        if (change) await inTurn(() => putBack($, START_KEYS, change, pane => pane.start))
      }),
    projectDraft: (change, at) =>
      run(() => inTurn(() => update($, paneAtom, pane => (pane.project && (at === undefined || isDrawn(pane, at)) ? { ...pane, project: { ...pane.project, ...change, error: null } } : pane)))),
    projectSubmit: change =>
      run(async () => {
        // As the start form's: what is added is the form as Enter left it, and a form still open gets Enter's text back.
        const { project: sent } = await inTurn(() => setProjectDraft($, change ?? {}))
        await submitProject($, sent)
        if (change) await inTurn(() => putBack($, PROJECT_KEYS, change, pane => pane.project))
      }),
    sessionDraft: (change, at) =>
      run(() => inTurn(() => update($, paneAtom, pane => (pane.session && (at === undefined || isDrawn(pane, at)) ? { ...pane, session: { ...pane.session, ...change } } : pane)))),
    // The form closes on Enter, so no field is put back: what opens is the form as Enter left it.
    sessionSubmit: change =>
      run(async () => {
        const { session: sent } = await inTurn(() => update($, paneAtom, pane => (pane.session ? { ...pane, session: { ...pane.session, ...change } } : pane)))
        await submitSession($, sent)
      }),
  }
}

/** Rows an inline pane takes at most: above the prompt it shares the screen with the transcript. */
const INLINE_ROWS = 24

export const register: Register = (on, options) => {
  if (typeof options.cli === 'string' && options.cli.trim()) cli = options.cli.trim()

  on('session.start', async ($, e, next) => {
    await Promise.all([
      $.command.register({ name: 'nexus', description: 'Drive Nexus threads: the pane, new, send, open, unpublish, archive, abort, retry, delete, strip, project, session', argumentHint: '[help]', immediate: true }),
      ...Object.values(TOOLS).map(spec => $.tool.register(spec)),
      loadStrip($),
      loadScope($),
      readHerdr($),
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
    const [strip, list, watch, shown, now, cursor, scope] = await Promise.all([
      read($, stripAtom),
      read($, listAtom),
      read($, watchAtom),
      read($, shownAtom),
      read($, nowAtom),
      read($, stripCursorAtom),
      read($, scopeAtom),
    ])
    if (!strip.isOn) return next(e)
    // The list has no parked tasks: only the thread the pane watches is known to hold them.
    const parked = new Set([...(watch?.state?.run === 'parked' ? [watch.thread] : []), ...(shown?.detail?.agent?.parkedTasks ? [shown.thread] : [])])
    const chips = stripChips(inScope(list.threads ?? [], scope), strip, Math.max(now, list.polledAt ?? 0), parked)
    if (chips.length === 0 && !(list.failure && !list.threads)) return next(e)
    return StripView($.ui.resolve(e), list, chips, e.props.bodyColumns, cursor, scope, id => void openFromStrip($, id))
  })

  on('ui.focus', { component: 'AbovePrompt' }, async ($, e, next) => {
    await $.state.set(STRIP_CURSOR, e.plugin === 'nexus' ? (e.element ?? null) : null)
    return next(e)
  })

  // The arrows, Tab and a click move the ring themselves: the cursor and the mode follow it.
  on('ui.focus', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const element = e.element
    if (e.origin.kind === 'person' && element) await update($, paneAtom, pane => ({ ...ringMoved(pane, element), isRetaken: false }))
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
    const [list, watch, live, shown, catalog, pane, now, scope] = await Promise.all([
      read($, listAtom),
      read($, watchAtom),
      read($, liveAtom),
      read($, shownAtom),
      read($, catalogAtom),
      read($, paneAtom),
      read($, nowAtom),
      read($, scopeAtom),
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
      scope,
      now: Math.max(now, list.polledAt ?? 0),
      width: Math.max(24, e.props.bodyColumns),
      rows: e.props.placement === 'dock' ? e.props.scroll.bodyRows : Math.min(e.props.scroll.bodyRows, INLINE_ROWS),
      placement: e.props.placement,
      isFocused: e.props.isFocused,
      surface: e.surface,
      inHerdr: herdrWorkspace !== null,
      cli,
    }
    const actions = paneActions($, e.surface)
    const tree =
      pane.view === 'start'
        ? StartView(draw, scene, actions)
        : pane.view === 'project'
          ? ProjectView(draw, scene, actions)
          : pane.view === 'session'
            ? SessionView(draw, scene, actions)
            : !pane.selected || pane.view === 'list'
              ? ListView(draw, scene, actions)
              : ThreadView(draw, scene, actions)
    rehome($, tree, pane, e.props.isFocused)
    return tree
  })
}
