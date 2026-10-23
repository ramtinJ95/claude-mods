// Everything the mod knows about Nexus that needs no `$`: parsing what the CLI
// prints, folding a watch stream into rows, the /nexus grammar and the tail's
// layout. docs/cli.md in the Nexus repository is the contract parsed here.
import type { NexusFailure, NexusRow, NexusRunState, NexusThread, NexusWatch } from '../types'

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

function parseThread(raw: unknown): NexusThread | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.title !== 'string' || typeof raw.project !== 'string') return undefined
  return {
    id: raw.id,
    title: raw.title,
    project: raw.project,
    status: raw.status as NexusThread['status'],
    agentTurnRunning: raw.agentTurnRunning === true,
    lastActivityAt: Math.max(num(raw.lastAgentActivityAt), num(raw.lastHumanActivityAt), num(raw.createdAt)),
  }
}

/** `threads --json` or `start --json`, kept to the fields the mod reads. */
export function parseThreads(json: unknown): NexusThread[] {
  if (!Array.isArray(json)) throw new Error('nexus threads did not print a list')
  return json.flatMap(raw => parseThread(raw) ?? [])
}

export function parseStarted(json: unknown): NexusThread {
  const thread = parseThread(json)
  if (!thread) throw new Error('nexus start did not print a thread')
  return thread
}

// The pi-ai message shapes an entry's `model` holds, as far as rows read them.
type Part = { type?: string; text?: string; id?: string; name?: string; arguments?: unknown }
type Message = {
  role?: string
  content?: string | Part[]
  toolCallId?: string
  isError?: boolean
  stopReason?: string
  errorMessage?: string
}

/** An entry as the watch prints it: its model messages, and the CLI's plain rendering of them. */
export type WatchEntry = { model: Message[] | null; text: string }

export type WatchEvent =
  | { type: 'reset'; entries: WatchEntry[] }
  | { type: 'entry'; entry: WatchEntry }
  | { type: 'state'; state: NexusRunState }
  | { type: 'error'; kind: 'unreachable' | 'failed'; message: string }

function parseEntry(entry: unknown, text: unknown): WatchEntry {
  const model = isRecord(entry) && Array.isArray(entry.model) ? (entry.model as Message[]) : null
  return { model, text: typeof text === 'string' ? text : '' }
}

/** One line of `watch --json`; undefined for a line or an event type this version does not know. */
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
  if (!isRecord(args)) return ''
  const key = SUMMARY_KEYS.find(name => typeof args[name] === 'string')
  const text = key ? (args[key] as string) : (Object.values(args).find(value => typeof value === 'string') as string | undefined) ?? JSON.stringify(args)
  return text.replace(/\s+/g, ' ').trim()
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
        if (text) next.push({ kind: 'user', text })
        break
      }
      case 'assistant': {
        for (const part of Array.isArray(message.content) ? message.content : []) {
          if (part.type === 'text' && part.text?.trim()) next.push({ kind: 'assistant', text: part.text.trim() })
          if (part.type === 'toolCall') next.push({ kind: 'tool', id: part.id ?? '', name: part.name ?? 'tool', summary: toolSummary(part.arguments), outcome: 'running' })
        }
        if (message.stopReason === 'error') next.push({ kind: 'notice', tone: 'error', text: `The model failed: ${message.errorMessage ?? 'no reason given'}` })
        if (message.stopReason === 'aborted') next.push({ kind: 'notice', tone: 'dim', text: 'Aborted.' })
        break
      }
      case 'toolResult': {
        const at = next.findLastIndex(row => row.kind === 'tool' && row.id === message.toolCallId)
        const row = next[at]
        if (row?.kind === 'tool') next[at] = { ...row, outcome: message.isError ? 'error' : 'ok' }
        break
      }
    }
  }
  return next
}

/** Rows kept per thread: the pane shows a tail, and `$.state` holds JSON for every redraw. */
const KEPT_ROWS = 400

export function applyEvent(watch: NexusWatch, event: WatchEvent): NexusWatch {
  switch (event.type) {
    case 'reset':
      return { ...watch, rows: event.entries.reduce(appendEntry, [] as NexusRow[]).slice(-KEPT_ROWS) }
    case 'entry':
      return { ...watch, rows: appendEntry(watch.rows, event.entry).slice(-KEPT_ROWS) }
    case 'state':
      return { ...watch, state: event.state, outage: null }
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

export type ProjectGroup = { project: string; threads: NexusThread[]; archived: number }

/** Threads by project, A to Z, each group's most recent first; archived ones counted unless shown. */
export function groupThreads(threads: readonly NexusThread[], showArchived: boolean): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>()
  for (const thread of threads) {
    if (thread.status === 'deleted') continue
    const group = groups.get(thread.project) ?? { project: thread.project, threads: [], archived: 0 }
    groups.set(thread.project, group)
    if (thread.status === 'archived' && !showArchived) group.archived += 1
    else group.threads.push(thread)
  }
  for (const group of groups.values()) group.threads.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  return [...groups.values()].sort((a, b) => a.project.localeCompare(b.project))
}

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
  | { verb: 'invalid'; reason: string }

export const USAGE = [
  '/nexus                          open the pane',
  '/nexus close                    close it',
  '/nexus open <id>                show a thread in the pane',
  '/nexus new <project> ["title"] <message>',
  '/nexus send <id> <message>      queued behind a running turn',
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
    default: {
      if (!Object.hasOwn(ACTIONS, verb)) return invalid(`/nexus has no ${verb}.`)
      const [thread, extra] = split(rest)
      if (extra) return invalid(`/nexus ${verb} takes at most one thread ID.`)
      return { verb: 'action', action: verb as Action, ...(thread ? { thread } : {}) }
    }
  }
}

export type Span = { text: string; color?: string; dim?: boolean; bold?: boolean }
export type Line = Span[]

/** East Asian wide characters and emoji, which take two terminal cells. */
const WIDE = [
  [0x1100, 0x115f],
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

/** `text` broken into lines of at most `width` cells at spaces, a longer word broken where it must. */
export function wrap(text: string, width: number): string[] {
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      let rest = word
      while (cells(rest) > width) {
        if (line) lines.push(line)
        line = ''
        const piece = head(rest, width) || [...rest][0]!
        lines.push(piece)
        rest = rest.slice(piece.length)
      }
      if (!rest) continue
      if (line && cells(line) + 1 + cells(rest) > width) {
        lines.push(line)
        line = rest
      } else line = line ? `${line} ${rest}` : rest
    }
    lines.push(line)
  }
  return lines
}

/** `text` ending in a full stop; the CLI's messages end without one. */
export const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`)

export const clip = (text: string, width: number) => (cells(text) <= width ? text : `${head(text, Math.max(0, width - 1))}…`)

const OUTCOME = {
  running: { glyph: '◌', color: 'claude' },
  ok: { glyph: '✓', color: 'success' },
  error: { glyph: '✗', color: 'error' },
} as const

/** A run of tool rows longer than this shows its last ones under a count of the rest. */
const TOOLS_SHOWN = 3

type Block = { kind: NexusRow['kind'] | 'tools'; lines: Line[] }

function rowLines(row: Exclude<NexusRow, { kind: 'tool' }>, width: number): Line[] {
  switch (row.kind) {
    case 'user':
      return wrap(row.text, width - 2).map((text, index) => [{ text: index === 0 ? '› ' : '  ', color: 'claude', bold: true }, { text, bold: true }])
    case 'assistant':
      return wrap(row.text, width).map(text => [{ text }])
    case 'notice':
      return wrap(row.text, width).map(text => [row.tone === 'error' ? { text, color: 'error' } : { text, dim: true }])
  }
}

function toolLine(row: Extract<NexusRow, { kind: 'tool' }>, width: number): Line {
  const { glyph, color } = OUTCOME[row.outcome]
  const name = clip(row.name, Math.max(4, width - 4))
  return [{ text: `${glyph} `, color }, { text: name, bold: true }, { text: clip(` ${row.summary}`, Math.max(0, width - 2 - cells(name))), dim: true }]
}

function toolBlock(run: Extract<NexusRow, { kind: 'tool' }>[], width: number): Line[] {
  const hidden = run.slice(0, Math.max(0, run.length - TOOLS_SHOWN))
  const failed = hidden.filter(row => row.outcome === 'error').length
  const head: Line[] = hidden.length
    ? [[{ text: clip(`  ${hidden.length} earlier tool call${hidden.length === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''}`, width), dim: true }]]
    : []
  return [...head, ...run.slice(hidden.length).map(row => toolLine(row, width))]
}

/**
 * The last `room` display lines of a conversation `width` cells wide: each message wrapped, each run of tool calls
 * collapsed to its last few, a blank line between messages. Built from the end, so a long thread costs its tail.
 */
export function tailLines(rows: readonly NexusRow[], width: number, room: number): Line[] {
  const blocks: Block[] = []
  let used = 0
  let at = rows.length - 1
  while (at >= 0 && used < room) {
    const row = rows[at]!
    if (row.kind === 'tool') {
      let start = at
      while (start > 0 && rows[start - 1]!.kind === 'tool') start -= 1
      const block = { kind: 'tools' as const, lines: toolBlock(rows.slice(start, at + 1) as Extract<NexusRow, { kind: 'tool' }>[], width) }
      blocks.unshift(block)
      used += block.lines.length + 1
      at = start - 1
    } else {
      const block = { kind: row.kind, lines: rowLines(row, width) }
      blocks.unshift(block)
      used += block.lines.length + 1
      at -= 1
    }
  }
  const isWork = (block: Block | undefined) => block?.kind === 'tools' || block?.kind === 'notice'
  const lines = blocks.flatMap((block, index) =>
    index === 0 || (isWork(block) && isWork(blocks[index - 1])) ? block.lines : [[], ...block.lines],
  )
  return lines.slice(-room)
}
