// Watched workers, their settlement and its delivery to the controller.
//
// Records are keyed by Herdr terminal ID (pane IDs change on move) and
// persisted per Claude Code session. One watcher process streams changes; each
// change is reconciled with a bridge `check`. A blocking tool call leases its
// worker, so the watcher never reports what the call itself returns.
import {
  type Ask,
  type Bridge,
  type CheckResult,
  type Tracked,
  type WatchLine,
  type WorkerRecord,
  call,
  message,
  watchWorkers,
} from './bridge'

/** The session's engine calls, bound in register.ts where `$` is reachable. */
export type SessionIo = {
  bridge: Bridge
  submit: (text: string) => Promise<unknown>
  status: (text: string | undefined) => void
  toast: (text: string) => void
  /** This session's saved watches; [] when none were saved. */
  readWatches: () => Promise<unknown>
  writeWatches: (records: readonly WorkerRecord[]) => Promise<void>
}

type Watched = WorkerRecord & {
  task?: string
  status?: string
  reportedAskId?: string
  blockedReported?: boolean
}

type Report = {
  record: Watched
  status: 'done' | 'failed' | 'question' | 'blocked' | 'interrupted' | 'closed'
  reply?: string
  ask?: Ask
}

// A blocking wait re-arms well inside the ten-minute process ceiling.
const WAIT_SLICE_MS = 9 * 60_000

function attribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
}

export function reportText({ record, status, reply, ask }: Report): string {
  const name = record.name ? ` name="${attribute(record.name)}"` : ''
  const body =
    status === 'done'
      ? reply || 'Finished without a reply.'
      : status === 'failed'
        ? reply || 'The worker stopped with an error.'
        : status === 'question'
          ? `${JSON.stringify({ ask_id: ask?.toolCallId, prompts: ask?.prompts ?? [] })}\nAnswer with answer and this ask_id, or let the user answer it in the worker's pane.`
          : status === 'blocked'
            ? 'Waiting on an approval or dialog. Inspect it with read source:"visible"; tell the user if it needs them.'
            : status === 'interrupted'
              ? 'Its Pi session changed before the task finished; the watch continues on the new session.'
              : 'The pane closed; its watch ended.'
  const safe = body.replaceAll('</agent_report>', '<\\/agent_report>')
  return `<agent_report target="${attribute(record.paneId)}"${name} status="${status}">\n${safe}\n</agent_report>`
}

export class Fleet {
  private readonly records = new Map<string, Watched>()
  /** Blocking calls per terminal; the watcher leaves leased workers alone. */
  private readonly leases = new Map<string, number>()
  /** Ask IDs whose answers are being entered. */
  private readonly answering = new Set<string>()
  private readonly checking = new Map<string, boolean>()
  /** Reports waiting for the running turn's next tool boundary or its end. */
  private outbox: string[] = []
  /** A main turn is running, or a submitted report has yet to start one. */
  private busy = false
  private loaded = false
  private stopWatch: (() => void) | undefined
  private watchKey = ''
  private monitorError: string | undefined

  constructor(private readonly io: SessionIo) {}

  async load(): Promise<void> {
    const saved = await this.io.readWatches()
    if (!Array.isArray(saved)) throw new Error('saved Shepherdr watches are not a list')
    for (const record of saved as Watched[]) this.records.set(record.terminalId, record)
    this.loaded = true
    this.ensureWatcher()
    this.updateStatus()
  }

  stop(): void {
    this.stopWatch?.()
    this.stopWatch = undefined
  }

  find(target: string): Watched | undefined {
    return [...this.records.values()].find(record => record.paneId === target || record.name === target)
  }

  isWatched(terminalId: string): boolean {
    return this.records.has(terminalId)
  }

  /**
   * Watches a delivered task, a worker named by `watch` (no task) or one
   * resuming from an answered Ask (whose question may then report again).
   */
  track({ agent, record: delivered }: Tracked, task?: string): Watched {
    const existing = this.records.get(delivered.terminalId)
    const { reportedAskId, ...kept } = existing ?? {}
    const record: Watched = {
      ...kept,
      ...delivered,
      ...(existing && !task ? { seenInputId: existing.seenInputId } : {}),
      ...(reportedAskId && !delivered.answeringAskId ? { reportedAskId } : {}),
      status: agent.status,
      ...(task ? { task } : {}),
    }
    this.records.set(record.terminalId, record)
    this.changed()
    return record
  }

  untrack(record: Watched): void {
    this.records.delete(record.terminalId)
    this.changed()
  }

  /**
   * Claims an Ask for answering. A watched worker is marked before any key is
   * sent, so the watcher reads its closing Ask as work in progress. The
   * returned function ends the claim and, unless the answer went in, unmarks.
   */
  beginAnswer(target: string, askId: string): (entered: boolean) => void {
    if (this.answering.has(askId)) throw new Error(`An answer to ${askId} is already being entered; wait for its result`)
    this.answering.add(askId)
    const record = this.find(target)
    if (record) {
      record.answeringAskId = askId
      this.persist()
    }
    return entered => {
      this.answering.delete(askId)
      if (!entered && record?.answeringAskId === askId) {
        delete record.answeringAskId
        this.persist()
      }
    }
  }

  turnStarted(): string[] {
    this.busy = true
    return this.drain()
  }

  /** Reports to append before the running turn's next model request. */
  drain(): string[] {
    const queued = this.outbox
    this.outbox = []
    return queued
  }

  /** Submits reports the turn did not reach; a submitted prompt resolves only once its turn starts. */
  turnEnded(): void {
    this.busy = false
    const queued = this.drain()
    if (queued.length) this.submit(queued.join('\n\n'))
  }

  briefAfterCompaction(): string | undefined {
    const agents = [...this.records.values()]
      .filter(record => record.task)
      .map(record => ({
        target: record.paneId,
        ...(record.name ? { name: record.name } : {}),
        status: record.status ?? 'unknown',
        task: record.task,
      }))
    if (!agents.length) return undefined
    return `<active_agents>\n${JSON.stringify(agents)}\n</active_agents>\nThis work stays assigned and reports when it settles; do not delegate it again.`
  }

  /** Holds a tool call until the worker settles, through the calling hook's own Bridge. */
  async waitFor(bridge: Bridge, record: Watched, signal: AbortSignal): Promise<string> {
    const release = this.lease(record.terminalId)
    try {
      for (;;) {
        signal.throwIfAborted()
        const result = await call<CheckResult>(bridge, 'wait', { record, timeoutMs: WAIT_SLICE_MS }, WAIT_SLICE_MS + 60_000)
        const report = this.settle(record, result, true)
        if (report) return reportText(report)
      }
    } finally {
      release()
    }
  }

  /** Restarts stopped monitoring; returns a summary for /shepherdr. */
  inspect(): string {
    const problem = this.monitorError
    if (problem) this.ensureWatcher()
    const records = [...this.records.values()]
    const lines = records.length
      ? records.map(
          record =>
            `${record.name ?? record.paneId} (${record.paneId}) ${record.status ?? 'unknown'}${record.task ? ', task assigned' : ''}`,
        )
      : ['Shepherdr watches no agents.']
    return [...(problem ? [`Monitoring had stopped (${problem}); restarted.`] : []), ...lines].join('\n')
  }

  private lease(id: string): () => void {
    this.leases.set(id, (this.leases.get(id) ?? 0) + 1)
    return () => {
      const left = (this.leases.get(id) ?? 1) - 1
      if (left) this.leases.set(id, left)
      else {
        this.leases.delete(id)
        if (this.records.has(id)) this.reconcile(id)
      }
    }
  }

  private changed(): void {
    this.persist()
    this.ensureWatcher()
    this.updateStatus()
  }

  private persist(): void {
    // Never overwrite saved watches before they were read.
    if (!this.loaded) return
    this.io
      .writeWatches([...this.records.values()])
      .catch(error => this.io.toast(`Shepherdr could not save its watches: ${message(error)}`))
  }

  private ensureWatcher(): void {
    const records = [...this.records.values()]
    const key = JSON.stringify(records.map(({ terminalId, sessionPath }) => [terminalId, sessionPath ?? null]).sort())
    if (key === this.watchKey && (this.stopWatch || !records.length)) return
    this.stop()
    this.watchKey = key
    this.monitorError = undefined
    if (!records.length) return
    const stop = watchWorkers(
      this.io.bridge,
      records,
      line => this.onLine(line),
      error => {
        if (this.stopWatch !== stop) return
        this.stopWatch = undefined
        this.monitorError = error
        this.updateStatus()
      },
    )
    this.stopWatch = stop
  }

  private onLine(line: WatchLine): void {
    if (line.type === 'ready') {
      for (const id of this.records.keys()) this.reconcile(id)
      return
    }
    const records = [...this.records.values()]
    if (line.type === 'session') {
      // A working worker writes its transcript continuously; Herdr's status
      // event marks when it settles, so only settled workers' writes matter.
      for (const record of records)
        if (record.sessionPath === line.path && record.status !== 'working') this.reconcile(record.terminalId)
      return
    }
    // Moves and closes name the pane by the ID the record knows.
    const record = records.find(candidate => candidate.paneId === line.pane)
    if (!record) return
    if (line.status === 'working' || line.status === 'unknown') {
      // Starting work settles nothing; leaving `blocked` ends an answered Ask.
      record.status = line.status
      record.blockedReported = false
      delete record.answeringAskId
      this.persist()
      this.updateStatus()
      return
    }
    this.reconcile(record.terminalId)
  }

  private reconcile(id: string): void {
    if (this.checking.has(id)) {
      this.checking.set(id, true)
      return
    }
    void (async () => {
      try {
        do {
          this.checking.set(id, false)
          const record = this.records.get(id)
          if (!record || this.leases.has(id)) break
          const result = await call<CheckResult>(this.io.bridge, 'check', { record }, 30_000)
          if (this.leases.has(id) || this.records.get(id) !== record) continue
          const report = this.settle(record, result, false)
          if (report) this.deliver(reportText(report))
        } while (this.checking.get(id))
      } catch (error) {
        this.io.toast(`Shepherdr could not check a worker: ${message(error)}`)
      } finally {
        this.checking.delete(id)
      }
    })()
  }

  /**
   * Applies a check to its record; returns what the controller has not heard
   * yet. `force` reports a settlement even if it was reported before.
   */
  private settle(record: Watched, result: CheckResult, force: boolean): Report | undefined {
    const before = JSON.stringify(record)
    const identity = [record.paneId, record.sessionPath]
    if (result.agent) {
      record.paneId = result.agent.target
      record.status = result.agent.status
      if (result.agent.name) record.name = result.agent.name
      if (result.agent.status !== 'blocked') delete record.answeringAskId
    }
    let report: Report | undefined
    switch (result.state) {
      case 'closed':
        this.records.delete(record.terminalId)
        report = { record, status: 'closed' }
        break
      case 'replaced':
        record.sessionPath = result.sessionPath
        record.seenInputId = result.inputId ?? null
        delete record.reportedAskId
        delete record.answeringAskId
        record.blockedReported = false
        if (record.task || force) report = { record, status: 'interrupted' }
        delete record.task
        break
      case 'working':
        record.blockedReported = false
        break
      case 'idle':
        break
      case 'done':
        if (!force && result.inputId === record.seenInputId) break
        record.seenInputId = result.inputId ?? null
        record.blockedReported = false
        delete record.task
        report = {
          record,
          status: result.reply?.stopReason === 'error' ? 'failed' : 'done',
          ...(result.reply?.text ? { reply: result.reply.text } : {}),
        }
        break
      case 'question':
        if (!force && record.reportedAskId === result.ask?.toolCallId) break
        record.reportedAskId = result.ask?.toolCallId
        report = { record, status: 'question', ...(result.ask ? { ask: result.ask } : {}) }
        break
      case 'blocked':
        if (!force && record.blockedReported) break
        record.blockedReported = true
        report = { record, status: 'blocked' }
        break
    }
    // A moved pane or new transcript needs the watcher on its new identity.
    const moved = identity[0] !== record.paneId || identity[1] !== record.sessionPath
    if (result.state === 'closed' || moved) this.changed()
    else if (JSON.stringify(record) !== before) {
      this.persist()
      this.updateStatus()
    }
    return report
  }

  /** Queues for the running turn; otherwise starts a turn with the report as its prompt. */
  private deliver(text: string): void {
    if (this.busy) this.outbox.push(text)
    else this.submit(text)
  }

  private submit(text: string): void {
    this.busy = true
    this.io.submit(text).catch(error => {
      this.busy = false
      this.io.toast(`Shepherdr could not deliver an agent report: ${message(error)}`)
    })
  }

  private updateStatus(): void {
    const records = [...this.records.values()]
    if (this.monitorError) this.io.status(`shepherdr: monitoring stopped (${this.monitorError}); run /shepherdr`)
    else if (!records.length) this.io.status(undefined)
    else {
      const working = records.filter(record => record.status === 'working').length
      this.io.status(`shepherdr: ${records.length} watched, ${working} working`)
    }
  }
}
