// Watched workers, their settlement and its delivery to the controller.
//
// Records are keyed by Herdr terminal ID (pane IDs change on move) and
// persisted per Claude Code session. One watcher process streams changes; each
// change is reconciled with a bridge `check`. A blocking tool call claims its
// worker, so the watcher never reports what the call itself returns.
import { type Ask, type Bridge, type CheckResult, type Delivery, type WatchLine, type WorkerRecord, call, watchWorkers } from './bridge'

/** The session's engine calls, bound by session.start since `$` cannot be passed. */
export type SessionIo = {
  bridge: Bridge
  append: (text: string) => Promise<unknown>
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

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

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
  private readonly claims = new Set<string>()
  private readonly checking = new Map<string, boolean>()
  private loaded = false
  private stopWatch: (() => void) | undefined
  private watchKey = ''
  private monitorError: string | undefined
  private running = false
  private seq = 0
  private loopTop = 0
  private lastAppend = 0

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

  list(): Watched[] {
    return [...this.records.values()]
  }

  find(target: string): Watched | undefined {
    return this.list().find(record => record.paneId === target || record.name === target)
  }

  isWatched(terminalId: string): boolean {
    return this.records.has(terminalId)
  }

  /** Watches a delivered task, or a worker named by `watch` when task is absent. */
  track(delivery: Pick<Delivery, 'agent' | 'record'>, task?: string): Watched {
    const existing = this.records.get(delivery.record.terminalId)
    const record: Watched = {
      ...existing,
      ...delivery.record,
      ...(existing && !task ? { seenInputId: existing.seenInputId } : {}),
      status: delivery.agent.status,
      ...(task ? { task } : {}),
    }
    this.records.set(record.terminalId, record)
    this.changed()
    return record
  }

  /** Keeps the watcher off a watched worker while the caller drives it; release reconciles it. */
  hold(target: string): () => void {
    const id = this.find(target)?.terminalId
    if (!id) return () => {}
    this.claims.add(id)
    return () => {
      this.claims.delete(id)
      if (this.records.has(id)) this.reconcile(id)
    }
  }

  /** Watches a worker resuming from an answered Ask; a later question with the same ID reports again. */
  trackAnswer(answered: Pick<Delivery, 'agent' | 'record'>): Watched {
    const record = this.track(answered)
    delete record.reportedAskId
    this.persist()
    return record
  }

  untrack(record: Watched): void {
    this.records.delete(record.terminalId)
    this.changed()
  }

  turnStarted(): void {
    this.running = true
    this.loopTop = ++this.seq
  }

  /** The next model request of a running turn starts after its tool results. */
  toolFinished(): void {
    if (this.running) this.loopTop = ++this.seq
  }

  /** Never awaits the wake: a submitted prompt resolves only once its turn starts. */
  turnEnded(): void {
    this.running = false
    const unread = this.lastAppend > this.loopTop
    this.lastAppend = 0
    if (unread)
      this.io
        .submit('Agent reports arrived while your last response was being written; act on any you have not handled.')
        .catch(error => this.io.toast(`Shepherdr could not wake the session: ${message(error)}`))
  }

  async briefAfterCompaction(): Promise<void> {
    const active = this.list().filter(record => record.task)
    if (!active.length) return
    const agents = active.map(record => ({
      target: record.paneId,
      ...(record.name ? { name: record.name } : {}),
      status: record.status ?? 'unknown',
      task: record.task,
    }))
    // Context for later requests, not a report: it never needs a wake.
    await this.io.append(
      `<active_agents>\n${JSON.stringify(agents)}\n</active_agents>\nThis work stays assigned and reports when it settles; do not delegate it again.`,
    )
  }

  /** Holds a tool call until the worker settles, through the calling hook's own Bridge. */
  async waitFor(bridge: Bridge, record: Watched, signal: AbortSignal): Promise<string> {
    const id = record.terminalId
    this.claims.add(id)
    try {
      for (;;) {
        signal.throwIfAborted()
        const result = await call<CheckResult>(
          bridge,
          'wait',
          { record, timeoutMs: WAIT_SLICE_MS },
          WAIT_SLICE_MS + 60_000,
        )
        if (result.state === 'working' || result.state === 'idle') {
          this.observe(record, result)
          continue
        }
        const report = this.settle(record, result, true)
        if (report) return reportText(report)
      }
    } finally {
      this.claims.delete(id)
      if (this.records.has(id)) this.reconcile(id)
    }
  }

  /** Restarts stopped monitoring; returns a summary for /shepherdr. */
  inspect(): string {
    const problem = this.monitorError
    if (problem) {
      this.watchKey = ''
      this.ensureWatcher()
    }
    const records = this.list()
    const lines = records.length
      ? records.map(
          record =>
            `${record.name ?? record.paneId} (${record.paneId}) ${record.status ?? 'unknown'}${record.task ? ', task assigned' : ''}`,
        )
      : ['Shepherdr watches no agents.']
    return [...(problem ? [`Monitoring had stopped (${problem}); restarted.`] : []), ...lines].join('\n')
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
      .writeWatches(this.list())
      .catch(error => this.io.toast(`Shepherdr could not save its watches: ${message(error)}`))
  }

  private ensureWatcher(): void {
    const records = this.list()
    const key = JSON.stringify(records.map(({ paneId, sessionPath }) => [paneId, sessionPath ?? null]).sort())
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
        this.watchKey = ''
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
    const records = this.list()
    // A working worker writes its transcript continuously; Herdr's status
    // event marks when it settles, so only settled workers' writes matter.
    const matched =
      line.type === 'session'
        ? records.filter(record => record.sessionPath === line.path && record.status !== 'working')
        : records.filter(record => record.paneId === line.pane)
    // A moved pane reports its new ID, which no record knows yet.
    const moved = line.type === 'event' && line.event === 'pane.moved'
    for (const record of matched.length || !moved ? matched : records) this.reconcile(record.terminalId)
  }

  private reconcile(id: string): void {
    if (this.checking.has(id)) {
      this.checking.set(id, true)
      return
    }
    this.checking.set(id, false)
    void (async () => {
      try {
        do {
          this.checking.set(id, false)
          const record = this.records.get(id)
          if (!record || this.claims.has(id)) break
          const result = await call<CheckResult>(this.io.bridge, 'check', { record }, 30_000)
          if (this.claims.has(id) || this.records.get(id) !== record) continue
          const report = this.settle(record, result, false)
          if (report) await this.deliver(reportText(report))
        } while (this.checking.get(id))
      } catch (error) {
        this.io.toast(`Shepherdr could not check a worker: ${message(error)}`)
      } finally {
        this.checking.delete(id)
      }
    })()
  }

  private observe(record: Watched, result: CheckResult): void {
    if (!result.agent) return
    record.paneId = result.agent.pane_id
    record.status = result.agent.status
    if (result.agent.name) record.name = result.agent.name
  }

  /** Applies a check to its record; returns what the controller has not heard yet. */
  private settle(record: Watched, result: CheckResult, force: boolean): Report | undefined {
    const before = JSON.stringify(record)
    const identity = [record.paneId, record.sessionPath]
    this.observe(record, result)
    let report: Report | undefined
    if (result.state !== 'working' && result.state !== 'idle') {
      delete record.answeringAskId
      delete record.answeringUntil
    }
    switch (result.state) {
      case 'closed':
        this.records.delete(record.terminalId)
        report = { record, status: 'closed' }
        break
      case 'replaced':
        record.sessionPath = result.sessionPath
        record.seenInputId = result.inputId ?? null
        delete record.reportedAskId
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

  private async append(text: string): Promise<void> {
    await this.io.append(text)
    this.lastAppend = ++this.seq
  }

  /** Steers a running turn; otherwise wakes the session with a turn of its own. */
  private async deliver(text: string): Promise<void> {
    if (this.running) await this.append(text)
    else await this.io.submit(text)
  }

  private updateStatus(): void {
    const records = this.list()
    if (this.monitorError) this.io.status(`shepherdr: monitoring stopped (${this.monitorError}); run /shepherdr`)
    else if (!records.length) this.io.status(undefined)
    else {
      const working = records.filter(record => record.status === 'working').length
      this.io.status(`shepherdr: ${records.length} watched, ${working} working`)
    }
  }
}
