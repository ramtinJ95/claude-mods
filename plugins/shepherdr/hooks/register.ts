import type { EngineInterface, Register } from 'claude-code'

import {
  type AgentSummary,
  type AnswerResult,
  type AnswerStatus,
  type Bridge,
  type Delivery,
  type Tracked,
  call,
  message,
  sendRoute,
} from './bridge'
import { type AgentsRequest, type ProfileSummary, TOOL_SPEC, helpText, orchestrationGuidance, parseRequest } from './contract'
import { Fleet, type SessionIo } from './fleet'
import { CallRow, PushedReports, ResultRow, parseReports } from './render'
import { awaitAnswer, takeAnswer } from './worker'

const COMMAND = 'shepherdr'

type Machine = { id: string; label: string; enabled: boolean }
type Profiles = { sources: Record<string, string>; profiles: ProfileSummary[] }

let fleet: Fleet | undefined
/** Texts this mod is sending to Claude Code workers right now, for its own permission check. */
const sending = new Map<string, number>()

function requireFleet(): Fleet {
  if (!fleet) throw new Error('Shepherdr is still starting; retry')
  return fleet
}

/** This session's open-question file; askFile in bridge/workers/claude.mjs reads it. */
async function askFile($: EngineInterface): Promise<string> {
  const [xdg, home, sessionId] = await Promise.all([$.env.get('XDG_DATA_HOME'), $.env.get('HOME'), $.session.id()])
  return `${xdg || `${home}/.local/share`}/claude-shepherdr/asks/${sessionId}.json`
}

/** A hook's own process calls: a blocking wait pauses only that hook's budget. */
function bridgeOf($: EngineInterface): Bridge {
  return {
    root: $.plugin.root,
    run: (argv, init) => $.process.run(argv, init),
    spawn: request => $.process.spawn(request),
    send: async (sessionId, text) => {
      sending.set(text, (sending.get(text) ?? 0) + 1)
      try {
        return await $.session.send({ to: { sessionId }, text })
      } finally {
        const left = (sending.get(text) ?? 1) - 1
        if (left) sending.set(text, left)
        else sending.delete(text)
      }
    },
  }
}

function sessionIo($: EngineInterface, file: string): SessionIo {
  return {
    bridge: bridgeOf($),
    submit: text => $.prompt.submit({ text }),
    status: text => $.ui.status(text),
    toast: text => $.ui.toast(text),
    readState: async () => ((await $.fs.exists(file)) ? JSON.parse(await $.fs.read(file)) : undefined),
    writeState: state => $.fs.write(file, JSON.stringify(state)),
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
    ...(delivery.record?.machine ? { machine: delivery.record.machine } : {}),
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
  const { machine } = request
  switch (request.action) {
    case 'help':
      if (request.commands) return JSON.stringify(await call(bridge, 'commands', { machine, target: request.target }))
      return helpText(await call<Profiles>(bridge, 'profiles'))
    case 'list': {
      const { agents, unavailable } = await call<{
        agents: (AgentSummary & { machine?: string })[]
        unavailable?: unknown[]
      }>(bridge, 'list', { machine, query: request.query, status: request.status })
      return JSON.stringify({
        agents: agents.map(({ terminal, ...agent }) => ({
          ...agent,
          ...(current.isWatched(terminal, agent.machine) ? { watched: true } : {}),
        })),
        ...(unavailable ? { unavailable } : {}),
      })
    }
    case 'spawn': {
      const delivery = await call<Delivery>(bridge, 'spawn', { ...request, fallbackCwd: cwd }, 240_000)
      try {
        await sendRoute(bridge, delivery.session)
      } catch (error) {
        const worker = delivery.agent.name ?? delivery.agent.target
        throw new Error(
          `${worker} started but did not receive its task: ${message(error)}. Assign the task to ${worker}, or close it with send "/quit"`,
        )
      }
      const blocking = delivery.profileBlocking ?? request.blocking ?? true
      return dispatchWork(bridge, current, delivery, request.message!, blocking, signal)
    }
    case 'assign': {
      const params = { machine, target: request.target, message: request.message, kind: 'task' }
      const delivery = await call<Delivery>(bridge, 'deliver', params, 90_000)
      await sendRoute(bridge, delivery.session)
      return dispatchWork(bridge, current, delivery, request.message!, request.blocking ?? true, signal)
    }
    case 'answer': {
      const askId = request.ask_id!
      const end = current.beginAnswer(request.target!, machine, askId)
      try {
        const params = { machine, target: request.target, ask_id: askId, answers: request.answers }
        const answered = await call<AnswerResult>(bridge, 'answer', params, 150_000)
        let { status } = answered
        if (answered.session) {
          await sendRoute(bridge, answered.session)
          ;({ status } = await call<AnswerStatus>(bridge, 'answered', params, 30_000))
        }
        const result = { target: answered.agent.target, ask_id: askId, status }
        if (!answered.record) return JSON.stringify({ ...result, input_sent: false })
        const record = current.track({ agent: answered.agent, record: answered.record }, undefined, true)
        // A background Ask never stopped its worker: there is nothing to wait for.
        if (answered.background || request.blocking === false) return JSON.stringify(result)
        return `${JSON.stringify(result)}\n${await current.waitFor(bridge, record, signal)}`
      } finally {
        end()
      }
    }
    case 'send': {
      const params = { machine, target: request.target, message: request.message, kind: 'message' }
      const delivery = await call<Delivery>(bridge, 'deliver', params, 90_000)
      await sendRoute(bridge, delivery.session)
      return JSON.stringify({
        target: delivery.agent.target,
        delivery: delivery.delivery,
        ...(delivery.command ? { commandSubmitted: true } : {}),
      })
    }
    case 'read':
      return JSON.stringify(
        await call(bridge, 'read', { machine, target: request.target, source: request.source, lines: request.lines }),
      )
    case 'watch': {
      const record = current.track(await call<Tracked>(bridge, 'watch', { machine, target: request.target }))
      return JSON.stringify({ target: record.paneId, ...(record.name ? { name: record.name } : {}), watching: true })
    }
    case 'unwatch': {
      const record = current.find(request.target!, machine)
      if (!record) throw new Error(`${request.target} is not watched; list shows watched agents`)
      current.untrack(record)
      return JSON.stringify({ target: record.paneId, watching: false })
    }
  }
}

/** /shepherdr: status and restart; `orchestrate` or `normal` switches the guidance. */
async function runCommand(
  $: EngineInterface,
  args: string,
): Promise<{ text: string; context?: string[] }> {
  const current = requireFleet()
  const bridge = bridgeOf($)
  const choice = args.trim()
  if (choice === 'orchestrate' || choice === 'normal') {
    const enabled = choice === 'orchestrate'
    const { profiles } = await call<Profiles>(bridge, 'profiles')
    const guidance = orchestrationGuidance(enabled, profiles.some(profile => profile.name === 'general'))
    current.orchestrate(enabled, guidance)
    return { text: `Orchestration ${enabled ? 'on' : 'off'}.`, context: [guidance] }
  }
  if (choice) return { text: 'Use /shepherdr, /shepherdr orchestrate or /shepherdr normal.' }
  return { text: current.inspect(await call<Machine[]>(bridge, 'machines')) }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await Promise.all([
      $.tool.register(TOOL_SPEC),
      $.command.register({
        name: COMMAND,
        description: 'Show Shepherdr agents and machines, restart monitoring, or switch orchestration (orchestrate|normal)',
      }),
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

  // Observes every tool: briefings and reports queued during the call join
  // the next model request. Its failure must never change another tool's call.
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
    if (e.agentId || !fleet || compacted.skip !== undefined) return compacted
    // Automatic compaction resumes mid-turn with no turn.start, so the
    // briefing joins the compacted conversation itself. Between turns
    // (/compact, a notes window) another plugin may replace the conversation
    // after this hook, so the next turn's start brings it instead.
    if (e.trigger === 'auto' || e.trigger === 'precompute') {
      const briefing = fleet.briefing()
      return briefing.length
        ? { ...compacted, messages: [...compacted.messages, { role: 'user', text: briefing.join('\n\n'), toolUses: [] }] }
        : compacted
    }
    fleet.compacted()
    return compacted
  }).catch(($, e, next) => next(e))

  // A delivery to a Claude Code worker is part of the agents call the session
  // already approved; auto mode's classifier cannot judge it on its own. Only
  // this mod's own send of a text it is delivering right now is allowed.
  on('tool.check', { tool: 'SendMessage' }, ($, e, next) => {
    // $.session.send runs as this mod's SendMessage call with { to, message }.
    const text = (e.input as { message?: unknown }).message
    return next.origin.plugin === $.plugin.name && typeof text === 'string' && sending.has(text)
      ? { decision: 'allow', reason: 'Shepherdr delivery for an approved agents call' }
      : next(e)
  }).catch(($, e, next) => next(e))

  // Worker side: a controller's answer settles this session's open question
  // in place of its dialog, whichever comes first; the dialog then closes.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    if (e.agentId || !e.tool_use_id) return next(e)
    const file = await askFile($)
    await $.fs.write(file, JSON.stringify({ toolCallId: e.tool_use_id, questions: e.questions }))
    const remote = awaitAnswer(e.tool_use_id)
    try {
      const winner = await Promise.race([
        next(e).then(local => ({ local })),
        remote.answered.then(payload => ({ payload })),
      ])
      if ('local' in winner) return winner.local
      const { answers, annotations } = winner.payload
      return {
        result: {
          questions: e.questions,
          answers,
          ...(annotations && Object.keys(annotations).length ? { annotations } : {}),
        },
      }
    } finally {
      remote.cancel()
      await $.fs.write(file, '{}')
    }
  }).catch(($, e, next) => (next.called ? { deny: 'The question was interrupted; ask it again.' } : next(e)))

  // A frame for a question already settled is dropped too: it was never for the model.
  on('session.receive', ($, e, next) => {
    if (e.origin.kind !== 'peer') return next(e)
    const taken = takeAnswer(e.text)
    if (!taken) return next(e)
    return { consumed: taken === 'answered' ? 'answered an open question' : 'answer for a question no longer open' }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: COMMAND }, ($, e) => runCommand($, e.args))

  // The rows the person sees; the model reads the same JSON and reports.
  on('ui.render', { component: 'ToolUse', props: { tool: 'mcp__shepherdr__agents' } }, ($, e) =>
    CallRow($.ui.resolve(e), e.props.input as Record<string, unknown>, e.props),
  )

  on('ui.render', { component: 'ToolResult', props: { tool: 'mcp__shepherdr__agents' } }, ($, e, next) => {
    if (e.props.isErrored || typeof e.props.output !== 'string') return next(e)
    return ResultRow($.ui.resolve(e), e.props.output) ?? next(e)
  })

  // Reports pushed as a prompt of their own; ctrl+o still shows the raw text.
  on('ui.render', { component: 'UserMessage', props: { origin: { kind: 'plugin' } } }, ($, e, next) => {
    const { origin, isExpanded, text } = e.props
    const reports = origin.kind === 'plugin' && origin.name === 'shepherdr' && !isExpanded ? parseReports(text) : []
    return reports.length ? PushedReports($.ui.resolve(e), reports) : next(e)
  })
}
