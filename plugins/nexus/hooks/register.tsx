import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { NexusFailure, NexusList, NexusPane, NexusRunState, NexusThread, NexusWatch } from '../types'
import {
  ACTIONS,
  type Action,
  type Reply,
  FULL_ID,
  USAGE,
  type WatchEntry,
  type WatchEvent,
  ago,
  applyEvent,
  isSettled,
  foldReply,
  leftOut,
  matchThread,
  parseCommand,
  parseFailure,
  parseStarted,
  parseThreads,
  parseWatchEvent,
  sentence,
  transcript,
} from './model'
import { needsHuman, TOOLS } from './tools'
import { COMPOSE, ListView, type PaneActions, ThreadView } from './view'

const PANE = 'nexus'
const POLL_MS = 5_000
/** A `$.process.run` of the CLI: its own requests give up after 30 s without data, and `start` makes two. */
const RUN_MS = 70_000
const READ_CHARS = 6_000
const REPLY_CHARS = 4_000

const listAtom = atom({ plugin: 'nexus', key: 'list' } as const, { threads: null, failure: null, polledAt: null })
const WATCH = { plugin: 'nexus', key: 'watch' } as const
const watchAtom = atom(WATCH, null)
const paneAtom = atom({ plugin: 'nexus', key: 'pane' } as const, {
  selected: null,
  mode: 'browse',
  showArchived: false,
  draft: '',
  notice: null,
})

/** The CLI to run, from the `cli` option. */
let cli = 'nexus'
/** The pane's two processes at most: one `threads` poll at a time, and one watch of the thread it shows. */
let poller: { timer: Timer; isBusy: boolean; stop: () => void; stopped: Promise<void> } | undefined
/** The second ask for the keyboard after `/nexus`, cancelled when the pane closes first. */
let refocus: Timer | undefined
let watcher: { thread: string; stop: () => void } | undefined

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

function threadsFrom(got: Outcome<unknown>): Outcome<NexusThread[]> {
  if (!got.ok) return got
  try {
    return { ok: true, value: parseThreads(got.value) }
  } catch (error) {
    return failed(messageOf(error))
  }
}

async function listThreads($: EngineInterface, project?: string): Promise<Outcome<NexusThread[]>> {
  return threadsFrom(await nexus($, ['threads', ...(project ? [`--project=${project}`] : [])]))
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
 * child exits. The exit is clean (no failure) after the thread's deletion.
 */
async function followWatch(
  $: EngineInterface,
  thread: string,
  take: (event: WatchEvent) => boolean | Promise<boolean>,
  stop: Promise<void>,
): Promise<ChildEnd> {
  let pending = ''
  return runChild(
    $,
    ['watch', thread, '--json'],
    async text => {
      pending += text
      const lines = pending.split('\n')
      pending = lines.pop()!
      for (const line of lines) {
        const event = parseWatchEvent(line)
        if (event && (await take(event))) return true
      }
      return false
    },
    stop,
  )
}

/** The pane's `threads` poll, as a child `stop` kills: a closed pane leaves no poll running. Undefined once stopped. */
async function pollList($: EngineInterface, stop: Promise<void>): Promise<Outcome<NexusThread[]> | undefined> {
  let stdout = ''
  const end = await runChild(
    $,
    ['threads', '--json'],
    text => {
      stdout += text
      return false
    },
    stop,
  )
  if (end.by !== 'exit') return undefined
  if (end.failure) return { ok: false, failure: end.failure }
  try {
    return threadsFrom({ ok: true, value: JSON.parse(stdout) })
  } catch {
    return failed('nexus threads printed something that is not JSON')
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

/** The thread open in the pane, watched until the pane leaves it. Events for a thread no longer shown are dropped. */
function watchInPane($: EngineInterface, thread: string) {
  watcher?.stop()
  const { promise, stop } = stopper()
  // A stopped watch may still hold lines it read: only the current one writes, so a rewatch of the same thread
  // never takes an older reader's entries or its exit.
  const mine = {
    thread,
    stop: () => {
      if (watcher === mine) watcher = undefined
      stop()
    },
  }
  watcher = mine
  void (async () => {
    await $.state.set(WATCH, { thread, rows: [], state: null, outage: null, ended: null })
    const end = await followWatch(
      $,
      thread,
      async event => {
        if (watcher !== mine) return true
        await update($, watchAtom, current => (current ? applyEvent(current, event) : current))
        return false
      },
      promise,
    )
    if (watcher !== mine || end.by !== 'exit') return
    watcher = undefined
    const ended = end.failure ? `The watch stopped: ${sentence(end.failure.message)} r watches again.` : 'The thread was deleted.'
    await update($, watchAtom, current => (current ? { ...current, ended } : current))
  })()
}

function stopPane() {
  poller?.timer.cancel()
  poller?.stop()
  poller = undefined
  refocus?.cancel()
  refocus = undefined
  watcher?.stop()
}

/**
 * One `threads` poll, skipped while one runs or the pane is behind another; the pane gone stops both processes.
 * Closing the pane kills a poll in flight, and one that ends as the pane closes writes nothing.
 */
async function pollThreads($: EngineInterface) {
  const current = poller
  if (!current || current.isBusy) return
  current.isBusy = true
  try {
    const pane = (await $.ui.panes()).find(one => one.id === PANE)
    if (!pane) return stopPane()
    if (!pane.isShown) return
    const got = await pollList($, current.stopped)
    const now = await $.clock.now()
    if (!got || poller !== current) return
    await update($, listAtom, (list): NexusList => (got.ok ? { threads: got.value, failure: null, polledAt: now } : { ...list, failure: got.failure }))
  } finally {
    current.isBusy = false
  }
}

/** Starts what an open pane needs, keeping what runs: the poll, polled now, and the watch of the thread it shows. */
async function startPane($: EngineInterface) {
  if (!poller) {
    const { promise, stop } = stopper()
    poller = { timer: $.clock.every(POLL_MS, () => void pollThreads($)), isBusy: false, stop, stopped: promise }
  }
  void pollThreads($)
  const { selected } = await read($, paneAtom)
  if (selected && watcher?.thread !== selected) watchInPane($, selected)
}

const OPEN = { id: PANE, title: 'Nexus', focus: true, columns: 64 } as const
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

async function showThread($: EngineInterface, thread: string) {
  await setPane($, () => ({ selected: thread, mode: 'browse', draft: '' }))
  watchInPane($, thread)
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

async function act($: EngineInterface, action: Action, id: string): Promise<Outcome<string>> {
  const got = await nexus($, [action, id])
  if (!got.ok) return got
  void pollThreads($)
  const title = await titleOf($, id)
  return { ok: true, value: `${ACTIONS[action]} ${id}${title ? ` (${title})` : ''}.` }
}

/** A command's reply. The transcript heads it with the plugin's name, so a failure is its message alone. */
const say = (outcome: Outcome<string>) =>
  outcome.ok ? outcome.value : sentence(outcome.failure.message.replace(/^./, first => first.toUpperCase()))

async function send($: EngineInterface, id: string, text: string): Promise<Outcome<string>> {
  // `--` keeps a message that starts with a dash from reading as a flag.
  const got = await nexus($, ['send', id, '--', text])
  return got.ok ? { ok: true, value: `Sent to ${id}.` } : got
}

async function start($: EngineInterface, project: string, message: string | undefined, title: string | undefined) {
  const got = await nexus($, [
    'start',
    `--project=${project}`,
    ...(title ? [`--title=${title}`] : []),
    ...(message ? [`--message=${message}`] : []),
  ])
  if (!got.ok) return got
  void pollThreads($)
  try {
    return { ok: true as const, value: parseStarted(got.value) }
  } catch (error) {
    return failed(messageOf(error))
  }
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
      const started = await start($, command.project, command.message, command.title)
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
      if (command.action === 'delete') {
        const title = await lookUpTitle($, id.value)
        const question = `${title ? `"${title}" (${id.value})` : id.value} and its pylon and conversation will be removed. Delete it?`
        // Keep comes first, so the dialog's default is the harmless answer.
        const answer = await $.ui.ask(question, ['Keep', 'Delete']).catch(() => 'Keep')
        if (answer !== 'Delete') return `Kept ${id.value}.`
      }
      return say(await act($, command.action, id.value))
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
  let watch: NexusWatch = { thread, rows: [], state: null, outage: null, ended: null }
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
  state && { status: state.status, run: state.run, pylon: state.pylon, queued: state.queued, ...(state.failed ? { failed: state.failed } : {}) }

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
      const started = await start($, project, message, str(input, 'title'))
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
    case 'archive': {
      const id = await toolThread($, input)
      if (!id.ok) return answer(id)
      const got = await nexus($, ['archive', id.value])
      if (!got.ok) return answer(got)
      void pollThreads($)
      return answer({ ok: true, value: { thread: id.value, status: 'archived' } })
    }
  }
}

function failedTool() {
  return { deny: 'nexus: the tool failed before it answered; try again.' }
}

/** The handlers the pane's buttons and field run, each with the render hook's `$`. */
function paneActions($: EngineInterface): PaneActions {
  const notify = (outcome: Outcome<string>) =>
    setPane($, () => ({ notice: outcome.ok ? { text: outcome.value, tone: 'dim' } : { text: outcome.failure.message, tone: 'error' } }))
  const onShown = async (fn: (id: string) => Promise<Outcome<string>>) => {
    const { selected } = await read($, paneAtom)
    if (selected) await notify(await fn(selected))
  }
  return {
    open: id => void showThread($, id),
    back: () =>
      void (async () => {
        watcher?.stop()
        await setPane($, () => ({ selected: null, mode: 'browse', draft: '' }))
        await $.state.set(WATCH, null)
      })(),
    refresh: () =>
      void (async () => {
        const { selected } = await read($, paneAtom)
        await setPane($, () => ({}))
        if (selected) watchInPane($, selected)
        else await pollThreads($)
      })(),
    toggleArchived: () => void setPane($, pane => ({ showArchived: !pane.showArchived })),
    close: () =>
      void (async () => {
        stopPane()
        await $.ui.close({ id: PANE })
      })(),
    compose: () =>
      void (async () => {
        await setPane($, () => ({ mode: 'compose' }))
        await $.ui.focus({ requestId: PANE, key: COMPOSE })
      })(),
    draft: text => void update($, paneAtom, pane => ({ ...pane, draft: text })),
    submit: text =>
      void (async () => {
        await setPane($, () => ({ mode: 'browse', draft: '' }))
        if (text.trim()) await onShown(id => send($, id, text.trim()))
      })(),
    askAbort: () => void setPane($, () => ({ mode: 'confirm-abort' })),
    keep: () => void setPane($, () => ({ mode: 'browse' })),
    abort: () =>
      void (async () => {
        await setPane($, () => ({ mode: 'browse' }))
        await onShown(id => act($, 'abort', id))
      })(),
    archive: () =>
      void onShown(async id => {
        const watch = await read($, watchAtom)
        const list = await read($, listAtom)
        const status = watch?.state?.status ?? list.threads?.find(thread => thread.id === id)?.status
        return act($, status === 'archived' ? 'unarchive' : 'archive', id)
      }),
  }
}

export const register: Register = (on, options) => {
  if (typeof options.cli === 'string' && options.cli.trim()) cli = options.cli.trim()

  on('session.start', async ($, e, next) => {
    await Promise.all([
      $.command.register({ name: 'nexus', description: 'Drive Nexus threads: the pane, new, send, open, archive, abort, retry, delete', argumentHint: '[help]', immediate: true }),
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
  on('tool.call', { tool: 'mcp__nexus__archive' }, ($, e, next) => callTool($, 'archive', input(e), next.signal)).catch(failedTool)

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface === 'mobile') {
      const { Text } = $.ui.resolve(e)
      return <Text dimColor>The Nexus pane needs a surface with text fields.</Text>
    }
    const draw = $.ui.resolve(e)
    const [list, watch, pane] = await Promise.all([read($, listAtom), read($, watchAtom), read($, paneAtom)])
    const width = Math.max(24, e.props.bodyColumns)
    const actions = paneActions($)
    const { isFocused } = e.props
    if (!pane.selected) return ListView(draw, list, pane, actions, width, isFocused)
    const thread = list.threads?.find(one => one.id === pane.selected)
    return ThreadView(draw, watch?.thread === pane.selected ? watch : null, thread, pane, actions, width, Math.max(10, e.props.scroll.bodyRows), isFocused)
  })
}

