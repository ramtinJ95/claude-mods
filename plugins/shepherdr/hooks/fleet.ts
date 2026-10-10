// Watched workers, their settlement and its delivery to the controller.
//
// Records are keyed by machine and Herdr terminal ID (pane IDs change on move)
// and persisted per Claude Code session. One watcher process streams changes
// from every machine; each change is reconciled with a bridge `check`. A
// blocking tool call leases its worker, so the watcher never reports what the
// call itself returns.
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
  /** This session's saved state; undefined when none was saved. */
  readState: () => Promise<unknown>
  writeState: (state: SavedState) => Promise<void>
}

type Watched = WorkerRecord & {
  task?: string
  status?: string
  reportedAskId?: string
  blockedReported?: boolean
}

type SavedState = { watches: Watched[]; orchestration?: Orchestration }

/** An explicit orchestration choice and the guidance it gave. */
type Orchestration = { enabled: boolean; guidance: string }

type Report = {
  record: Watched
  status: 'done' | 'failed' | 'question' | 'blocked' | 'interrupted' | 'closed'
  reply?: string
  ask?: Ask
}

// A blocking wait re-arms well inside the ten-minute process ceiling.
const WAIT_SLICE_MS = 9 * 60_000

/** This machine is `local` in requests and an absent `machine` on records. */
export const machineOf = (machine: string | undefined) => (!machine || machine === 'local' ? undefined : machine)

const keyOf = ({ machine, terminalId }: WorkerRecord) => `${machineOf(machine) ?? 'local'}:${terminalId}`

function attribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
}

/** Herdr CLI prefix that reaches the worker's machine. */
function herdrCommand(record: Watched): string {
  return record.machine ? `herdr --machine ${record.machine}` : 'herdr'
}

export function reportText({ record, status, reply, ask }: Report): string {
  const machine = record.machine ? ` machine="${record.machine}"` : ''
  const name = record.name ? ` name="${attribute(record.name)}"` : ''
  const task = record.task && status !== 'closed' ? [`Task: ${record.task}`] : []
  const body =
    status === 'done'
      ? [reply || 'Finished without a reply.']
      : status === 'failed'
        ? [
            reply || 'The worker stopped with an error.',
            'Inspect it with read source:"recent" and assess the failure. If this task was not retried yet and one corrective assign could recover it, try once; if it fails again or the setup looks broken, stop and tell the user.',
          ]
        : status === 'question'
          ? [
              JSON.stringify({ ask_id: ask?.toolCallId, prompts: ask?.prompts ?? [] }),
              ask?.delivery === 'steer'
                ? 'The worker continues meanwhile. Answer with answer and this ask_id, asking the user first when the choice is theirs.'
                : 'The worker waits. Answer with answer and this ask_id, asking the user first when the choice is theirs, or let them answer in its pane.',
            ]
          : status === 'blocked'
            ? [
                `Waiting on an approval or dialog. Inspect it with read source:"visible"; respond with send, or use \`${herdrCommand(record)} agent send-keys ${record.paneId} <keys>\` for interactive controls. Tell the user if it needs them.`,
              ]
            : status === 'interrupted'
              ? ['Its Pi session changed before the task finished; the watch continues on the new session.']
              : ['The pane closed; its watch ended.']
  const text = [...task, ...body].join('\n').replaceAll('</agent_report>', '<\\/agent_report>')
  return `<agent_report target="${attribute(record.paneId)}"${machine}${name} status="${status}">\n${text}\n</agent_report>`
}

export class Fleet {
  private readonly records = new Map<string, Watched>()
  /** Blocking calls per worker; the watcher leaves leased workers alone. */
  private readonly leases = new Map<string, number>()
  /** Ask IDs whose answers are being entered. */
  private readonly answering = new Set<string>()
  private readonly checking = new Map<string, boolean>()
  /** Reports waiting for the running turn's next tool boundary or its end. */
  private outbox: string[] = []
  /** Context lost to compaction, restored before the next model request. */
  private briefingDue = false
  /** A main turn is running, or a submitted report has yet to start one. */
  private busy = false
  private loaded = false
  private orchestration: Orchestration | undefined
  private stopWatch: (() => void) | undefined
  private watchKey = ''
  private monitorError: string | undefined
  private readonly machineErrors = new Map<string, string>()

  constructor(private readonly io: SessionIo) {}

  async load(): Promise<void> {
    const saved = await this.io.readState()
    // Earlier versions saved the watch list alone.
    const state: SavedState | undefined = Array.isArray(saved) ? { watches: saved as Watched[] } : (saved as SavedState)
    if (state !== undefined && !Array.isArray(state?.watches)) throw new Error('saved Shepherdr state is malformed')
    for (const record of state?.watches ?? []) this.records.set(keyOf(record), record)
    this.orchestration = state?.orchestration
    this.loaded = true
    this.ensureWatcher()
    this.updateStatus()
  }

  stop(): void {
    this.stopWatch?.()
    this.stopWatch = undefined
  }

  find(target: string, machine?: string): Watched | undefined {
    return [...this.records.values()].find(
      record => record.machine === machineOf(machine) && (record.paneId === target || record.name === target),
    )
  }

  isWatched(terminalId: string, machine?: string): boolean {
    return this.records.has(keyOf({ machine: machineOf(machine), terminalId } as WorkerRecord))
  }

  /**
   * Watches a delivered task, a worker named by `watch` (no task) or one
   * resuming from an answered Ask (whose question may then report again).
   */
  track({ agent, record: delivered }: Tracked, task?: string): Watched {
    const existing = this.records.get(keyOf(delivered))
    const { reportedAskId, ...kept } = existing ?? {}
    const record: Watched = {
      ...kept,
      ...delivered,
      ...(existing && !task ? { seenInputId: existing.seenInputId } : {}),
      ...(reportedAskId && !delivered.answeringAskId ? { reportedAskId } : {}),
      status: agent.status,
      ...(task ? { task } : {}),
    }
    this.records.set(keyOf(record), record)
    this.changed()
    return record
  }

  untrack(record: Watched): void {
    this.records.delete(keyOf(record))
    this.changed()
  }

  /**
   * Claims an Ask for answering. A watched worker is marked before any key is
   * sent, so the watcher reads its closing Ask as work in progress. The
   * returned function ends the claim and, unless the answer went in, unmarks.
   */
  beginAnswer(target: string, machine: string | undefined, askId: string): (entered: boolean) => void {
    if (this.answering.has(askId)) throw new Error(`An answer to ${askId} is already being entered; wait for its result`)
    this.answering.add(askId)
    const record = this.find(target, machine)
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

  /** Records an explicit orchestration choice; returns the guidance to give now. */
  orchestrate(enabled: boolean, guidance: string): string {
    this.orchestration = { enabled, guidance }
    this.persist()
    return guidance
  }

  orchestrationMode(): boolean {
    return this.orchestration?.enabled ?? false
  }

  /** Compaction dropped earlier context; brief again before the next model request. */
  compacted(): void {
    this.briefingDue = true
  }

  turnStarted(): string[] {
    this.busy = true
    return this.drain()
  }

  /** Context and reports to append before the running turn's next model request. */
  drain(): string[] {
    const briefing = this.briefingDue ? this.briefing() : []
    this.briefingDue = false
    const queued = [...briefing, ...this.outbox]
    this.outbox = []
    return queued
  }

  /** Submits reports the turn did not reach; a submitted prompt resolves only once its turn starts. */
  turnEnded(): void {
    this.busy = false
    const queued = this.outbox
    this.outbox = []
    if (queued.length) this.submit(queued.join('\n\n'))
  }

  /** Holds a tool call until the worker settles, through the calling hook's own Bridge. */
  async waitFor(bridge: Bridge, record: Watched, signal: AbortSignal): Promise<string> {
    const release = this.lease(keyOf(record))
    try {
      for (;;) {
        signal.throwIfAborted()
        const result = await call<CheckResult>(bridge, 'wait', { record, timeoutMs: WAIT_SLICE_MS }, WAIT_SLICE_MS + 90_000)
        const report = this.settle(record, result, true)
        if (report) return reportText(report)
      }
    } finally {
      release()
    }
  }

  /** Restarts monitoring that stopped on any machine; returns a summary for /shepherdr. */
  inspect(machines: readonly { id: string; label: string; enabled: boolean }[]): string {
    const problems = [
      ...(this.monitorError ? [`Monitoring had stopped (${this.monitorError}); restarted.`] : []),
      ...[...this.machineErrors].map(
        ([id, error]) => `Monitoring on ${machines.find(machine => machine.id === id)?.label ?? id} had stopped (${error}); restarted.`,
      ),
    ]
    if (problems.length) this.restartWatcher()
    const records = [...this.records.values()]
    const lines = records.length
      ? records.map(record => {
          const where = record.machine ? ` on ${machines.find(machine => machine.id === record.machine)?.label ?? record.machine}` : ''
          return `${record.name ?? record.paneId} (${record.paneId}${where}) ${record.status ?? 'unknown'}${record.task ? ', task assigned' : ''}`
        })
      : ['Shepherdr watches no agents.']
    const machineLines = machines.map(
      machine => `Machine ${machine.label} (${machine.id}): ${machine.enabled ? 'enabled' : 'disabled in Herdr'}`,
    )
    const mode = `Orchestration: ${this.orchestrationMode() ? 'on' : 'off'}`
    return [...problems, ...lines, ...machineLines, mode].join('\n')
  }

  /** What compaction drops: the chosen orchestration guidance and agents with assigned work. */
  briefing(): string[] {
    const agents = [...this.records.values()]
      .filter(record => record.task)
      .map(record => ({
        ...(record.machine ? { machine: record.machine } : {}),
        target: record.paneId,
        ...(record.name ? { name: record.name } : {}),
        status: record.status ?? 'unknown',
        task: record.task,
      }))
    return [
      ...(this.orchestration ? [this.orchestration.guidance] : []),
      ...(agents.length
        ? [
            `Existing agents after context rollover. Do not duplicate their work. Status is last observed; use these machine/target values for updates.\n${JSON.stringify(agents)}`,
          ]
        : []),
    ]
  }

  private lease(key: string): () => void {
    this.leases.set(key, (this.leases.get(key) ?? 0) + 1)
    return () => {
      const left = (this.leases.get(key) ?? 1) - 1
      if (left) this.leases.set(key, left)
      else {
        this.leases.delete(key)
        if (this.records.has(key)) this.reconcile(key)
      }
    }
  }

  private changed(): void {
    this.persist()
    this.ensureWatcher()
    this.updateStatus()
  }

  private persist(): void {
    // Never overwrite saved state before it was read.
    if (!this.loaded) return
    this.io
      .writeState({ watches: [...this.records.values()], ...(this.orchestration ? { orchestration: this.orchestration } : {}) })
      .catch(error => this.io.toast(`Shepherdr could not save its watches: ${message(error)}`))
  }

  private restartWatcher(): void {
    this.watchKey = ''
    this.stop()
    this.ensureWatcher()
  }

  private ensureWatcher(): void {
    const records = [...this.records.values()]
    const key = JSON.stringify(records.map(record => [keyOf(record), record.sessionPath ?? null]).sort())
    if (key === this.watchKey && (this.stopWatch || !records.length)) return
    this.stop()
    this.watchKey = key
    this.monitorError = undefined
    this.machineErrors.clear()
    if (!records.length) return this.updateStatus()
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
    const records = [...this.records.values()].filter(record => record.machine === line.machine)
    switch (line.type) {
      case 'ready':
        this.machineErrors.delete(line.machine ?? 'local')
        this.updateStatus()
        for (const record of records) this.reconcile(keyOf(record))
        return
      case 'error':
        this.machineErrors.set(line.machine ?? 'local', line.message)
        this.updateStatus()
        return
      case 'session':
        for (const record of records) {
          if (record.sessionPath !== line.path) continue
          if (line.ask && line.ask.toolCallId !== record.reportedAskId) this.question(record, line.ask)
          // A working worker writes its transcript continuously; Herdr's status
          // event marks when it settles, so only settled workers' writes matter.
          else if (record.status !== 'working') this.reconcile(keyOf(record))
        }
        return
      case 'event': {
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
        this.reconcile(keyOf(record))
      }
    }
  }

  /**
   * A background question: reported at once, while its worker keeps working,
   * even during a blocking call on it, which ends only when the task does.
   */
  private question(record: Watched, ask: Ask): void {
    record.reportedAskId = ask.toolCallId
    this.persist()
    this.deliver(reportText({ record, status: 'question', ask }))
  }

  private reconcile(key: string): void {
    if (this.checking.has(key)) {
      this.checking.set(key, true)
      return
    }
    void (async () => {
      try {
        do {
          this.checking.set(key, false)
          const record = this.records.get(key)
          if (!record || this.leases.has(key)) break
          const result = await call<CheckResult>(this.io.bridge, 'check', { record }, 90_000)
          if (this.leases.has(key) || this.records.get(key) !== record) continue
          const report = this.settle(record, result, false)
          if (report) this.deliver(reportText(report))
        } while (this.checking.get(key))
      } catch (error) {
        this.io.toast(`Shepherdr could not check a worker: ${message(error)}`)
      } finally {
        this.checking.delete(key)
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
        this.records.delete(keyOf(record))
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
        report = {
          record: { ...record },
          status: result.reply?.stopReason === 'error' ? 'failed' : 'done',
          ...(result.reply?.text ? { reply: result.reply.text } : {}),
        }
        delete record.task
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
    const stopped = this.monitorError ?? [...this.machineErrors.values()][0]
    if (stopped) this.io.status(`shepherdr: monitoring stopped (${stopped}); run /shepherdr`)
    else if (!records.length) this.io.status(this.orchestrationMode() ? 'shepherdr: orchestrating' : undefined)
    else {
      const working = records.filter(record => record.status === 'working').length
      const mode = this.orchestrationMode() ? ', orchestrating' : ''
      this.io.status(`shepherdr: ${records.length} watched, ${working} working${mode}`)
    }
  }
}
