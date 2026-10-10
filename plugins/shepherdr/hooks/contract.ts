// The model-facing `agents` contract: schema, request validation and help.

export const TOOL_NAME = 'agents'

const ACTIONS = ['help', 'list', 'spawn', 'send', 'assign', 'read', 'watch', 'unwatch'] as const
const STATUSES = ['idle', 'working', 'blocked', 'done', 'unknown'] as const
const PLACEMENTS = ['new_tab', 'new_workspace', 'pane'] as const
const SOURCES = ['latest', 'visible', 'recent'] as const

export type Action = (typeof ACTIONS)[number]

const FIELDS: Record<Action, readonly string[]> = {
  help: [],
  list: ['query', 'status'],
  spawn: ['agent_type', 'label', 'name', 'placement', 'workspace', 'pane', 'cwd', 'message', 'base', 'blocking'],
  send: ['target', 'message'],
  assign: ['target', 'message', 'blocking'],
  read: ['target', 'source', 'lines'],
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
    },
  },
} as const

export type AgentsRequest = {
  action: Action
  target?: string
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
  for (const field of ['target', 'message', 'agent_type', 'label'] as const) {
    const needed =
      (field === 'target' && !['help', 'list', 'spawn'].includes(action)) ||
      (field === 'message' && ['spawn', 'send', 'assign'].includes(action)) ||
      ((field === 'agent_type' || field === 'label') && action === 'spawn')
    const value = request[field]
    if (needed && (typeof value !== 'string' || !value.trim()))
      throw new Error(`${field} is required for ${action}`)
  }
  return { ...request, action } as AgentsRequest
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
      list: '{action:"list", query?, status?}',
      spawn: '{action:"spawn", agent_type, label (2-3 words), message, cwd?, placement?: new_tab|new_workspace|pane, workspace?, pane?, name?, base?, blocking?}',
      send: '{action:"send", target, message}',
      assign: '{action:"assign", target, message, blocking?}',
      read: '{action:"read", target, source?: latest|visible|recent, lines?}',
      watch: '{action:"watch", target}',
      unwatch: '{action:"unwatch", target}',
    },
    rules: [
      'spawn and assign block until the worker settles unless blocking:false; a profile blocking setting overrides spawn',
      'Non-blocking work and watched agents report completion, questions and blockage as agent_report messages; never poll',
      'send delivers input without waiting or watching; use assign only for work whose result you need',
      'Delegation and watch keep reporting later work until unwatch or the pane closes',
      'Messages starting with / run as the worker\'s slash commands without a watch',
      'For work in this repository, create a dedicated worktree and pass it as cwd',
      'Close finished workers by sending "/quit"; do not send acknowledgements',
    ],
  })
}
