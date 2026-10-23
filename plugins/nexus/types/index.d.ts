/** A pylon's state as its node last reported it: `ActualState` in the Nexus repository's src/reconcile.ts. */
export type NexusActual = 'spawning' | 'running' | 'pausing' | 'paused' | 'deleting' | 'absent' | 'failed' | 'unknown'

/** What the control plane wants a pylon to be, from its thread's activity. */
export type NexusDesired = 'running' | 'paused' | 'deleted'

/** The fields of the CLI's `Thread` this mod reads. */
export type NexusThread = {
  id: string
  title: string
  project: string
  status: 'active' | 'idle' | 'archived' | 'deleted'
  agentTurnRunning: boolean
  /** Unix milliseconds, as are the two after it. */
  createdAt: number
  lastHumanActivityAt: number
  lastAgentActivityAt: number
  /** The latest of the three. */
  lastActivityAt: number
}

/** A `threads` row: the thread with its pylon's state and what the planner wants of the pylon. */
export type NexusThreadRow = NexusThread & {
  pylon: { node: string; actualState: NexusActual; failed: string | null }
  desired: NexusDesired
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

/** A watch `live` event: what the current run shows before it is committed to the conversation. */
export type NexusLive = {
  /** The text of each message waiting behind the run. */
  queued: string[]
  /** The output so far of each tool call still running, by its call's id. */
  tools: { callId: string; output: string }[]
  /** The answer streaming now. */
  partial: string | null
  /** The error of a model request waiting to be retried. */
  retry: string | null
}

/** One drawn row of a conversation. A tool call and its result are one row. */
export type NexusRow =
  | { kind: 'user'; text: string; at: number | null }
  | { kind: 'assistant'; text: string }
  | {
      kind: 'tool'
      id: string
      name: string
      summary: string
      outcome: 'running' | 'ok' | 'error'
      /** The call's arguments, each string cut to a bound. */
      args: Record<string, unknown>
      /** The result's text, its tail kept, and how many lines the whole had. */
      output: string
      lines: number
      /** A unified patch of what an edit changed, when its result carries one. */
      patch: string | null
    }
  | { kind: 'notice'; tone: 'error' | 'dim'; text: string }

/** The latest `threads` poll. A failed poll keeps the threads it had and says why. */
export type NexusList = { threads: NexusThreadRow[] | null; failure: NexusFailure | null; polledAt: number | null }

/** The thread open in the pane, as its watch has reported it. */
export type NexusWatch = {
  thread: string
  rows: NexusRow[]
  /** Null until the watch's first poll answers. */
  state: NexusRunState | null
  /** Null until the first `live` event, and from a control plane that sends none. */
  live: NexusLive | null
  /** The model of the newest answer, which the next message goes to. */
  model: string | null
  /** The outage the watch reported last, cleared by its next state. */
  outage: string | null
  /** Why the watch stopped; null while it runs. */
  ended: string | null
}

export type NexusSession = {
  herdrPane: string
  harness: 'claude-code' | 'pi' | 'shell'
  harnessSessionId: string | null
  status: 'working' | 'idle' | 'blocked' | 'done' | 'unknown'
}

/** `show --json`: a thread with its pylon, sessions, previews and outputs. */
export type NexusDetail = {
  thread: NexusThread
  pylon: { id: string; node: string; actualState: NexusActual; failed: string | null; observedAt: string | null; retryRefused: string | null }
  sessions: NexusSession[]
  previews: { service: string; httpsPort: number; ready: boolean }[]
  outputs: { kind: 'branch' | 'diff' | 'preview' | 'file'; ref: string }[]
  /** Null for a thread with no conversation. */
  agent: { parkedTasks: number } | null
  hasConversation: boolean
  desired: NexusDesired
  /** The command that attaches to the pylon's Herdr sessions from a shell in the pylon. */
  attach: string
}

/** The `show` poll of the thread open in the pane. */
export type NexusShown = { thread: string; detail: NexusDetail | null; failure: NexusFailure | null }

export type NexusProject = { id: string; repoUrl: string; defaultBranch: string; defaultNode: string }
export type NexusNode = { name: string; tailnetHost: string; state: 'online' | 'offline' }

/** `projects` and `nodes`, read when the pane opens, on a refresh and when the start form opens. */
export type NexusCatalog = {
  projects: NexusProject[] | null
  nodes: NexusNode[] | null
  /** Why the last read of `nodes` failed: their line and the form's node list are left out meanwhile. */
  nodesFailure: NexusFailure | null
  projectsFailure: NexusFailure | null
}

/** What the start form holds while the person fills it in. */
export type NexusStartDraft = {
  title: string
  project: string
  /** Empty for the project's default node, as for its default branch. */
  node: string
  branch: string
  message: string
  error: string | null
  isStarting: boolean
  /** The submission this form waits on, 0 before its first: a start that ends checks it is still the form's. */
  request: number
}

export type NexusView = 'list' | 'thread' | 'details' | 'start'

export type NexusPane = {
  view: NexusView
  /** The thread shown, or null for the list. */
  selected: string | null
  /** Whether the composer, the filter or no field has the keys: Buttons with hotkeys are drawn only with none. */
  field: 'none' | 'compose' | 'filter'
  /** The folds, tool rows and closed-thread groups the person opened or closed, by key; the rest follow the defaults. */
  toggled: Record<string, boolean>
  filter: string
  /** The message typed so far, kept so a redraw does not lose it. */
  draft: string
  start: NexusStartDraft | null
  /** The outcome of the last press, until the next one. */
  notice: { text: string; tone: 'error' | 'dim' } | null
}

declare module 'claude-code' {
  interface PluginState {
    nexus: {
      list: NexusList
      watch: NexusWatch | null
      shown: NexusShown | null
      catalog: NexusCatalog
      pane: NexusPane
      /** The run clock, ticked each second while a shown run works. */
      now: number
    }
  }
}
