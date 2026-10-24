// Everything the mod knows about Nexus that needs no `$`: parsing what the CLI
// prints, folding a watch stream into rows, the /nexus grammar and what the
// pane derives from them. docs/cli.md in the Nexus repository is the contract.
import type {
  NexusActual,
  NexusDesired,
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
  NexusSession,
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

const HARNESS = new Set(['claude-code', 'pi', 'shell'])
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
    sessions: list(json.sessions).flatMap((raw): NexusSession[] =>
      isRecord(raw) && typeof raw.herdrPane === 'string'
        ? [
            {
              herdrPane: raw.herdrPane,
              harness: HARNESS.has(str(raw.harness)) ? (raw.harness as NexusSession['harness']) : 'shell',
              harnessSessionId: strOrNull(raw.harnessSessionId),
              status: SESSION.has(str(raw.status)) ? (raw.status as NexusSession['status']) : 'unknown',
            },
          ]
        : [],
    ),
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

/** `nexus project add`'s answer: the project it added. */
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
  // A failed service's URL answers 502 until the service runs again, so it is no link; the reason is the node's.
  if (preview.failed) return { linked: false, label: 'failed', tone: 'bad' as Tone, hint: preview.failed }
  return preview.ready ? { linked: true, label: 'ready', tone: 'ok' as Tone, hint: null } : { linked: false, label: 'starting', tone: 'busy' as Tone, hint: null }
}

/** Who opened the thread's pane, what it runs and where: the dashboard's session labels. */
export const HARNESS_LABEL: Record<NexusSession['harness'], string> = { 'claude-code': 'Claude Code', pi: 'pi', shell: 'Shell' }
export const SESSION_TONE: Record<NexusSession['status'], Tone> = { working: 'work', idle: 'idle', blocked: 'bad', done: 'ok', unknown: 'muted' }

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
    default: {
      if (!Object.hasOwn(ACTIONS, verb)) return invalid(`/nexus has no ${verb}.`)
      const [thread, extra] = split(rest)
      if (extra) return invalid(`/nexus ${verb} takes at most one thread ID.`)
      return { verb: 'action', action: verb as Action, ...(thread ? { thread } : {}) }
    }
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
