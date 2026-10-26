// The tools the session's model calls, listed as mcp__nexus__<name>. Their
// text rides on every request that loads them: keep it short and fixed.
// Deleting a thread and retrying a pylon are left to the person's /nexus.
import type { ToolSpec } from 'claude-code'
import type { NexusPort, NexusRunState } from '../types'

const thread = { type: 'string', description: 'Thread ID, or a unique prefix of one' }
const threadPort = {
  type: 'object',
  additionalProperties: false,
  properties: { thread, port: { type: 'integer', minimum: 1, maximum: 65535 } },
  required: ['thread', 'port'],
} as const

export const TOOLS = {
  projects: {
    name: 'projects',
    description: 'List Nexus projects.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  project_add: {
    name: 'project_add',
    description: 'Add a Nexus project from repo_url or scratch: true. Defaults to the first online node and branch main. github grants GH_TOKEN only to api.github.com and github.com. Needs Nexus CLI 0.7.0 or later.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string' },
        repo_url: { type: 'string' },
        scratch: { type: 'boolean' },
        node: { type: 'string' },
        branch: { type: 'string' },
        cpus: { type: 'number' },
        memory_gib: { type: 'number' },
        disk_gib: { type: 'number' },
        allow_hosts: { type: 'array', items: { type: 'string' } },
        logins: { type: 'array', items: { type: 'string', enum: ['claude', 'chatgpt'] } },
        github: { type: 'boolean' },
      },
      required: ['id'],
    },
  },
  threads: {
    name: 'threads',
    description:
      'List Nexus threads: coding agents, each in its own VM on the home lab, grouped by project. Gives id, project, title, status and whether the agent is working.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { project: { type: 'string' } } },
  },
  start: {
    name: 'start',
    description:
      'Start a Nexus thread on a project with a first message for its agent, or with claude: true a Claude Code worker, and return its id. The agent works on its own; use wait for its reply.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        project: { type: 'string' },
        message: { type: 'string' },
        title: { type: 'string', description: 'Defaults to the first line of message' },
        claude: { type: 'boolean', description: 'Start a Claude Code worker with message as its first prompt instead of the Nexus agent' },
        model: { type: 'string', description: "The Claude Code worker's model, with claude: true. Defaults to the CLI's" },
        node: { type: 'string', description: "Defaults to the project's node" },
      },
      required: ['project', 'message'],
    },
  },
  send: {
    name: 'send',
    description: "Send a message to a Nexus thread's agent. If it is working, the message waits for its current turn to end.",
    inputSchema: { type: 'object', additionalProperties: false, properties: { thread, text: { type: 'string' } }, required: ['thread', 'text'] },
  },
  read: {
    name: 'read',
    description: "A Nexus thread's state (status, run, pylon, listening ports with any preview URL; ports null: unknown) and the latest part of its conversation.",
    inputSchema: { type: 'object', additionalProperties: false, properties: { thread }, required: ['thread'] },
  },
  wait: {
    name: 'wait',
    description: "Wait until a Nexus thread's agent has answered and gone idle, or the timeout passes, then return its state and latest reply.",
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { thread, timeout_seconds: { type: 'integer', minimum: 1, maximum: 600, description: 'Default 300' } },
      required: ['thread'],
    },
  },
  preview: {
    name: 'preview',
    description:
      "Publish a port the thread's pylon listens on as a preview, open to the home tailnet until unpublished, and return its URL once it is served (up to 2 min).",
    inputSchema: threadPort,
  },
  unpublish: {
    name: 'unpublish',
    description:
      "Close the preview a port of a Nexus thread was published as. A declared service's preview cannot be closed. Publishing the port again may give it a new URL. Wakes a paused pylon first (up to 2 min).",
    inputSchema: threadPort,
  },
  archive: {
    name: 'archive',
    description: 'Archive a Nexus thread, which pauses its VM. The person can unarchive it.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { thread }, required: ['thread'] },
  },
} as const satisfies Record<string, ToolSpec>

/** A listening port as the model reads it: its service and its preview's URL, when it has them, and why that failed. pi-nexus gives the same keys in the same order. */
export const portFacts = (port: NexusPort) => ({
  port: port.port,
  ...(port.service ? { service: port.service } : {}),
  ...(port.preview ? { url: port.preview.url, ready: port.preview.ready } : {}),
  ...(port.preview?.failed ? { failed: port.preview.failed } : {}),
})

/** What only a person can do for a thread, so the model says so rather than waiting again. pi-nexus words it the same. */
export function needsHuman(state: NexusRunState | null): string | undefined {
  if (state?.run === 'parked') return 'Tasks hit the restart limit and are parked. A human must retry them with /nexus retry.'
  if (state?.pylon === 'failed' || state?.failed) return 'The pylon failed. A human must retry it with /nexus retry-pylon.'
  return undefined
}

export function projectArgs(input: Record<string, unknown>): string[] {
  const properties = TOOLS.project_add.inputSchema.properties
  for (const [key, value] of Object.entries(input)) {
    const spec = properties[key as keyof typeof properties]
    if (!spec) throw new Error(`Unknown project_add parameter: ${key}`)
    if (spec.type === 'array') {
      if (!Array.isArray(value) || value.some(one => typeof one !== 'string' || (key === 'logins' && one !== 'claude' && one !== 'chatgpt'))) throw new Error(`Invalid ${key}`)
    } else if (typeof value !== spec.type || (typeof value === 'number' && !Number.isFinite(value))) throw new Error(`Invalid ${key}`)
  }
  if (typeof input.id !== 'string' || !input.id.trim()) throw new Error('id is required')
  if ((input.repo_url !== undefined) === (input.scratch === true)) throw new Error('provide exactly one of repo_url or scratch: true')
  if (typeof input.repo_url === 'string' && !input.repo_url.trim()) throw new Error('repo_url is required')
  const args = ['project', 'add', `--branch=${input.branch ?? 'main'}`]
  if (input.node !== undefined) args.push(`--node=${input.node}`)
  for (const [key, flag] of [['cpus', 'cpus'], ['memory_gib', 'memory'], ['disk_gib', 'disk']] as const) {
    if (input[key] !== undefined) args.push(`--${flag}=${input[key]}`)
  }
  for (const host of (input.allow_hosts ?? []) as string[]) args.push(`--allow-host=${host}`)
  for (const login of (input.logins ?? []) as string[]) args.push(`--login=${login}`)
  if (input.github === true) args.push('--secret=GH_TOKEN:api.github.com,github.com')
  if (input.scratch === true) args.push('--scratch')
  args.push('--', input.id.trim())
  if (input.repo_url !== undefined) args.push((input.repo_url as string).trim())
  return args
}
