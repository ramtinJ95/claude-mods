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

/** A preview of one of a pylon's services: `Preview` in the Nexus repository's src/control/registry.ts. */
export type NexusPreview = {
  service: string
  httpsPort: number
  /** The node publishes it and has warmed its URL; it says nothing of the pylon answering. */
  ready: boolean
  /** Why it cannot answer: the pylon's node reported its service failed. Null otherwise, and from a control plane too old to say. */
  failed: string | null
  /** The CLI's own URL, used as it is. */
  url: string
}

/** A TCP port a preview can reach in the pylon, and the preview of the service that owns it. */
export type NexusPort = { port: number; service: string | null; preview: NexusPreview | null }

/** A watch `state` event: the thread's status, its run, its pylon and the ports it listens on. */
export type NexusRunState = {
  status: NexusThread['status']
  run: 'idle' | 'working' | 'parked'
  parkedTasks: number
  queued: number
  pylon: string
  failed: string | null
  /** In port order; [] while the pylon is not running, null while its node could not read them. */
  ports: NexusPort[] | null
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

/** The thread open in the pane, as its watch has reported it, but for its `live` events. */
export type NexusWatch = {
  thread: string
  rows: NexusRow[]
  /** How many rows came before `rows[0]` since the last reset: the rows kept are a tail. */
  dropped: number
  /** Null until the watch's first poll answers. */
  state: NexusRunState | null
  /** The model of the newest answer, which the next message goes to. */
  model: string | null
  /** The outage the watch reported last, cleared by its next state. */
  outage: string | null
  /** Why the watch stopped; null while it runs. */
  ended: string | null
}

/**
 * A session in the pylon, as its node last reported it: open in its pane (`running`), one the pylon's next wake brings
 * back (`paused`), or one the last wake did not bring back (`failed`, `message` saying why). A control plane older than
 * CLI 0.8.0 sends only running sessions, without `state` or `id`.
 */
export type NexusSession = {
  /** What `session close` takes: the pane, or `failed-<hash>` for a failed session in no pane. */
  id: string
  harness: NexusHarness
  harnessSessionId: string | null
  /** Herdr's, as last read while the session ran. */
  status: 'working' | 'idle' | 'blocked' | 'done' | 'unknown'
  /** Its Herdr workspace's label; null from a probe or control plane older than CLI 0.5.0. */
  title: string | null
} & (
  | { state: 'running'; herdrPane: string; message: null }
  /** `herdrPane` is the pane it had, which a wake may change. */
  | { state: 'paused'; herdrPane: string | null; message: null }
  /** `herdrPane` is the pane it left behind, or null. */
  | { state: 'failed'; herdrPane: string | null; message: string }
)

/** The agents `session open` starts in a pylon. */
export type NexusHarness = 'claude-code' | 'pi' | 'shell'

/** What `session open` prints: the session it opened, with the title the CLI gave it. */
export type NexusOpenedSession = { herdrPane: string; harness: NexusHarness; title: string }

/**
 * What the person did to a thread's sessions from the pane: the opens and closes under way, and those confirmed that
 * the details have not shown yet, each with when it was confirmed. The node reads its sessions again once the CLI has
 * answered, so a `show` asked for after the confirmation can still list them as they were.
 */
export type NexusSessionChanges = {
  /** Each open under way, by the number the pane gave it. */
  opening: { id: number; harness: NexusHarness; title: string | null }[]
  /**
   * `before`: the IDs and harness session IDs of the sessions the details listed when the open was confirmed, or null
   * when they were not at hand. A wake moves a session's pane, and so its ID, but keeps its harness session ID.
   */
  opened: { session: NexusOpenedSession; at: number; before: { ids: string[]; harnessSessionIds: string[] } | null }[]
  /** The IDs of the sessions whose close is under way. */
  closing: string[]
  /** Each close confirmed, by session ID: when, and the session's own ID, which a wake that moves its pane keeps. */
  closed: Record<string, { at: number; harnessSessionId: string | null }>
}

/** What the open a session form holds: the harness, and a title that is the harness's name when empty. */
export type NexusSessionDraft = { harness: NexusHarness; title: string }

/**
 * The watch's latest `live` event for the thread open in the pane. It has an atom of its own: a streaming answer
 * prints ten a second, and writing it with the rows would copy every row each time.
 */
export type NexusLiveShown = { thread: string; live: NexusLive }

/** `show --json`: a thread with its pylon, sessions, previews, ports and outputs. */
export type NexusDetail = {
  thread: NexusThread
  pylon: { id: string; node: string; actualState: NexusActual; failed: string | null; observedAt: string | null; retryRefused: string | null }
  sessions: NexusSession[]
  previews: NexusPreview[]
  /** In port order; [] while the pylon is not running, null while its node could not read them. */
  ports: NexusPort[] | null
  outputs: { kind: 'branch' | 'diff' | 'preview' | 'file'; ref: string }[]
  /** Null for a thread with no conversation. */
  agent: { parkedTasks: number } | null
  hasConversation: boolean
  desired: NexusDesired
  /** The command that attaches to the pylon's Herdr sessions from a shell in the pylon. */
  attach: string
}

/** The `show` poll of the thread open in the pane. */
export type NexusShown = {
  thread: string
  detail: NexusDetail | null
  /** The poll's place in `sequence`, taken as it asked: a port change confirmed before it, the details show. */
  askedSeq: number
  failure: NexusFailure | null
}

export type NexusProject = { id: string; repoUrl: string; defaultBranch: string; defaultNode: string }
export type NexusNode = { name: string; tailnetHost: string; state: 'online' | 'offline' }

/** `projects` and `nodes`, read when the pane opens, on a refresh, and when the start form or the project picker opens. */
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
  /** The field or element the person moved the ring to, which the message's rows follow. */
  focused: string | null
}

/** What the new project form holds while the person fills it in: what `nexus project add` takes. */
export type NexusProjectDraft = {
  id: string
  repoUrl: string
  /** A node's name; the first online one to begin with. */
  node: string
  /** Empty for `main`. */
  branch: string
  /** Why the last add failed, the CLI's message as it printed it. */
  error: string | null
  isAdding: boolean
  /** The add this form waits on, 0 before its first: an add that ends checks it is still the form's. */
  request: number
}

export type NexusView = 'list' | 'thread' | 'start' | 'project' | 'session'

/** The thread view's tabs, in the order h and l walk them: the dashboard's inspector, after the conversation. */
export type NexusTab = 'conversation' | 'changes' | 'previews' | 'pylon'

/** What a checkout read compares with: `start`, what the pylon booted at, or `head`. Null `commit` is the empty tree. */
export type NexusBase = { kind: 'start' | 'head'; commit: string | null }

export type NexusFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'typechange'

/** One file of `changes --json`. A binary file's counts are null. */
export type NexusChangedFile = { path: string; oldPath: string | null; status: NexusFileStatus; additions: number | null; deletions: number | null }

/** `changes --json`: the files that differ from the base, at most 3000, `truncated` when there were more. */
export type NexusChanges = { base: NexusBase; files: NexusChangedFile[]; truncated: boolean }

/**
 * The Changes tab's reads of the thread shown. Each read reaches into the pylon and wakes it, so they happen only on
 * the rules `checkoutTrigger` keeps, one at a time.
 */
export type NexusCheckout = {
  thread: string
  /** The last reply, kept on screen while a read runs again. */
  changes: NexusChanges | null
  /** Why the last read failed; `isNoBase` when the pylon booted before Nexus recorded its base. */
  failure: { message: string; isNoBase: boolean } | null
  isReading: boolean
  /** The person asked to wake a paused pylon to read it: the read runs, and runs again once the pylon runs. */
  isWanted: boolean
}

/** One drawn row of a diff: a hunk's separator with its heading, or a line with the new file's number (none when removed). */
export type NexusDiffRow = { kind: 'hunk'; text: string } | { kind: 'add' | 'del' | 'ctx'; line: number | null; text: string }

/** The diff open in the Changes tab, as `diff --json` printed it, parsed into rows. */
export type NexusDiffShown = {
  thread: string
  file: NexusChangedFile
  /** Whether it was read against HEAD. */
  isUncommitted: boolean
  /** Null until a read answers. */
  rows: NexusDiffRow[] | null
  /** What git says beyond the lines: renames, modes. */
  meta: string[]
  isBinary: boolean
  /** The rows stop short: the CLI's `truncated`, or `DIFF_ROWS`. */
  isCut: boolean
  failure: string | null
  isReading: boolean
}

/**
 * Where typed letters go: to the hotkeys (`normal`), the composer (`insert`) or the list's filter (`filter`). The
 * pane's own record of it, since the engine says nothing when Esc hands the keys back from a field.
 */
export type NexusMode = 'normal' | 'insert' | 'filter'

/**
 * What covers the view's body: the Actions menu or the project picker with the key of the row under its cursor, the
 * key help, or nothing.
 */
export type NexusOverlay = { kind: 'menu'; cursor: string | null } | { kind: 'projects'; cursor: string | null } | { kind: 'help'; top: number } | null

/**
 * How far the conversation is scrolled back: null follows its end; else the body's bottom edge stands `rows` above
 * the bottom of the block keyed `anchor`, so what arrives below moves nothing on screen.
 */
export type NexusScroll = { anchor: string; rows: number } | null

/**
 * A port the person published or unpublished from the pane. The three are apart, so an operation that starts or
 * fails never loses what the last one that succeeded did.
 */
export type NexusPortChange = {
  /** What the last operation that succeeded left the port with, its preview or none, and its place in `sequence`. */
  confirmed: { preview: NexusPreview | null; seq: number } | null
  /** `nexus preview --wait` or `nexus unpreview` under way. */
  pending: 'open' | 'close' | null
  /** Why the last operation failed, until the next starts. */
  failure: { action: 'open' | 'close'; message: string } | null
}

/**
 * A text field's `value` and how many times the pane has put one there. The field is drawn under a key of its own for
 * each put (`fieldKey`), so the engine shows the put text, never the typing under an older key.
 */
export type NexusField = { text: string; puts: number }

export type NexusPane = {
  view: NexusView
  tab: NexusTab
  /** The thread shown, or null for the list. */
  selected: string | null
  mode: NexusMode
  overlay: NexusOverlay
  /** The first key of a two-key motion, `g`, waiting for its second. */
  pending: 'g' | null
  /** The list's row under the cursor: a thread's ID or a closed group's key. Back from a thread puts it there. */
  listCursor: string | null
  /** The list's first row shown, as last scrolled; each drawing clamps it so the cursor shows. */
  listTop: number
  /**
   * The pane took the keys back without the person asking (`recover`) and put the ring on the list's cursor. An Enter
   * typed for the field the keys left may still be on its way, so the next Enter on a row opens nothing and says what
   * a second would open. The person's next key or move of the ring clears it.
   */
  isRetaken: boolean
  scroll: NexusScroll
  /** The Changes tab's row under the cursor: `dir-<path>` or `file-<path>`. */
  changesCursor: string | null
  /** The diff open in the Changes tab, in place of the tree, and its first row shown; null for the tree. */
  diff: { path: string; top: number } | null
  /** The Previews tab's row under the cursor: `preview-<service>` or `port-<port>`. */
  portCursor: string | null
  /** The Pylon tab's stop under the cursor: `pylon-details`, `session-<id>` or `attach-mac`. */
  pylonCursor: string | null
  /** The folds, tool rows, closed-thread groups and Changes folders the person opened or closed, by key; the rest follow the defaults. */
  toggled: Record<string, boolean>
  filter: string
  /** The composer's text as the person typed it, for the rows it takes. */
  draft: string
  start: NexusStartDraft | null
  project: NexusProjectDraft | null
  session: NexusSessionDraft | null
  /** What the pane last put in each text field, by the field's name (`putFields`). */
  fields: Record<string, NexusField>
  /** The outcome of the last press, until the next one. */
  notice: { text: string; tone: 'error' | 'dim' } | null
  /**
   * The ports the person published or unpublished, by thread and then port. Kept when the pane leaves a thread, since
   * the CLI runs on; cleared when the pane's processes start afresh, as no older one is under way then.
   */
  portChanges: Record<string, Record<string, NexusPortChange>>
  /** The sessions the person opened or closed, by thread, kept when the pane leaves a thread as `portChanges` are. */
  sessionChanges: Record<string, NexusSessionChanges>
}

/** What the strip above the prompt reads besides the list: whether it shows, and when each thread was last viewed. */
export type NexusStrip = {
  isOn: boolean
  /** When the person last viewed each thread, Unix milliseconds; a thread not in it counts from `since`. */
  seen: Record<string, number>
  /** When the strip first ran: a reply before it is not news. */
  since: number
}

declare module 'claude-code' {
  interface PluginState {
    nexus: {
      list: NexusList
      watch: NexusWatch | null
      live: NexusLiveShown | null
      shown: NexusShown | null
      catalog: NexusCatalog
      pane: NexusPane
      strip: NexusStrip
      /** The project whose threads the list, the strip and `/nexus` show, null for every project; kept in `$.store`. */
      scope: string | null
      /** The strip's chip under the focus ring, a thread's ID, drawn highlighted. */
      stripCursor: string | null
      /** The run clock, ticked each second while a shown run works. */
      now: number
      /** The Changes tab's reads of the thread shown, null before the first. */
      checkout: NexusCheckout | null
      /** The diff the Changes tab shows, null before one is opened. */
      diff: NexusDiffShown | null
      /** Whether Changes shows only what is uncommitted (since HEAD) rather than all since the pylon booted; kept in `$.store`. */
      uncommitted: boolean
    }
  }
}
