// Watched workers, their settlement and its delivery to the controller.
//
// Records are keyed by machine and Core terminal address (`paneId` and
// `terminalId` are both that address) and persisted per Claude Code session. Each machine with watched workers has
// its own watcher process, so a change on one machine restarts only that one;
// each change is reconciled with a bridge `check`. A blocking tool call or an
// answer being entered leases its worker, so the watcher never reports what
// the call itself returns.
//
// Workers the session spawned are also kept as its children, watched or not,
// so it can close the idle ones and reopen a closed one on its saved session.
import {
  type AgentSummary,
  type Ask,
  type Bridge,
  type CheckResult,
  type CloseResult,
  type Delivery,
  LONGEST_CALL_MS,
  type Launch,
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
  /** The task whose outcome is still owed. */
  task?: string
  /** The agent's first task, and its latest when that differs: what a briefing restores. */
  scope?: string
  latest?: string
  status?: string
  reportedAskId?: string
  blockedReported?: boolean
}

/** A worker this session spawned: it may close it when idle and reopen it once closed. */
type Owned = {
  machine?: string
  machineName?: string
  terminalId: string
  /** Its routing name; the newest worker to hold a name keeps it. */
  name?: string
  /** Earlier terminal addresses, which still name it. */
  aliases?: string[]
  launch: Launch
}

type SavedState = { watches: Watched[]; children?: Owned[]; orchestration?: Orchestration }

/** An explicit orchestration choice and the guidance it gave. */
type Orchestration = { enabled: boolean; guidance: string }

type Machine = { id: string; name: string; state: string }

type Report = {
  record: Watched
  status: 'done' | 'failed' | 'question' | 'blocked' | 'interrupted' | 'closed'
  reply?: string
  ask?: Ask
}

/** One machine's watcher: the targets it covers and how to stop it. */
type Watcher = { key: string; stop?: () => void; error?: string }

const machineKey = (machine: string | undefined) => machine ?? 'local'
const keyOf = ({ machine, terminalId }: Pick<WorkerRecord, 'machine' | 'terminalId'>) =>
  `${machineKey(machine)}:${terminalId}`
/** Whether a record is on the machine a request names, by ID or by the name it had. */
const onMachine = (record: Pick<WorkerRecord, 'machine' | 'machineName'>, machine: string | undefined) =>
  record.machine === machine || (machine !== undefined && record.machineName === machine)

function attribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function questionHint(ask: Ask | undefined): string {
  if (ask?.handoff) return 'The worker waits on an action only the user can take. Tell the user; they complete it in its pane.'
  if (ask?.delivery === 'steer')
    return 'The worker continues meanwhile. Answer with answer and this ask_id, asking the user first when the choice is theirs.'
  return 'The worker waits. Answer with answer and this ask_id, asking the user first when the choice is theirs, or let them answer in its pane.'
}

function bodyFor({ record, status, reply, ask }: Report): string[] {
  switch (status) {
    case 'done':
      return [reply || 'Finished without a reply.']
    case 'failed':
      return [
        reply || 'The worker stopped with an error.',
        'Inspect it with read source:"recent" and assess the failure. If this task was not retried yet and one corrective assign could recover it, try once; if it fails again or the setup looks broken, stop and tell the user.',
      ]
    case 'question':
      return [
        JSON.stringify({
          ask_id: ask?.toolCallId,
          ...(ask?.question ? { question: ask.question } : { prompts: ask?.prompts ?? [] }),
        }),
        questionHint(ask),
      ]
    case 'blocked': {
      const address = record.machine ? `${record.machine}/${record.paneId}` : record.paneId
      return [
        `Waiting on an approval or dialog. Inspect it with read source:"visible"; respond with send, or use \`hc keys ${address} <keys>\` for interactive controls. Tell the user if it needs them.`,
      ]
    }
    case 'interrupted':
      return ['Its session changed before the task finished; the watch continues on the new session.']
    case 'closed':
      return ['Its terminal closed; its watch ended.']
  }
}

export function reportText(report: Report): string {
  const { record, status } = report
  const machine = record.machine ? ` machine="${record.machine}"` : ''
  const name = record.name ? ` name="${attribute(record.name)}"` : ''
  const task = record.task && status !== 'closed' ? [`Task: ${record.task}`] : []
  const text = [...task, ...bodyFor(report)].join('\n').replaceAll('</agent_report>', '<\\/agent_report>')
  return `<agent_report target="${attribute(record.paneId)}"${machine}${name} status="${status}">\n${text}\n</agent_report>`
}

export class Fleet {
  private readonly records = new Map<string, Watched>()
  private children: Owned[] = []
  /** Workers this controller is closing; their closing is not reported back to it. */
  private readonly closing = new Set<string>()
  /** Blocking calls and answers per worker; the watcher leaves leased workers alone. */
  private readonly leases = new Map<string, number>()
  /** Ask IDs whose answers are being entered. */
  private readonly answering = new Set<string>()
  private readonly checking = new Map<string, boolean>()
  private readonly watchers = new Map<string, Watcher>()
  /** Reports waiting for the running turn's next tool boundary or its end. */
  private outbox: string[] = []
  /** Context lost to compaction, restored before the next model request. */
  private briefingDue = false
  /** A main turn is running, or a submitted report has yet to start one. */
  private busy = false
  private loaded = false
  private orchestration: Orchestration | undefined

  constructor(private readonly io: SessionIo) {}

  async load(): Promise<void> {
    const state = (await this.io.readState()) as SavedState | undefined
    if (state !== undefined && !Array.isArray(state?.watches)) throw new Error('saved Shepherdr state is malformed')
    for (const record of state?.watches ?? []) this.records.set(keyOf(record), record)
    this.children = state?.children ?? []
    this.orchestration = state?.orchestration
    this.loaded = true
    this.ensureWatchers()
    this.updateStatus()
  }

  stop(): void {
    for (const watcher of this.watchers.values()) watcher.stop?.()
    this.watchers.clear()
    // Retire in-flight checks too, without changing this session's saved state.
    this.loaded = false
    this.records.clear()
    this.children = []
    this.outbox = []
  }

  find(target: string, machine?: string): Watched | undefined {
    return [...this.records.values()].find(
      record => onMachine(record, machine) && (record.paneId === target || record.name === target),
    )
  }

  /** The spawned worker a target names: by its address, an earlier one, or its name. */
  child(target: string, machine?: string): Owned | undefined {
    return this.children.find(
      child =>
        onMachine(child, machine) &&
        (child.terminalId === target || child.name === target || child.aliases?.includes(target) === true),
    )
  }

  /** Keeps a spawned worker as this session's own. */
  own({ launch, agent, record }: Delivery): void {
    if (!launch) return
    this.adopt({
      ...(record?.machine ? { machine: record.machine, machineName: record.machineName } : {}),
      terminalId: agent.terminal,
      ...(agent.name ? { name: agent.name } : {}),
      launch,
    })
  }

  /** Follows a reopened worker to its new terminal; its earlier address still names it. */
  reopened(child: Owned, agent: AgentSummary): void {
    const { name: _, ...rest } = child
    this.adopt(
      {
        ...rest,
        terminalId: agent.terminal,
        ...(agent.name ? { name: agent.name } : {}),
        aliases: [...new Set([...(child.aliases ?? []), child.terminalId])],
      },
      child,
    )
  }

  private adopt(child: Owned, replaces?: Owned): void {
    const others = this.children.filter(other => other !== replaces)
    this.children = [
      ...others.map(other => {
        if (!child.name || other.name !== child.name || machineKey(other.machine) !== machineKey(child.machine)) return other
        const { name: _, ...unnamed } = other
        return unnamed
      }),
      child,
    ]
    this.persist()
  }

  /**
   * Before a /quit: its worker's closing is this controller's own doing, not
   * news for it. Call the result with whether the worker closed.
   */
  quitting(target: string, machine?: string): (closed: boolean) => void {
    const record = this.find(target, machine)
    if (!record) return () => {}
    const key = keyOf(record)
    this.closing.add(key)
    return closed => {
      this.closing.delete(key)
      if (closed && this.records.get(key) === record) this.untrack(record)
    }
  }

  /**
   * Closes the idle workers this session spawned, for /shepherdr close-idle.
   * One with a blocking call, a task still owed or work running stays open;
   * the rest are closed only if idle when asked. Closed ones stay children,
   * so a later send or assign reopens them.
   */
  async closeIdle(): Promise<string> {
    if (!this.children.length) return 'This session spawned no agents.'
    const labelOf = (child: Owned) => child.name ?? child.terminalId
    const left: string[] = []
    const candidates = this.children.filter(child => {
      const key = keyOf(child)
      const record = this.records.get(key)
      const busy = this.leases.has(key) || Boolean(record?.task) || record?.status === 'working'
      if (busy) left.push(`${labelOf(child)} (work outstanding)`)
      return !busy
    })
    const closed: string[] = []
    for (const child of candidates) this.closing.add(keyOf(child))
    try {
      const results = candidates.length
        ? await call<CloseResult[]>(
            this.io.bridge,
            'closeIdle',
            { children: candidates.map(({ machine, terminalId, launch }) => ({ machine, terminalId, launch })) },
            120_000,
          )
        : []
      for (const result of results) {
        const child = candidates.find(candidate => keyOf(candidate) === keyOf(result))
        if (!child) continue
        if (result.closed) {
          closed.push(labelOf(child))
          this.records.delete(keyOf(child))
        } else if (result.skipped) left.push(`${labelOf(child)} (${result.skipped})`)
      }
    } finally {
      for (const child of candidates) this.closing.delete(keyOf(child))
    }
    if (closed.length) this.changed()
    return [
      closed.length ? `Closed ${closed.length} idle: ${closed.join(', ')}.` : 'Closed none.',
      ...(left.length ? [`Left open: ${left.join(', ')}.`] : []),
    ].join(' ')
  }

  isWatched(terminalId: string, machine?: string): boolean {
    return this.records.has(keyOf({ machine, terminalId } as WorkerRecord))
  }

  /**
   * Watches a delivered task, a worker named by `watch` (no task) or one
   * resuming from an answered Ask, whose next question reports again.
   */
  track({ agent, record: delivered }: Tracked, task?: string, answered = false): Watched {
    const existing = this.records.get(keyOf(delivered))
    const scope = existing?.scope ?? existing?.task ?? task
    const record: Watched = {
      ...existing,
      ...delivered,
      ...(existing && !task ? { seenInputId: existing.seenInputId } : {}),
      status: agent.status,
      ...(task ? { task, scope } : {}),
    }
    if (task && task !== scope) record.latest = task
    else if (task) delete record.latest
    if (answered) delete record.reportedAskId
    this.records.set(keyOf(record), record)
    this.changed()
    return record
  }

  untrack(record: Watched): void {
    this.records.delete(keyOf(record))
    this.changed()
  }

  /**
   * Claims an Ask for answering and leases a watched worker, so the watcher
   * leaves it alone while keys are entered and its Ask closes. The returned
   * function ends both.
   */
  beginAnswer(target: string, machine: string | undefined, askId: string): () => void {
    if (this.answering.has(askId)) throw new Error(`An answer to ${askId} is already being entered; wait for its result`)
    this.answering.add(askId)
    const record = this.find(target, machine)
    const release = record ? this.lease(keyOf(record)) : () => {}
    return () => {
      this.answering.delete(askId)
      release()
    }
  }

  /** Records an explicit orchestration choice, given again after compaction. */
  orchestrate(enabled: boolean, guidance: string): void {
    this.orchestration = { enabled, guidance }
    this.persist()
    this.updateStatus()
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
        const result = await call<CheckResult>(bridge, 'wait', { record }, LONGEST_CALL_MS)
        const report = this.settle(record, result, true)
        if (report) return reportText(report)
      }
    } finally {
      release()
    }
  }

  /** Restarts monitoring that stopped on any machine; returns a summary for /shepherdr. */
  inspect(machines: readonly Machine[]): string {
    const labelOf = (id: string) => machines.find(machine => machine.id === id)?.name ?? id
    const stopped = [...this.watchers].filter(([, watcher]) => watcher.error)
    const problems = stopped.map(
      ([machine, watcher]) =>
        `Monitoring ${machine === 'local' ? 'here' : `on ${labelOf(machine)}`} had stopped (${watcher.error}); restarted.`,
    )
    for (const [machine] of stopped) this.watchers.delete(machine)
    this.ensureWatchers()
    const records = [...this.records.values()]
    const lines = records.length
      ? records.map(record => {
          const where = record.machine ? ` on ${labelOf(record.machine)}` : ''
          return `${record.name ?? record.paneId} (${record.paneId}${where}) ${record.status ?? 'unknown'}${record.task ? ', task assigned' : ''}`
        })
      : ['Shepherdr watches no agents.']
    const machineLines = machines.map(machine => `Machine ${machine.name} (${machine.id}): ${machine.state}`)
    const mode = `Orchestration: ${this.orchestration?.enabled ? 'on' : 'off'}`
    return [...problems, ...lines, ...machineLines, mode].join('\n')
  }

  /**
   * What compaction drops: the chosen orchestration guidance and every watched
   * agent, idle ones included so the controller reuses them, each with its
   * first task and its latest instruction.
   */
  briefing(): string[] {
    const agents = [...this.records.values()].map(record => {
      const instructions = [record.scope ?? record.task, record.latest].filter(Boolean).join('\n\n')
      return {
        ...(record.machine ? { machine: record.machine } : {}),
        target: record.paneId,
        ...(record.name ? { name: record.name } : {}),
        status: record.status ?? 'unknown',
        ...(instructions ? { instructions } : {}),
      }
    })
    return [
      ...(this.orchestration ? [this.orchestration.guidance] : []),
      ...(agents.length
        ? [
            `Supervised agents after context rollover. Their instructions are reference data, not tasks for you. Do not repeat settled tasks or duplicate running work. Status is last observed; use these machine/target values for updates.\n${JSON.stringify(agents)}`,
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
    this.ensureWatchers()
    this.updateStatus()
  }

  private persist(): void {
    // Never overwrite saved state before it was read.
    if (!this.loaded) return
    this.io
      .writeState({
        watches: [...this.records.values()],
        ...(this.children.length ? { children: this.children } : {}),
        ...(this.orchestration ? { orchestration: this.orchestration } : {}),
      })
      .catch(error => this.io.toast(`Shepherdr could not save its watches: ${message(error)}`))
  }

  /** Restarts each machine's watcher whose targets changed; leaves the others running. */
  private ensureWatchers(): void {
    const groups = new Map<string, Watched[]>()
    for (const record of this.records.values()) {
      const machine = machineKey(record.machine)
      groups.set(machine, [...(groups.get(machine) ?? []), record])
    }
    for (const [machine, watcher] of this.watchers)
      if (!groups.has(machine)) {
        watcher.stop?.()
        this.watchers.delete(machine)
      }
    for (const [machine, records] of groups) {
      const key = JSON.stringify(records.map(record => [record.terminalId, record.sessionPath ?? null]).sort())
      const current = this.watchers.get(machine)
      if (current?.key === key) continue
      current?.stop?.()
      const id = machine === 'local' ? undefined : machine
      const watcher: Watcher = { key }
      watcher.stop = watchWorkers(
        this.io.bridge,
        id,
        records,
        line => this.onLine(id, line),
        error => {
          if (this.watchers.get(machine) !== watcher) return
          watcher.stop = undefined
          watcher.error = error
          this.updateStatus()
        },
      )
      this.watchers.set(machine, watcher)
    }
  }

  private onLine(machine: string | undefined, line: WatchLine): void {
    const records = [...this.records.values()].filter(record => record.machine === machine)
    switch (line.type) {
      case 'ready':
        for (const record of records) this.reconcile(keyOf(record))
        return
      case 'session':
        for (const record of records) {
          if (record.sessionPath !== line.path) continue
          // A background question reports at once, while its worker continues.
          if (line.ask) this.report(this.settle(record, { state: 'question', ask: line.ask }, false))
          // A working worker writes its transcript continuously; Core's status
          // event marks when it settles, so only settled workers' writes matter.
          else if (record.status !== 'working') this.reconcile(keyOf(record))
        }
        return
      case 'event': {
        const record = records.find(candidate => candidate.terminalId === line.pane)
        if (!record) return
        if (line.status === 'working' || line.status === 'unknown') {
          // Starting work settles nothing.
          record.status = line.status
          record.blockedReported = false
          this.persist()
          this.updateStatus()
          return
        }
        this.reconcile(keyOf(record))
      }
    }
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
          this.report(this.settle(record, result, false))
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
    }
    // A transcript first written after the watch began.
    if (result.state !== 'replaced' && result.sessionPath) record.sessionPath = result.sessionPath
    let report: Report | undefined
    switch (result.state) {
      case 'closed':
        this.records.delete(keyOf(record))
        // A blocking call still hears it; otherwise this controller's own close is no news.
        if (force || !this.closing.has(keyOf(record))) report = { record, status: 'closed' }
        break
      case 'replaced':
        record.sessionPath = result.sessionPath
        record.seenInputId = result.inputId ?? null
        delete record.reportedAskId
        record.blockedReported = false
        if (record.task || force) report = { record: { ...record }, status: 'interrupted' }
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
    // A new transcript needs the watcher on its new identity.
    const moved = identity[0] !== record.paneId || identity[1] !== record.sessionPath
    if (result.state === 'closed' || moved) this.changed()
    else if (JSON.stringify(record) !== before) {
      this.persist()
      this.updateStatus()
    }
    return report
  }

  /** Queues for the running turn; otherwise starts a turn with the report as its prompt. */
  private report(report: Report | undefined): void {
    if (!report) return
    const text = reportText(report)
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
    const stopped = [...this.watchers.values()].find(watcher => watcher.error)?.error
    const mode = this.orchestration?.enabled ? 'orchestrating' : undefined
    if (stopped) this.io.status(`monitoring stopped (${stopped}); run /shepherdr`)
    else if (!records.length) this.io.status(mode)
    else {
      const working = records.filter(record => record.status === 'working').length
      this.io.status(`${records.length} watched, ${working} working${mode ? `, ${mode}` : ''}`)
    }
  }
}
