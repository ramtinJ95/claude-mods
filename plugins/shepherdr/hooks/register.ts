import type { EngineInterface, Register } from 'claude-code'

import { type AgentSummary, type AnswerResult, type Bridge, type Delivery, type Tracked, call, message } from './bridge'
import { type AgentsRequest, type ProfileSummary, TOOL_SPEC, helpText, parseRequest } from './contract'
import { Fleet, type SessionIo } from './fleet'

const COMMAND = 'shepherdr'

let fleet: Fleet | undefined

function requireFleet(): Fleet {
  if (!fleet) throw new Error('Shepherdr is still starting; retry')
  return fleet
}

/** A hook's own process calls: a blocking wait pauses only that hook's budget. */
function bridgeOf($: EngineInterface): Bridge {
  return {
    root: $.plugin.root,
    run: (argv, init) => $.process.run(argv, init),
    spawn: request => $.process.spawn(request),
  }
}

function sessionIo($: EngineInterface, file: string): SessionIo {
  return {
    bridge: bridgeOf($),
    submit: text => $.prompt.submit({ text }),
    status: text => $.ui.status(text),
    toast: text => $.ui.toast(text),
    readWatches: async () => ((await $.fs.exists(file)) ? JSON.parse(await $.fs.read(file)) : []),
    writeWatches: records => $.fs.write(file, JSON.stringify(records)),
  }
}

async function appendAll($: EngineInterface, texts: readonly string[]): Promise<void> {
  for (const text of texts) await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
}

function dispatchWork(
  bridge: Bridge,
  current: Fleet,
  delivery: Delivery,
  task: string,
  blocking: boolean,
  signal: AbortSignal,
): Promise<string> | string {
  const summary = {
    target: delivery.agent.target,
    ...(delivery.agent.name ? { name: delivery.agent.name } : {}),
    delivery: delivery.delivery,
  }
  if (delivery.command || !delivery.record) return JSON.stringify({ ...summary, commandSubmitted: true })
  const record = current.track({ agent: delivery.agent, record: delivery.record }, task)
  if (!blocking) return JSON.stringify({ ...summary, status: 'working' })
  return current.waitFor(bridge, record, signal)
}

async function handle(bridge: Bridge, cwd: string, request: AgentsRequest, signal: AbortSignal): Promise<string> {
  const current = requireFleet()
  switch (request.action) {
    case 'help':
      return helpText(await call<{ source: string; profiles: ProfileSummary[] }>(bridge, 'profiles'))
    case 'list': {
      const agents = await call<AgentSummary[]>(bridge, 'list', { query: request.query, status: request.status })
      return JSON.stringify(
        agents.map(({ terminal, ...agent }) => ({
          ...agent,
          ...(current.isWatched(terminal) ? { watched: true } : {}),
        })),
      )
    }
    case 'spawn': {
      const delivery = await call<Delivery>(bridge, 'spawn', { ...request, fallbackCwd: cwd }, 120_000)
      const blocking = delivery.profileBlocking ?? request.blocking ?? true
      return dispatchWork(bridge, current, delivery, request.message!, blocking, signal)
    }
    case 'assign': {
      const params = { target: request.target, message: request.message, kind: 'task' }
      const delivery = await call<Delivery>(bridge, 'deliver', params)
      return dispatchWork(bridge, current, delivery, request.message!, request.blocking ?? true, signal)
    }
    case 'answer': {
      const askId = request.ask_id!
      const end = current.beginAnswer(request.target!, askId)
      let entered = false
      try {
        const params = { target: request.target, ask_id: askId, answers: request.answers }
        const answered = await call<AnswerResult>(bridge, 'answer', params)
        entered = true
        const result = { target: answered.agent.target, ask_id: askId, status: answered.status }
        if (!answered.record) return JSON.stringify({ ...result, input_sent: false })
        const record = current.track({ agent: answered.agent, record: answered.record })
        if (request.blocking === false) return JSON.stringify(result)
        return `${JSON.stringify(result)}\n${await current.waitFor(bridge, record, signal)}`
      } finally {
        end(entered)
      }
    }
    case 'send': {
      const params = { target: request.target, message: request.message, kind: 'message' }
      const delivery = await call<Delivery>(bridge, 'deliver', params)
      return JSON.stringify({
        target: delivery.agent.target,
        delivery: delivery.delivery,
        ...(delivery.command ? { commandSubmitted: true } : {}),
      })
    }
    case 'read':
      return JSON.stringify(
        await call(bridge, 'read', { target: request.target, source: request.source, lines: request.lines }),
      )
    case 'watch': {
      const record = current.track(await call<Tracked>(bridge, 'watch', { target: request.target }))
      return JSON.stringify({ target: record.paneId, ...(record.name ? { name: record.name } : {}), watching: true })
    }
    case 'unwatch': {
      const record = current.find(request.target!)
      if (!record) throw new Error(`${request.target} is not watched; list shows watched agents`)
      current.untrack(record)
      return JSON.stringify({ target: record.paneId, watching: false })
    }
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await Promise.all([
      $.tool.register(TOOL_SPEC),
      $.command.register({ name: COMMAND, description: 'Show Shepherdr agents and restart stopped monitoring' }),
    ])
    const started = await next(e)
    fleet?.stop()
    const [xdg, home, sessionId] = await Promise.all([$.env.get('XDG_DATA_HOME'), $.env.get('HOME'), $.session.id()])
    const file = `${xdg || `${home}/.local/share`}/claude-shepherdr/sessions/${sessionId}.json`
    fleet = new Fleet(sessionIo($, file))
    try {
      await fleet.load()
    } catch (error) {
      $.ui.toast(
        `Shepherdr could not read its saved watches (${message(error)}); fix or remove ${file}. New watches are not saved until then.`,
      )
    }
    return started
  })

  on('session.end', ($, e, next) => {
    fleet?.stop()
    return next(e)
  })

  on('tool.call', { tool: 'mcp__shepherdr__agents' }, async ($, e, next) => {
    try {
      const request = parseRequest(e as unknown as Record<string, unknown>)
      const cwd = request.action === 'spawn' ? await $.session.cwd() : ''
      return { result: await handle(bridgeOf($), cwd, request, next.signal) }
    } catch (error) {
      if (next.signal.aborted) return { deny: 'Cancelled; the worker keeps running and reports when it settles.' }
      return { deny: message(error) }
    }
  }).catch(() => ({ deny: 'Shepherdr failed to handle the call; retry or call agents with {} for help.' }))

  // Observes every tool: reports queued during the call join the next model
  // request. Its failure must never change another tool's call.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (!e.agentId && fleet) await appendAll($, fleet.drain())
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (fleet) await appendAll($, fleet.turnStarted())
    return next(e)
  })

  // Subagent runs raise turn.complete too (with agentId) but no turn.start.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (!e.agentId) fleet?.turnEnded()
    return done
  })

  on('session.compact', async ($, e, next) => {
    const compacted = await next(e)
    const brief = fleet?.briefAfterCompaction()
    if (brief) await appendAll($, [brief])
    return compacted
  }).catch(($, e, next) => next(e))

  on('command.run', { command: COMMAND }, () => ({ text: requireFleet().inspect() }))
}
