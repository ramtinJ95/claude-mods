import type { EngineInterface, Register, SessionCompacted, ToolCallInput, ToolCallResult } from 'claude-code'
import { MESSAGE_LIMIT, useHistory } from './history.ts'
import { agentName, type Note, noteFileName, ROOT, recentPaths, resolvePath, useNotes } from './notes.ts'
import {
  GUIDANCE,
  newState,
  nextWindow,
  parseWindow,
  reminderFor,
  type SessionState,
  type WindowIdentity,
  windowText,
} from './windows.ts'

const NOTES_TOOL = 'mcp__notes-compaction__notes'

const NOTES_ACTIONS = ['help', 'list_files_by_prefix', 'read_file', 'search_contents', 'append_to_file', 'write_file']
const HISTORY_ACTIONS = ['help', 'list_windows', 'list_items', 'read_item', 'search_contents']
const FIELDS: Record<string, readonly string[]> = {
  list_files_by_prefix: ['prefix', 'file_order', 'file_order_by', 'max_results'],
  read_file: ['path', 'start_line', 'stop_line'],
  search_notes: ['query', 'path_prefix', 'max_files', 'max_matches_per_file', 'recent_file_first'],
  append_to_file: ['path', 'text'],
  write_file: ['path', 'text'],
  list_windows: ['agent_name', 'limit', 'recent_first'],
  list_items: ['agent_name', 'window_id', 'role', 'tool_name', 'limit', 'max_chars_per_item', 'recent_first'],
  read_item: ['agent_name', 'window_id', 'item_id', 'offset_chars', 'limit_chars'],
  search_history: ['agent_name', 'window_id', 'role', 'tool_name', 'query', 'limit', 'recent_first'],
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

/** Storage outside ~/.claude, which may be a synced dotfiles directory. */
async function storageRoot($: EngineInterface): Promise<string> {
  return `${(await $.env.get('XDG_DATA_HOME')) || `${await $.env.get('HOME')}/.local/share`}/claude-notes-compaction`
}

/**
 * Root notes live with their session. A subagent's live under its agent ID, which is unique,
 * so a fork that carries the Agent call reaches the same notes.
 */
async function notesDir($: EngineInterface, agent: string): Promise<string> {
  if (agent === ROOT) return `${(await session($)).dir}/notes`
  return `${await storageRoot($)}/agents/${agent.slice(ROOT.length + 1)}/notes`
}

async function session($: EngineInterface) {
  const dir = `${await storageRoot($)}/sessions/${await $.session.id()}`
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

/**
 * A session without state is new, or a fork (`--fork-session`, `/branch`) whose transcript was
 * copied from its parent. Like Pi's receipts, each successful write saves a revision under its
 * tool use ID holding the agent's whole note set and window identity, so the last write the copied
 * transcript shows restores the notes as they stood at the fork point. A later window marker wins
 * for the window identity.
 */
async function loadSession($: EngineInterface, dir: string) {
  const path = `${dir}/state.json`
  if (await $.fs.exists(path)) return { dir, state: JSON.parse(await $.fs.read(path)) as SessionState }
  const messages = await $.session.messages()
  const state = newState()
  let restored: Revision | undefined
  let writes = 0
  let windowFromMarker = false
  for (let i = messages.length - 1; i >= 0 && !restored; i--) {
    const message = messages[i]!
    const marker = message.role === 'user' ? parseWindow(message.text) : undefined
    if (marker && !windowFromMarker && !restored) {
      windowFromMarker = true
      state.window = {
        firstWindowId: marker.first ?? marker.current,
        currentWindowId: marker.current,
        ...(marker.previous ? { previousWindowId: marker.previous } : {}),
        windowNumber: messages.filter((m) => m.role === 'user' && parseWindow(m.text)).length,
      }
    }
    for (const use of [...message.toolUses].reverse()) {
      if (use.tool !== NOTES_TOOL || use.isError || !['write_file', 'append_to_file'].includes(String(use.input['action'])))
        continue
      writes++
      const file = `${await storageRoot($)}/revisions/${use.tool_use_id}.json`
      if (!(await $.fs.exists(file))) continue
      restored = JSON.parse(await $.fs.read(file)) as Revision
      break
    }
  }
  if (restored) {
    for (const note of restored.notes)
      await $.fs.write(`${dir}/notes/${await noteFileName(note.path)}`, JSON.stringify(note))
    if (!windowFromMarker && restored.window) state.window = restored.window
    if (restored.agents?.length) state.agents = restored.agents
  } else if (writes || messages.length >= MESSAGE_LIMIT)
    $.ui.toast("This session's earlier notes could not be restored. Notes start empty; earlier history remains.")
  // Persist before use: history and notes may cite the first window's ID before anything else is saved.
  await saveState($, dir, state)
  return { dir, state }
}

/** One successful root write: root's whole note set after it, its window, and the session's subagents. */
interface Revision {
  agent: string
  notes: Note[]
  window?: WindowIdentity
  agents?: string[]
}

/** $.fs.read takes at most 4 MiB, so a revision must stay below it to be restorable. */
const REVISION_LIMIT = 4_000_000

/**
 * Agents a note path may name: root, the caller, subagents that wrote notes here, and every
 * subagent the transcript in view launched.
 */
async function sessionAgents($: EngineInterface, self: string): Promise<Set<string>> {
  const agents = new Set([ROOT, self, ...((await session($)).state.agents ?? [])])
  for (const message of await $.session.messages())
    for (const use of message.toolUses) if (use.agentId) agents.add(agentName(use.agentId))
  return agents
}

async function saveState($: EngineInterface, dir: string, state: SessionState) {
  await $.fs.write(`${dir}/state.json`, JSON.stringify(state))
}

async function readNotes($: EngineInterface, dir: string): Promise<Map<string, Note>> {
  const notes = new Map<string, Note>()
  if (!(await $.fs.exists(dir))) return notes
  for (const entry of await $.fs.list(dir)) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    const note = JSON.parse(await $.fs.read(`${dir}/${entry.name}`)) as Note
    notes.set(note.path, note)
  }
  return notes
}

async function openWindow($: EngineInterface): Promise<SessionCompacted> {
  const { dir, state } = await session($)
  const ids = nextWindow(state.window)
  const recent = recentPaths(await readNotes($, await notesDir($, ROOT)), ROOT)
  state.window = ids
  state.reminded = []
  await saveState($, dir, state)
  return {
    messages: [
      { role: 'user', text: windowText(ROOT, ids, recent), toolUses: [] },
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

/**
 * Where Claude Code compacts on its own (an auto-compact window such as 400k), refreshed each turn.
 * Reminders and remaining context measure against it, so checkpoints come before that compaction.
 */
let compactThreshold: number | undefined

async function refreshThreshold($: EngineInterface) {
  const breakdown = (await $.session.usage({ breakdown: 'summary' })).context.breakdown
  compactThreshold = breakdown?.isAutoCompactEnabled ? breakdown.autoCompactThreshold : undefined
}

async function contextUsed($: EngineInterface): Promise<{ limit: number; tokens?: number }> {
  const { context } = await $.session.usage()
  return { limit: Math.min(context.window, compactThreshold ?? context.window), tokens: context.tokens }
}

/** Context reminders ride on tool results, the one mid-turn channel to the model. Each fires once per window. */
async function remind($: EngineInterface, agentId: string | undefined, called: ToolCallResult): Promise<ToolCallResult> {
  if (agentId !== undefined || called.deny !== undefined) return called
  try {
    const { dir, state } = await session($)
    const { limit, tokens } = await contextUsed($)
    const reminder = reminderFor(state, tokens === undefined || limit <= 0 ? undefined : (100 * tokens) / limit)
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
    const scoped = relevant('notes', params)
    const self = agentName(e.agentId)
    const field = params['action'] === 'list_files_by_prefix' ? 'prefix' : params['action'] === 'search_contents' ? 'path_prefix' : 'path'
    const target = resolvePath(scoped[field], self, field === 'path')
    if (isWrite && target.agent !== self)
      throw new Error(`Write only your own notes, with a relative path. ${target.agent}'s notes are read-only here.`)
    if (target.agent !== self && !(await sessionAgents($, self)).has(target.agent))
      throw new Error(`${target.agent} is not an agent of this session. Use a relative path for your own notes.`)
    const dir = await notesDir($, target.agent)
    const notes = await readNotes($, dir)
    const { payload, write } = useNotes(
      notes,
      { ...scoped, [field]: target.path },
      await $.clock.now(),
      `${target.agent}/notes/`,
    )
    if (!write) return result(payload)
    const { dir: sessionDir, state } = await session($)
    // The revision is the receipt a fork rebuilds root notes from. Subagent notes need none: they
    // live under the agent ID, which a fork shares. Its size is checked before anything changes.
    notes.set(write.path, write)
    const revision =
      e.tool_use_id && self === ROOT
        ? JSON.stringify({ agent: self, notes: [...notes.values()], window: state.window, agents: state.agents } satisfies Revision)
        : undefined
    if (revision && new TextEncoder().encode(revision).length > REVISION_LIMIT)
      throw new Error('Notes exceed 4 MB in total. Shorten or replace existing notes, then save again.')
    try {
      await $.fs.write(`${dir}/${await noteFileName(write.path)}`, JSON.stringify(write))
    } catch {
      throw new Error('Note could not be saved. Retry after local storage is available.')
    }
    if (revision)
      try {
        await $.fs.write(`${await storageRoot($)}/revisions/${e.tool_use_id}.json`, revision)
      } catch {
        throw new Error(
          `${payload['path']} was saved, but forks of this session will not see it. Read it back and save it again with write_file.`,
        )
      }
    if (self !== ROOT && !state.agents?.includes(self)) {
      state.agents = [...(state.agents ?? []), self]
      await saveState($, sessionDir, state)
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
    const scoped = relevant('history', params)
    const agent = typeof scoped['agent_name'] === 'string' && scoped['agent_name'] ? scoped['agent_name'] : agentName(e.agentId)
    if (agent === ROOT) {
      const { state } = await session($)
      return result(useHistory(await $.session.messages(), scoped, state.window.currentWindowId))
    }
    // A subagent's transcript is its own single window.
    const match = /^\/root\/([A-Za-z0-9_-]+)$/.exec(agent)
    if (!match) throw new Error(`Name agents as note paths do: ${ROOT} or ${ROOT}/<agentId>.`)
    const found = await $.session.messages({ agentId: match[1]! })
    if ('deny' in found)
      throw new Error(`${agent}'s history is not available here. Omit agent_name to search your own.`)
    return result(useHistory(found, scoped, `agent:${match[1]}`))
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
        'Cross-window notes. write_file replaces; append_to_file adds. Virtual paths: relative uses current agent; cross-agent uses <agent>/notes[/path], read-only. Call with no arguments for help.',
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
    // /config and /model can move the threshold between turns; the previous figure stands meanwhile.
    refreshThreshold($).catch(() => undefined)
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
      if (e.isAborted || requested.windowId !== windowId) $.ui.toast('Checkpoint cancelled. The old context remains.')
      else if (fresh) roll($)
      else
        $.ui.toast(
          'Rollover did not start. No fresh note was saved in the completed checkpoint. The old context remains.',
        )
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

  // Other tools' results carry reminders too; a hook that answers without next never reaches this one.
  on('tool.call', async ($, e, next) => remind($, e.agentId, await next(e)))
}
