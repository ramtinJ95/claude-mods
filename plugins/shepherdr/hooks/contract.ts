// The model-facing `agents` contract: schema, request validation and help.

export const TOOL_NAME = 'agents'

const ACTIONS = ['help', 'list', 'spawn', 'send', 'assign', 'answer', 'read', 'watch', 'unwatch'] as const
const STATUSES = ['idle', 'working', 'blocked', 'done', 'unknown'] as const
const PLACEMENTS = ['new_tab', 'new_workspace', 'pane'] as const
const SOURCES = ['latest', 'visible', 'recent'] as const

export type Action = (typeof ACTIONS)[number]

const FIELDS: Record<Action, readonly string[]> = {
  help: ['commands', 'target', 'machine'],
  list: ['machine', 'query', 'status'],
  spawn: ['machine', 'agent_type', 'label', 'name', 'placement', 'workspace', 'pane', 'cwd', 'message', 'base', 'blocking'],
  send: ['machine', 'target', 'message'],
  assign: ['machine', 'target', 'message', 'blocking'],
  answer: ['machine', 'target', 'ask_id', 'answers', 'blocking'],
  read: ['machine', 'target', 'source', 'lines'],
  watch: ['machine', 'target'],
  unwatch: ['machine', 'target'],
}

const REQUIRED: Record<Action, readonly string[]> = {
  help: [],
  list: [],
  spawn: ['agent_type', 'label', 'message'],
  send: ['target', 'message'],
  assign: ['target', 'message'],
  answer: ['target', 'ask_id', 'answers'],
  read: ['target'],
  watch: ['target'],
  unwatch: ['target'],
}

export const TOOL_SPEC = {
  name: TOOL_NAME,
  description:
    'Spawn, delegate to and monitor Pi agents running in Herdr. Call with {} first for profiles and rules.',
  isDeferred: false,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: { type: 'string', enum: ACTIONS },
      target: { type: 'string', description: 'Agent name or pane ID' },
      machine: { type: 'string', description: 'Machine ID from list; omit for this machine' },
      commands: { type: 'boolean' },
      agent_type: { type: 'string' },
      label: { type: 'string' },
      name: { type: 'string' },
      placement: { type: 'string', enum: PLACEMENTS },
      workspace: { type: 'string' },
      pane: { type: 'string' },
      cwd: { type: 'string' },
      message: { type: 'string' },
      base: { type: 'string', description: 'Review base branch' },
      blocking: { type: 'boolean' },
      query: { type: 'string' },
      status: { type: 'string', enum: STATUSES },
      source: { type: 'string', enum: SOURCES },
      lines: { type: 'integer', minimum: 1, maximum: 200 },
      ask_id: { type: 'string' },
      answers: {
        type: 'array',
        description: 'One per prompt, in order',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            selections: { type: 'array', items: { type: 'string' } },
            other: { type: 'string' },
            comment: { type: 'string' },
          },
        },
      },
    },
  },
} as const

export type AgentsRequest = {
  action: Action
  target?: string
  machine?: string
  commands?: boolean
  agent_type?: string
  label?: string
  name?: string
  placement?: (typeof PLACEMENTS)[number]
  workspace?: string
  pane?: string
  cwd?: string
  message?: string
  base?: string
  blocking?: boolean
  query?: string
  status?: (typeof STATUSES)[number]
  source?: (typeof SOURCES)[number]
  lines?: number
  ask_id?: string
  answers?: { selections?: string[]; other?: string; comment?: string }[]
}

const RESERVED = new Set(['tool', 'tool_use_id', 'consent', 'agentId'])

export function parseRequest(input: Record<string, unknown>): AgentsRequest {
  const request = Object.fromEntries(
    Object.entries(input).filter(([key, value]) => !RESERVED.has(key) && value !== undefined),
  )
  const action = request['action'] ?? 'help'
  if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action))
    throw new Error(`action must be one of: ${ACTIONS.join(', ')}`)
  const allowed = new Set(['action', ...FIELDS[action as Action]])
  const unknown = Object.keys(request).filter(key => !allowed.has(key))
  if (unknown.length)
    throw new Error(
      action === 'send' && unknown.includes('blocking')
        ? 'send is message-only; omit blocking. Use assign to delegate work'
        : `unknown ${action} field(s): ${unknown.join(', ')}`,
    )
  for (const field of REQUIRED[action as Action]) {
    const value = request[field]
    const present = field === 'answers' ? Array.isArray(value) : typeof value === 'string' && value.trim() !== ''
    if (!present) throw new Error(`${field} is required for ${action}`)
  }
  if (action === 'help' && (request['commands'] === true) !== (typeof request['target'] === 'string'))
    throw new Error('commands:true and target go together: they list the slash commands that agent accepts')
  if (action === 'help' && 'machine' in request && !request['commands'])
    throw new Error('machine requires commands:true and target for help')
  return { ...request, action } as AgentsRequest
}

/** pi-shepherdr's orchestration guidance, given once per switch and after compaction. */
export function orchestrationGuidance(enabled: boolean, general: boolean): string {
  const ownership = "Own a scope or delegate it; don't do both."
  if (!enabled) return `Work normally. Delegate only when useful or requested. ${ownership}`
  const guidance = general
    ? 'Your main goal from now on is to orchestrate agents. Fan out suitable work to general agents, synthesize their results, and report the outcome. Work directly only when asked or for routine local tasks.'
    : 'Your main goal from now on is to orchestrate agents. Fan out suitable work, synthesize agent results, and report the outcome. Work directly only when asked or for routine local tasks.'
  return `${guidance} ${ownership}`
}

export type ProfileSummary = {
  name: string
  description: string
  model: string
  thinking: string
  accepts?: string[]
  blocking?: boolean
}

export function helpText(profiles: { source: string; profiles: ProfileSummary[] }): string {
  return JSON.stringify({
    profiles: profiles.profiles,
    profile_source: profiles.source,
    requests: {
      list: '{action:"list", machine?, query?, status?} — this machine and every connected machine unless machine is given',
      commands: '{commands:true, target, machine?} — the slash commands that agent accepts',
      spawn: '{action:"spawn", agent_type, label (2-3 words), message, cwd?, placement?: new_tab|new_workspace|pane, workspace?, pane?, name?, base?, blocking?}',
      send: '{action:"send", target, message}',
      assign: '{action:"assign", target, message, blocking?}',
      answer: '{action:"answer", target, ask_id, answers: [{selections?: [choice label], other?, comment?}] one per prompt in order, blocking?}',
      read: '{action:"read", target, source?: latest|visible|recent, lines?}',
      watch: '{action:"watch", target}',
      unwatch: '{action:"unwatch", target}',
    },
    rules: [
      'spawn, assign and answer block until the worker settles unless blocking:false; a profile blocking setting overrides spawn',
      'Non-blocking work and watched agents report completion, questions and blockage as agent_report messages; never poll',
      'send delivers input without waiting or watching; use assign only for work whose result you need',
      'Delegation and watch keep reporting later work until unwatch or the pane closes',
      'A question report carries its ask_id and prompts; answer it with answer, asking the user first when the choice is theirs. A background question does not stop the worker, and answering it does not wait for its task',
      'Messages starting with / run as the worker\'s slash commands without a watch; list them first with commands:true',
      'Agents on another machine need its machine ID from list with every request; omit machine for this one',
      'For work in this repository, create a dedicated worktree and pass it as cwd',
      'Close finished workers by sending "/quit"; do not send acknowledgements',
    ],
  })
}
