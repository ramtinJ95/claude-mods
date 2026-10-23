// The tools the session's model calls, listed as mcp__nexus__<name>. Their
// text rides on every request that loads them: keep it short and fixed.
// Deleting a thread and retrying a pylon are left to the person's /nexus.
import type { ToolSpec } from 'claude-code'
import type { NexusRunState } from '../types'

const thread = { type: 'string', description: 'Thread ID, or a unique prefix of one' }

export const TOOLS = {
  threads: {
    name: 'threads',
    description:
      'List Nexus threads: coding agents, each in its own VM on the home lab, grouped by project. Gives id, project, title, status and whether the agent is working.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { project: { type: 'string' } } },
  },
  start: {
    name: 'start',
    description: 'Start a Nexus thread on a project with a first message for its agent, and return its id. The agent works on its own; use wait for its reply.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { project: { type: 'string' }, message: { type: 'string' }, title: { type: 'string', description: 'Defaults to the first line of message' } },
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
    description: "A Nexus thread's state (status, run, pylon) and the latest part of its conversation.",
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
  archive: {
    name: 'archive',
    description: 'Archive a Nexus thread, which pauses its VM. The person can unarchive it.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { thread }, required: ['thread'] },
  },
} as const satisfies Record<string, ToolSpec>

/** What only a person can do for a thread, so the model says so rather than waiting again. pi-nexus words it the same. */
export function needsHuman(state: NexusRunState | null): string | undefined {
  if (state?.run === 'parked') return 'Tasks hit the restart limit and are parked. A human must retry them with /nexus retry.'
  if (state?.pylon === 'failed' || state?.failed) return 'The pylon failed. A human must retry it with /nexus retry-pylon.'
  return undefined
}
