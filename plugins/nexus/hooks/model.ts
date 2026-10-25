// Everything the mod knows about Nexus that needs no `$`: parsing what the CLI
// prints, folding a watch stream into rows, the /nexus grammar and what the
// pane derives from them. docs/cli.md in the Nexus repository is the contract.
import type {
  NexusActual,
  NexusBase,
  NexusChangedFile,
  NexusChanges,
  NexusDesired,
  NexusDiffRow,
  NexusFileStatus,
  NexusDetail,
  NexusFailure,
  NexusLive,
  NexusNode,
  NexusPort,
  NexusPortChange,
  NexusPreview,
  NexusProject,
  NexusRow,
  NexusRunState,
  NexusHarness,
  NexusOpenedSession,
  NexusSession,
  NexusSessionChanges,
  NexusStrip,
  NexusThread,
  NexusThreadRow,
  NexusWatch,
} from '../types'

export const FULL_ID = /^th-[0-9a-f]{12}$/

const KINDS: Record<number, NexusFailure['kind']> = { 1: 'failed', 2: 'unreachable', 3: 'refused', 4: 'not-found', 5: 'conflict', 64: 'invalid' }

/** A failed command's error: the JSON line it printed on stderr, else its exit code. */
export function parseFailure(exitCode: number, stderr: string): NexusFailure {
  const kind = KINDS[exitCode] ?? 'failed'
  for (const line of stderr.trim().split('\n').reverse()) {
    try {
      const parsed = JSON.parse(line) as { error?: unknown }
      if (typeof parsed.error === 'string') return { kind, message: parsed.error }
    } catch {
      // Not the CLI's JSON line: a crash or a shim's own message.
    }
  }
  const text = stderr.trim().split('\n').pop()
  return { kind, message: text || `the CLI exited with ${exitCode}` }
}

type Raw = Record<string, unknown>
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value)
const num = (value: unknown) => (typeof value === 'number' ? value : 0)
const str = (value: unknown) => (typeof value === 'string' ? value : '')
const strOrNull = (value: unknown) => (typeof value === 'string' ? value : null)
const list = (value: unknown) => (Array.isArray(value) ? value : [])

const ACTUAL = new Set<string>(['spawning', 'running', 'pausing', 'paused', 'deleting', 'absent', 'failed', 'unknown'])
const actual = (value: unknown): NexusActual => (typeof value === 'string' && ACTUAL.has(value) ? (value as NexusActual) : 'unknown')
const desired = (value: unknown): NexusDesired | undefined => (value === 'running' || value === 'paused' || value === 'deleted' ? value : undefined)

/** A field docs/cli.md requires is missing: the CLI and this mod disagree on the contract. */
const contractError = (command: string, what: string) => new Error(`nexus ${command} printed ${what}, which docs/cli.md requires: the CLI and this mod disagree on the contract`)

function parseThread(raw: unknown): NexusThread | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.title !== 'string' || typeof raw.project !== 'string') return undefined
  return {
    id: raw.id,
    title: raw.title,
    project: raw.project,
    status: raw.status as NexusThread['status'],
    agentTurnRunning: raw.agentTurnRunning === true,
    createdAt: num(raw.createdAt),
    lastHumanActivityAt: num(raw.lastHumanActivityAt),
    lastAgentActivityAt: num(raw.lastAgentActivityAt),
    lastActivityAt: Math.max(num(raw.lastAgentActivityAt), num(raw.lastHumanActivityAt), num(raw.createdAt)),
  }
}

/** `threads --json`, kept to the fields the mod reads. A row without its pylon or `desired` fails the whole list. */
export function parseThreads(json: unknown): NexusThreadRow[] {
  if (!Array.isArray(json)) throw new Error('nexus threads did not print a list')
  return json.flatMap(raw => {
    const thread = parseThread(raw)
    if (!thread || !isRecord(raw)) return []
    const { pylon } = raw
    if (!isRecord(pylon) || typeof pylon.node !== 'string') throw contractError('threads', `a row (${thread.id}) without its pylon`)
    const wants = desired(raw.desired)
    if (!wants) throw contractError('threads', `a row (${thread.id}) without desired`)
    return [{ ...thread, pylon: { node: pylon.node, actualState: actual(pylon.actualState), failed: strOrNull(pylon.failed) }, desired: wants }]
  })
}

export function parseStarted(json: unknown): NexusThread {
  const thread = parseThread(json)
  if (!thread) throw new Error('nexus start did not print a thread')
  return thread
}

/** A `Preview`, its `url` required: the CLI owns the URL, so one missing is a contract error rather than one rebuilt. */
export function parsePreview(raw: unknown, command: string): NexusPreview {
  if (!isRecord(raw) || typeof raw.service !== 'string') throw contractError(command, 'a preview without its service')
  if (typeof raw.url !== 'string') throw contractError(command, `a preview (${raw.service}) without its url`)
  return { service: raw.service, httpsPort: num(raw.httpsPort), ready: raw.ready === true, failed: strOrNull(raw.failed), url: raw.url }
}

/** `unpreview` prints a literal null; anything else is a CLI this mod does not know, so the close is not taken as done. */
export function parseUnpreviewed(raw: unknown): null {
  if (raw !== null) throw new Error(`nexus unpreview printed ${clip(JSON.stringify(raw), 60)} where docs/cli.md says null: the CLI and this mod disagree on the contract`)
  return null
}

/** `ListeningPort[] | null`, as `show` and a watch `state` print it: a missing list is a contract error, not "unknown". */
export function parsePorts(raw: unknown, command: string): NexusPort[] | null {
  if (raw === null) return null
  if (!Array.isArray(raw)) throw contractError(command, 'no ports')
  return raw.map(one => {
    if (!isRecord(one) || typeof one.port !== 'number') throw contractError(command, 'a port without its number')
    return { port: one.port, service: strOrNull(one.service), preview: one.preview === null ? null : parsePreview(one.preview, command) }
  })
}

/** The port a preview links, from its service `port-<port>`; null for a declared or ad hoc service's preview, which `unpreview` refuses. */
export function linkedPort(preview: NexusPreview): number | null {
  const match = /^port-(\d+)$/.exec(preview.service)
  return match ? Number(match[1]) : null
}

export const NO_CHANGE: NexusPortChange = { confirmed: null, pending: null, failure: null }

/** What the person did to `port`, its `confirmed` kept only while the details shown (asked as `askedSeq`) were asked before it. */
export function portChange(changes: Record<string, NexusPortChange>, port: number, askedSeq: number): NexusPortChange {
  const change = changes[String(port)] ?? NO_CHANGE
  return change.confirmed && change.confirmed.seq < askedSeq ? { ...change, confirmed: null } : change
}

/** The agents `session open` can start in a pylon, its default first. */
export const HARNESSES: readonly NexusHarness[] = ['claude-code', 'pi', 'shell']
const HARNESS = new Set<string>(HARNESSES)
const SESSION = new Set(['working', 'idle', 'blocked', 'done', 'unknown'])
const OUTPUT = new Set(['branch', 'diff', 'preview', 'file'])

/** `show --json`: the ThreadDetail, kept to what the pane draws. */
export function parseDetail(json: unknown): NexusDetail {
  const thread = isRecord(json) ? parseThread(json.thread) : undefined
  if (!isRecord(json) || !thread || !isRecord(json.pylon)) throw new Error('nexus show did not print a thread')
  const { pylon } = json
  const wants = desired(json.desired)
  if (!wants) throw contractError('show', 'no desired')
  if (typeof json.attach !== 'string') throw contractError('show', 'no attach')
  return {
    thread,
    pylon: {
      id: str(pylon.id),
      node: str(pylon.node),
      actualState: actual(pylon.actualState),
      failed: strOrNull(pylon.failed),
      observedAt: strOrNull(pylon.observedAt),
      retryRefused: strOrNull(pylon.retryRefused),
    },
    sessions: list(json.sessions).map(parseSession),
    previews: list(json.previews).map(raw => parsePreview(raw, 'show')),
    ports: parsePorts(json.ports, 'show'),
    outputs: list(json.outputs).flatMap(raw =>
      isRecord(raw) && OUTPUT.has(str(raw.kind)) ? [{ kind: raw.kind as NexusDetail['outputs'][number]['kind'], ref: str(raw.ref) }] : [],
    ),
    agent: isRecord(json.agent) ? { parkedTasks: num(json.agent.parkedTasks) } : null,
    hasConversation: isRecord(json.thread) && typeof json.thread.conversationId === 'string',
    desired: wants,
    attach: json.attach,
  }
}

const projectOf = (id: string, raw: Record<string, unknown>): NexusProject => ({ id, repoUrl: str(raw.repoUrl), defaultBranch: str(raw.defaultBranch), defaultNode: str(raw.defaultNode) })

export function parseProjects(json: unknown): NexusProject[] {
  if (!Array.isArray(json)) throw new Error('nexus projects did not print a list')
  return json.flatMap(raw => (isRecord(raw) && typeof raw.id === 'string' ? [projectOf(raw.id, raw)] : []))
}

/**
 * One of `show`'s sessions. A control plane older than CLI 0.8.0 lists only running sessions and sends no `state`,
 * `id` or `message`: no `state` is running, and no `id` is the pane. A state this mod does not know, a session with
 * no ID, a running one with no pane or a failed one with no message is a contract error, since the Pylon tab offers
 * a close by state and ID.
 */
function parseSession(raw: unknown): NexusSession {
  if (!isRecord(raw)) throw contractError('show', 'a session that is not an object')
  const state = raw.state ?? 'running'
  const herdrPane = typeof raw.herdrPane === 'string' ? raw.herdrPane : null
  const id = raw.id ?? herdrPane
  if (typeof id !== 'string' || !id) throw contractError('show', 'a session without its id')
  const common = {
    id,
    harness: HARNESS.has(str(raw.harness)) ? (raw.harness as NexusHarness) : 'shell',
    harnessSessionId: strOrNull(raw.harnessSessionId),
    status: SESSION.has(str(raw.status)) ? (raw.status as NexusSession['status']) : 'unknown',
    // Absent from a control plane older than CLI 0.5.0, which means none.
    title: strOrNull(raw.title),
  } as const
  switch (state) {
    case 'running':
      if (herdrPane === null) throw contractError('show', `a running session (${id}) without its herdrPane`)
      return { ...common, state: 'running', herdrPane, message: null }
    case 'paused':
      return { ...common, state: 'paused', herdrPane, message: null }
    case 'failed':
      if (typeof raw.message !== 'string') throw contractError('show', `a failed session (${id}) without its message`)
      return { ...common, state: 'failed', herdrPane, message: raw.message }
    default:
      throw contractError('show', `a session (${id}) in a state it does not know, ${clip(JSON.stringify(state), 40)}`)
  }
}

/** `nexus project add`'s answer: the project it added. */
/** `session open`'s `OpenedSession`, each field required: the pane is what a close and the Pylon tab name it by. */
export function parseOpenedSession(json: unknown): NexusOpenedSession {
  if (!isRecord(json) || typeof json.herdrPane !== 'string' || typeof json.title !== 'string' || !HARNESS.has(str(json.harness))) {
    throw contractError('session open', 'no OpenedSession')
  }
  return { herdrPane: json.herdrPane, harness: json.harness as NexusHarness, title: json.title }
}

/** `session close` prints a literal null. */
export function parseSessionClosed(raw: unknown): null {
  if (raw !== null) throw new Error(`nexus session close printed ${clip(JSON.stringify(raw), 60)} where docs/cli.md says null: the CLI and this mod disagree on the contract`)
  return null
}

export function parseAdded(json: unknown): NexusProject {
  if (!isRecord(json) || typeof json.id !== 'string') throw new Error('nexus project add did not print the project it added')
  return projectOf(json.id, json)
}

/** The threads of `project`, or every thread for null: the scope the list, the strip and `/nexus` show. */
export const inScope = <T extends { project: string }>(threads: readonly T[], project: string | null): T[] =>
  project === null ? [...threads] : threads.filter(thread => thread.project === project)

/** The scope as the list's title and the strip name it. */
export const scopeLabel = (project: string | null) => project ?? 'All projects'

export function parseNodes(json: unknown): NexusNode[] {
  if (!Array.isArray(json)) throw new Error('nexus nodes did not print a list')
  return json.flatMap(raw =>
    isRecord(raw) && typeof raw.name === 'string'
      ? [{ name: raw.name, tailnetHost: str(raw.tailnetHost), state: raw.state === 'offline' ? ('offline' as const) : ('online' as const) }]
      : [],
  )
}

// The pi-ai message shapes an entry's `model` holds, as far as rows read them.
type Part = { type?: string; text?: string; id?: string; name?: string; arguments?: unknown }
type Message = {
  role?: string
  content?: string | Part[]
  toolCallId?: string
  toolName?: string
  isError?: boolean
  stopReason?: string
  errorMessage?: string
  timestamp?: number
  model?: string
  details?: unknown
}

/** An entry as the watch prints it: its model messages, and the CLI's plain rendering of them. */
export type WatchEntry = { model: Message[] | null; text: string }

export type WatchEvent =
  | { type: 'reset'; entries: WatchEntry[] }
  | { type: 'entry'; entry: WatchEntry }
  | { type: 'state'; state: NexusRunState }
  | { type: 'live'; live: NexusLive }
  | { type: 'error'; kind: 'unreachable' | 'failed'; message: string }

function parseEntry(entry: unknown, text: unknown): WatchEntry {
  const model = isRecord(entry) && Array.isArray(entry.model) ? (entry.model as Message[]) : null
  return { model, text: typeof text === 'string' ? text : '' }
}

/** Live output kept per running call: its tail, enough for the few lines a row shows. */
const LIVE_CHARS = 2_000

/**
 * One line of `watch --json`; undefined for a line or an event type this version does not know. A `state` without
 * a field docs/cli.md requires and the mod reads throws.
 */
export function parseWatchEvent(line: string): WatchEvent | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!isRecord(raw)) return undefined
  switch (raw.type) {
    case 'reset':
      return {
        type: 'reset',
        entries: Array.isArray(raw.entries) ? raw.entries.map(one => (isRecord(one) ? parseEntry(one.entry, one.text) : parseEntry(null, ''))) : [],
      }
    case 'entry':
      return { type: 'entry', entry: parseEntry(raw.entry, raw.text) }
    case 'state':
      return {
        type: 'state',
        state: {
          status: raw.status as NexusRunState['status'],
          run: raw.run === 'working' || raw.run === 'parked' ? raw.run : 'idle',
          parkedTasks: num(raw.parkedTasks),
          queued: num(raw.queued),
          pylon: typeof raw.pylon === 'string' ? raw.pylon : 'unknown',
          failed: typeof raw.failed === 'string' ? raw.failed : null,
          ports: parsePorts(raw.ports, 'watch'),
        },
      }
    case 'live':
      return {
        type: 'live',
        live: {
          queued: list(raw.queued).filter((text): text is string => typeof text === 'string'),
          tools: list(raw.tools).flatMap(tool =>
            isRecord(tool) && typeof tool.callId === 'string' ? [{ callId: tool.callId, output: keepTail(str(tool.output), LIVE_CHARS) }] : [],
          ),
          partial: strOrNull(raw.partial),
          retry: strOrNull(raw.retry),
        },
      }
    case 'error':
      return {
        type: 'error',
        kind: raw.kind === 'failed' ? 'failed' : 'unreachable',
        message: typeof raw.message === 'string' ? raw.message : 'the control plane failed',
      }
    default:
      return undefined
  }
}

const contentText = (content: Message['content']) =>
  typeof content === 'string' ? content : (content ?? []).map(part => (part.type === 'text' ? (part.text ?? '') : part.type === 'image' ? '[image]' : '')).join('')

const SUMMARY_KEYS = ['command', 'path', 'file_path', 'pattern', 'query', 'url', 'description']

/** A tool call in one line: the argument that says what it does, else the arguments as JSON. */
export function toolSummary(args: unknown): string {
  if (!isRecord(args) || Object.keys(args).length === 0) return ''
  const key = SUMMARY_KEYS.find(name => typeof args[name] === 'string')
  const text = key ? (args[key] as string) : (Object.values(args).find(value => typeof value === 'string') as string | undefined) ?? JSON.stringify(args)
  return text.replace(/\s+/g, ' ').trim()
}

/** What a row keeps of a call's arguments and result: `$.state` holds every row as JSON for each redraw. */
const ARG_CHARS = 4_000
const OUTPUT_CHARS = 3_000
const PATCH_CHARS = 20_000

/** `value` with every string longer than the bound cut, for a row's arguments. */
function bounded(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.length > ARG_CHARS ? `${value.slice(0, ARG_CHARS)}…` : value
  if (depth > 4) return null
  if (Array.isArray(value)) return value.slice(0, 50).map(item => bounded(item, depth + 1))
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, bounded(item, depth + 1)]))
  return value
}

const lineCount = (text: string) => (text.trim() === '' ? 0 : text.trimEnd().split('\n').length)

function patchOf(details: unknown): string | null {
  const patch = isRecord(details) ? details.patch : undefined
  return typeof patch === 'string' && patch.length <= PATCH_CHARS ? patch : null
}

/** The rows after one more entry: its messages in order, a tool result settling its call's row. */
export function appendEntry(rows: readonly NexusRow[], entry: WatchEntry): NexusRow[] {
  const next = [...rows]
  if (!entry.model) {
    if (entry.text) next.push({ kind: 'notice', tone: 'dim', text: entry.text })
    return next
  }
  for (const message of entry.model) {
    switch (message.role) {
      case 'user': {
        const text = contentText(message.content).trim()
        if (text) next.push({ kind: 'user', text, at: typeof message.timestamp === 'number' ? message.timestamp : null })
        break
      }
      case 'assistant': {
        for (const part of Array.isArray(message.content) ? message.content : []) {
          if (part.type === 'text' && part.text?.trim()) next.push({ kind: 'assistant', text: part.text.trim() })
          if (part.type === 'toolCall') next.push(toolRow(part.id ?? '', part.name ?? 'tool', part.arguments))
        }
        if (message.stopReason === 'error') next.push({ kind: 'notice', tone: 'error', text: `The model failed: ${message.errorMessage ?? 'no reason given'}` })
        if (message.stopReason === 'aborted') next.push({ kind: 'notice', tone: 'dim', text: 'Aborted.' })
        break
      }
      case 'toolResult': {
        const output = contentText(message.content)
        const settled = { outcome: message.isError ? ('error' as const) : ('ok' as const), output: keepTail(output, OUTPUT_CHARS), lines: lineCount(output), patch: patchOf(message.details) }
        const at = next.findLastIndex(row => row.kind === 'tool' && row.id === message.toolCallId)
        const row = next[at]
        // A result whose call is not in the context still shows, as the dashboard shows it.
        if (row?.kind === 'tool') next[at] = { ...row, ...settled }
        else next.push({ ...toolRow(message.toolCallId ?? '', message.toolName ?? 'tool', {}), ...settled })
        break
      }
    }
  }
  return next
}

function toolRow(id: string, name: string, args: unknown): Extract<NexusRow, { kind: 'tool' }> {
  return { kind: 'tool', id, name, summary: toolSummary(args), outcome: 'running', args: isRecord(args) ? (bounded(args) as Raw) : {}, output: '', lines: 0, patch: null }
}

/** The model of the newest answer in `entry`, else `model`. */
function modelIn(model: string | null, entry: WatchEntry): string | null {
  const answers = (entry.model ?? []).filter(message => message.role === 'assistant' && typeof message.model === 'string')
  return answers.at(-1)?.model ?? model
}

/** Rows kept per thread: the pane shows a tail, and `$.state` holds JSON for every redraw. */
const KEPT_ROWS = 400

/** `rows` cut to the tail kept, counting what the cut dropped onto `dropped`. */
function kept(rows: NexusRow[], dropped: number): Pick<NexusWatch, 'rows' | 'dropped'> {
  const cut = Math.max(0, rows.length - KEPT_ROWS)
  return { rows: rows.slice(cut), dropped: dropped + cut }
}

/** The watch after one event. A `live` event changes nothing here: the pane keeps it apart from the rows. */
export function applyEvent(watch: NexusWatch, event: WatchEvent): NexusWatch {
  switch (event.type) {
    case 'reset':
      return { ...watch, ...kept(event.entries.reduce(appendEntry, [] as NexusRow[]), 0), model: event.entries.reduce(modelIn, null) }
    case 'entry':
      return { ...watch, ...kept(appendEntry(watch.rows, event.entry), watch.dropped), model: modelIn(watch.model, event.entry) }
    case 'state':
      return { ...watch, state: event.state, outage: null }
    case 'live':
      return watch
    case 'error':
      return { ...watch, outage: `${event.kind === 'failed' ? 'The control plane is failing' : 'Nexus is unreachable'}: ${sentence(event.message)}` }
  }
}

/**
 * The agent is done for now. Either the thread cannot run on (archived, deleted, parked, or its pylon failed), or
 * its run is idle with nothing queued and either the last row is not the person's message or this watch saw the
 * run working first. A message just sent shows as queued or as a trailing user row, so it is not missed; a turn
 * aborted before it wrote any text leaves a trailing user row, which the working-then-idle run settles.
 */
export function isSettled(state: NexusRunState | null, rows: readonly NexusRow[], sawWorking: boolean): boolean {
  if (!state) return false
  if (state.status === 'archived' || state.status === 'deleted' || state.run === 'parked') return true
  if (state.pylon === 'failed' || state.failed !== null) return true
  if (state.run !== 'idle' || state.queued > 0) return false
  return sawWorking || (rows.length > 0 && rows.at(-1)!.kind !== 'user')
}

/**
 * Every text the agent wrote since the person's last message, its parts a blank line apart, folded in as the watch
 * reads it: its last `max` characters and how many came before them. It reads each entry whole, so a turn longer
 * than the rows a watch keeps still gives its first text.
 */
export type Reply = { tail: string; dropped: number }

export function foldReply(reply: Reply | undefined, event: WatchEvent, max: number): Reply | undefined {
  if (event.type === 'reset') return event.entries.reduce<Reply | undefined>((sofar, entry) => addReply(sofar, appendEntry([], entry), max), undefined)
  if (event.type === 'entry') return addReply(reply, appendEntry([], event.entry), max)
  return reply
}

function addReply(reply: Reply | undefined, rows: readonly NexusRow[], max: number): Reply | undefined {
  for (const row of rows) {
    if (row.kind === 'user') reply = undefined
    if (row.kind !== 'assistant') continue
    const text = reply ? `${reply.tail}\n\n${row.text}` : row.text
    reply = { tail: text.slice(-max), dropped: (reply?.dropped ?? 0) + Math.max(0, text.length - max) }
  }
  return reply
}

/** The last `max` characters of `text`, cut at a line where it can be, saying what was left out. */
export const keepTail = (text: string, max: number) => leftOut(text.slice(-max), Math.max(0, text.length - max))

/** The tail of a longer text, opened at a line where it can be, saying how many characters came before it. */
export function leftOut(cut: string, dropped: number): string {
  if (dropped === 0) return cut
  const line = cut.indexOf('\n')
  return `[${dropped} earlier characters left out]\n${line >= 0 && line < cut.length / 4 ? cut.slice(line + 1) : cut}`
}

/** A conversation for the model: the CLI's own rendering of each entry. */
export const transcript = (entries: readonly WatchEntry[], max: number) =>
  keepTail(entries.map(entry => entry.text).filter(Boolean).join('\n\n') || 'No messages yet.', max)

export type MatchResult = { id: string } | { error: string } | { unknown: true }

/** A thread ID or a prefix of one, with or without `th-`, among `threads`. */
export function matchThread(arg: string, threads: readonly NexusThread[]): MatchResult {
  if (FULL_ID.test(arg)) return { id: arg }
  const hex = arg.startsWith('th-') ? arg.slice(3) : arg
  if (!/^[0-9a-f]+$/.test(hex)) return { error: `${arg} is not a thread ID or a prefix of one.` }
  const found = threads.filter(thread => thread.id.slice(3).startsWith(hex))
  if (found.length === 1) return { id: found[0]!.id }
  if (found.length > 1) return { error: `${arg} matches ${found.length} threads: ${found.slice(0, 5).map(thread => thread.id).join(', ')}.` }
  return { unknown: true }
}

export type ProjectGroup = {
  project: string
  /** Active and idle threads, newest first. */
  open: NexusThreadRow[]
  /** Archived and deleted ones, folded under the open ones. */
  closed: NexusThreadRow[]
  /** Whether the fold shows its threads: as the person left it, else when a filter matches one of them. */
  isUnfolded: boolean
}

const isClosed = (thread: NexusThread) => thread.status === 'archived' || thread.status === 'deleted'

/**
 * Threads by project, A to Z, each group newest first with its closed threads folded below, as the dashboard
 * lists them. A filter keeps the threads whose title holds it, opens a fold it matches and drops empty groups.
 */
export function groupThreads(threads: readonly NexusThreadRow[], filter: string, toggled: Readonly<Record<string, boolean>>): ProjectGroup[] {
  const query = filter.trim().toLowerCase()
  const groups = new Map<string, NexusThreadRow[]>()
  for (const thread of threads) {
    if (query && !thread.title.toLowerCase().includes(query)) continue
    groups.set(thread.project, [...(groups.get(thread.project) ?? []), thread])
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([project, members]) => {
      const sorted = members.toSorted((a, b) => b.createdAt - a.createdAt)
      const closed = sorted.filter(isClosed)
      return { project, open: sorted.filter(thread => !isClosed(thread)), closed, isUnfolded: toggled[closedKey(project)] ?? (query !== '' && closed.length > 0) }
    })
}

export const closedKey = (project: string) => `closed-${project}`

/** The list's rows in the order drawn, each group's fold where it folds: what the cursor walks. */
export const listOrder = (groups: readonly ProjectGroup[]): { id: string }[] =>
  groups.flatMap(group => [...group.open, ...(group.closed.length > 0 ? [{ id: closedKey(group.project) }] : []), ...(group.isUnfolded ? group.closed : [])])

/** "3 archived, 1 deleted". */
export function closedLabel(threads: readonly NexusThread[]): string {
  const deleted = threads.filter(thread => thread.status === 'deleted').length
  const archived = threads.length - deleted
  return [archived > 0 && `${archived} archived`, deleted > 0 && `${deleted} deleted`].filter(Boolean).join(', ')
}

/** The colour of a state: `work` is an agent mid-turn, `busy` a pylon changing phase. The dashboard's tones. */
export type Tone = 'ok' | 'work' | 'busy' | 'idle' | 'bad' | 'muted'
export const TONE_COLOR: Record<Tone, string> = { ok: 'success', work: 'claude', busy: 'warning', idle: 'inactive', bad: 'error', muted: 'subtle' }

export const ACTUAL_BADGE: Record<NexusActual, [label: string, tone: Tone]> = {
  running: ['running', 'ok'],
  spawning: ['spawning', 'busy'],
  pausing: ['pausing', 'busy'],
  deleting: ['deleting', 'busy'],
  paused: ['paused', 'idle'],
  absent: ['not on its node', 'muted'],
  failed: ['failed', 'bad'],
  unknown: ['unknown', 'muted'],
}
export const DESIRED_TONE: Record<NexusDesired, Tone> = { running: 'ok', paused: 'idle', deleted: 'muted' }

/** What a thread is doing, most urgent first: the agent mid-turn hides a running pylon, never a failed one. */
export function threadState(thread: Pick<NexusThread, 'status' | 'agentTurnRunning'>, pylon: NexusActual): [label: string, tone: Tone] {
  if (thread.status === 'archived' || thread.status === 'deleted') return [thread.status, 'muted']
  if (thread.agentTurnRunning && pylon !== 'failed') return ['agent working', 'work']
  return ACTUAL_BADGE[pylon]
}

/** "5 min", or null under 45 seconds: the dashboard's spans. */
export function span(ms: number): string | null {
  const seconds = Math.max(0, Math.round(ms / 1000))
  return seconds < 45
    ? null
    : seconds < 45 * 60
      ? `${Math.round(seconds / 60)} min`
      : seconds < 36 * 3600
        ? `${Math.round(seconds / 3600)} h`
        : `${Math.round(seconds / 86_400)} d`
}

/** "5 min ago", "just now", or "never" for a time of 0. */
export function since(at: number, now: number): string {
  if (at === 0) return 'never'
  const label = span(now - at)
  return label === null ? 'just now' : `${label} ago`
}

/** A run's length as a clock reads it, such as 1m 12s. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

/**
 * A paused pylon's preview keeps its link, because a visit wakes the pylon. An archived thread's stays paused
 * whatever the visit, so its link would only show the waking page.
 */
export function previewLook(detail: Pick<NexusDetail, 'thread' | 'pylon'>, preview: NexusPreview) {
  if (detail.thread.status === 'archived') return { linked: false, label: 'paused', tone: 'idle' as Tone, hint: 'Unarchive the thread to open it.' }
  if (detail.pylon.actualState === 'paused') return { linked: true, label: 'paused', tone: 'idle' as Tone, hint: 'Opening it wakes the pylon.' }
  // A failed service's URL answers 502, and an unrouted port's 404, so it is no link; the reason is the node's.
  if (preview.failed) return { linked: false, label: 'failed', tone: 'bad' as Tone, hint: preview.failed }
  return preview.ready ? { linked: true, label: 'ready', tone: 'ok' as Tone, hint: null } : { linked: false, label: 'starting', tone: 'busy' as Tone, hint: null }
}

/** Who opened the thread's pane, what it runs and where: the dashboard's session labels. */
export const HARNESS_LABEL: Record<NexusSession['harness'], string> = { 'claude-code': 'Claude Code', pi: 'pi', shell: 'Shell' }
export const SESSION_TONE: Record<ShownSession['status'], Tone> = { working: 'work', idle: 'idle', blocked: 'bad', done: 'ok', unknown: 'muted', opened: 'muted' }

/** The command that attaches a terminal on this Mac to the thread's pylon, through the CLI `cli` names, as a shell takes it. */
export const attachCommand = (cli: string, thread: string) => `${shellQuote(cli)} attach ${shellQuote(thread)}`
/** `word` as one word to a POSIX shell or zsh: bare when nothing in it is special, else single-quoted. */
export const shellQuote = (word: string) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`)

/** The pane of the tab `herdr tab create` printed, or null for output that names none. */
export function parseHerdrTab(stdout: string): string | null {
  try {
    const json: unknown = JSON.parse(stdout)
    const pane = isRecord(json) && isRecord(json.result) && isRecord(json.result.root_pane) ? json.result.root_pane.pane_id : undefined
    return typeof pane === 'string' && pane ? pane : null
  } catch {
    return null
  }
}

/** Why a herdr command failed: the message of the error it printed, else its output, else its exit code. */
export function herdrError(exitCode: number, stdout: string, stderr: string): string {
  for (const text of [stderr, stdout]) {
    try {
      const json: unknown = JSON.parse(text)
      if (isRecord(json) && isRecord(json.error) && typeof json.error.message === 'string') return json.error.message
    } catch {
      // Not herdr's JSON: its usage text or a shell's message.
    }
  }
  return stderr.trim() || stdout.trim() || `herdr exited with ${exitCode}`
}

/** What attaching from this Mac needs, in pi-nexus's words too. */
export const ATTACH_HINT = 'Attaching needs Nexus CLI 0.9.0 or newer and goes through the control plane.'

/** A session as a person names it: its harness, and its title when it has one, such as `Claude Code "login"`. */
export const sessionName = (harness: NexusHarness, title: string | null | undefined) => `${HARNESS_LABEL[harness]}${title ? ` "${title}"` : ''}`

/** How a person names the session `id` in a notice: by its pane while it has that pane, else by the ID `session close` takes. */
export const sessionPlace = (id: string, session: Pick<NexusSession, 'herdrPane'> | undefined) => (session?.herdrPane === id || !session ? `pane ${id}` : `session ${id}`)

/** What brings a paused session back: its pylon's wake, which for an archived thread only its unarchive gives. */
export const resumesOn = (status: NexusThread['status'] | undefined) => (status === 'archived' ? 'unarchive' : 'wake')

/** Why a paused session is not closed: `session close` refuses one without waking its pylon, so the pane does not ask. */
export const pausedClose = (name: string, status: NexusThread['status'] | undefined) => `${name} is paused: it resumes on ${resumesOn(status)}, and can be closed once it runs.`

/** The version `nexus --version` printed (`nexus 0.8.0`), or null when it printed none. */
export function parseVersion(stdout: string): number[] | null {
  const found = /(\d+)\.(\d+)\.(\d+)/.exec(stdout)
  return found ? found.slice(1).map(Number) : null
}

/** Whether `version` comes before `than`, both as `parseVersion` gives them. */
export const isOlder = (version: readonly number[], than: readonly number[]) => {
  const at = version.findIndex((part, index) => part !== than[index])
  return at !== -1 && version[at]! < than[at]!
}

/**
 * How long an open or close confirmed in the pane outweighs details that do not show it. The node reads its sessions
 * again once the CLI has answered, so the next details can still show them as they were.
 */
export const SESSION_SETTLE_MS = 30_000

export const NO_SESSION_CHANGES: NexusSessionChanges = { opening: [], opened: [], closing: [], closed: {} }

/** A session as the Pylon tab lists it: `opened` is one the CLI opened that the node has not reported yet. */
export type ShownSession = NexusSession | (Omit<Extract<NexusSession, { state: 'running' }>, 'status'> & { status: 'opened' })

type Opened = NexusSessionChanges['opened'][number]
type Closed = NexusSessionChanges['closed'][string]

/**
 * The opens the details list, each against a session of its own. A pane names one session, so an open listed in its
 * pane is matched first, unless that session's harness session ID was listed before the open: stale details then show
 * the pane's earlier session. A wake can move a session to another pane, so an open is also matched by a session of its
 * harness and title whose harness session ID the details did not list when the open was confirmed (`before`), which an
 * existing session that moved keeps. A session with no harness session ID could be one that moved, so it matches only
 * by pane, and an open nothing matches keeps its row until `SESSION_SETTLE_MS`.
 */
function listedOpens(opens: readonly Opened[], sessions: readonly NexusSession[]): Set<Opened> {
  const taken = new Set<NexusSession>()
  const listed = new Set<Opened>()
  const claim = (one: Opened, matches: (session: NexusSession) => boolean) => {
    const session = sessions.find(candidate => !taken.has(candidate) && matches(candidate))
    if (!session) return
    taken.add(session)
    listed.add(one)
  }
  // Stale details can still list the pane's earlier session there: one whose harness session ID was listed before is not the open's.
  const wasListed = (one: Opened, session: NexusSession) => session.harnessSessionId !== null && (one.before?.harnessSessionIds.includes(session.harnessSessionId) ?? false)
  for (const one of opens) claim(one, session => session.herdrPane === one.session.herdrPane && !wasListed(one, session))
  for (const one of opens) {
    const { before } = one
    if (listed.has(one) || !before) continue
    claim(
      one,
      session =>
        session.harnessSessionId !== null &&
        !wasListed(one, session) &&
        !before.ids.includes(session.id) &&
        session.harness === one.session.harness &&
        session.title === one.session.title,
    )
  }
  return listed
}

/** Whether the details list `session` as the one closed as `id`: by its ID, or by its harness's session ID, which a wake that moves its pane keeps. */
const isClosedAs = (id: string, closed: Closed, session: NexusSession) =>
  session.id === id || (closed.harnessSessionId !== null && session.harnessSessionId === closed.harnessSessionId)

/**
 * The sessions as the details list them, with the confirmations they do not show yet, for `SESSION_SETTLE_MS` at
 * most: a session just closed is gone, and a session just opened is there, `opened` until the node reports it.
 */
export function shownSessions(sessions: readonly NexusSession[], changes: NexusSessionChanges, now: number): ShownSession[] {
  const isFresh = (at: number) => now - at < SESSION_SETTLE_MS
  const closes = Object.entries(changes.closed).filter(([, closed]) => isFresh(closed.at))
  const listed = sessions.filter(session => !closes.some(([id, closed]) => isClosedAs(id, closed, session)))
  const listedOpen = listedOpens(changes.opened, sessions)
  const opened = changes.opened
    .filter(one => isFresh(one.at) && !closes.some(([id]) => id === one.session.herdrPane) && !listedOpen.has(one))
    .map(({ session }): ShownSession => ({ ...session, id: session.herdrPane, state: 'running', message: null, status: 'opened', harnessSessionId: null }))
  return [...listed, ...opened]
}

/** `changes` without the confirmations that `sessions`, just read, show, or that have waited `SESSION_SETTLE_MS`; the same object when none went. */
export function settleSessions(changes: NexusSessionChanges, sessions: readonly NexusSession[], now: number): NexusSessionChanges {
  const listedOpen = listedOpens(changes.opened, sessions)
  const opened = changes.opened.filter(one => !listedOpen.has(one) && now - one.at < SESSION_SETTLE_MS)
  const closed = Object.fromEntries(
    Object.entries(changes.closed).filter(([id, one]) => sessions.some(session => isClosedAs(id, one, session)) && now - one.at < SESSION_SETTLE_MS),
  )
  if (opened.length === changes.opened.length && Object.keys(closed).length === Object.keys(changes.closed).length) return changes
  return { ...changes, opened, closed }
}

// The Changes tab: the pylon's checkout as `changes` and `diff` print it, the tree the dashboard draws of it, and when
// a read may run, since every read wakes a paused pylon.

const FILE_STATUS = new Set<string>(['added', 'modified', 'deleted', 'renamed', 'copied', 'typechange'])

function parseBase(raw: unknown, command: string): NexusBase {
  if (!isRecord(raw) || (raw.kind !== 'start' && raw.kind !== 'head')) throw contractError(command, 'no base')
  return { kind: raw.kind, commit: strOrNull(raw.commit) }
}

const countOrNull = (value: unknown) => (typeof value === 'number' ? value : null)

/** `changes --json`. A file without its path or a known status fails the read: the CLI and the mod disagree. */
export function parseChanges(json: unknown): NexusChanges {
  if (!isRecord(json) || !Array.isArray(json.files)) throw contractError('changes', 'no files')
  return {
    base: parseBase(json.base, 'changes'),
    files: json.files.map((raw): NexusChangedFile => {
      if (!isRecord(raw) || typeof raw.path !== 'string' || !FILE_STATUS.has(str(raw.status))) throw contractError('changes', 'a file without its path or status')
      return { path: raw.path, oldPath: strOrNull(raw.oldPath), status: raw.status as NexusFileStatus, additions: countOrNull(raw.additions), deletions: countOrNull(raw.deletions) }
    }),
    truncated: json.truncated === true,
  }
}

/** `diff --json`: the unified diff as text, and whether the CLI cut it. */
export function parseDiffReply(json: unknown): { base: NexusBase; diff: string; truncated: boolean } {
  if (!isRecord(json) || typeof json.diff !== 'string') throw contractError('diff', 'no diff')
  return { base: parseBase(json.base, 'diff'), diff: json.diff, truncated: json.truncated === true }
}

/** The one-letter badge of a file's status, as the dashboard's tree shows it. */
export const STATUS_LETTER: Record<NexusFileStatus, string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R', copied: 'C', typechange: 'T' }

/** The facts a Changes read hangs on, from the thread's details. */
export type CheckoutFacts = { status: NexusThread['status']; pylon: NexusActual; turn: boolean; agentAt: number }

export const checkoutFacts = (detail: Pick<NexusDetail, 'thread' | 'pylon'>): CheckoutFacts => ({
  status: detail.thread.status,
  pylon: detail.pylon.actualState,
  turn: detail.thread.agentTurnRunning,
  agentAt: detail.thread.lastAgentActivityAt,
})

/** A read wakes nothing only on a running pylon, and an archived or deleted thread's checkout is never read. */
export const canReadCheckout = (facts: CheckoutFacts) => facts.pylon === 'running' && (facts.status === 'active' || facts.status === 'idle')

/**
 * Whether new details call for a read, as the dashboard's `noticeFacts` decides: an agent turn ended on a running
 * pylon (the run went idle, or the agent was active since with no turn running, so a turn between two polls counts
 * too), or the pylon started running after the person asked to wake it, or while the Changes tab waits for its first
 * read. Never on a timer: a read counts as human activity and keeps the pylon awake.
 */
export function checkoutTrigger(before: CheckoutFacts | null, now: CheckoutFacts, waiting: { isWanted: boolean; isFirst: boolean }): boolean {
  if (!before || !canReadCheckout(now)) return false
  const started = before.pylon !== 'running'
  const turnEnded = !now.turn && (before.turn || now.agentAt !== before.agentAt)
  return turnEnded || (started && (waiting.isWanted || waiting.isFirst))
}

/** `6 files · +30017 −5`, and what they are compared with: `since the pylon booted, 9abe10e`. */
export function changesSummary(changes: NexusChanges): { counts: string; added: number; deleted: number; since: string } {
  const added = changes.files.reduce((sum, file) => sum + (file.additions ?? 0), 0)
  const deleted = changes.files.reduce((sum, file) => sum + (file.deletions ?? 0), 0)
  const isHead = changes.base.kind === 'head'
  // The base is the empty tree before a checkout's first commit, and at the start of a scratch project's pylon.
  const commit = changes.base.commit === null ? (isHead ? 'no commit yet' : 'an empty repository') : changes.base.commit.slice(0, 7)
  return { counts: `${plural(changes.files.length, 'file', 'files')}`, added, deleted, since: `${isHead ? 'since the last commit' : 'since the pylon booted'}, ${commit}` }
}

/** A row of the Changes tree as drawn: a folder, which Enter folds, or a file, which Enter opens. */
export type TreeRow =
  | { kind: 'dir'; key: string; path: string; name: string; depth: number; isOpen: boolean }
  | { kind: 'file'; key: string; name: string; depth: number; file: NexusChangedFile }

type Folder = { dirs: Map<string, Folder>; files: { name: string; file: NexusChangedFile }[] }

export const dirKey = (path: string) => `dir-${path}`
export const fileKey = (path: string) => `file-${path}`

/**
 * The changed files as the dashboard's tree: folders first, then files, each by name, a folder that holds only one
 * folder merged into it (`src/checkout`), and the folders the person folded (`toggled`, keyed `dir-<path>`) closed.
 */
export function changeTree(files: readonly NexusChangedFile[], toggled: Readonly<Record<string, boolean>>): TreeRow[] {
  const root: Folder = { dirs: new Map(), files: [] }
  for (const file of files) {
    const parts = file.path.split('/')
    let folder = root
    for (const part of parts.slice(0, -1)) {
      if (!folder.dirs.has(part)) folder.dirs.set(part, { dirs: new Map(), files: [] })
      folder = folder.dirs.get(part)!
    }
    folder.files.push({ name: parts.at(-1)!, file })
  }
  const rows: TreeRow[] = []
  const walk = (folder: Folder, path: string, depth: number) => {
    for (const [part, inner] of [...folder.dirs].sort(([a], [b]) => a.localeCompare(b))) {
      let name = part
      let deepest = inner
      while (deepest.files.length === 0 && deepest.dirs.size === 1) {
        const [child, next] = [...deepest.dirs][0]!
        name = `${name}/${child}`
        deepest = next
      }
      const at = path === '' ? name : `${path}/${name}`
      const isOpen = toggled[dirKey(at)] ?? true
      rows.push({ kind: 'dir', key: dirKey(at), path: at, name, depth, isOpen })
      if (isOpen) walk(deepest, at, depth + 1)
    }
    for (const { name, file } of folder.files.toSorted((a, b) => a.name.localeCompare(b.name))) rows.push({ kind: 'file', key: fileKey(file.path), name, depth, file })
  }
  walk(root, '', 0)
  return rows
}

/** The most rows a diff shows, as the dashboard caps it: the rest is said to be cut. */
export const DIFF_ROWS = 20_000
/** What a diff row keeps of its line: the pane cuts long lines at its width, and `$.state` holds the rows as JSON. */
const DIFF_CHARS = 400
/** What a diff says of a file beyond its lines, such as a rename or a new mode: the dashboard's `metaLine`. */
const META_LINE = /^(old mode|new mode|new file mode|deleted file mode|similarity index|rename from|rename to|copy from|copy to) /

/**
 * A unified diff's rows, each line with the new file's number or none for a removed one, the hunk separators with
 * their heading, and the lines that say what changed beyond the lines, as the dashboard's `parseDiff` reads it.
 */
export function parseDiff(text: string, max = DIFF_ROWS): { rows: NexusDiffRow[]; meta: string[]; isCut: boolean; isBinary: boolean } {
  const rows: NexusDiffRow[] = []
  const meta: string[] = []
  let next = 0
  let inHunk = false
  for (const line of text.split('\n')) {
    if (rows.length >= max) break
    if (line.startsWith('diff --git ')) {
      inHunk = false
      continue
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line)
    if (hunk) {
      next = Number(hunk[1])
      inHunk = true
      rows.push({ kind: 'hunk', text: hunk[2]!.trim().slice(0, DIFF_CHARS) })
      continue
    }
    if (!inHunk) {
      if (META_LINE.test(line)) meta.push(line)
      continue
    }
    if (line === '' || line[0] === '\\') continue
    const kind = line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : 'ctx'
    rows.push({ kind, line: kind === 'del' ? null : next, text: line.slice(1, DIFF_CHARS + 1) })
    if (kind !== 'del') next += 1
  }
  return { rows, meta, isCut: rows.length >= max, isBinary: /^Binary files /m.test(text) }
}

/** The changes reading needs: its argv, the base after `--uncommitted`, the thread after `--` as the CLI's parseArgs takes it. */
export const changesArgv = (thread: string, uncommitted: boolean) => ['changes', ...(uncommitted ? ['--uncommitted'] : []), '--', thread]

/** A file's diff: a renamed file's old path goes too, or the diff shows it as added. */
export const diffArgv = (thread: string, file: NexusChangedFile, uncommitted: boolean) => ['diff', ...(uncommitted ? ['--uncommitted'] : []), '--', thread, file.path, ...(file.oldPath ? [file.oldPath] : [])]

/** A refusal of the boot base because the pylon booted before Nexus recorded it: the CLI then says to ask since HEAD. */
export const isNoBase = (message: string) => /refs\/nexus\/base|since HEAD/i.test(message)

export type ToolRow = Extract<NexusRow, { kind: 'tool' }>

/** A tool call as drawn: still running in a busy run, without a result once the run stopped, or settled. */
export type ToolStatus = 'running' | 'none' | 'ok' | 'error'

export const toolStatus = (tool: ToolRow, isWorking: boolean): ToolStatus =>
  tool.outcome !== 'running' ? tool.outcome : isWorking ? 'running' : 'none'

/** One block of the conversation as drawn. A run of tool calls this long folds into one line. */
export const FOLD_AT = 4

/**
 * A block's `key` names the row it starts at, counted from the watch's first, so keeping a shorter tail of rows
 * changes no key. `isLive` marks what the run shows of itself, which the next live event replaces.
 */
export type Block = { key: string; isLive: boolean } & (
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'notice'; tone: 'error' | 'dim' | 'warning'; text: string }
  | { kind: 'tools'; tools: ToolRow[] }
)

/**
 * The rows, `dropped` of them before the first, then what the run shows of itself: the answer streaming, a retry
 * waiting, and the queued messages. The answer streaming takes the key of the row it becomes once committed.
 */
export function blocks(rows: readonly NexusRow[], dropped: number, live: NexusLive | null): Block[] {
  const out: Block[] = []
  rows.forEach((row, index) => {
    const last = out.at(-1)
    const key = `row-${dropped + index}`
    if (row.kind === 'tool') {
      if (last?.kind === 'tools') last.tools.push(row)
      else out.push({ key, isLive: false, kind: 'tools', tools: [row] })
    } else if (row.kind === 'notice') out.push({ key, isLive: false, kind: 'notice', tone: row.tone, text: row.text })
    else out.push({ key, isLive: false, kind: row.kind, text: row.text })
  })
  if (live?.partial?.trim()) out.push({ key: `row-${dropped + rows.length}`, isLive: true, kind: 'assistant', text: live.partial.trim() })
  if (live?.retry) out.push({ key: 'live-retry', isLive: true, kind: 'notice', tone: 'warning', text: `The model request failed and will be retried: ${live.retry}` })
  live?.queued.forEach((text, index) => out.push({ key: `live-queued-${index}`, isLive: true, kind: 'user', text }))
  return out
}

/** The name a call is drawn under, as Claude Code names its own: Bash, Read, Update. */
const TOOL_NAMES: Record<string, string> = { bash: 'Bash', read: 'Read', edit: 'Update', write: 'Write', grep: 'Search', find: 'Find', ls: 'List' }
export const toolName = (name: string) => TOOL_NAMES[name] ?? (name ? `${name[0]!.toUpperCase()}${name.slice(1)}` : 'Tool')

/** The argument that says what a call did, shown in its row: the dashboard's subject keys. */
const SUBJECT_KEYS = ['command', 'pattern', 'path', 'url']
export function subjectOf(tool: ToolRow): { key: string; value: string } | undefined {
  const key = SUBJECT_KEYS.find(name => typeof tool.args[name] === 'string')
  return key === undefined ? undefined : { key, value: String(tool.args[key]) }
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/** A fold's line, in Claude Code's words: "Read 3 files, ran 2 commands". */
export function foldSummary(tools: readonly ToolRow[]): string {
  const counts = new Map<string, number>()
  for (const tool of tools) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1)
  const phrase = ([name, count]: [string, number]) =>
    name === 'read'
      ? `read ${plural(count, 'file', 'files')}`
      : name === 'bash'
        ? `ran ${plural(count, 'command', 'commands')}`
        : name === 'edit'
          ? `edited ${plural(count, 'file', 'files')}`
          : name === 'write'
            ? `wrote ${plural(count, 'file', 'files')}`
            : name === 'grep' || name === 'find'
              ? `searched ${plural(count, 'pattern', 'patterns')}`
              : name === 'ls'
                ? `listed ${plural(count, 'directory', 'directories')}`
                : `called ${name} ${plural(count, 'time', 'times')}`
  const text = [...counts.entries()].map(phrase).join(', ')
  return `${text[0]!.toUpperCase()}${text.slice(1)}`
}

/** pi's bash tool ends a failed command's output with its exit code. */
export const exitCode = (output: string) => /exited with code (\d+)/.exec(output)?.[1]

/** `omitted` counts the replacements of an edit's call left out of `source`, which holds what fits in `PATCH_CHARS`. */
export type Diff = { source: string; added: number; removed: number; isNumbered: boolean; omitted: number }

const diffLines = (sign: '+' | '-', text: string) => text.split('\n').map(line => `${sign}${line}`)

/**
 * What an edit or a write changed, as unified hunks Code draws: the patch the edit's result carries, numbered as the
 * file is, else hunks from the call's arguments, which say nothing of where in the file they are.
 */
export function diffOf(tool: ToolRow): Diff | null {
  // From the first hunk on, a line starting + or - is a change: a removed "-- x" reads "--- x" and still counts.
  const count = (source: string) => {
    const lines = source.split('\n')
    return { added: lines.filter(line => line.startsWith('+')).length, removed: lines.filter(line => line.startsWith('-')).length }
  }
  const at = tool.patch?.indexOf('@@') ?? -1
  if (tool.patch && at >= 0) {
    // Only the newline that ends the patch goes: a blank context line is a single space the hunk's counts include.
    const source = tool.patch.slice(at).replace(/\n$/, '')
    return { source, ...count(source), isNumbered: true, omitted: 0 }
  }
  const { edits, content } = tool.args
  const isEdit = (edit: unknown): edit is { oldText: string; newText: string } =>
    isRecord(edit) && typeof edit.oldText === 'string' && typeof edit.newText === 'string'
  if (tool.name === 'edit' && Array.isArray(edits) && edits.length > 0 && edits.every(isEdit)) {
    // A row bounds each replacement, not their number: the hunks are kept whole while they fit, the first always.
    const hunks: string[] = []
    let size = 0
    for (const edit of edits) {
      const hunk = [`@@ -1,${edit.oldText.split('\n').length} +1,${edit.newText.split('\n').length} @@`, ...diffLines('-', edit.oldText), ...diffLines('+', edit.newText)].join('\n')
      if (hunks.length > 0 && size + hunk.length > PATCH_CHARS) break
      hunks.push(hunk)
      size += hunk.length + 1
    }
    const source = hunks.join('\n')
    return { source, ...count(source), isNumbered: false, omitted: edits.length - hunks.length }
  }
  if (tool.name === 'write' && typeof content === 'string') {
    const text = content.replace(/\n$/, '')
    const source = [`@@ -0,0 +1,${text.split('\n').length} @@`, ...diffLines('+', text)].join('\n')
    return { source, ...count(source), isNumbered: true, omitted: 0 }
  }
  return null
}

/** What the agent's run is doing: since when it works and how many tools this turn ran. */
export function runOf(rows: readonly NexusRow[]): { since: number | null; tools: number } {
  const asked = rows.findLastIndex(row => row.kind === 'user')
  const prompt = rows[asked]
  return { since: prompt?.kind === 'user' ? prompt.at : null, tools: rows.slice(asked + 1).filter(row => row.kind === 'tool').length }
}

/** Claude Code's spinner glyphs, one per tick. */
const SPINNER = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢']
export const spinner = (now: number) => SPINNER[Math.floor(now / 1000) % SPINNER.length]!

export function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`
}

/** The verbs that act on one thread: the CLI command of the same name, and what the reply says it did. */
export const ACTIONS = {
  archive: 'Archived',
  unarchive: 'Unarchived',
  abort: 'Aborted the run of',
  retry: 'Retried the parked tasks of',
  'retry-pylon': 'Retried the pylon of',
  delete: 'Deleted',
} as const

export type Action = keyof typeof ACTIONS

export type NexusCommand =
  | { verb: 'pane' }
  | { verb: 'close' }
  | { verb: 'help' }
  | { verb: 'open'; thread: string }
  | { verb: 'new'; project: string; title?: string; message?: string }
  | { verb: 'send'; thread: string; text: string }
  | { verb: 'action'; action: Action; thread?: string }
  | { verb: 'unpublish'; port: number; thread?: string }
  | { verb: 'strip'; isOn: boolean }
  /** `project` undefined asks which project is shown, null shows every project. */
  | { verb: 'scope'; project?: string | null }
  | { verb: 'add-project'; id: string; repoUrl: string; node: string; branch?: string }
  | { verb: 'session-open'; thread: string; harness?: NexusHarness; title?: string }
  /** `session` is the ID `session close` takes, the pane for a session in one. Without it, it asks which to close. */
  | { verb: 'session-close'; thread: string; session?: string }
  | { verb: 'attach'; thread: string }
  | { verb: 'invalid'; reason: string }

export const USAGE = [
  '/nexus                          open the pane',
  '/nexus close                    close it',
  '/nexus open <id>                show a thread in the pane',
  '/nexus new <project> ["title"] <message>',
  '/nexus send <id> <message>      queued behind a running turn',
  '/nexus unpublish <port> [id]    close the preview of a port',
  '/nexus strip on|off             show or hide the threads above the prompt',
  "/nexus project [id|all]         which project's threads show, or the one shown",
  '/nexus project add <id> <repo-url> --node <node> [--branch <branch>]',
  '/nexus session open <id> [--harness claude-code|pi|shell] [--title T]',
  '/nexus session close <id> [session]  a pane or failed-… ID; without one, asks which',
  '/nexus session attach <id>      the command that attaches a terminal to its sessions',
  '/nexus archive|unarchive|abort|retry|retry-pylon|delete [id]',
  'An ID may be a unique prefix (4f2a or th-4f2a). Without one, an action takes the thread open in the pane.',
].join('\n')

/** The head word of `text` and what follows it, whitespace inside the rest kept. */
function split(text: string): [string, string] {
  const match = /^(\S+)\s*([\s\S]*)$/.exec(text.trim())
  return match ? [match[1]!, match[2]!] : ['', '']
}

/** `/nexus` arguments as typed. */
export function parseCommand(args: string): NexusCommand {
  const [verb, rest] = split(args)
  const invalid = (reason: string): NexusCommand => ({ verb: 'invalid', reason: `${reason}\n\n${USAGE}` })
  switch (verb) {
    case '':
    case 'pane':
      return rest ? invalid(`/nexus ${verb} takes nothing more.`) : { verb: 'pane' }
    case 'close':
    case 'help':
      return rest ? invalid(`/nexus ${verb} takes nothing more.`) : { verb }
    case 'open': {
      const [thread, extra] = split(rest)
      return thread && !extra ? { verb: 'open', thread } : invalid('/nexus open takes one thread ID.')
    }
    case 'send': {
      const [thread, text] = split(rest)
      return thread && text ? { verb: 'send', thread, text } : invalid('/nexus send takes a thread ID and a message.')
    }
    case 'new': {
      const [project, after] = split(rest)
      if (!project) return invalid('/nexus new takes a project.')
      const quoted = /^(["'])([\s\S]*?)\1\s*([\s\S]*)$/.exec(after)
      const title = quoted?.[2]?.trim() || undefined
      const message = (quoted ? quoted[3]! : after).trim() || undefined
      if (quoted && !title) return invalid('The title in quotes is empty.')
      if (!title && !message) return invalid('/nexus new takes a message, a "title" or both.')
      return { verb: 'new', project, ...(title ? { title } : {}), ...(message ? { message } : {}) }
    }
    case 'unpublish': {
      const [port, after] = split(rest)
      const [thread, extra] = split(after)
      if (!/^\d+$/.test(port) || extra) return invalid('/nexus unpublish takes a port and at most one thread ID.')
      return { verb: 'unpublish', port: Number(port), ...(thread ? { thread } : {}) }
    }
    case 'strip':
      return rest === 'on' || rest === 'off' ? { verb: 'strip', isOn: rest === 'on' } : invalid('/nexus strip takes on or off.')
    case 'project': {
      const [first, after] = split(rest)
      if (first === 'add') return addProject(after.split(/\s+/).filter(Boolean), invalid)
      if (after) return invalid('/nexus project takes one project ID, all, or add.')
      return first ? { verb: 'scope', project: first === 'all' ? null : first } : { verb: 'scope' }
    }
    case 'session': {
      const parts = words(rest)
      return parts ? session(parts, invalid) : invalid('/nexus session has a quote it does not close.')
    }
    default: {
      if (!Object.hasOwn(ACTIONS, verb)) return invalid(`/nexus has no ${verb}.`)
      const [thread, extra] = split(rest)
      if (extra) return invalid(`/nexus ${verb} takes at most one thread ID.`)
      return { verb: 'action', action: verb as Action, ...(thread ? { thread } : {}) }
    }
  }
}

/**
 * `text` split into words as a shell splits them, so a title can hold spaces: at whitespace outside quotes, a quote
 * anywhere in a word quoting up to its close (`--title="two words"`), and a backslash outside single quotes taking the
 * next character as it is. Null for a quote left open.
 */
function words(text: string): string[] | null {
  const found: string[] = []
  let word: string | null = null
  let quote: '"' | "'" | null = null
  for (let at = 0; at < text.length; at++) {
    const char = text[at]!
    if (quote) {
      if (char === quote) quote = null
      else if (char === '\\' && quote === '"' && (text[at + 1] === '"' || text[at + 1] === '\\')) word = `${word ?? ''}${text[++at]}`
      else word = `${word ?? ''}${char}`
    } else if (/\s/.test(char)) {
      if (word !== null) found.push(word)
      word = null
    } else if (char === '"' || char === "'") {
      quote = char
      word ??= ''
    } else if (char === '\\' && at + 1 < text.length) word = `${word ?? ''}${text[++at]}`
    else word = `${word ?? ''}${char}`
  }
  if (quote) return null
  if (word !== null) found.push(word)
  return found
}

/** `/nexus session open|close|attach` and their arguments. */
function session([command, ...args]: readonly string[], invalid: (reason: string) => NexusCommand): NexusCommand {
  switch (command) {
    case 'open': {
      const positional: string[] = []
      const flags: { harness?: string; title?: string } = {}
      for (let at = 0; at < args.length; at++) {
        const arg = args[at]!
        if (!arg.startsWith('--')) {
          positional.push(arg)
          continue
        }
        const [flag, inline] = arg.slice(2).split(/=(.*)/s) as [string, string | undefined]
        if (flag !== 'harness' && flag !== 'title') return invalid(`/nexus session open takes only --harness and --title, not --${flag}.`)
        const value = inline ?? args[++at]
        if (!value) return invalid(`/nexus session open needs a ${flag} after --${flag}.`)
        flags[flag] = value
      }
      if (positional.length !== 1) return invalid('/nexus session open takes one thread ID.')
      if (flags.harness !== undefined && !HARNESS.has(flags.harness)) return invalid(`/nexus session open takes a harness of ${HARNESSES.join(', ')}, not ${flags.harness}.`)
      return { verb: 'session-open', thread: positional[0]!, ...(flags.harness ? { harness: flags.harness as NexusHarness } : {}), ...(flags.title ? { title: flags.title } : {}) }
    }
    case 'close':
      if (args.length === 0 || args.length > 2) return invalid('/nexus session close takes a thread ID, and may name a session by its pane or ID.')
      return { verb: 'session-close', thread: args[0]!, ...(args[1] === undefined ? {} : { session: args[1] }) }
    case 'attach':
      return args.length === 1 ? { verb: 'attach', thread: args[0]! } : invalid('/nexus session attach takes one thread ID.')
    default:
      return invalid(command === undefined ? '/nexus session takes open, close or attach.' : `/nexus session has no ${command}.`)
  }
}

/** `/nexus project add`'s arguments: an ID and a repo URL, and --node and --branch, as `--flag value` or `--flag=value`. */
function addProject(args: readonly string[], invalid: (reason: string) => NexusCommand): NexusCommand {
  const positional: string[] = []
  const flags: { node?: string; branch?: string } = {}
  for (let at = 0; at < args.length; at++) {
    const arg = args[at]!
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const [flag, inline] = arg.slice(2).split(/=(.*)/s) as [string, string | undefined]
    if (flag !== 'node' && flag !== 'branch') return invalid(`/nexus project add takes only --node and --branch, not --${flag}.`)
    const value = inline ?? args[++at]
    if (!value) return invalid(`/nexus project add needs a ${flag} after --${flag}.`)
    flags[flag] = value
  }
  if (positional.length !== 2) return invalid('/nexus project add takes a project ID and a repo URL.')
  if (!flags.node) return invalid('/nexus project add needs --node <node>; nexus nodes lists them.')
  const [id, repoUrl] = positional as [string, string]
  return { verb: 'add-project', id, repoUrl, node: flags.node, ...(flags.branch ? { branch: flags.branch } : {}) }
}

/** A thread the strip shows, by what it asks of the person: most urgent first. */
export type Chip = { thread: NexusThreadRow; kind: 'needs' | 'reply' | 'working'; note: string }

const CHIP_RANK: Record<Chip['kind'], number> = { needs: 0, reply: 1, working: 2 }

/**
 * The open threads that ask for the person or are busy: a failed pylon or parked tasks (known only for the thread
 * the pane watches, since `threads` does not carry them), an answer since the person last viewed the thread, then
 * the agents at work with how long since the person's message started them. The rest stay out of the strip.
 */
export function stripChips(threads: readonly NexusThreadRow[], strip: NexusStrip, now: number, parked: ReadonlySet<string>): Chip[] {
  const chips = threads.flatMap((thread): Chip[] => {
    if (thread.status !== 'active' && thread.status !== 'idle') return []
    if (thread.pylon.actualState === 'failed' || thread.pylon.failed || parked.has(thread.id)) return [{ thread, kind: 'needs', note: 'needs you' }]
    if (thread.agentTurnRunning) return [{ thread, kind: 'working', note: `working ${span(now - thread.lastHumanActivityAt) ?? 'now'}` }]
    if (thread.lastAgentActivityAt > (strip.seen[thread.id] ?? strip.since)) return [{ thread, kind: 'reply', note: 'new reply' }]
    return []
  })
  return chips.sort((a, b) => CHIP_RANK[a.kind] - CHIP_RANK[b.kind] || b.thread.lastActivityAt - a.thread.lastActivityAt)
}

/**
 * East Asian wide characters and emoji, which take two terminal cells. The emoji below 0x2e80 are the ones Bun's
 * `stringWidth` (1.3.14, Claude Code's runtime) counts as two; the rarer scripts where it differs are not mirrored.
 */
const WIDE = [
  [0x1100, 0x115f],
  [0x20e3, 0x20e3], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3], [0x25fd, 0x25fe],
  [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be],
  [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa],
  [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755],
  [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1faff],
  [0x20000, 0x3fffd],
] as const

const charCells = (char: string) => {
  const point = char.codePointAt(0)!
  return WIDE.some(([first, last]) => point >= first && point <= last) ? 2 : 1
}

/** The cells `text` takes in a terminal. */
export function cells(text: string): number {
  let count = 0
  for (const char of text) count += charCells(char)
  return count
}

/** The longest start of `text` that fits in `width` cells. */
function head(text: string, width: number): string {
  let used = 0
  let end = 0
  for (const char of text) {
    used += charCells(char)
    if (used > width) break
    end += char.length
  }
  return text.slice(0, end)
}

/** `text` ending in a full stop; the CLI's messages end without one. */
export const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`)

export const clip = (text: string, width: number) => (cells(text) <= width ? text : `${head(text, Math.max(0, width - 1))}…`)
