// The mod has no Node APIs; Herdr sockets, transcripts and processes go
// through the Node helpers under ../bridge. Hooks may not pass `$` along, so
// each hook hands its own process calls in as a Bridge.
import type { HookStream, ProcessRunInit, ProcessRunResult, ProcessSpawnChunk, ProcessSpawnRequest, ProcessSpawnResult } from 'claude-code'

export type Bridge = {
  root: string
  run: (argv: readonly string[], init: ProcessRunInit) => Promise<ProcessRunResult>
  spawn: (request: ProcessSpawnRequest) => HookStream<ProcessSpawnChunk, ProcessSpawnResult>
}

export type WorkerRecord = {
  terminalId: string
  paneId: string
  kind: string
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
  prompts: { title: string; multiple: boolean; choices: { label: string; description?: string }[]; body?: string }[]
}

export type CheckResult = {
  state: 'closed' | 'replaced' | 'working' | 'idle' | 'done' | 'question' | 'blocked'
  agent?: { pane_id: string; terminal_id: string; status: string; name?: string }
  inputId?: string | null
  sessionPath?: string
  reply?: { id: string; text: string; stopReason?: string }
  ask?: Ask
  reason?: string
  timedOut?: true
}

export type Delivery = {
  agent: AgentSummary
  record: WorkerRecord
  delivery: 'peer' | 'terminal'
  command?: true
  profileBlocking?: boolean
}

export async function call<T>(
  bridge: Bridge,
  op: string,
  params: Record<string, unknown> = {},
  timeoutMs = 60_000,
): Promise<T> {
  const run = await bridge.run(['node', `${bridge.root}/bridge/cli.mjs`], {
    stdin: JSON.stringify({ op, ...params }),
    timeoutMs,
  })
  const line = run.stdout.trim().split('\n').at(-1) ?? ''
  let reply: { ok: true; result: T } | { ok: false; error: { message: string; code?: string } }
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

export type WatchLine =
  | { type: 'ready' }
  | { type: 'event'; event: string; pane: string | null }
  | { type: 'session'; path: string }

/** Starts the session-lifetime watcher; the returned function stops it. */
export function watchWorkers(
  bridge: Bridge,
  records: readonly WorkerRecord[],
  onLine: (line: WatchLine) => void,
  onExit: (error: string) => void,
): () => void {
  const stream = bridge.spawn({
    argv: ['node', `${bridge.root}/bridge/watch.mjs`],
    input: JSON.stringify({
      targets: records.map(({ terminalId, sessionPath }) => ({ terminalId, sessionPath })),
    }),
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
      error = thrown instanceof Error ? thrown.message : String(thrown)
    }
    if (!stopped) onExit(error ?? (stderr.trim() || 'monitor exited'))
  })()
  return () => {
    stopped = true
    void stream.return(undefined as never)
  }
}
