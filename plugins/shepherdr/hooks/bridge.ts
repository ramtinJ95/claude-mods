// The mod has no Node APIs; Herdr sockets, transcripts and processes go
// through the Node helpers under ../bridge. A Bridge carries one hook's own
// process calls, since `$` stays in the hooks module's top-level functions.
import type {
  HookStream,
  ProcessRunInit,
  ProcessRunResult,
  ProcessSpawnChunk,
  ProcessSpawnRequest,
  ProcessSpawnResult,
  SessionSendResult,
} from 'claude-code'

export type Bridge = {
  root: string
  run: (argv: readonly string[], init: ProcessRunInit) => Promise<ProcessRunResult>
  spawn: (request: ProcessSpawnRequest) => HookStream<ProcessSpawnChunk, ProcessSpawnResult>
  /** Claude Code's own cross-session message, which the Node bridge cannot send. */
  send: (sessionId: string, text: string) => Promise<SessionSendResult>
}

/** A message for a Claude Code worker's session that the bridge prepared and the hooks send. */
export type SessionRoute = { sessionId: string; text: string }

export async function sendRoute(bridge: Bridge, route: SessionRoute | undefined): Promise<void> {
  if (!route) return
  const sent = await bridge.send(route.sessionId, route.text)
  if (!sent.isDelivered) throw new Error(`The worker's Claude Code session did not take the message: ${sent.reason}`)
}

export type WorkerRecord = {
  /** Herdr machine profile ID; absent on the machine running Claude Code. */
  machine?: string
  terminalId: string
  paneId: string
  name?: string
  sessionPath?: string
  seenInputId: string | null
}

export type AgentSummary = {
  target: string
  name?: string
  kind: string
  status: string
  terminal: string
  cwd?: string
}

export type Ask = {
  toolCallId: string
  /** "steer": asked while the worker continues. */
  delivery?: 'steer'
  prompts: { title: string; multiple: boolean; choices: { label: string; description?: string }[]; body?: string }[]
  /** The worker's own question text, when it published no prompts. */
  question?: string
  /** Only the user can complete it, in the worker's pane. */
  handoff?: boolean
}

export type CheckResult = {
  state: 'closed' | 'replaced' | 'working' | 'idle' | 'done' | 'question' | 'blocked'
  agent?: AgentSummary
  inputId?: string | null
  sessionPath?: string
  reply?: { id: string; text: string; stopReason?: string }
  ask?: Ask
}

export type Delivery = {
  agent: AgentSummary
  /** Present for tasks: the watch that reports the outcome. */
  record?: WorkerRecord
  delivery: 'peer' | 'terminal' | 'session'
  command?: true
  profileBlocking?: boolean
  session?: SessionRoute
}

export type Tracked = { agent: AgentSummary; record: WorkerRecord }

export type AnswerStatus = { agent: AgentSummary; status: 'accepted' | 'rejected' | 'unknown' }

export type AnswerResult = {
  agent: AgentSummary
  /** Absent while a `session` route is unsent; `answered` reads it afterwards. */
  status?: AnswerStatus['status']
  session?: SessionRoute
  /** A background Ask: the worker never stopped, so there is no settlement to wait for. */
  background?: boolean
  /** Present only when answers were entered; a recorded retry sends nothing. */
  record?: WorkerRecord
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The ten-minute ceiling $.process.run allows, less room to wind down. */
export const LONGEST_CALL_MS = 590_000

/**
 * Runs one bridge operation. Its time limit is the one budget for everything
 * beneath: the bridge, and any SSH call it makes, finish inside it.
 */
export async function call<T>(
  bridge: Bridge,
  op: string,
  params: Record<string, unknown> = {},
  timeoutMs = 60_000,
): Promise<T> {
  const run = await bridge.run(['node', `${bridge.root}/bridge/cli.mjs`], {
    stdin: JSON.stringify({ op, ...params, budgetMs: timeoutMs - 2_000 }),
    timeoutMs,
  })
  const line = run.stdout.trim().split('\n').at(-1) ?? ''
  let reply: { ok: true; result: T } | { ok: false; error: { message: string } }
  try {
    reply = JSON.parse(line)
  } catch {
    throw new Error(
      `Shepherdr bridge failed (exit ${run.exitCode}): ${run.stderr.trim() || run.stdout.trim() || 'no output'}`,
    )
  }
  if (!reply.ok) throw new Error(reply.error.message)
  return reply.result
}

/** Every line carries `machine` when it came from a remote machine's watcher. */
export type WatchLine =
  | { type: 'ready' }
  | { type: 'event'; event: string; pane: string | null; status?: string }
  | { type: 'session'; path: string; ask?: Ask }

/** Starts one machine's watcher (this one when `machine` is absent); the returned function stops it. */
export function watchWorkers(
  bridge: Bridge,
  machine: string | undefined,
  records: readonly WorkerRecord[],
  onLine: (line: WatchLine) => void,
  onExit: (error: string) => void,
): () => void {
  const stream = bridge.spawn({
    argv: ['node', `${bridge.root}/bridge/watch.mjs`],
    input: `${JSON.stringify({
      machine,
      targets: records.map(({ terminalId, sessionPath }) => ({ terminalId, sessionPath })),
    })}\n`,
  })
  let stopped = false
  void (async () => {
    let buffer = ''
    let stderr = ''
    let error: string | undefined
    try {
      for await (const { stream: name, text } of stream) {
        if (name === 'stderr') {
          stderr = (stderr + text).slice(-2000)
          continue
        }
        buffer += text
        for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          if (!line) continue
          const value = JSON.parse(line) as WatchLine | { type: 'error'; message: string }
          if (value.type === 'error') error = value.message
          else onLine(value)
        }
      }
    } catch (thrown) {
      error = message(thrown)
    }
    if (!stopped) onExit(error ?? (stderr.trim() || 'monitor exited'))
  })()
  return () => {
    stopped = true
    void stream.return(undefined as never)
  }
}
