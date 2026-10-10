import type { EngineInterface, Register, SessionCompacted, ToolCallInput, ToolCallResult } from 'claude-code'
import { useHistory } from './history.ts'
import { type Note, noteFileName, recentPaths, useNotes } from './notes.ts'
import { GUIDANCE, newState, nextWindow, reminderFor, type SessionState, windowText } from './windows.ts'

const NOTES_ACTIONS = ['help', 'list_files_by_prefix', 'read_file', 'search_contents', 'append_to_file', 'write_file']
const HISTORY_ACTIONS = ['help', 'list_windows', 'list_items', 'read_item', 'search_contents']
const FIELDS: Record<string, readonly string[]> = {
  list_files_by_prefix: ['prefix', 'file_order', 'file_order_by', 'max_results'],
  read_file: ['path', 'start_line', 'stop_line'],
  search_notes: ['query', 'path_prefix', 'max_files', 'max_matches_per_file', 'recent_file_first'],
  append_to_file: ['path', 'text'],
  write_file: ['path', 'text'],
  list_windows: ['limit', 'recent_first'],
  list_items: ['window_id', 'role', 'tool_name', 'limit', 'max_chars_per_item', 'recent_first'],
  read_item: ['window_id', 'item_id', 'offset_chars', 'limit_chars'],
  search_history: ['window_id', 'role', 'tool_name', 'query', 'limit', 'recent_first'],
}
const REQUIRED = ['path', 'text', 'query', 'item_id', 'window_id']
const STRING = { type: 'string' }
const POSITIVE = { type: 'integer', minimum: 1 }
const NOTES_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: NOTES_ACTIONS },
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
    action: { type: 'string', enum: HISTORY_ACTIONS },
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

/** The tool's own arguments: tool.call's input also carries reserved keys beside them. */
function args(e: object, schema: { properties: object }): Record<string, unknown> {
  const keys = Object.keys(schema.properties)
  return Object.fromEntries(Object.entries(e).filter(([key]) => keys.includes(key)))
}

/** Help-backed tools: no arguments, or action help, lists each action's fields. */
function discovery(namespace: 'notes' | 'history', params: Record<string, unknown>) {
  const keys = Object.keys(params)
  if (keys.length && params['action'] !== 'help') return
  if (keys.some((key) => key !== 'action')) throw new Error('Help accepts only action: help')
  const actions = namespace === 'notes' ? NOTES_ACTIONS : HISTORY_ACTIONS
  return {
    actions: Object.fromEntries(
      actions.map((action) => [
        action,
        action === 'help'
          ? ''
          : FIELDS[action === 'search_contents' ? `search_${namespace}` : action]!
              .map((field) => (REQUIRED.includes(field) ? field : `${field}?`))
              .join(' '),
      ]),
    ),
  }
}

function relevant(namespace: 'notes' | 'history', params: Record<string, unknown>): Record<string, unknown> {
  const action = params['action']
  const fields = FIELDS[action === 'search_contents' ? `search_${namespace}` : String(action)]
  if (!fields) throw new Error('Unknown action')
  return Object.fromEntries(Object.entries(params).filter(([key]) => key === 'action' || fields.includes(key)))
}

const result = (payload: unknown) => ({ result: JSON.stringify(payload) })
const failure = (error: unknown) => ({ deny: error instanceof Error ? error.message : String(error) })

const CHECKPOINT_PROMPT =
  '<context_window_reminder>\nContext checkpoint requested. Save the current state with notes, then finish your response. The new window opens after this turn. Do not call new_context. If saving fails, report the failure without rolling over.\n</context_window_reminder>'

// Module state restarts on reload; the window identity itself is persisted per session.
let cached: { dir: string; state: SessionState } | undefined
let loading: { dir: string; promise: Promise<{ dir: string; state: SessionState }> } | undefined
let turn: { id: string; saved: number; failed: boolean } | undefined
let lastCompleted: { windowId: string; fresh: boolean } | undefined
let rollRequested = false
let checkpoint: { windowId: string } | undefined
let rolling = false
let opened = false

// The engine follows $ only into functions declared in this file, so all I/O lives here.

/** Per-session storage outside ~/.claude, which may be a synced dotfiles directory. */
async function session($: EngineInterface) {
  const base = (await $.env.get('XDG_DATA_HOME')) || `${await $.env.get('HOME')}/.local/share`
  const dir = `${base}/claude-notes-compaction/sessions/${await $.session.id()}`
  if (cached?.dir === dir) return cached
  // Concurrent first calls share one load; a failed load is retried by the next call.
  if (loading?.dir !== dir) {
    const promise = loadSession($, dir)
    loading = { dir, promise }
    promise.then(
      (loaded) => {
        cached = loaded
      },
      () => {
        if (loading?.promise === promise) loading = undefined
      },
    )
  }
  return loading.promise
}

async function loadSession($: EngineInterface, dir: string) {
  const path = `${dir}/state.json`
  if (await $.fs.exists(path)) return { dir, state: JSON.parse(await $.fs.read(path)) as SessionState }
  // Persist before use: history and notes may cite the first window's ID before anything else is saved.
  const state = newState()
  await saveState($, dir, state)
  return { dir, state }
}

async function saveState($: EngineInterface, dir: string, state: SessionState) {
  await $.fs.write(`${dir}/state.json`, JSON.stringify(state))
}

async function readNotes($: EngineInterface, dir: string): Promise<Map<string, Note>> {
  const notes = new Map<string, Note>()
  if (!(await $.fs.exists(`${dir}/notes`))) return notes
  for (const entry of await $.fs.list(`${dir}/notes`)) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    const note = JSON.parse(await $.fs.read(`${dir}/notes/${entry.name}`)) as Note
    notes.set(note.path, note)
  }
  return notes
}

async function openWindow($: EngineInterface): Promise<SessionCompacted> {
  const { dir, state } = await session($)
  const ids = nextWindow(state.window)
  const recent = recentPaths(await readNotes($, dir))
  state.window = ids
  state.reminded = []
  await saveState($, dir, state)
  return {
    messages: [
      { role: 'user', text: windowText(ids, recent), toolUses: [] },
      { role: 'assistant', text: 'New context window opened.', toolUses: [] },
    ],
  }
}

/** Rollover runs between turns through /compact: the one route on which our session.compact hook answers. */
function roll($: EngineInterface) {
  $.clock.after(100, async () => {
    rolling = true
    opened = false
    try {
      await $.command.run({ command: 'compact' })
    } catch (error) {
      $.ui.toast(`Context rollover failed: ${String(error)}. The existing context remains.`)
      return
    } finally {
      rolling = false
    }
    if (opened) await $.prompt.submit({ text: 'Continue.' })
  })
}

/** Context reminders ride on tool results, the one mid-turn channel to the model. Each fires once per window. */
async function remind($: EngineInterface, agentId: string | undefined, called: ToolCallResult): Promise<ToolCallResult> {
  if (agentId !== undefined || called.deny !== undefined) return called
  try {
    const { dir, state } = await session($)
    const reminder = reminderFor(state, (await $.session.usage()).context.percent)
    if (!reminder) return called
    await saveState($, dir, state)
    return { ...called, context: [...(called.context ?? []), reminder] }
  } catch {
    return called
  }
}

/** Parallel calls in one batch would otherwise read the same note before either append lands. */
let notesQueue: Promise<unknown> = Promise.resolve()

function callNotes($: EngineInterface, e: ToolCallInput): Promise<ToolCallResult> {
  const run = notesQueue.then(() => runNotes($, e))
  notesQueue = run.catch(() => undefined)
  return run
}

async function runNotes($: EngineInterface, e: ToolCallInput): Promise<ToolCallResult> {
  const params = args(e, NOTES_SCHEMA)
  const isWrite = params['action'] === 'write_file' || params['action'] === 'append_to_file'
  try {
    const help = discovery('notes', params)
    if (help) return result(help)
    const { dir } = await session($)
    const { payload, write } = useNotes(await readNotes($, dir), relevant('notes', params), await $.clock.now())
    if (!write) return result(payload)
    try {
      await $.fs.write(`${dir}/notes/${await noteFileName(write.path)}`, JSON.stringify(write))
    } catch {
      throw new Error('Note could not be saved. Retry after local storage is available.')
    }
    if (e.agentId === undefined && turn) turn.saved++
    return result(payload)
  } catch (error) {
    if (isWrite && e.agentId === undefined && turn) turn.failed = true
    return failure(error)
  }
}

async function callHistory($: EngineInterface, e: ToolCallInput): Promise<ToolCallResult> {
  const params = args(e, HISTORY_SCHEMA)
  try {
    const help = discovery('history', params)
    if (help) return result(help)
    const { state } = await session($)
    return result(useHistory(await $.session.messages(), relevant('history', params), state.window.currentWindowId))
  } catch (error) {
    return failure(error)
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    turn = lastCompleted = checkpoint = undefined
    rollRequested = rolling = false
    await $.tool.register({
      name: 'notes',
      description:
        'Cross-window notes. write_file replaces; append_to_file adds. Relative virtual paths. Call with no arguments for help.',
      inputSchema: NOTES_SCHEMA,
      isDeferred: false,
    })
    await $.tool.register({
      name: 'history',
      description: 'Prior-window detail. Pass IDs unchanged. Search, never browse. Call with no arguments for help.',
      inputSchema: HISTORY_SCHEMA,
      isDeferred: true,
    })
    await $.tool.register({
      name: 'new_context',
      description: 'Start a new context window',
      inputSchema: EMPTY_SCHEMA,
      isDeferred: false,
    })
    await $.tool.register({
      name: 'get_context_remaining',
      description: 'Remaining context tokens',
      inputSchema: EMPTY_SCHEMA,
      isDeferred: true,
    })
    return started
  })

  on('session.end', async ($, e, next) => {
    cached = loading = turn = lastCompleted = checkpoint = undefined
    rollRequested = rolling = false
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!e.tools.includes('mcp__notes-compaction__notes')) return composed
    return { sections: [...composed.sections, { id: 'notes-compaction:guidance', text: GUIDANCE, scope: 'session' }] }
  })

  on('turn.start', async ($, e, next) => {
    turn = { id: e.turnId, saved: 0, failed: false }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const completed = await next(e)
    if (e.agentId !== undefined) return completed
    const { state } = await session($)
    const windowId = state.window.currentWindowId
    const fresh = e.reason === 'answer' && turn?.id === e.turnId && turn.saved > 0 && !turn.failed
    lastCompleted = { windowId, fresh }
    if (checkpoint) {
      const requested = checkpoint
      checkpoint = undefined
      if (fresh && requested.windowId === windowId) roll($)
      else $.ui.toast('Rollover did not start. No fresh note was saved in the checkpoint. The old context remains.')
    } else if (rollRequested) {
      rollRequested = false
      if (e.isAborted) $.ui.toast('Rollover cancelled by the interruption. The old context remains.')
      else roll($)
    }
    return completed
  })

  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined || e.trigger === 'precompute') return next(e)
    if (rolling) {
      const window = await openWindow($)
      opened = true
      return window
    }
    if (e.trigger === 'manual') {
      if (checkpoint || rollRequested) return { skip: 'A notes checkpoint or rollover is already pending.' }
      const { state } = await session($)
      const windowId = state.window.currentWindowId
      if (!e.instructions?.trim() && lastCompleted?.fresh && lastCompleted.windowId === windowId) {
        const window = await openWindow($)
        $.clock.after(100, () => $.prompt.submit({ text: 'Continue.' }))
        return window
      }
      checkpoint = { windowId }
      const guidance = e.instructions?.trim() ? `\n\nCheckpoint guidance:\n${e.instructions}` : ''
      $.clock.after(100, () => $.prompt.submit({ text: CHECKPOINT_PROMPT + guidance }))
      return { skip: 'Saving a notes checkpoint first. The new window opens after it completes.' }
    }
    // Automatic compaction stays Claude Code's own; reminders restart in the compacted context.
    const compacted = await next(e)
    if (!compacted.skip) {
      const { dir, state } = await session($)
      state.reminded = []
      await saveState($, dir, state)
    }
    return compacted
  }).catch(() => {
    rolling = false
    return { skip: 'Context rollover failed. The existing context remains.' }
  })

  on('tool.call', { tool: 'mcp__notes-compaction__notes' }, async ($, e) =>
    remind($, e.agentId, await callNotes($, e)),
  )

  on('tool.call', { tool: 'mcp__notes-compaction__history' }, async ($, e) =>
    remind($, e.agentId, await callHistory($, e)),
  )

  on('tool.call', { tool: 'mcp__notes-compaction__new_context' }, async ($, e) => {
    if (e.agentId !== undefined) return { deny: 'Only the main conversation can start a new context window.' }
    if (checkpoint || rollRequested || rolling)
      return result({
        started: false,
        message: 'A checkpoint or rollover is already pending. Save notes and finish your response',
      })
    rollRequested = true
    return result({
      started: true,
      message: 'Finish your response now. A new window will continue from your notes after this turn',
    })
  })

  on('tool.call', { tool: 'mcp__notes-compaction__get_context_remaining' }, async ($) => {
    const { state } = await session($)
    const { context } = await $.session.usage()
    const remainingTokens =
      typeof context.tokens === 'number' && context.window > 0 ? Math.max(0, context.window - context.tokens) : null
    return result({
      contextWindow: context.window,
      windowId: state.window.currentWindowId,
      remainingTokens,
      remainingPercent: remainingTokens === null ? null : Math.round((remainingTokens / context.window) * 1000) / 10,
    })
  })

  // Other tools' results carry reminders too; a hook that answers without next never reaches this one.
  on('tool.call', async ($, e, next) => remind($, e.agentId, await next(e)))
}
