/** The fields of the CLI's `Thread` this mod reads. */
export type NexusThread = {
  id: string
  title: string
  project: string
  status: 'active' | 'idle' | 'archived' | 'deleted'
  agentTurnRunning: boolean
  /** Unix milliseconds. */
  lastActivityAt: number
}

/** Why a CLI call failed: the CLI's error kind (its exit code) and message. */
export type NexusFailure = {
  kind: 'failed' | 'unreachable' | 'refused' | 'not-found' | 'conflict' | 'invalid'
  message: string
}

/** A watch `state` event: the thread's status, its run and its pylon. */
export type NexusRunState = {
  status: NexusThread['status']
  run: 'idle' | 'working' | 'parked'
  parkedTasks: number
  queued: number
  pylon: string
  failed: string | null
}

/** One drawn row of a conversation. A tool call and its result are one row. */
export type NexusRow =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; id: string; name: string; summary: string; outcome: 'running' | 'ok' | 'error' }
  | { kind: 'notice'; tone: 'error' | 'dim'; text: string }

/** The latest `threads` poll. A failed poll keeps the threads it had and says why. */
export type NexusList = { threads: NexusThread[] | null; failure: NexusFailure | null; polledAt: number | null }

/** The thread open in the pane, as its watch has reported it. */
export type NexusWatch = {
  thread: string
  rows: NexusRow[]
  /** Null until the watch's first poll answers. */
  state: NexusRunState | null
  /** The outage the watch reported last, cleared by its next state. */
  outage: string | null
  /** Why the watch stopped; null while it runs. */
  ended: string | null
}

export type NexusPaneMode = 'browse' | 'compose' | 'confirm-abort'

export type NexusPane = {
  /** The thread shown, or null for the list. */
  selected: string | null
  mode: NexusPaneMode
  showArchived: boolean
  /** The message typed so far, kept so a redraw does not lose it. */
  draft: string
  /** The outcome of the last press, until the next one. */
  notice: { text: string; tone: 'error' | 'dim' } | null
}

declare module 'claude-code' {
  interface PluginState {
    nexus: { list: NexusList; watch: NexusWatch | null; pane: NexusPane }
  }
}
