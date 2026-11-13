// The model-facing `agents` contract: schema, request validation and help.

export const TOOL_NAME = 'agents'

const ACTIONS = ['help', 'list', 'spawn', 'send', 'assign', 'answer', 'read', 'watch', 'unwatch'] as const
const STATUSES = ['idle', 'working', 'blocked', 'done', 'unknown'] as const
const PLACEMENTS = ['new_tab', 'new_workspace', 'terminal'] as const
const SOURCES = ['latest', 'visible', 'recent'] as const

export type Action = (typeof ACTIONS)[number]

const FIELDS: Record<Action, readonly string[]> = {
  help: ['commands', 'target', 'machine'],
  list: ['machine', 'query', 'status'],
  spawn: ['machine', 'agent_type', 'model', 'label', 'name', 'placement', 'workspace', 'cwd', 'message', 'base', 'blocking'],
  send: ['machine', 'target', 'message'],
  assign: ['machine', 'target', 'message', 'blocking'],
  answer: ['machine', 'target', 'ask_id', 'answers'],
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
    'Spawn, delegate to and monitor Pi and Claude Code agents running in Herdr Core terminals. Call with {} first for profiles and rules.',
  isDeferred: false,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: { type: 'string', enum: ACTIONS },
      target: { type: 'string', description: 'Agent name or terminal address' },
      machine: { type: 'string', description: 'Machine name or ID from list; omit for this machine' },
      commands: { type: 'boolean' },
      agent_type: { type: 'string' },
      model: { type: 'string', description: "One of the profile's other_models; only when the user asks for that model" },
      label: { type: 'string', description: 'Tab label, short; required for spawn' },
      name: { type: 'string' },
      placement: { type: 'string', enum: PLACEMENTS },
      workspace: { type: 'string', description: 'Herdr space ID from list' },
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
  model?: string
  label?: string
  name?: string
  placement?: (typeof PLACEMENTS)[number]
  workspace?: string
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
  // Omitting machine means this one; "local" is accepted as the same.
  const request = Object.fromEntries(
    Object.entries(input).filter(
      ([key, value]) => !RESERVED.has(key) && value !== undefined && !(key === 'machine' && value === 'local'),
    ),
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
    ? 'Orchestrate general agents with separate scopes. Integrate their results, validate the combined outcome and report it. Work directly only when asked or for routine local tasks.'
    : 'Orchestrate agents with separate scopes. Integrate their results, validate the combined outcome and report it. Work directly only when asked or for routine local tasks.'
  return `${guidance} ${ownership}`
}

export type ProfileSummary = {
  name: string
  /** Present for Claude Code profiles; Pi otherwise. */
  agent?: 'claude'
  description: string
  model: string
  thinking?: string
  effort?: string
  other_models?: string[]
  accepts?: string[]
  blocking?: boolean
}

export function helpText(profiles: { sources: Record<string, string>; profiles: ProfileSummary[] }): string {
  const general = profiles.profiles.map(profile => profile.name).filter(name => /(^|-)general$/.test(name))
  return JSON.stringify({
    profiles: profiles.profiles,
    profile_sources: profiles.sources,
    requests: {
      list: '{action:"list", machine?, query?, status?} — this machine and every connected machine unless machine is given',
      commands: '{commands:true, target, machine?} — the slash commands that agent accepts',
      spawn: '{action:"spawn", agent_type, label (short, 2 words when useful), message, cwd?, placement?: new_tab|new_workspace|terminal, workspace?, name?, base?, blocking?, model?} — a new tab beside this session by default, in workspace (a space ID from list) when given; terminal runs it in the background',
      send: '{action:"send", target, message}',
      assign: '{action:"assign", target, message, blocking?}',
      answer: '{action:"answer", target, ask_id, answers: [{selections?: [choice label], other?, comment?}] one per prompt in order}',
      read: '{action:"read", target, source?: latest|visible|recent, lines?}',
      watch: '{action:"watch", target}',
      unwatch: '{action:"unwatch", target}',
    },
    rules: [
      'spawn and assign return once the task is delivered, and its result arrives as an agent_report message. blocking:true waits for the result in the call instead; a profile blocking setting overrides spawn. Blocking calls made together wait together',
      'Reports of completion, questions and blockage arrive on their own, for delegated work and watched agents: do other work or end the turn; never poll or sleep for them',
      'A profile runs on its model. Pass spawn model, one of that profile\'s other_models, only when the user explicitly asks for that model for the worker; never choose it yourself',
      'send delivers input without waiting or watching; use assign only for work whose result you need',
      'Give the task and the context it needs, and trust the agent to choose its approach; avoid unnecessary restrictions and overly narrow scope',
      'Keep each agent until its task is verified complete and return corrections to it before closing it; use separate agents for unrelated work and independent reviews',
      'Messages wake idle agents: send only what changes the recipient\'s next action, never acknowledgements, status-only updates or standby reminders. Close a finished worker with "/quit" alone',
      'Delegation and watch keep reporting later work until unwatch or the terminal closes',
      'send or assign to a closed worker this session spawned reopens its saved session first and returns resumed:true with its current target; "/quit" never reopens one',
      'A question report carries its ask_id and prompts; answer it with answer, asking the user first when the choice is theirs. answer returns once the worker took it; the work it resumes reports on its own',
      'Messages starting with / run as the worker\'s slash commands without a watch; list them first with commands:true',
      'Agents on another machine need its machine name or ID from list with every request; omit machine for this one. Claude Code agents work on this machine only',
      'Use agents for every operation it supports, even after a failure: report the blocker instead of driving agents with hc or shell commands',
      'For work in this repository, create a dedicated worktree and pass it as cwd',
      ...(general.length ? [`Use ${general.join(' and ')} only when asked or while orchestrating`] : []),
    ],
  })
}
