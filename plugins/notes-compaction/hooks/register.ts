import type {
  EngineInterface,
  Register,
  RenderElement,
  SessionCompacted,
  SessionMessage,
  ToolCallInput,
  ToolCallResult,
} from 'claude-code'
import { MESSAGE_LIMIT, useHistory } from './history.ts'
import {
  agentIdOf,
  agentName,
  type Note,
  noteFileName,
  ROOT,
  recentPaths,
  resolvePath,
  useNotes,
  WRITE_ACTIONS,
} from './notes.ts'
import {
  GUIDANCE,
  newState,
  nextWindow,
  reminderFor,
  remindersDone,
  type SessionState,
  type WindowIdentity,
  windowMarker,
  windowText,
} from './windows.ts'

const NOTES_TOOL = 'mcp__notes-compaction__notes'

type Namespace = 'notes' | 'history'
interface ActionSpec {
  fields: readonly string[]
  required?: readonly string[]
  /** The notes field that holds a virtual path. */
  pathField?: string
}
/** Each tool's actions: the fields they take and which are required. Help, filtering and checks derive from it. */
const ACTIONS: Record<Namespace, Record<string, ActionSpec>> = {
  notes: {
    list_files_by_prefix: { fields: ['prefix', 'file_order', 'file_order_by', 'max_results'], pathField: 'prefix' },
    read_file: { fields: ['path', 'start_line', 'stop_line'], required: ['path'], pathField: 'path' },
    search_contents: {
      fields: ['query', 'path_prefix', 'max_files', 'max_matches_per_file', 'recent_file_first'],
      required: ['query'],
      pathField: 'path_prefix',
    },
    append_to_file: { fields: ['path', 'text'], required: ['path', 'text'], pathField: 'path' },
    write_file: { fields: ['path', 'text'], required: ['path', 'text'], pathField: 'path' },
  },
  history: {
    list_windows: { fields: ['agent_name', 'limit', 'recent_first'] },
    list_items: {
      fields: ['agent_name', 'window_id', 'role', 'tool_name', 'limit', 'max_chars_per_item', 'recent_first'],
    },
    read_item: {
      fields: ['agent_name', 'window_id', 'item_id', 'offset_chars', 'limit_chars'],
      required: ['window_id', 'item_id'],
    },
    search_contents: {
      fields: ['agent_name', 'window_id', 'role', 'tool_name', 'query', 'limit', 'recent_first'],
      required: ['query'],
    },
  },
}
const actionNames = (namespace: Namespace) => ['help', ...Object.keys(ACTIONS[namespace])]
const STRING = { type: 'string' }
const POSITIVE = { type: 'integer', minimum: 1 }
const NOTES_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: actionNames('notes') },
    path: STRING,
    text: STRING,
    prefix: STRING,
    query: STRING,
    path_prefix: STRING,
    start_line: POSITIVE,
    stop_line: POSITIVE,
    max_results: POSITIVE,
    max_files: POSITIVE,
    max_matches_per_file: POSITIVE,
    file_order: { type: 'string', enum: ['ascending', 'descending'] },
    file_order_by: { type: 'string', enum: ['name', 'created_at', 'updated_at'] },
    recent_file_first: { type: 'boolean' },
  },
  additionalProperties: false,
}
const HISTORY_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: actionNames('history') },
    agent_name: STRING,
    item_id: STRING,
    window_id: STRING,
    query: STRING,
    limit: POSITIVE,
    limit_chars: POSITIVE,
    max_chars_per_item: POSITIVE,
    offset_chars: { type: 'integer', minimum: 0 },
    recent_first: { type: 'boolean' },
    role: { type: 'string', enum: ['user', 'assistant', 'tool'] },
    tool_name: STRING,
  },
  additionalProperties: false,
}
const EMPTY_SCHEMA = { type: 'object', properties: {}, additionalProperties: false }
const TOOLS = [
  {
    name: 'notes',
    // The description carries the checkpoint guidance: prompt events do not reach this mod (see AGENTS.md).
    description: `Persistent notes. write_file replaces; append_to_file adds. Virtual paths: relative uses current agent; cross-agent uses <agent>/notes[/path], read-only. Call with no arguments for help.\n\n${GUIDANCE}`,
    inputSchema: NOTES_SCHEMA,
    isDeferred: false,
  },
  {
    name: 'history',
    description: "Search earlier conversation, don't browse it. Pass returned IDs unchanged. Call with no arguments for help.",
    inputSchema: HISTORY_SCHEMA,
    isDeferred: true,
  },
  {
    name: 'new_context',
    description: 'Start fresh from saved notes; recover earlier conversation through history',
    inputSchema: EMPTY_SCHEMA,
    isDeferred: false,
  },
  { name: 'get_context_remaining', description: 'Remaining context tokens', inputSchema: EMPTY_SCHEMA, isDeferred: true },
]

/** The tool's own arguments: tool.call's input also carries reserved keys beside them. */
function args(e: object, schema: { properties: object }): Record<string, unknown> {
  const keys = Object.keys(schema.properties)
  return Object.fromEntries(Object.entries(e).filter(([key]) => keys.includes(key)))
}

/** Help-backed tools: no arguments, or action help, lists each action's fields; optional ones end in `?`. */
function discovery(namespace: Namespace, params: Record<string, unknown>) {
  const keys = Object.keys(params)
  if (keys.length && params['action'] !== 'help') return
  if (keys.some((key) => key !== 'action')) throw new Error('Help accepts only action: help')
  return {
    actions: Object.fromEntries([
      ['help', ''],
      ...Object.entries(ACTIONS[namespace]).map(([action, spec]) => [
        action,
        spec.fields.map((field) => (spec.required?.includes(field) ? field : `${field}?`)).join(' '),
      ]),
    ]),
  }
}

/** The action's own fields, with its required ones present. */
function relevant(namespace: Namespace, params: Record<string, unknown>) {
  const spec = ACTIONS[namespace][String(params['action'])]
  if (!spec) throw new Error('Unknown action')
  const missing = (spec.required ?? []).filter((field) => typeof params[field] !== 'string' || !params[field])
  if (missing.length) throw new Error(`Supply ${missing.join(' and ')}`)
  const scoped = Object.fromEntries(
    Object.entries(params).filter(([key]) => key === 'action' || spec.fields.includes(key)),
  )
  return { scoped, spec }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
const result = (payload: unknown) => ({ result: JSON.stringify(payload) })
const failure = (error: unknown) => ({ deny: message(error) })

/**
 * Where Claude Code keeps plugins out of compaction (2.1.299+ on machines with managed settings and for Team and
 * Enterprise organizations), a rollover is Claude Code's summary told to defer to the notes.
 */
const ROLLOVER_SUMMARY =
  'The agent saved its working state in notes and continues from them in a new context window. Write at most a few lines: the user\'s latest request in their words, and only what happened after the last notes save that the notes lack. Do not restate saved notes.'
const BLOCKED_NOTICE =
  "Claude Code keeps plugins out of compaction here, so each new window starts from a short Claude Code summary and your notes. Idle and automatic compaction stay Claude Code's own."

const PENDING = 'A notes checkpoint or rollover is already pending.'
const CHECKPOINT_FIRST = 'Saving a notes checkpoint first. The new window opens after it completes.'
const ROLLOVER_FAILED = 'Context rollover failed. The existing context remains.'
const NOTE_FIRST = 'Save your progress with notes, wait for the write to succeed, then call new_context next.'

const CHECKPOINT_PROMPT =
  '<context_window_reminder>\nContext checkpoint requested. Save the current state with notes, then finish your response. The new window opens after this turn. Do not call new_context. If saving fails, report the failure without rolling over.\n</context_window_reminder>'

/** One successful root write: root's whole note set after it, its window, and the session's subagents. */
interface Revision {
  /** The writing session, so /notes can prune its records with it. */
  session?: string
  notes: Note[]
  window?: WindowIdentity
  agents?: string[]
}
/** $.fs.read takes at most 4 MiB, so a revision must stay below it to be restorable. */
const REVISION_LIMIT = 4_000_000

// Module state restarts on reload; the window identity itself is persisted per session.
let storage: Promise<string> | undefined
let sessionId: string | undefined
let loaded: { dir: string; promise: Promise<{ dir: string; state: SessionState }> } | undefined
/**
 * The running main turn. Between turns, Claude Code compacts on its own only while idle. `lastCall` is its latest
 * completed tool call and `savedNote` its latest successful notes write, so new_context can require that it directly
 * follows a saved note.
 */
let turn: { id: string; notes: 'none' | 'saved' | 'failed'; lastCall?: string; savedNote?: string } | undefined
/** The window whose latest completed turn saved fresh notes. */
let freshWindowId: string | undefined
/**
 * At most one rollover at a time: requested by new_context, a checkpoint (/compact or idle compaction), or the
 * /compact opening it. Only new_context's window continues on its own; the others (`waits`) wait for the user,
 * as Claude Code's /compact does.
 */
let pending:
  | { kind: 'requested' }
  | { kind: 'checkpoint'; windowId: string }
  | { kind: 'rolling'; waits: boolean; answered: boolean }
  | undefined
/**
 * The marker of a window opened from Claude Code's summary that waits for the user: it leads their next prompt,
 * the one message that can carry it there.
 */
let unsentMarker: string | undefined
/** The context whose idle compaction already asked for a checkpoint; a later one there stays Claude Code's own. */
let idleCheckpointWindowId: string | undefined
/**
 * Where Claude Code compacts on its own (an auto-compact window such as 400k), refreshed each turn.
 * Reminders and remaining context measure against it, so checkpoints come before that compaction.
 */
let compactThreshold: number | undefined
/** Parallel calls in one batch would otherwise read the same note before either append lands. */
let notesQueue: Promise<unknown> = Promise.resolve()
/** The /notes setting: run Claude Code's summary before each new window, as Pi's normal compaction does. */
let normalCompaction = false
/**
 * Whether our session.compact hook answers (`hooked`) or Claude Code skips it (`blocked`), as the last rollover or
 * compaction found; unknown until then, and treated as possibly blocked. Kept in the store, so where the hook
 * answers, rollover's /compact carries no summary instructions; after an upgrade into the block, the first
 * rollover is therefore Claude Code's full summary.
 */
let compaction: 'hooked' | 'blocked' | undefined
/** What the /notes pane shows; a change redraws it. */
let panel: { status: string[]; confirmPrune: boolean; message?: string } = { status: [], confirmPrune: false }
const PANE = 'notes-compaction'

// The engine follows $ only into functions declared in this file, so all I/O lives here.

/** Storage outside ~/.claude, which may be a synced dotfiles directory. */
function storageRoot($: EngineInterface): Promise<string> {
  storage ??= dataHome($)
  return storage
}

async function dataHome($: EngineInterface): Promise<string> {
  return `${(await $.env.get('XDG_DATA_HOME')) || `${await $.env.get('HOME')}/.local/share`}/claude-notes-compaction`
}

/** Where Claude Code keeps this profile's transcripts, one folder per project. */
async function transcriptsDir($: EngineInterface): Promise<string> {
  return `${(await $.env.get('CLAUDE_CONFIG_DIR')) || `${await $.env.get('HOME')}/.claude`}/projects`
}

async function revisionPath($: EngineInterface, toolUseId: string): Promise<string> {
  return `${await storageRoot($)}/revisions/${toolUseId}.json`
}

const rootNotesDir = (sessionDir: string) => `${sessionDir}/notes`

/**
 * Root notes live with their session. A subagent's live under its agent ID, which is unique,
 * so a fork that carries the Agent call reaches the same notes.
 */
async function notesDir($: EngineInterface, agent: string): Promise<string> {
  const id = agentIdOf(agent)
  return id === undefined ? rootNotesDir((await session($)).dir) : `${await storageRoot($)}/agents/${id}/notes`
}

/** The session's state, loaded once; concurrent first calls share the load, and a failed one is retried. */
async function session($: EngineInterface) {
  sessionId ??= await $.session.id()
  const dir = `${await storageRoot($)}/sessions/${sessionId}`
  if (loaded?.dir !== dir) {
    const promise = loadSession($, dir)
    loaded = { dir, promise }
    promise.catch(() => {
      if (loaded?.promise === promise) loaded = undefined
    })
  }
  return loaded.promise
}

/**
 * A session without state is new, or a fork (`--fork-session`, `/branch`) whose transcript was
 * copied from its parent. Like Pi's receipts, each successful root write saves a revision under its
 * tool use ID, so the last write the copied transcript shows restores the notes as they stood at
 * the fork point. A window marker after that write wins for the window identity.
 */
async function loadSession($: EngineInterface, dir: string) {
  const path = `${dir}/state.json`
  if (await $.fs.exists(path)) return { dir, state: JSON.parse(await $.fs.read(path)) as SessionState }
  const messages = await $.session.messages()
  const markers = messages.map(windowMarker)
  const state = newState()
  state.projects = await transcriptsDir($)
  // A fork inherits the subagents its copied transcript launched, with their notes.
  const launched = messages.flatMap((m) => m.toolUses.flatMap((use) => (use.agentId ? [agentName(use.agentId)] : [])))
  if (launched.length) state.agents = [...new Set(launched)]
  let restored: Revision | undefined
  let restoredFrom: string | undefined
  let markerWindow: WindowIdentity | undefined
  let sawWrite = false
  for (let i = messages.length - 1; i >= 0 && !restored; i--) {
    const marker = markers[i]
    if (marker && !markerWindow)
      markerWindow = {
        firstWindowId: marker.first ?? marker.current,
        currentWindowId: marker.current,
        ...(marker.previous ? { previousWindowId: marker.previous } : {}),
        windowNumber: markers.filter((m) => m && !m.repeated).length,
      }
    for (const use of [...messages[i]!.toolUses].reverse()) {
      if (use.tool !== NOTES_TOOL || use.isError || !WRITE_ACTIONS.includes(use.input['action'])) continue
      sawWrite = true
      const file = await revisionPath($, use.tool_use_id)
      if (!(await $.fs.exists(file))) continue
      restored = JSON.parse(await $.fs.read(file)) as Revision
      restoredFrom = use.tool_use_id
      break
    }
  }
  state.window = markerWindow ?? restored?.window ?? state.window
  if (restored) {
    await Promise.all(restored.notes.map((note) => writeNote($, rootNotesDir(dir), note)))
    state.agents = [...new Set([...(state.agents ?? []), ...(restored.agents ?? [])])]
    state.restoredFrom = restoredFrom
  } else if (sawWrite || messages.length >= MESSAGE_LIMIT)
    $.ui.toast("This session's earlier notes could not be restored. Notes start empty; earlier history remains.")
  // Persist before use: history and notes may cite the first window's ID before anything else is saved.
  await saveState($, dir, state)
  return { dir, state }
}

async function saveState($: EngineInterface, dir: string, state: SessionState) {
  await $.fs.write(`${dir}/state.json`, JSON.stringify(state))
}

async function writeNote($: EngineInterface, dir: string, note: Note) {
  await $.fs.write(`${dir}/${await noteFileName(note.path)}`, JSON.stringify(note))
}

async function readNotes($: EngineInterface, dir: string): Promise<Map<string, Note>> {
  if (!(await $.fs.exists(dir))) return new Map()
  const files = (await $.fs.list(dir)).filter((entry) => entry.kind === 'file' && entry.name.endsWith('.json'))
  const notes = await Promise.all(files.map(async (entry) => JSON.parse(await $.fs.read(`${dir}/${entry.name}`)) as Note))
  return new Map(notes.map((note) => [note.path, note]))
}

/** One note, for a read: its own file instead of the whole set. */
async function readNote($: EngineInterface, dir: string, path: string): Promise<Map<string, Note>> {
  const file = `${dir}/${await noteFileName(path)}`
  if (!(await $.fs.exists(file))) return new Map()
  const note = JSON.parse(await $.fs.read(file)) as Note
  return new Map([[note.path, note]])
}

/**
 * Whether a note path may name this agent: root, the caller, subagents that wrote notes here, or
 * a subagent the transcript in view launched.
 */
async function isSessionAgent($: EngineInterface, self: string, agent: string): Promise<boolean> {
  if (agent === ROOT || agent === self || (await session($)).state.agents?.includes(agent)) return true
  return (await $.session.messages()).some((m) => m.toolUses.some((use) => use.agentId && agentName(use.agentId) === agent))
}

/**
 * The window's opening message, after `kept` (normal compaction's summary, or nothing for a
 * notes-only window); the conversation continues once it stands, unless it waits for the user.
 */
async function openWindow($: EngineInterface, kept: readonly SessionMessage[], waits: boolean): Promise<SessionCompacted> {
  const marker = await advanceWindow($)
  if (!waits) $.clock.after(100, () => $.prompt.submit({ text: 'Continue.' }))
  return {
    messages: [
      ...kept,
      { role: 'user', text: marker, toolUses: [] },
      { role: 'assistant', text: 'New context window opened.', toolUses: [] },
    ],
  }
}

/** Moves the session into its next window, whose reminders start over, and returns that window's marker. */
async function advanceWindow($: EngineInterface): Promise<string> {
  const { dir, state } = await session($)
  const ids = nextWindow(state.window)
  const recent = recentPaths(await readNotes($, rootNotesDir(dir)), ROOT)
  state.window = ids
  state.reminded = []
  await saveState($, dir, state)
  return windowText(ROOT, ids, recent)
}

/**
 * Rollover runs between turns through /compact: the one route on which our session.compact hook answers.
 * Where Claude Code skips that hook, its own summary runs instead, guided to defer to the notes.
 */
function roll($: EngineInterface, waits: boolean) {
  const rolling = { kind: 'rolling' as const, waits, answered: false }
  pending = rolling
  $.clock.after(100, async () => {
    try {
      const guided = !normalCompaction && compaction !== 'hooked'
      await $.command.run({ command: 'compact', ...(guided ? { args: ROLLOVER_SUMMARY } : {}) })
      if (!rolling.answered) await continueAfterSummary($, waits)
    } catch (error) {
      $.ui.toast(`Context rollover failed: ${message(error)}. The existing context remains.`)
    } finally {
      pending = undefined
    }
  })
}

/**
 * The window after Claude Code's own summary, when our hook could not answer: the marker that history reads
 * window boundaries from arrives as the prompt that continues. Usage reads no context until the next request,
 * so a context still measured means no compaction ran.
 */
async function continueAfterSummary($: EngineInterface, waits: boolean) {
  if ((await $.session.usage()).context.tokens !== undefined)
    throw new Error('Claude Code did not compact the conversation')
  if (compaction !== 'blocked') {
    $.ui.toast(BLOCKED_NOTICE)
    await setCompaction($, 'blocked')
  }
  const marker = await advanceWindow($)
  if (waits) unsentMarker = marker
  else $.clock.after(100, () => $.prompt.submit({ text: `${marker}\nContinue.` }))
}

async function setCompaction($: EngineInterface, found: 'hooked' | 'blocked') {
  compaction = found
  await $.store.set('compaction', found)
}

/** In place of a compaction: a turn that saves notes, after which turn.complete rolls into a window that waits. */
function checkpoint($: EngineInterface, windowId: string, guidance: string) {
  pending = { kind: 'checkpoint', windowId }
  $.clock.after(100, () => $.prompt.submit({ text: CHECKPOINT_PROMPT + guidance }))
}

async function refreshThreshold($: EngineInterface) {
  const breakdown = (await $.session.usage({ breakdown: 'summary' })).context.breakdown
  compactThreshold = breakdown?.isAutoCompactEnabled ? breakdown.autoCompactThreshold : undefined
}

async function contextUsed($: EngineInterface): Promise<{ limit: number; tokens?: number }> {
  const { context } = await $.session.usage()
  return { limit: Math.min(context.window, compactThreshold ?? context.window), tokens: context.tokens }
}

/**
 * Characters of tool results since the model's last request. Measured usage stops at that request,
 * so a large batch (several file reads) would otherwise cross the limit unseen.
 */
let batchChars = 0
/** A rough, early-leaning conversion for code and prose alike. */
const CHARS_PER_TOKEN = 3
/** The context dueReminder last measured, and the share of the limit it must fall by to count as a compaction. */
let measured: number | undefined
const UNSEEN_COMPACTION_DROP = 0.1

/** The context reminder due once `unsentChars` more reach the model, marked sent. Each fires once per window. */
async function dueReminder($: EngineInterface, unsentChars: number): Promise<string | undefined> {
  const { dir, state } = await session($)
  // Where the hook answers, compaction resets reminders there, so a reminded-out window needs no measuring.
  if (compaction === 'hooked' && remindersDone(state)) return
  const { limit, tokens } = await contextUsed($)
  if (compaction !== 'hooked') {
    // Where Claude Code keeps plugins out of compaction, its own compaction goes unseen here. Measured context only
    // grows within a window, so a clear fall since the last check, or none measured (also on resume), means one ran.
    const compacted = tokens === undefined || (measured !== undefined && measured - tokens > limit * UNSEEN_COMPACTION_DROP)
    measured = tokens
    if (compacted && state.reminded.length) {
      state.reminded = []
      await saveState($, dir, state)
    }
  }
  if (remindersDone(state)) return
  const estimate = tokens === undefined ? undefined : tokens + unsentChars / CHARS_PER_TOKEN
  const reminder = reminderFor(state, estimate === undefined || limit <= 0 ? undefined : (100 * estimate) / limit)
  if (reminder) await saveState($, dir, state)
  return reminder
}

/** Mid-turn, reminders ride on tool results, the one channel to the model. */
async function remind($: EngineInterface, agentId: string | undefined, called: ToolCallResult): Promise<ToolCallResult> {
  if (agentId !== undefined || called.deny !== undefined) return called
  batchChars += (called.text ?? (typeof called.result === 'string' ? called.result : JSON.stringify(called.result ?? ''))).length
  try {
    const reminder = await dueReminder($, batchChars)
    return reminder ? { ...called, context: [...(called.context ?? []), reminder] } : called
  } catch {
    return called
  }
}

function callNotes($: EngineInterface, e: ToolCallInput): Promise<ToolCallResult> {
  const run = notesQueue.then(() => runNotes($, e))
  notesQueue = run.catch(() => undefined)
  return run
}

async function runNotes($: EngineInterface, e: ToolCallInput): Promise<ToolCallResult> {
  const params = args(e, NOTES_SCHEMA)
  const isWrite = WRITE_ACTIONS.includes(params['action'])
  const main = e.agentId === undefined
  try {
    const help = discovery('notes', params)
    if (help) return result(help)
    const { scoped, spec } = relevant('notes', params)
    const self = agentName(e.agentId)
    const field = spec.pathField!
    const target = resolvePath(scoped[field], self, spec.required?.includes(field) ?? false)
    if (isWrite && target.agent !== self)
      throw new Error(`Write only your own notes, with a relative path. ${target.agent}'s notes are read-only here.`)
    if (!(await isSessionAgent($, self, target.agent)))
      throw new Error(`${target.agent} is not an agent of this session. Use a relative path for your own notes.`)
    const dir = await notesDir($, target.agent)
    const notes = params['action'] === 'read_file' ? await readNote($, dir, target.path) : await readNotes($, dir)
    const { payload, write } = useNotes(notes, { ...scoped, [field]: target.path }, await $.clock.now(), target.agent)
    if (!write) return result(payload)
    const { dir: sessionDir, state } = await session($)
    // The revision is the receipt a fork rebuilds root notes from. Subagent notes need none: they
    // live under the agent ID, which a fork shares. Its size is checked before anything changes.
    notes.set(write.path, write)
    const revision =
      e.tool_use_id && main
        ? JSON.stringify({
            session: sessionId,
            notes: [...notes.values()],
            window: state.window,
            agents: state.agents,
          } satisfies Revision)
        : undefined
    if (revision && new TextEncoder().encode(revision).length > REVISION_LIMIT)
      throw new Error('Notes exceed 4 MB in total. Shorten or replace existing notes, then save again.')
    try {
      await writeNote($, dir, write)
    } catch {
      throw new Error('Note could not be saved. Retry after local storage is available.')
    }
    if (revision)
      try {
        await $.fs.write(await revisionPath($, e.tool_use_id!), revision)
      } catch {
        throw new Error(
          `${payload['path']} was saved, but forks of this session will not see it. Read it back and save it again with write_file.`,
        )
      }
    if (!main && !state.agents?.includes(self)) {
      state.agents = [...(state.agents ?? []), self]
      await saveState($, sessionDir, state)
    }
    if (main && turn) {
      if (turn.notes === 'none') turn.notes = 'saved'
      turn.savedNote = e.tool_use_id
    }
    return result(payload)
  } catch (error) {
    if (isWrite && main && turn) turn.notes = 'failed'
    return failure(error)
  }
}

async function callHistory($: EngineInterface, e: ToolCallInput): Promise<ToolCallResult> {
  const params = args(e, HISTORY_SCHEMA)
  try {
    const help = discovery('history', params)
    if (help) return result(help)
    const { scoped } = relevant('history', params)
    const name = scoped['agent_name']
    const id = agentIdOf(typeof name === 'string' && name ? name : agentName(e.agentId))
    if (id === undefined) {
      const { state } = await session($)
      return result(useHistory(await $.session.messages(), scoped, state.window.currentWindowId))
    }
    // A subagent's transcript is its own single window.
    const found = await $.session.messages({ agentId: id })
    if ('deny' in found)
      throw new Error(`${agentName(id)}'s history is not available here. Omit agent_name to search your own.`)
    return result(useHistory(found, scoped, `agent:${id}`))
  } catch (error) {
    return failure(error)
  }
}

function showPanel($: EngineInterface, change: Partial<typeof panel>) {
  panel = { ...panel, ...change }
  $.ui.invalidate('ui.render')
}

async function childNames($: EngineInterface, dir: string, kind: 'file' | 'dir'): Promise<string[]> {
  if (!(await $.fs.exists(dir))) return []
  return (await $.fs.list(dir)).filter((entry) => entry.kind === kind).map((entry) => entry.name)
}

async function refreshPanel($: EngineInterface) {
  const base = await storageRoot($)
  const { dir, state } = await session($)
  const notes = (await childNames($, rootNotesDir(dir), 'file')).length
  const sessions = (await childNames($, `${base}/sessions`, 'dir')).length
  const records = (await childNames($, `${base}/revisions`, 'file')).length
  const { limit } = await contextUsed($)
  showPanel($, {
    status: [
      `Continuity active · window ${state.window.windowNumber + 1} · ${notes} notes in this session`,
      ...(compaction === 'blocked' ? ['Claude Code keeps plugins out of compaction here: new windows start from a short summary'] : []),
      `Reminders at 85% and 90% of ${limit} tokens (${compactThreshold ? 'the auto-compact threshold' : 'the model window'})`,
      `${sessions} sessions · ${records} fork records`,
    ],
  })
}

async function toggleNormalCompaction($: EngineInterface) {
  normalCompaction = !normalCompaction
  await $.store.set('settings', { normalCompaction })
  showPanel($, { message: undefined })
}

/** A session this recently active stays: one that saves no transcript may still be running. */
const PRUNE_GRACE_MS = 24 * 60 * 60 * 1000

/**
 * Removes stored sessions of this profile whose Claude Code transcript is gone, with their fork
 * records and the subagent notes no remaining session names. The active session, recently active
 * ones, other profiles' sessions and records a remaining fork restored from stay.
 */
async function prune($: EngineInterface): Promise<string> {
  const base = await storageRoot($)
  const projects = await transcriptsDir($)
  if (!(await $.fs.exists(projects))) return `No Claude Code transcripts found at ${projects}. Nothing was pruned.`
  const live = new Set([sessionId])
  for (const project of await childNames($, projects, 'dir'))
    for (const file of await childNames($, `${projects}/${project}`, 'file'))
      if (file.endsWith('.jsonl')) live.add(file.slice(0, -'.jsonl'.length))
  const now = await $.clock.now()
  const removed = new Set<string>()
  const kept: SessionState[] = []
  let retained = 0
  for (const id of await childNames($, `${base}/sessions`, 'dir')) {
    const dir = `${base}/sessions/${id}`
    const entries = await $.fs.list(dir)
    const stateFile = entries.find((entry) => entry.name === 'state.json')
    const state = stateFile ? (JSON.parse(await $.fs.read(`${dir}/state.json`)) as SessionState) : undefined
    const recent = entries.some((entry) => now - entry.mtimeMs < PRUNE_GRACE_MS)
    if (live.has(id) || !state || state.projects !== projects || recent) {
      if (state) kept.push(state)
      if (!live.has(id)) retained++
    } else removed.add(id)
  }
  const keptAgents = new Set(kept.flatMap((state) => state.agents ?? []))
  const keptRecords = new Set(kept.flatMap((state) => (state.restoredFrom ? [`${state.restoredFrom}.json`] : [])))
  const records: string[] = []
  for (const file of await childNames($, `${base}/revisions`, 'file')) {
    if (keptRecords.has(file)) continue
    const owner = (JSON.parse(await $.fs.read(`${base}/revisions/${file}`)) as Revision).session
    if (owner && removed.has(owner)) records.push(`${base}/revisions/${file}`)
  }
  const agents = (await childNames($, `${base}/agents`, 'dir')).filter((id) => !keptAgents.has(agentName(id)))
  const paths = [
    ...[...removed].map((id) => `${base}/sessions/${id}`),
    ...records,
    ...agents.map((id) => `${base}/agents/${id}`),
  ]
  const retainedNote = retained
    ? ` Retained ${retained} sessions without a transcript that are recent, from another profile or of unknown origin.`
    : ''
  if (!paths.length) return `Nothing to prune.${retainedNote}`
  for (let i = 0; i < paths.length; i += 200) {
    let run: { exitCode: number; stderr: string }
    try {
      run = await $.process.run(['rm', '-rf', ...paths.slice(i, i + 200)])
    } catch (error) {
      return `Prune needs the rm command, which could not run: ${message(error)}. Nothing further was removed.`
    }
    if (run.exitCode !== 0) return `Prune stopped: ${run.stderr.trim() || `rm exited ${run.exitCode}`}.`
  }
  return `Pruned ${removed.size} sessions, ${records.length} fork records and ${agents.length} subagent note sets.${retainedNote}`
}

async function confirmPrune($: EngineInterface) {
  showPanel($, { confirmPrune: false, message: 'Pruning…' })
  let outcome: string
  try {
    outcome = await prune($)
  } catch (error) {
    outcome = `Prune failed: ${message(error)}`
  }
  showPanel($, { message: outcome })
  await refreshPanel($)
}

export const register: Register = (on) => {
  // First registered is outermost: this wraps every tool's result, the plugin's own included.
  on('tool.call', async ($, e, next) => {
    const called = await next(e)
    if (e.agentId === undefined && turn && e.tool_use_id) turn.lastCall = e.tool_use_id
    return remind($, e.agentId, called)
  })

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const [settings, found] = await Promise.all([$.store.get('settings'), $.store.get('compaction')])
    normalCompaction = (settings as { normalCompaction?: boolean } | undefined)?.normalCompaction === true
    compaction = found as typeof compaction
    for (const tool of TOOLS) await $.tool.register(tool)
    await $.command.register({ name: 'notes', description: 'Notes continuity status and settings' })
    return started
  })

  // A turn without tool calls gets its reminder with the prompt. Our own prompts are skipped:
  // "Continue." arrives while usage still measures the old window, and the checkpoint prompt already asks for notes.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'plugin' && e.origin.name === 'notes-compaction') return next(e)
    // A slash command's text cannot be rewritten, so the marker waits for a plain prompt.
    const marker = e.command ? undefined : unsentMarker
    if (marker) unsentMarker = undefined
    const prompt = marker ? { ...e, text: `${marker}\n${e.text}` } : e
    // This runs before turn.start refreshes the threshold, which a resumed session has yet to read.
    const reminder = await refreshThreshold($)
      .then(() => dueReminder($, e.text.length))
      .catch(() => undefined)
    return next(reminder ? { ...prompt, context: [...(prompt.context ?? []), reminder] } : prompt)
  })

  // After new_context, the turn ends at its next model request, once the whole tool batch ran,
  // as Pi's new_context ends the run; the rollover then follows the turn's completion.
  // A note that failed this turn keeps the turn going, so the model sees the error; the rollover is then cancelled.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) batchChars = 0
    if (e.agentId !== undefined || pending?.kind !== 'requested' || turn?.notes === 'failed') return yield* next(e)
    const answer = 'Starting a new context window.'
    yield { kind: 'text', index: 0, text: answer }
    yield { kind: 'stop', stopReason: 'end_turn', usage: null }
    return { turnId: e.turnId, index: e.index, answer, toolUses: [], stopReason: 'end_turn', usage: null }
  })

  // /clear ends this session in the same process, under a new ID.
  on('session.end', async ($, e, next) => {
    sessionId = loaded = turn = freshWindowId = pending = idleCheckpointWindowId = measured = unsentMarker = undefined
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    turn = { id: e.turnId, notes: 'none' }
    // /config and /model can move the threshold between turns; the previous figure stands meanwhile.
    refreshThreshold($).catch(() => undefined)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const completed = await next(e)
    if (e.agentId !== undefined) return completed
    const ended = turn?.id === e.turnId ? turn : undefined
    turn = undefined
    const windowId = (await session($)).state.window.currentWindowId
    const fresh = e.reason === 'answer' && ended?.notes === 'saved'
    freshWindowId = fresh ? windowId : undefined
    const was = pending
    if (was?.kind === 'checkpoint') {
      pending = undefined
      if (e.isAborted || was.windowId !== windowId) $.ui.toast('Checkpoint cancelled. The old context remains.')
      else if (fresh) roll($, true)
      else
        $.ui.toast(
          'Rollover did not start. No fresh note was saved in the completed checkpoint. The old context remains.',
        )
    } else if (was?.kind === 'requested') {
      pending = undefined
      if (e.isAborted) $.ui.toast('Rollover cancelled by the interruption. The old context remains.')
      else if (ended?.notes === 'failed')
        $.ui.toast('Rollover did not start: a note failed to save this turn. The old context remains.')
      else roll($, false)
    }
    return completed
  })

  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    if (compaction !== 'hooked') await setCompaction($, 'hooked')
    if (e.trigger === 'precompute') return next(e)
    if (pending?.kind === 'rolling') {
      const { waits } = pending
      pending.answered = true
      if (!normalCompaction) return openWindow($, [], waits)
      const compacted = await next(e)
      return compacted.messages ? openWindow($, compacted.messages, waits) : compacted
    }
    // With normal compaction on, idle compaction is Claude Code's own, as in Pi. Otherwise it is handled as /compact
    // (the command.run hook): the prompt cache is still warm, so a checkpoint turn costs about what its summary would.
    if (e.trigger === 'auto' && turn === undefined && !normalCompaction) {
      if (pending) return { skip: PENDING }
      const windowId = (await session($)).state.window.currentWindowId
      if (freshWindowId === windowId) return openWindow($, [], true)
      if (idleCheckpointWindowId !== windowId) {
        idleCheckpointWindowId = windowId
        checkpoint($, windowId, '')
        return { skip: CHECKPOINT_FIRST }
      }
    }
    // Other compaction stays Claude Code's own; reminders and the idle checkpoint restart in the compacted context.
    // The window's marker leads it again, so the window keeps its identity and history files the summary under it.
    const compacted = await next(e)
    if (!compacted.messages) return compacted
    idleCheckpointWindowId = undefined
    const { dir, state } = await session($)
    state.reminded = []
    await saveState($, dir, state)
    const marker = windowText(ROOT, state.window, recentPaths(await readNotes($, rootNotesDir(dir)), ROOT), true)
    return { ...compacted, messages: [{ role: 'user', text: marker, toolUses: [] }, ...compacted.messages] }
  }).catch(async ($, e, next) => {
    // A called next replays what it settled to: a rejection there is Claude Code's own compaction failing.
    if (next.called)
      try {
        await next(e)
      } catch (error) {
        return { skip: `Claude Code's compaction failed: ${message(error)}. The existing context remains.` }
      }
    return { skip: ROLLOVER_FAILED }
  })

  on('tool.call', { tool: 'mcp__notes-compaction__notes' }, ($, e) => callNotes($, e))

  on('tool.call', { tool: 'mcp__notes-compaction__history' }, ($, e) => callHistory($, e))

  on('tool.call', { tool: 'mcp__notes-compaction__new_context' }, async ($, e) => {
    if (e.agentId !== undefined) return { deny: 'Only the main conversation can start a new context window.' }
    if (pending)
      return result({
        started: false,
        message: 'A checkpoint or rollover is already pending. Save notes and finish your response',
      })
    // A write earlier in the batch may still be saving.
    await notesQueue
    if (!turn?.savedNote || turn.lastCall !== turn.savedNote) return { deny: NOTE_FIRST }
    pending = { kind: 'requested' }
    return result({
      started: true,
      message: normalCompaction
        ? 'Normal compaction will run before the new window opens'
        : 'A new window will continue from your notes after this turn',
    })
  })

  // /compact is decided here, before compaction, since Claude Code may keep plugins out of session.compact. With
  // normal compaction on it is Claude Code's own, as in Pi. The rollover's own /compact, run by this plugin, skips this hook.
  on('command.run', { command: 'compact' }, async ($, e, next) => {
    if (normalCompaction) return next(e)
    if (pending) return { text: PENDING }
    const windowId = (await session($)).state.window.currentWindowId
    const instructions = e.args.trim()
    if (!instructions && freshWindowId === windowId) {
      roll($, true)
      return { text: 'Opening a new window from your notes.' }
    }
    checkpoint($, windowId, instructions ? `\n\nCheckpoint guidance:\n${instructions}` : '')
    return { text: CHECKPOINT_FIRST }
  }).catch(() => ({ text: ROLLOVER_FAILED }))

  on('command.run', { command: 'notes' }, async ($, e) => {
    if (e.args.trim()) return { text: 'Use /notes to open the notes panel.' }
    showPanel($, { confirmPrune: false, message: undefined })
    await refreshPanel($)
    await $.ui.open({ id: PANE, title: 'Notes continuity' })
    return { text: 'Notes panel opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const prune = panel.confirmPrune
      ? h(
          Box,
          { flexDirection: 'row', gap: 1 },
          h(
            Button,
            { key: 'confirm', hotkey: 'y', variant: 'primary', onPress: () => void confirmPrune($) },
            'Confirm prune',
          ),
          h(Button, { key: 'cancel', hotkey: 'c', onPress: () => showPanel($, { confirmPrune: false }) }, 'Cancel'),
        )
      : h(
          Button,
          { key: 'prune', hotkey: 'p', onPress: () => showPanel($, { confirmPrune: true, message: undefined }) },
          'Prune missing sessions',
        )
    return h(
      Box,
      { flexDirection: 'column' },
      ...panel.status.map((line) => h(Text, null, line)),
      h(
        Button,
        { key: 'normal', hotkey: 'n', onPress: () => void toggleNormalCompaction($) },
        `Normal compaction before new windows: ${normalCompaction ? 'on' : 'off'}`,
      ),
      prune,
      panel.confirmPrune &&
        h(Text, { dimColor: true }, 'Removes stored notes of sessions whose Claude Code transcript no longer exists.'),
      panel.message && h(Text, { dimColor: true }, panel.message),
      h(Button, { key: 'close', hotkey: 'x', role: 'dismiss', onPress: () => void $.ui.close({ id: PANE }) }, 'Close'),
    ) as RenderElement
  })

  on('tool.call', { tool: 'mcp__notes-compaction__get_context_remaining' }, async ($, e) => {
    if (e.agentId !== undefined) return { deny: 'Context usage is reported for the main conversation only.' }
    const { state } = await session($)
    const { limit, tokens } = await contextUsed($)
    const remainingTokens = typeof tokens === 'number' && limit > 0 ? Math.max(0, limit - tokens) : null
    return result({
      contextWindow: limit,
      windowId: state.window.currentWindowId,
      remainingTokens,
      remainingPercent: remainingTokens === null ? null : Math.round((remainingTokens / limit) * 1000) / 10,
    })
  })
}
