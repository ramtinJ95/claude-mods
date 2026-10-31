import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface, Timer } from 'claude-code'

import type {
  NexusCatalog,
  NexusChangedFile,
  NexusBase,
  NexusCheckout,
  NexusClaudeShown,
  NexusDetail,
  NexusDiffShown,
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
  ATTACH_HINT,
  BASES,
  type Action,
  type Reply,
  FULL_ID,
  HARNESS_LABEL,
  NO_CHANGE,
  NO_SESSION_CHANGES,
  USAGE,
  type ClaudeReading,
  type WatchEntry,
  type WatchEvent,
  ago,
  attachCommand,
  applyEvent,
  canReadCheckout,
  changesArgv,
  checkoutFacts,
  checkoutTrigger,
  diffArgv,
  fileKey,
  isNoBase,
  parseChanges,
  parseDiff,
  parseDiffReply,
  closedKey,
  groupThreads,
  herdrError,
  isSettled,
  keepTail,
  kept,
  foldReply,
  inScope,
  leftOut,
  listOrder,
  matchThread,
  parseCommand,
  parseAdded,
  projectJson,
  onlineNode,
  parseDetail,
  parseFailure,
  parseHerdrTab,
  parseNodes,
  parseOpenedSession,
  parsePreview,
  parseProjects,
  parseSessionClosed,
  parseClaudeConversation,
  parseSent,
  sentText,
  type Sent,
  claudeWatch,
  claudeState,
  rowsReply,
  rowsText,
  parseVersion,
  isOlder,
  isPaneRunning,
  isWorkerDone,
  isWorkerIdle,
  hasDrawnReply,
  transcriptHolds,
  isUnread,
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
import { needsHuman, portFacts, projectArgs, TOOLS } from './tools'
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
/** A `$.process.run` of `send`: for a Claude Code worker the CLI tries a paused pylon again once a second for up to 120 s. */
const SEND_MS = 160_000
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
const CLAUDE = { plugin: 'nexus', key: 'claude' } as const
const claudeAtom = atom(CLAUDE, null)
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
  changesCursor: null,
  diff: null,
  portCursor: null,
  pylonCursor: null,
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
const stripAtom = atom(STRIP, { isOn: true })
const SCOPE = { plugin: 'nexus', key: 'scope' } as const
/** What `$.store` keeps under `project`, mirrored here so a change draws the list and the strip again. */
const scopeAtom = atom(SCOPE, null)
const STRIP_CURSOR = { plugin: 'nexus', key: 'stripCursor' } as const
const stripCursorAtom = atom(STRIP_CURSOR, null)
const CHECKOUT = { plugin: 'nexus', key: 'checkout' } as const
const checkoutAtom = atom(CHECKOUT, null)
const DIFF = { plugin: 'nexus', key: 'diff' } as const
const diffAtom = atom(DIFF, null)
const CHANGES_BASE = { plugin: 'nexus', key: 'changesBase' } as const
/** What `$.store` keeps under `changesBase`, mirrored here so a change draws the Changes tab again. */
const changesBaseAtom = atom(CHANGES_BASE, 'start')

/** The CLI to run, from the `cli` option. */
let cli = 'nexus'
/** The Herdr workspace Claude Code runs in, read at session start: Enter's attach opens a tab there. Null outside Herdr. */
let herdrWorkspace: string | null = null
/**
 * The pane's two processes at most: one poll at a time, of `threads` for the list or `show` for the thread shown,
 * and one watch of that thread. The ticker only reads the watch's state, to move the run clock while it works.
 */
let poller: { timer: Timer; ticker: Timer; isBusy: boolean; isAgain: boolean; stop: () => void; stopped: Promise<void> } | undefined
/** The second ask for the keyboard after `/nexus`, cancelled when the pane closes first. */
let refocus: Timer | undefined
let watcher: { thread: string; stop: () => void } | undefined
/**
 * The Changes tab's children: at most one `changes` and one `diff`, each a child of the pane killed when it closes,
 * and stopped when the pane leaves their thread or a newer diff takes the place of one.
 */
let changesChild: { thread: string; stop: () => void } | undefined
let diffChild: { thread: string; stop: () => void } | undefined
/** The Herdr tab's pane where the pane last started `nexus attach`, and its thread. */
let attached: { thread: string; pane: string } | undefined
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

/** The CLI that added the attention, the seen marker and the reply time to every thread, which the list and the details read. */
const ATTENTION_CLI = [0, 10, 0]

/** `parse` over `threads` or `show`, a contract error from a CLI before 0.10.0 naming the version it needs. */
async function threadsJson<T>($: EngineInterface, got: Outcome<unknown>, parse: (json: unknown) => T, budget?: Budget): Promise<Outcome<T>> {
  const value = parsed(got, parse)
  if (value.ok || !got.ok) return value
  return { ok: false, failure: await olderThan($, value.failure, ATTENTION_CLI, 'reading threads with their unread replies', budget) }
}

const threadsFrom = ($: EngineInterface, got: Outcome<unknown>) => threadsJson($, got, parseThreads)
const detailFrom = ($: EngineInterface, got: Outcome<unknown>, budget?: Budget) => threadsJson($, got, parseDetail, budget)

async function listThreads($: EngineInterface, project?: string): Promise<Outcome<NexusThreadRow[]>> {
  return threadsFrom($, await nexus($, ['threads', ...(project ? [`--project=${project}`] : [])]))
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
  const words = argv[0] === 'project' || argv[0] === 'session' ? 2 : 1
  const end = await runChild(
    $,
    [...argv.slice(0, words), '--json', ...argv.slice(words)],
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

async function toolJson($: EngineInterface, args: readonly string[], signal: AbortSignal, ms = RUN_MS): Promise<Outcome<unknown>> {
  if (signal.aborted) return failed('cancelled')
  if (ms <= 0) return failed('timed out')
  const { promise, stop } = stopper()
  const timer = $.clock.after(ms, stop)
  signal.addEventListener('abort', stop)
  try {
    const got = await childJson($, args, promise)
    return signal.aborted ? failed('cancelled') : got ?? failed('timed out')
  } finally {
    timer.cancel()
    signal.removeEventListener('abort', stop)
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
      const threads = await threadsFrom($, got)
      await update($, listAtom, (list): NexusList => (threads.ok ? { threads: threads.value, failure: null, polledAt: now } : { ...list, failure: threads.failure }))
      return
    }
    const detail = await detailFrom($, got)
    if ((await read($, paneAtom)).selected !== thread) return
    const shownBefore = await read($, shownAtom)
    const before = shownBefore?.thread === thread ? shownBefore.detail : null
    if (detail.ok) {
      void recordVisit($, detail.value.thread)
      await patchRow($, detail.value)
    }
    await update($, shownAtom, (shown): NexusShown =>
      detail.ok
        ? { thread, detail: detail.value, askedSeq, failure: null }
        : shown?.thread === thread
          ? { ...shown, failure: detail.failure }
          : { thread, detail: null, askedSeq, failure: detail.failure },
    )
    if (detail.ok) void noticeCheckout($, thread, before, detail.value)
    // The opens and closes these details show, or that waited long enough for them, are drawn from the details now.
    const changes = (await read($, paneAtom)).sessionChanges[thread]
    if (detail.ok && changes && settleSessions(changes, detail.value.sessions, now) !== changes) {
      await changeSessions($, thread, was => settleSessions(was, detail.value.sessions, now))
    }
    if (!detail.ok) return
    // While the person is attached to the pylon in a Herdr tab, the worker's transcript is not read: they see it there.
    const isDrawn =
      detail.value.conversation === 'claude'
        ? !(await isAttached($, thread)) && transcriptHolds(await readClaude($, thread, current), detail.value.thread.lastReplyAt)
        : hasDrawnReply(await read($, watchAtom), thread)
    const { selected: still, view: on, tab, overlay } = await read($, paneAtom)
    if (!isDrawn || still !== thread || on !== 'thread' || tab !== 'conversation' || overlay) return
    // The person reads the reply in the pane: once every client counts it seen, the details read again drop it.
    const reply = detail.value.thread.lastReplyAt
    displayed.set(thread, reply)
    if (isUnread(detail.value.thread) && refusedSeen.get(thread) !== reply) void seenRefusal($).then(refusal => markSeen($, thread, reply, refusal).then(seen => seen && pollAgain($)))
  } finally {
    current.isBusy = false
    if (current.isAgain && poller === current) {
      current.isAgain = false
      void poll($)
    }
  }
}

/**
 * The Claude Code worker transcript of the thread shown, as part of its poll, since `nexus watch` streams none: one
 * `nexus conversation`, which never wakes the pylon and reads it only while it runs. A failed read keeps the rows it had.
 * Says when the transcript was read from the pylon, null when it never was or the read failed.
 */
async function readClaude($: EngineInterface, thread: string, current: NonNullable<typeof poller>): Promise<number | null> {
  const got = await childJson($, ['conversation', thread], current.stopped)
  if (!got || poller !== current || (await read($, paneAtom)).selected !== thread) return null
  const reading = parsed(got, parseClaudeConversation)
  await update($, claudeAtom, (was): NexusClaudeShown =>
    reading.ok
      ? { thread, ...kept(reading.value.rows, reading.value.dropped), working: reading.value.working, queued: reading.value.queued, readAt: reading.value.readAt, failure: null }
      : { ...(was?.thread === thread ? was : { thread, rows: [], dropped: 0, working: false, queued: [], readAt: null }), failure: reading.failure.message },
  )
  return reading.ok ? reading.value.readAt : null
}

/** Polls now, or once the poll under way ends, since that one may have read what was there before a change. */
function pollAgain($: EngineInterface) {
  if (poller?.isBusy) poller.isAgain = true
  else void poll($)
}

/** Moves the run clock while the thread shown works, so its timer and spinner tick. */
async function tick($: EngineInterface) {
  const [watch, claude] = await Promise.all([read($, watchAtom), read($, claudeAtom)])
  if (watch?.state?.run === 'working' || claude?.working) await $.state.set(NOW, await $.clock.now())
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
      isAgain: false,
      stop,
      stopped: promise,
    }
    // The projects too: the list heads each with its default branch.
    void loadCatalog($, { projects: true })
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
    const got = await threadsFrom($, await nexus($, ['threads', '--all']))
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
    changesCursor: isSame ? pane.changesCursor : null,
    diff: isSame ? pane.diff : null,
    portCursor: isSame ? pane.portCursor : null,
    pylonCursor: isSame ? pane.pylonCursor : null,
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
  let left: string | null = null
  await setPane($, pane => {
    left = pane.view === 'thread' && pane.selected !== thread ? pane.selected : null
    return threadView(pane, thread)
  })
  if (left) void markLeft($, left)
  refusedSeen.delete(thread)
  await followThread($, thread)
}

/**
 * Whether the strip shows, as `$.store` kept it. A store written before the control plane kept the seen marker also
 * holds what the person saw then: it is written again without it.
 */
async function loadStrip($: EngineInterface) {
  const stored = (await $.store.get('strip')) as Record<string, unknown> | undefined
  const strip: NexusStrip = { isOn: stored?.isOn !== false }
  await $.state.set(STRIP, strip)
  if (stored && Object.keys(stored).some(key => key !== 'isOn')) await $.store.set('strip', strip)
}

async function saveStrip($: EngineInterface, change: (strip: NexusStrip) => NexusStrip) {
  await $.store.set('strip', await update($, stripAtom, change))
}

/** The threads whose `nexus seen` runs, so a poll that comes again before it ends does not start a second. */
const seeing = new Set<string>()
/** The reply whose mark failed, by thread: polls leave it until another reply comes or the thread is opened again. */
const refusedSeen = new Map<string, number | null>()
/** The latest reply the pane showed in each thread's conversation, by its `lastReplyAt`: what leaving the thread may mark. */
const displayed = new Map<string, number | null>()

/** The CLI whose `seen` takes the reply shown (`--last-reply-at`), so a mark never passes it. */
const SEEN_AT_CLI = [0, 19, 0]

/** Leaving `thread` marks the reply the pane showed there, and no newer one. */
async function markLeft($: EngineInterface, thread: string): Promise<boolean> {
  if (!displayed.has(thread)) return false
  const reply = displayed.get(thread) ?? null
  displayed.delete(thread)
  if (reply === null) return false
  return markSeen($, thread, reply, await seenRefusal($))
}

/**
 * Why `seen` cannot mark only the reply shown, read once for each mark: `nexus --version` failed or printed no version,
 * or the CLI is older than 0.19.0, whose `seen` marks the latest reply. Null when it can.
 */
async function seenRefusal($: EngineInterface): Promise<string | null> {
  const found = await cliVersion($)
  if (found === null) return `${cli} --version gave no version, so the pane cannot mark only the reply it showed.`
  return isOlder(found, SEEN_AT_CLI) ? `${cli} is ${found.join('.')}: marking only the reply shown seen needs Nexus CLI ${SEEN_AT_CLI.join('.')} or later (nexus --version).` : null
}

/**
 * Marks the reply the pane showed, `reply`, seen on the control plane, for every client, and none after it. A failure, or
 * a `refusal` from the version check, says so in the pane, as the reply stays new everywhere, and polls do not ask again
 * for that reply. Whether it marked.
 */
async function markSeen($: EngineInterface, thread: string, reply: number | null, refusal: string | null): Promise<boolean> {
  if (refusal !== null) {
    if (refusedSeen.get(thread) === reply) return false
    refusedSeen.set(thread, reply)
    await setPane($, () => ({ notice: { text: `The reply in ${thread} was not marked seen, so it still shows as new: ${refusal}`, tone: 'error' } }))
    return false
  }
  if (reply === null || seeing.has(thread)) return false
  seeing.add(thread)
  try {
    const got = await nexus($, ['seen', thread, `--last-reply-at=${reply}`])
    if (got.ok) {
      refusedSeen.delete(thread)
      return true
    }
    refusedSeen.set(thread, reply)
    await setPane($, () => ({ notice: { text: `The reply in ${thread} was not marked seen, so it still shows as new: ${sentence(got.failure.message)}`, tone: 'error' } }))
    return false
  } finally {
    seeing.delete(thread)
  }
}

/** The thread's row in the list as its details just read it, so the list and the strip need not wait for their poll. */
async function patchRow($: EngineInterface, detail: NexusDetail) {
  const { thread, attention } = detail
  await update($, listAtom, (list): NexusList =>
    list.threads?.some(one => one.id === thread.id)
      ? { ...list, threads: list.threads.map(one => (one.id === thread.id ? { ...one, attention, seenAt: thread.seenAt, lastReplyAt: thread.lastReplyAt } : one)) }
      : list,
  )
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
    const threads = await threadsFrom($, await nexus($, ['threads', '--all']))
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
  if (shown?.thread !== thread) await Promise.all([$.state.set(SHOWN, null), $.state.set(CLAUDE, null)])
  await leaveCheckout($, thread)
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

// The Changes tab. Every read of the checkout counts as human activity and wakes a paused pylon, so the changes are
// read only while the pylon runs and the thread is open, when the tab is first shown, when an agent turn ends, when
// the pylon runs after the person asked to wake it, and on r; never on a timer. A paused pylon is woken only when the
// person says so. One `changes` child and one `diff` child at most, as children of the pane.

const emptyCheckout = (thread: string): NexusCheckout => ({ thread, changes: null, failure: null, isReading: false, isWanted: false })

/** Changes the Changes tab's reads of `thread`, if they are still the ones the pane holds. */
const changeCheckout = ($: EngineInterface, thread: string, change: (was: NexusCheckout) => NexusCheckout) =>
  update($, checkoutAtom, was => (was?.thread === thread ? change(was) : was))

/** What Changes compares with, as `$.store` kept it. A store from before the latest turn kept only whether to show the uncommitted changes. */
async function loadChangesBase($: EngineInterface) {
  const stored = await $.store.get('changesBase')
  const old = await $.store.get('uncommitted')
  const base = stored === 'start' || stored === 'turn' || stored === 'head' ? stored : old === true ? 'head' : 'start'
  await $.state.set(CHANGES_BASE, base)
  if (old === undefined) return
  await $.store.set('changesBase', base)
  await $.store.delete('uncommitted')
}

/**
 * A failed checkout read: a CLI too old for the command names the version it needs, and one too old for `--turn`,
 * which its parseArgs refuses as an unknown option, the version that added it.
 */
async function checkoutFailure($: EngineInterface, failure: NexusFailure, base: NexusBase['kind'], command: string, doing: string): Promise<NexusFailure> {
  const older = newer(failure, command, doing, '0.6.0')
  if (older !== failure || base !== 'turn' || failure.kind !== 'invalid') return older
  return olderThan($, failure, [0, 11, 0], "comparing with the latest turn")
}

/**
 * Reads `thread`'s changes, if the rule allows: its details say the pylon runs and the thread is open, or the person
 * asked to wake it (`wake`, or an earlier ask still standing). One read at a time: a second ask while one runs is the
 * same read. A reply for the base before a toggle of c is dropped, and the read runs again for the base now chosen.
 */
async function readChanges($: EngineInterface, thread: string, wake: boolean): Promise<void> {
  const current = poller
  if (!current || (await read($, paneAtom)).selected !== thread) return
  const shown = await read($, shownAtom)
  const detail = shown?.thread === thread ? shown.detail : null
  // Until the first details say what the pylon is doing, nothing is read: their arrival reads (`noticeCheckout`).
  if (!detail) return
  const facts = checkoutFacts(detail)
  if (facts.status !== 'active' && facts.status !== 'idle') return
  const checkout = await update($, checkoutAtom, was => (was?.thread === thread ? was : emptyCheckout(thread)))
  if (!canReadCheckout(facts)) {
    if (!wake && !checkout?.isWanted) return
    if (!checkout?.isWanted) await changeCheckout($, thread, was => ({ ...was, isWanted: true }))
  }
  const base = await read($, changesBaseAtom)
  // The check and the claim are one synchronous step, so two asks at once never start two children.
  if (changesChild?.thread === thread) return
  changesChild?.stop()
  const { promise, stop } = stopper()
  const mine = { thread, stop }
  changesChild = mine
  await changeCheckout($, thread, was => ({ ...was, isReading: true }))
  const got = await childJson($, changesArgv(thread, base), Promise.race([current.stopped, promise]))
  if (changesChild === mine) changesChild = undefined
  const isStale = got !== undefined && (await read($, changesBaseAtom)) !== base
  if (!got || isStale) {
    await changeCheckout($, thread, was => ({ ...was, isReading: false }))
    if (isStale) await readChanges($, thread, false)
    return
  }
  const changes = got.ok ? parsed(got, parseChanges) : { ok: false as const, failure: await checkoutFailure($, got.failure, base, 'changes', 'reading the changes') }
  if (!changes.ok) {
    const { message } = changes.failure
    await changeCheckout($, thread, was => ({ ...was, changes: null, failure: { message, isNoBase: base !== 'head' && isNoBase(message) }, isReading: false, isWanted: false }))
    return
  }
  await changeCheckout($, thread, () => ({ thread, changes: changes.value, failure: null, isReading: false, isWanted: false }))
  // The diff open is read again against what was just read, as the dashboard's open tab is: a turn changed it, or c did.
  const { selected, diff } = await read($, paneAtom)
  if (selected !== thread || !diff) return
  const file = changes.value.files.find(one => one.path === diff.path) ?? (await read($, diffAtom))?.file
  // The CLI answers only once the pylon runs, so the diff reads now, though the details may still say it was paused.
  if (file?.path === diff.path) await readDiff($, thread, file, true)
}

/**
 * Reads the diff of `file`, if the rule allows: on a pylon not running it reads nothing, and the diff view offers to
 * wake it. The rows read before for the same file and base stay on screen during the read. A newer read stops this one.
 * `isAwake`: a changes read just answered, which the CLI does only once the pylon runs, whatever the details say.
 */
async function readDiff($: EngineInterface, thread: string, file: NexusChangedFile, isAwake = false) {
  const current = poller
  if (!current || (await read($, paneAtom)).selected !== thread) return
  const shown = await read($, shownAtom)
  const detail = shown?.thread === thread ? shown.detail : null
  const base = await read($, changesBaseAtom)
  const fresh: NexusDiffShown = { thread, file, base, rows: null, meta: [], isBinary: false, isCut: false, failure: null, isReading: false }
  const kept = (was: NexusDiffShown | null): NexusDiffShown => (was?.thread === thread && was.file.path === file.path && was.base === base ? { ...was, file } : fresh)
  const facts = detail && checkoutFacts(detail)
  const isOpen = facts?.status === 'active' || facts?.status === 'idle'
  if (!facts || !isOpen || (!isAwake && !canReadCheckout(facts))) {
    await update($, diffAtom, was => ({ ...kept(was), isReading: false }))
    return
  }
  diffChild?.stop()
  const { promise, stop } = stopper()
  const mine = { thread, stop }
  diffChild = mine
  await update($, diffAtom, was => ({ ...kept(was), isReading: true }))
  const got = await childJson($, diffArgv(thread, file, base), Promise.race([current.stopped, promise]))
  // A newer read took this one's place, and writes its own.
  if (diffChild !== mine) return
  diffChild = undefined
  const isOurs = (was: NexusDiffShown | null) => was?.thread === thread && was.file.path === file.path && was.base === base
  if (!got || (await read($, changesBaseAtom)) !== base) {
    await update($, diffAtom, was => (isOurs(was) ? { ...was!, isReading: false } : was))
    return
  }
  const reply = got.ok ? parsed(got, parseDiffReply) : { ok: false as const, failure: await checkoutFailure($, got.failure, base, 'diff', 'reading a diff') }
  await update($, diffAtom, was => {
    if (!isOurs(was)) return was
    if (!reply.ok) return { ...was!, isReading: false, failure: reply.failure.message }
    const { rows, meta, isCut, isBinary } = parseDiff(reply.value.diff)
    return { ...fresh, rows, meta, isBinary, isCut: isCut || reply.value.truncated }
  })
}

/** c: the next of what Changes compares with (`BASES`); kept between sessions, and read again. */
async function nextChangesBase($: EngineInterface) {
  const next = BASES[await read($, changesBaseAtom)].next
  await $.state.set(CHANGES_BASE, next)
  await $.store.set('changesBase', next)
  const { selected } = await read($, paneAtom)
  if (selected) await readChanges($, selected, false)
}

/** The Changes tab shown: its first read, unless one has run or runs for this thread. */
async function firstRead($: EngineInterface) {
  const { selected } = await read($, paneAtom)
  const checkout = await read($, checkoutAtom)
  if (selected && !(checkout?.thread === selected && (checkout.changes || checkout.failure || checkout.isReading))) await readChanges($, selected, false)
}

/**
 * New details of the thread shown, against the ones before: read the changes when a turn ended on a running pylon,
 * when the pylon runs after the person asked to wake it, and when the Changes tab waits for its first read.
 */
async function noticeCheckout($: EngineInterface, thread: string, before: NexusDetail | null, now: NexusDetail) {
  const [pane, checkout] = await Promise.all([read($, paneAtom), read($, checkoutAtom)])
  const mine = checkout?.thread === thread ? checkout : null
  const isFirst = pane.view === 'thread' && pane.tab === 'changes' && !mine?.changes && !mine?.failure
  // A tab still waiting for its first read reads with any details, so a read the pane's close cut short runs again.
  const isDue = (isFirst && !mine?.isReading) || checkoutTrigger(before && checkoutFacts(before), checkoutFacts(now), { isWanted: mine?.isWanted ?? false, isFirst })
  if (isDue) await readChanges($, thread, false)
}

/** The pane left the thread whose checkout it read, for `thread` or the list: its reads stop and are forgotten. */
async function leaveCheckout($: EngineInterface, thread: string | null) {
  if (changesChild && changesChild.thread !== thread) changesChild.stop()
  if (diffChild && diffChild.thread !== thread) diffChild.stop()
  await update($, checkoutAtom, was => (was && was.thread !== thread ? null : was))
  await update($, diffAtom, was => (was && was.thread !== thread ? null : was))
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
  return { ok: false, failure: await olderThan($, failure, [0, 8, 0], 'closing a failed session') }
}

/** `failure`, or when `nexus --version` says the CLI is older than `version`, the version `doing` needs. */
async function olderThan($: EngineInterface, failure: NexusFailure, version: readonly number[], doing: string, budget?: Budget): Promise<NexusFailure> {
  const found = await cliVersion($, budget)
  return found && isOlder(found, version) ? { kind: failure.kind, message: `${cli} is ${found.join('.')}: ${doing} needs Nexus CLI ${version.join('.')} or later (nexus --version)` } : failure
}

/** What a tool call has left: the time before its deadline and the abort that cancels it. */
type Budget = { ms: number; signal: AbortSignal }

/**
 * The CLI's version, or null when `--version` printed none, did not run, or outlasted `budget`. `$.process.run` takes no
 * abort signal, so an abort only stops the waiting; the run itself is bounded by the time left.
 */
async function cliVersion($: EngineInterface, budget?: Budget): Promise<number[] | null> {
  if (budget && (budget.signal.aborted || budget.ms <= 0)) return null
  const { promise, stop } = stopper()
  budget?.signal.addEventListener('abort', stop)
  try {
    const ran = await Promise.race([$.process.run([cli, '--version'], { timeoutMs: Math.min(RUN_MS, budget?.ms ?? RUN_MS) }), promise.then(() => null)])
    return ran?.exitCode === 0 ? parseVersion(ran.stdout) : null
  } catch {
    return null
  } finally {
    budget?.signal.removeEventListener('abort', stop)
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
    await sayOf($, thread, `${done}. ⏎ on it in Pylon ${how}.`, `${done} of ${thread}.`, 'dim')
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
 * Closes a running or failed session from the pane once the person says so; the Pylon tab offers no close of a
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
  const detail = await detailFrom($, await nexus($, ['show', thread]))
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
  `Claude Code cannot give its terminal to the attach, so run this in a terminal or a Herdr tab:\n\n  ${attachCommand(cli, thread)}\n\nEach session is a workspace in the pylon's Herdr: pick one there, and detach from Herdr to come back. ${ATTACH_HINT}`

/**
 * `nexus attach` in a new tab of the Herdr workspace Claude Code runs in, put in front: Claude Code cannot hand its
 * own terminal over, and a Herdr tab can. The tab's shell runs it, so the detach leaves the tab at its shell, with any
 * error of the attach still there to read. Resolves the tab's label.
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
  if (ran.ok) attached = { thread, pane }
  return ran.ok ? { ok: true, value: label } : ran
}

/** Whether the Herdr tab the pane opened for `thread` still runs its attach, which ends once the person detaches or closes it. */
async function isAttached($: EngineInterface, thread: string): Promise<boolean> {
  if (attached?.thread !== thread) return false
  const info = await herdr($, ['pane', 'process-info', '--pane', attached.pane])
  if (info.ok && isPaneRunning(info.value)) return true
  attached = undefined
  return false
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

/** Sends `text` to the thread's agent, or types it into its Claude Code worker's session; the thread shown is read again to show it. */
async function send($: EngineInterface, id: string, text: string): Promise<Outcome<Sent>> {
  // `--` keeps a message that starts with a dash from reading as a flag.
  const sent = parsed(await nexus($, ['send', id, '--', text], SEND_MS), parseSent)
  if (sent.ok && (await read($, paneAtom)).selected === id) pollAgain($)
  return sent
}

const saySent = (id: string, sent: Outcome<Sent>): Outcome<string> => (sent.ok ? { ok: true, value: sentText(id, sent.value) } : sent)

/** What `start` sends: `message` for the Nexus agent, or `claude`, a Claude Code worker's first prompt, with its `model`. */
type StartFields = {
  project: string
  title?: string | undefined
  message?: string | undefined
  claude?: string | undefined
  model?: string | undefined
  node?: string | undefined
  branch?: string | undefined
}

async function start($: EngineInterface, fields: StartFields): Promise<Outcome<NexusThread>> {
  const got = await nexus($, [
    'start',
    `--project=${fields.project}`,
    ...(['title', 'message', 'claude', 'model', 'node', 'branch'] as const).flatMap(key => (fields[key] ? [`--${key}=${fields[key]}`] : [])),
  ])
  // `--claude` came with CLI 0.15.0 and `--model` with 0.16.0; an older CLI refuses them as unknown options.
  if (!got.ok && fields.claude) return { ok: false, failure: await olderThan($, got.failure, fields.model ? [0, 16, 0] : [0, 15, 0], 'starting a Claude Code worker') }
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
      return say(id.ok ? saySent(id.value, await send($, id.value, command.text)) : id)
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

/** How often `wait` reads a Claude Code worker thread, whose transcript no watch streams. */
const CLAUDE_WAIT_MS = 2_000

type ClaudeThread = { detail: NexusDetail; reading: ClaudeReading }

/**
 * A Claude Code worker thread's details and transcript, for a tool; null for a harness thread, which its watch reports.
 * Each read ends by `until`, a time on `$.clock`.
 */
async function claudeThread($: EngineInterface, thread: string, signal: AbortSignal, until = Infinity): Promise<Outcome<ClaudeThread | null>> {
  const left = async () => Math.min(RUN_MS, until - (await $.clock.now()))
  const detail = await detailFrom($, await toolJson($, ['show', thread], signal, await left()), { ms: await left(), signal })
  if (!detail.ok || detail.value.conversation !== 'claude') return detail.ok ? { ok: true, value: null } : detail
  // The model reads the transcript's whole text cut to one tail, so no tool result is cut on its own first.
  const reading = parsed(await toolJson($, ['conversation', thread], signal, await left()), json => parseClaudeConversation(json, Infinity))
  return reading.ok ? { ok: true, value: { detail: detail.value, reading: reading.value } } : reading
}

/** A Claude Code worker's launch for the model, a failed one with the newest lines of its diagnostic. */
const workerFields = (detail: NexusDetail) =>
  detail.worker ? { worker: { state: detail.worker.state, model: detail.worker.model, ...(detail.worker.message ? { message: keepTail(detail.worker.message, 1_000) } : {}) } } : {}

/**
 * `wait` on a Claude Code worker thread, from its first reading (`first`) until `until`: its details and transcript read
 * every `CLAUDE_WAIT_MS`, each read cut off at `until`. A failed or stalled launch, or a thread that can no longer run (`isWorkerDone`), settles at once. Being idle
 * (`isWorkerIdle`) settles only once the launch has started and a turn shows (in the transcript, or as this wait saw it
 * run), since a worker still launching is idle with nothing in its transcript. A message just typed may not be in the
 * transcript yet, nor its turn reported, so an idle reading settles only when the one a full `CLAUDE_WAIT_MS` before it
 * was idle too, unless this wait saw the turn run. A deadline too near for the next reading, or passed during one, ends
 * the wait `timed_out`, and a cancel ends it `cancelled`, both unsettled and with the last reading. A transcript that
 * ends at a prompt the worker never answered settles so too, its reply null.
 */
async function waitForClaude($: EngineInterface, thread: string, first: ClaudeThread, until: number, signal: AbortSignal): Promise<Outcome<unknown>> {
  let { detail, reading } = first
  let sawWorking = false
  let wasIdle = false
  /** Why the last reading failed, while it fails: the wait goes on with the reading before, as a watch outlives an outage. */
  let outage: string | null = null
  const result = (settled: boolean, end?: 'timed_out' | 'cancelled'): Outcome<unknown> => {
    const state = claudeState(detail, reading)
    const human = needsHuman(state)
    const reply = rowsReply(reading.rows, REPLY_CHARS)
    return {
      ok: true,
      value: {
        thread,
        settled,
        ...(end ? { [end]: true } : {}),
        ...stateFields(state),
        ...workerFields(detail),
        ...(outage ? { outage } : {}),
        ...(human ? { needs_human: human } : {}),
        reply: reply ? leftOut(reply.tail, reply.dropped) : null,
      },
    }
  }
  for (;;) {
    sawWorking ||= reading.working
    const launch = detail.worker?.state
    const hasEnded = outage === null && (launch === 'failed' || launch === 'stalled' || isWorkerDone(claudeState(detail, reading)))
    const isIdle = outage === null && launch === 'started' && (reading.hasTurn || sawWorking) && isWorkerIdle(claudeState(detail, reading))
    if (hasEnded || (isIdle && (wasIdle || sawWorking))) return result(true)
    if (signal.aborted) return result(false, 'cancelled')
    if ((await $.clock.now()) + CLAUDE_WAIT_MS > until) return result(false, 'timed_out')
    wasIdle = isIdle
    const { promise, stop } = stopper()
    const timer = $.clock.after(CLAUDE_WAIT_MS, stop)
    signal.addEventListener('abort', stop)
    await promise
    timer.cancel()
    signal.removeEventListener('abort', stop)
    if (signal.aborted) return result(false, 'cancelled')
    const next = await claudeThread($, thread, signal, until)
    if (signal.aborted) return result(false, 'cancelled')
    if (!next.ok && (await $.clock.now()) >= until) return result(false, 'timed_out')
    if (!next.ok && next.failure.kind !== 'unreachable' && next.failure.kind !== 'failed') return next
    if (!next.ok) {
      outage = next.failure.message
      continue
    }
    outage = null
    if (!next.value) return failed(`${thread} is no longer a Claude Code worker thread`)
    detail = next.value.detail
    reading = next.value.reading
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
    case 'projects':
      return answer(parsed(await toolJson($, ['projects'], signal), json => projectJson(json, 'projects')))
    case 'project_add': {
      let args: string[]
      try {
        args = projectArgs(input)
      } catch (error) {
        return answer(failed(messageOf(error)))
      }
      if (input.node === undefined) {
        const node = parsed(await toolJson($, ['nodes'], signal), onlineNode)
        if (!node.ok) return answer(node)
        if (node.value === undefined) return answer(failed('no online node is available; provide node explicitly'))
        args.splice(2, 0, `--node=${node.value}`)
      }
      if (signal.aborted) return answer(failed('cancelled'))
      const got = await toolJson($, args, signal)
      if (!got.ok) {
        const failure = got.failure.kind === 'invalid' ? newer(got.failure, 'project add', 'adding a project', '0.7.0') : got.failure
        return answer({ ok: false, failure: failure === got.failure ? failure : { ...failure, message: `${failure.message}. Update the nexus CLI.` } })
      }
      const added = parsed(got, json => projectJson(json, 'project add'))
      if (added.ok) void loadCatalog($, { projects: true })
      return answer(added)
    }
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
      const model = str(input, 'model')
      const isClaude = input.claude === true
      if (model && !isClaude) return { deny: 'model needs claude: true' }
      const started = await start($, { project, title: str(input, 'title'), node: str(input, 'node'), ...(isClaude ? { claude: message, model } : { message }) })
      return answer(started.ok ? { ok: true, value: { id: started.value.id, project: started.value.project, title: started.value.title } } : started)
    }
    case 'send': {
      const id = await toolThread($, input)
      const text = str(input, 'text')
      if (!id.ok || !text) return answer(id.ok ? failed('text is required') : id)
      const sent = await send($, id.value, text)
      return answer(sent.ok ? { ok: true, value: { thread: id.value, sent: true, ...(sent.value.kind === 'claude' ? { claude: { outcome: sent.value.outcome, resumed: sent.value.resumed } } : {}) } } : sent)
    }
    case 'read': {
      const id = await toolThread($, input)
      if (!id.ok) return answer(id)
      const worker = await claudeThread($, id.value, signal)
      if (!worker.ok) return answer(worker)
      if (worker.value) {
        const { detail, reading } = worker.value
        return answer({ ok: true, value: { thread: id.value, ...stateFields(claudeState(detail, reading)), ...workerFields(detail), conversation: rowsText(reading.rows, READ_CHARS) } })
      }
      const got = await snapshot($, id.value, signal)
      if (!got.ok) return answer(got)
      return answer({ ok: true, value: { thread: id.value, ...stateFields(got.value.state), conversation: transcript(got.value.entries, READ_CHARS) } })
    }
    case 'wait': {
      const id = await toolThread($, input)
      if (!id.ok) return answer(id)
      const seconds = typeof input.timeout_seconds === 'number' ? Math.min(600, Math.max(1, Math.round(input.timeout_seconds))) : 300
      // The first reading, which says whether the thread is a Claude Code worker's, counts inside the timeout.
      const until = (await $.clock.now()) + seconds * 1000
      const worker = await claudeThread($, id.value, signal, until)
      if (!worker.ok && signal.aborted) return answer({ ok: true, value: { thread: id.value, settled: false, cancelled: true } })
      if (!worker.ok && (await $.clock.now()) >= until) return answer({ ok: true, value: { thread: id.value, settled: false, timed_out: true } })
      if (!worker.ok) return answer(worker)
      if (worker.value) return answer(await waitForClaude($, id.value, worker.value, until, signal))
      const got = await waitFor($, id.value, until - (await $.clock.now()), signal)
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
 * Opens the session the form describes: the form gives way to the Pylon tab at once, where the session shows as
 * opening while the CLI wakes the pylon and starts the agent, as pi-nexus does.
 */
async function submitSession($: EngineInterface, draft: NexusSessionDraft | null) {
  let thread: string | null = null
  await update($, paneAtom, (pane): NexusPane => {
    thread = pane.view === 'session' ? pane.selected : null
    return thread ? { ...pane, view: 'thread', tab: 'pylon', mode: 'normal', session: null } : pane
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
  changesCursor: null,
  diff: null,
  portCursor: null,
  pylonCursor: null,
  listCursor: was.selected ?? was.listCursor,
})

/** After the list took the place of the thread `left`: its watch stopped, what was read of it dropped, the list polled. */
async function listShown($: EngineInterface, left: string | null, pane: NexusPane) {
  watcher?.stop()
  await leaveCheckout($, null)
  await Promise.all([$.state.set(WATCH, null), $.state.set(LIVE, null), $.state.set(SHOWN, null), $.state.set(CLAUDE, null)])
  // The list read after the mark no longer shows the reply the person just read as new.
  void (async () => {
    if (left) await markLeft($, left)
    pollAgain($)
  })()
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
    await Promise.all([poll($), loadCatalog($, { projects: view === 'list' })])
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
    if (tab === 'changes') await firstRead($)
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
      case 'read-changes':
        return readChanges($, effect.thread, true)
      case 'base':
        return nextChangesBase($)
      case 'open-diff':
        await setPane($, pane => (pane.selected === effect.thread ? { diff: { path: effect.file.path, top: 0 }, changesCursor: fileKey(effect.file.path) } : {}))
        return readDiff($, effect.thread, effect.file)
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
        await onShown(async id => saySent(id, await send($, id, text.trim())))
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
      loadChangesBase($),
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

  const input = (e: object) => {
    const { tool, tool_use_id, agentId, consent, requestMeta, ...args } = e as Record<string, unknown>
    return args
  }
  on('tool.call', { tool: 'mcp__nexus__projects' }, ($, e, next) => callTool($, 'projects', input(e), next.signal)).catch(failedTool)
  on('tool.call', { tool: 'mcp__nexus__project_add' }, ($, e, next) => callTool($, 'project_add', input(e), next.signal)).catch(failedTool)
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
    const [strip, list, now, cursor, scope] = await Promise.all([
      read($, stripAtom),
      read($, listAtom),
      read($, nowAtom),
      read($, stripCursorAtom),
      read($, scopeAtom),
    ])
    if (!strip.isOn) return next(e)
    const chips = stripChips(inScope(list.threads ?? [], scope), Math.max(now, list.polledAt ?? 0))
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
    const [list, watched, streamed, shown, catalog, pane, now, scope, checkout, diff, changesBase, claude] = await Promise.all([
      read($, listAtom),
      read($, watchAtom),
      read($, liveAtom),
      read($, shownAtom),
      read($, catalogAtom),
      read($, paneAtom),
      read($, nowAtom),
      read($, scopeAtom),
      read($, checkoutAtom),
      read($, diffAtom),
      read($, changesBaseAtom),
      read($, claudeAtom),
    ])
    const detail = shown?.thread === pane.selected ? shown.detail : null
    // A Claude Code worker's conversation comes from `nexus conversation`, its watch carrying only the thread's state.
    const worker = detail?.conversation === 'claude' && watched?.thread === pane.selected ? claudeWatch(watched, claude?.thread === pane.selected ? claude : null, detail.worker?.model ?? null) : null
    const watch = worker?.watch ?? watched
    const live = worker && watched ? { thread: watched.thread, live: worker.live } : streamed
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
      checkout,
      diff,
      changesBase,
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
