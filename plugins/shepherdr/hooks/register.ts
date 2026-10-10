import type { Register } from 'claude-code'

import { type AgentSummary, type Bridge, type Delivery, call } from './bridge'
import { type AgentsRequest, type ProfileSummary, TOOL_SPEC, helpText, parseRequest } from './contract'
import { Fleet } from './fleet'

const COMMAND = 'shepherdr'

let fleet: Fleet | undefined

function requireFleet(): Fleet {
  if (!fleet) throw new Error('Shepherdr is still starting; retry')
  return fleet
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
  if (delivery.command) return JSON.stringify({ ...summary, commandSubmitted: true })
  const record = current.track(delivery, task)
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
      const delivery = await call<Delivery>(bridge, 'deliver', {
        target: request.target,
        message: request.message,
        kind: 'task',
      })
      return dispatchWork(bridge, current, delivery, request.message!, request.blocking ?? true, signal)
    }
    case 'send': {
      const delivery = await call<Delivery>(bridge, 'deliver', {
        target: request.target,
        message: request.message,
        kind: 'message',
      })
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
      const delivery = await call<Pick<Delivery, 'agent' | 'record'>>(bridge, 'watch', { target: request.target })
      const record = current.track(delivery)
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
    await $.tool.register(TOOL_SPEC)
    await $.command.register({ name: COMMAND, description: 'Show Shepherdr agents and restart stopped monitoring' })
    const started = await next(e)
    fleet?.stop()
    const dataHome = (await $.env.get('XDG_DATA_HOME')) || `${await $.env.get('HOME')}/.local/share`
    const file = `${dataHome}/claude-shepherdr/sessions/${await $.session.id()}.json`
    fleet = new Fleet({
      bridge: {
        root: $.plugin.root,
        run: (argv, init) => $.process.run(argv, init),
        spawn: request => $.process.spawn(request),
      },
      append: text => $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } }),
      submit: text => $.prompt.submit({ text }),
      status: text => $.ui.status(text),
      toast: text => $.ui.toast(text),
      readWatches: async () => ((await $.fs.exists(file)) ? JSON.parse(await $.fs.read(file)) : []),
      writeWatches: records => $.fs.write(file, JSON.stringify(records)),
    })
    try {
      await fleet.load()
    } catch (error) {
      $.ui.toast(
        `Shepherdr could not read its saved watches (${error instanceof Error ? error.message : String(error)}); fix or remove ${file}. New watches are not saved until then.`,
      )
    }
    return started
  })

  on('session.end', ($, e, next) => {
    fleet?.stop()
    return next(e)
  })

  // Bridge calls go through this hook's own $, so a blocking wait does not
  // count against the hook's budget.
  on('tool.call', { tool: 'mcp__shepherdr__agents' }, async ($, e, next) => {
    try {
      const bridge: Bridge = {
        root: $.plugin.root,
        run: (argv, init) => $.process.run(argv, init),
        spawn: request => $.process.spawn(request),
      }
      const request = parseRequest(e as unknown as Record<string, unknown>)
      const cwd = request.action === 'spawn' ? await $.session.cwd() : ''
      return { result: await handle(bridge, cwd, request, next.signal) }
    } catch (error) {
      if (next.signal.aborted) return { deny: 'Cancelled; the worker keeps running and reports when it settles.' }
      return { deny: error instanceof Error ? error.message : String(error) }
    }
  }).catch(() => ({ deny: 'Shepherdr failed to handle the call; retry or call agents with {} for help.' }))

  // Observes every tool; its failure must never change another tool's call.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (!e.agentId) fleet?.toolFinished()
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.start', ($, e, next) => {
    fleet?.turnStarted()
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
    await fleet?.briefAfterCompaction()
    return compacted
  }).catch(($, e, next) => next(e))

  on('command.run', { command: COMMAND }, () => ({ text: requireFleet().inspect() }))
}
