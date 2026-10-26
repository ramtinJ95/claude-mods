import { expect, mock, test, type TestBody } from 'claude-code/testing'

import { projectArgs } from '../hooks/tools'
import { register } from '../hooks/register'

import { CONVERSATION, DETAIL, T0, WORKER, WORKER_DETAIL, boot, fake, OPENED, PROJECTS } from './fake-cli'

const ID = 'th-4f2a00000001'
const healthy = { type: 'state', thread: ID, status: 'active', run: 'idle', parkedTasks: 0, queued: 0, pylon: 'running', failed: null, ports: [] }
const asked = { type: 'reset', thread: ID, entries: [{ entry: { id: 1, model: [{ role: 'user', content: 'go' }] }, text: '> go' }] }
const reply = (id: number, text: string) => ({ type: 'entry', thread: ID, entry: { id, model: [{ role: 'assistant', content: [{ type: 'text', text }] }] }, text })
const said = reply(2, 'Done.')

/** The mod's `wait` and `read` tools over a watch that prints the given events and then holds, as a live watch does. */
async function tools(...[$, on]: Parameters<TestBody>) {
  const clock = mock.clock(on)
  mock.env(on, {})
  let events: unknown[] = []
  on('command.register', () => ({ value: { command: 'nexus' } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__nexus__${e.name}` } }))
  on('ui.panes', () => ({ value: [] }))
  on('process.spawn', async function* (_, e) {
    // `read` and `wait` ask the details first, which say whether a Claude Code worker's transcript stands in for the watch.
    if (e.argv[1] === 'show') {
      yield { stream: 'stdout' as const, text: JSON.stringify(DETAIL) }
      return { value: { code: 0, signal: null } }
    }
    for (const event of events) yield { stream: 'stdout' as const, text: `${JSON.stringify(event)}\n` }
    await clock.sleep(600_000)
    return { value: { code: 0, signal: null } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  return {
    async wait(...printed: unknown[]) {
      events = printed
      const call = $.tool.call({ tool: 'mcp__nexus__wait', thread: ID, timeout_seconds: 5 } as never)
      await clock.advance(2_000)
      const { result } = await call
      return JSON.parse(String(result)) as Record<string, unknown>
    },
    read(...printed: unknown[]) {
      events = printed
      return $.tool.call({ tool: 'mcp__nexus__read', thread: ID } as never)
    },
  }
}

test('wait says when only a person can unblock the thread', async ($, on) => {
  const { wait: waitOn } = await tools($, on)
  expect(await waitOn(asked, { ...healthy, run: 'parked', parkedTasks: 2 })).toMatchObject({
    settled: true,
    run: 'parked',
    needs_human: 'Tasks hit the restart limit and are parked. A human must retry them with /nexus retry.',
    reply: null,
  })
  expect(await waitOn(asked, { ...healthy, run: 'working', failed: 'the VM did not boot' })).toMatchObject({
    settled: true,
    run: 'working',
    needs_human: 'The pylon failed. A human must retry it with /nexus retry-pylon.',
  })
  expect(await waitOn(asked, { ...healthy, pylon: 'failed' })).toMatchObject({ needs_human: expect.stringContaining('/nexus retry-pylon') })
  const answered = await waitOn(asked, said, healthy)
  expect(answered).toMatchObject({ settled: true, reply: 'Done.' })
  expect(answered).not.toHaveProperty('needs_human')
})

test("wait's reply is every text since the person's message, a blank line apart, its tail kept", async ($, on) => {
  const { wait: waitOn } = await tools($, on)
  const long = 'x'.repeat(2_500)
  const got = await waitOn(asked, reply(2, `first\n${long}`), reply(3, `second\n${long}`), healthy)
  expect(got.reply).toBe(`[1015 earlier characters left out]\n${'x'.repeat(1_491)}\n\nsecond\n${long}`)
})

test("wait's reply is the whole turn, past the rows a watch keeps", async ($, on) => {
  const { wait: waitOn } = await tools($, on)
  const tool = (id: number) => ({ type: 'entry', thread: ID, entry: { id, model: [{ role: 'assistant', content: [{ type: 'toolCall', id: `t${id}`, name: 'bash', arguments: { command: 'ls' } }] }] }, text: '' })
  const calls = Array.from({ length: 450 }, (_, n) => tool(n + 3))
  expect(await waitOn(asked, reply(2, 'Starting'), ...calls, reply(500, 'Done'), healthy)).toMatchObject({ settled: true, reply: 'Starting\n\nDone' })
})

test('read keeps the kind of an error the watch reports before any state', async ($, on) => {
  const { read: readOn } = await tools($, on)
  const read = (kind: string) => readOn({ type: 'error', thread: ID, kind, message: 'the API answered 500' })
  expect(await read('failed')).toMatchObject({ deny: 'nexus (failed): the API answered 500' })
  expect(await read('unreachable')).toMatchObject({ deny: 'nexus (unreachable): the API answered 500' })
})

test("read and wait report the ports the pylon listens on with their preview's URL, null when unknown", async ($, on) => {
  const { read: readOn, wait: waitOn } = await tools($, on)
  const preview = { pylon: 'p', service: 'web', httpsPort: 10201, ready: true, url: 'https://node.example.ts.net:10201/' }
  const listening = { ...healthy, ports: [{ port: 3000, service: 'web', preview }, { port: 5173, service: null, preview: null }] }
  const { result } = await readOn(asked, listening)
  expect(JSON.parse(String(result)).ports).toEqual([{ port: 3000, service: 'web', url: 'https://node.example.ts.net:10201/', ready: true }, { port: 5173 }])
  // A service the node reports failed says why.
  const failed = { ...listening, ports: [{ port: 3000, service: 'web', preview: { ...preview, ready: false, failed: 'web exited with code 1' } }] }
  expect(JSON.stringify(JSON.parse(String((await readOn(asked, failed)).result)).ports)).toBe(
    JSON.stringify([{ port: 3000, service: 'web', url: 'https://node.example.ts.net:10201/', ready: false, failed: 'web exited with code 1' }]),
  )
  // An empty reason is no reason, as pi-nexus reads it.
  const blank = { ...listening, ports: [{ port: 3000, service: 'web', preview: { ...preview, ready: false, failed: '' } }] }
  expect(JSON.parse(String((await readOn(asked, blank)).result)).ports).toEqual([{ port: 3000, service: 'web', url: 'https://node.example.ts.net:10201/', ready: false }])
  expect(await waitOn(asked, said, { ...healthy, ports: null })).toMatchObject({ settled: true, ports: null })
  // A CLI older than the contract prints no ports: the call says the two disagree rather than guess.
  const { ports: _, ...old } = healthy
  expect(await readOn(asked, old)).toMatchObject({ deny: expect.stringContaining('nexus watch printed no ports, which docs/cli.md requires') })
})

test('preview publishes a port and answers its URL once the node serves it, or why it could not', async ($, on) => {
  const cli = fake()
  await boot($, on, cli)
  const call = (port: number) => $.tool.call({ tool: 'mcp__nexus__preview', thread: ID, port } as never)
  const { result } = await call(5173)
  expect(cli.spawns).toContainEqual(['preview', '--json', ID, '5173', '--wait'])
  expect(JSON.parse(String(result))).toEqual({ thread: ID, port: 5173, url: OPENED.url, ready: true })
  cli.fail.preview = { exitCode: 5, error: 'the pylon is not running' }
  expect(await call(5173)).toMatchObject({ deny: 'nexus (conflict): the pylon is not running' })
})

test("unpublish closes a linked port's preview from the tool and /nexus, says why it could not, and names the CLI an old one needs", async ($, on) => {
  const cli = fake()
  const { nexus } = await boot($, on, cli)
  const call = (port: number) => $.tool.call({ tool: 'mcp__nexus__unpublish', thread: '4f2a', port } as never)
  const { result } = await call(5173)
  expect(cli.spawns).toContainEqual(['unpreview', '--json', ID, '5173'])
  expect(JSON.parse(String(result))).toEqual({ thread: ID, port: 5173, unpublished: true })
  expect(await nexus('unpublish 8080 4f2a')).toEqual({ text: `Unpublished port 8080 of ${ID}. Publishing it again may give it a new URL.` })
  expect(cli.spawns).toContainEqual(['unpreview', '--json', ID, '8080'])
  // Without an ID it takes the thread open in the pane.
  await nexus(`open ${ID}`)
  await nexus('unpublish 3001')
  expect(cli.spawns).toContainEqual(['unpreview', '--json', ID, '3001'])
  cli.fail.unpreview = { exitCode: 1, error: 'port 3000 is previewed by the service web, which unpreview does not close' }
  expect(await call(3000)).toMatchObject({ deny: 'nexus (failed): port 3000 is previewed by the service web, which unpreview does not close' })
  expect(await nexus('unpublish 3000')).toEqual({ text: 'Port 3000 is previewed by the service web, which unpreview does not close.' })
  cli.fail.unpreview = { exitCode: 64, error: 'unknown command unpreview' }
  const needs = 'nexus has no unpreview command: unpublishing a preview needs Nexus CLI 0.3.0 or later (nexus --version)'
  expect(await call(5173)).toMatchObject({ deny: `nexus (invalid): ${needs}` })
  expect(await nexus('unpublish 5173')).toEqual({ text: `N${needs.slice(1)}.` })
})

test('one operation at a time holds a port, whichever of the pane, /nexus or a tool started it; a second is refused, not queued', async ($, on) => {
  const cli = fake({ slow: { preview: 3_000, unpreview: 3_000 } })
  const { clock, nexus, mount } = await boot($, on, cli)
  const busy = `Port 5173 on ${ID} is already being published or unpublished. Try again when it finishes.`
  const unpublish = () => $.tool.call({ tool: 'mcp__nexus__unpublish', thread: ID, port: 5173 } as never)
  const publish = () => $.tool.call({ tool: 'mcp__nexus__preview', thread: ID, port: 5173 } as never)
  const ops = () => cli.spawns.filter(argv => argv[0] === 'preview' || argv[0] === 'unpreview')
  await nexus(`open ${ID}`)
  const ui = await mount()
  const keys = async (letters: string) => {
    for (const letter of letters) await ui.press({ key: `key-${letter}` })
  }
  await keys('ll')
  // A tool publishes: the pane's press on the same port is refused and says why.
  const opening = publish()
  await clock.advance(0)
  await ui.press({ key: 'port-5173' })
  expect(await ui.find({ type: 'Text', text: busy })).toBeDefined()
  expect(ops()).toHaveLength(1)
  await clock.advance(3_000)
  expect(JSON.parse(String((await opening).result))).toMatchObject({ port: 5173, url: OPENED.url })
  // The pane unpublishes: the tool and /nexus are refused until it ends.
  await clock.advance(5_000)
  await keys('ggjjx')
  expect(ops()).toHaveLength(2)
  expect(ops()[1]).toEqual(['unpreview', '--json', ID, '5173'])
  expect(await unpublish()).toMatchObject({ deny: busy })
  expect(await publish()).toMatchObject({ deny: busy })
  expect(await nexus('unpublish 5173')).toEqual({ text: busy })
  expect(ops()).toHaveLength(2)
  await clock.advance(3_000)
  // Once free, the port takes an operation again.
  const again = publish()
  await clock.advance(3_000)
  expect(JSON.parse(String((await again).result))).toMatchObject({ port: 5173 })
  expect(ops()).toHaveLength(3)
})

test('unpublish takes only the null docs/cli.md promises as done; any other answer is a CLI this mod does not know', async ($, on) => {
  const cli = fake({ printed: { unpreview: { closed: true } } })
  const { nexus } = await boot($, on, cli)
  const wrong = 'nexus unpreview printed {"closed":true} where docs/cli.md says null: the CLI and this mod disagree on the contract'
  expect(await $.tool.call({ tool: 'mcp__nexus__unpublish', thread: ID, port: 5173 } as never)).toMatchObject({ deny: `nexus (failed): ${wrong}` })
  expect(await nexus(`unpublish 5173 ${ID}`)).toEqual({ text: `N${wrong.slice(1)}.` })
})


test('project arguments allow only the fixed GitHub grant, and keep flag-like values out of options', () => {
  expect(projectArgs({ id: '--id', scratch: true, github: true, node: '--node', branch: '--branch', cpus: 3, memory_gib: 6, disk_gib: 20, allow_hosts: ['--secret=GH_TOKEN:evil.example'], logins: ['claude', 'chatgpt'] })).toEqual([
    'project', 'add', '--branch=--branch', '--node=--node', '--cpus=3', '--memory=6', '--disk=20', '--allow-host=--secret=GH_TOKEN:evil.example', '--login=claude', '--login=chatgpt', '--secret=GH_TOKEN:api.github.com,github.com', '--scratch', '--', '--id',
  ])
  expect(projectArgs({ id: ' repo ', repo_url: ' --secret=OTHER:evil.example ', scratch: false, github: false })).toEqual(['project', 'add', '--branch=main', '--', 'repo', '--secret=OTHER:evil.example'])
  for (const input of [{}, { repo_url: 'url', scratch: true }, { scratch: false }, { scratch: true, secret: 'GH_TOKEN:evil.example' }, { scratch: true, github: 'true' }, { scratch: true, logins: ['other'] }]) {
    expect(() => projectArgs({ id: 'test', ...input })).toThrow()
  }
})

test('projects lists raw JSON; adding returns the Project, refreshes the catalog without changing scope, and preserves refusals', async ($, on) => {
  const cli = fake({ store: { project: 'web' } })
  let catalog: unknown
  on('state.set', (_, e, next) => {
    if (e.key === 'catalog') catalog = e.value
    return next(e)
  })
  const { clock } = await boot($, on, cli)
  const call = (input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__nexus__project_add', ...input } as never)
  expect(await $.tool.call({ tool: 'mcp__nexus__projects' } as never)).toMatchObject({ result: JSON.stringify(cli.projects) })
  await clock.settle()
  const baseline = cli.runs.filter(args => args[0] === 'projects').length
  const added = await call({ id: ' docs ', repo_url: 'git@example.com:docs.git' })
  expect(added).toMatchObject({ result: JSON.stringify(cli.projects.at(-1)) })
  expect(cli.spawns).toContainEqual(['project', 'add', '--json', '--node=firebat', '--branch=main', '--', 'docs', 'git@example.com:docs.git'])
  await clock.settle()
  expect(cli.runs.filter(args => args[0] === 'projects').length).toBe(baseline + 1)
  expect(cli.isOpen).toBe(false)
  expect(catalog).toMatchObject({ projects: (cli.projects as (typeof PROJECTS)[number][]).map(({ id, repoUrl, defaultBranch, defaultNode }) => ({ id, repoUrl, defaultBranch, defaultNode })) })
  expect(cli.store.project).toBe('web')
  cli.fail.project = { exitCode: 5, error: 'Project docs already exists' }
  expect(await call({ id: 'docs', scratch: true, node: 'offline' })).toMatchObject({ deny: 'nexus (conflict): Project docs already exists' })
})

test('project tools reject malformed contracts, skip unknown node states, and explain an old CLI', async ($, on) => {
  const cli = fake()
  await boot($, on, cli)
  const add = (input: Record<string, unknown> = {}) => $.tool.call({ tool: 'mcp__nexus__project_add', id: 'scratch', scratch: true, ...input } as never)
  for (const json of [null, {}, [null], [{ id: 'missing-fields' }]]) {
    cli.printed.projects = json
    expect(await $.tool.call({ tool: 'mcp__nexus__projects' } as never)).toMatchObject({ deny: expect.stringContaining('contract') })
  }
  for (const json of [null, {}, { id: 'missing-fields' }]) {
    cli.printed.project = json
    expect(await add({ node: 'chosen' })).toMatchObject({ deny: expect.stringContaining('contract') })
  }
  const project = { id: 'scratch', repoUrl: null, defaultNode: 'online', defaultBranch: 'main', extra: { kept: true } }
  cli.printed.projects = [project]
  expect(await $.tool.call({ tool: 'mcp__nexus__projects' } as never)).toMatchObject({ result: JSON.stringify([project]) })
  cli.printed.project = project
  cli.printed.nodes = [{ name: 'unknown', state: 'unknown' }, { name: 'offline', state: 'offline' }, { name: 'online', state: 'online' }]
  expect(await add()).toMatchObject({ result: JSON.stringify(project) })
  expect(cli.spawns.at(-1)).toEqual(['project', 'add', '--json', '--node=online', '--branch=main', '--scratch', '--', 'scratch'])
  cli.printed.nodes = [{ name: 'unknown', state: 'unknown' }]
  expect(await add()).toMatchObject({ deny: 'nexus (failed): no online node is available; provide node explicitly' })
  cli.fail.project = { exitCode: 64, error: 'unknown command project' }
  expect(await add({ node: 'chosen' })).toMatchObject({ deny: 'nexus (invalid): nexus has no project add command: adding a project needs Nexus CLI 0.7.0 or later (nexus --version). Update the nexus CLI.' })
})

function projectHandler(tool = 'mcp__nexus__project_add') {
  let handler: (engine: unknown, input: Record<string, unknown>, next: { signal: AbortSignal }) => Promise<unknown> = async () => { throw new Error(`${tool} was not registered`) }
  register(((event: string, matcher: unknown, run: typeof handler) => {
    if (event === 'tool.call' && (matcher as { tool: string }).tool === tool) handler = run
    return { catch() {} }
  }) as never, {})
  return handler
}

test('cancelling before or during the node lookup never adds; cancelling an add stops its child', async () => {
  // The kit's $.tool.call has no abort option; give the registered handler a real signal at its process boundary.
  const handler = projectHandler()
  for (const phase of ['before', 'nodes', 'project']) {
    const controller = new AbortController()
    const started: string[][] = []
    let stopped = 0
    let entered = () => {}
    const waiting = new Promise<void>(resolve => { entered = resolve })
    const engine = {
      clock: { after: () => ({ cancel() {} }) },
      process: { spawn: ({ argv }: { argv: string[] }) => {
        started.push(argv)
        entered()
        return { next: () => new Promise(() => {}), return: async () => { stopped++; return { done: true } } }
      } },
    }
    if (phase === 'before') controller.abort()
    const call = handler(engine, { id: 'scratch', scratch: true, ...(phase === 'project' ? { node: 'chosen' } : {}) }, { signal: controller.signal })
    if (phase !== 'before') {
      await waiting
      controller.abort()
    }
    expect(await call).toEqual({ deny: 'nexus (failed): cancelled' })
    expect(started.map(argv => argv[1])).toEqual(phase === 'before' ? [] : [phase])
    expect(stopped).toBe(phase === 'before' ? 0 : 1)
  }
})

test('project_add strips the engine metadata for agent calls but still rejects unknown model parameters', async () => {
  // $.tool.call starts in the main loop and drops agentId; exercise the received event instead.
  const handler = projectHandler()
  const started: string[][] = []
  const engine = {
    clock: { after: () => ({ cancel() {} }) },
    process: { spawn: ({ argv }: { argv: string[] }) => {
      started.push(argv)
      return (async function* () {
        yield { stream: 'stderr', text: JSON.stringify({ error: 'Project docs already exists' }) }
        return { code: 5, signal: null }
      })()
    } },
  }
  const next = { signal: new AbortController().signal }
  for (const agentId of ['subagent-1', 'teammate-1']) {
    const event = {
      tool: 'mcp__nexus__project_add', tool_use_id: 'call-1', agentId,
      consent: 'The user pressed Yes', requestMeta: { 'anthropic/sources': '[]' },
      id: 'docs', repo_url: 'git@example.com:docs.git', node: 'chosen',
    }
    expect(await handler(engine, event, next)).toEqual({ deny: 'nexus (conflict): Project docs already exists' })
    expect(started.at(-1)).toEqual(['nexus', 'project', 'add', '--json', '--branch=main', '--node=chosen', '--', 'docs', 'git@example.com:docs.git'])
    const baseline = started.length
    for (const key of ['secret', 'secret_hosts', 'unexpected']) {
      expect(await handler(engine, { ...event, [key]: 'untrusted' }, next)).toEqual({ deny: `nexus (failed): Unknown project_add parameter: ${key}` })
    }
    expect(started).toHaveLength(baseline)
  }
})

test("read and wait on a Claude Code worker read its transcript, which no watch streams; wait settles once the turn it saw run ends", async ($, on) => {
  const turn = CONVERSATION.entries.slice(0, 6)
  const cli = fake({ threads: [WORKER], detail: WORKER_DETAIL, conversation: { ...CONVERSATION, working: true } })
  const { clock } = await boot($, on, cli)
  const call = async (tool: string, args: Record<string, unknown>) => JSON.parse(String((await $.tool.call({ tool: `mcp__nexus__${tool}`, thread: WORKER.id, ...args } as never)).result)) as Record<string, unknown>
  const read = await call('read', {})
  expect(read).toMatchObject({ thread: WORKER.id, run: 'working', queued: 1, worker: { state: 'started', model: 'claude-opus-5-5' } })
  expect(read.conversation).toContain('> /poteto-mode add a health check')
  expect(read.conversation).toContain('Bash(npm test)\nFAIL server.test.ts')
  expect(cli.spawns.some(argv => argv[0] === 'watch')).toBe(false)
  cli.conversation = { ...CONVERSATION, entries: turn, working: true }
  const waiting = call('wait', { timeout_seconds: 60 })
  await clock.advance(2_000)
  cli.conversation = { ...CONVERSATION, entries: [...turn, { kind: 'reply', at: T0, text: 'Done.' }], working: false }
  await clock.advance(2_000)
  expect(await waiting).toMatchObject({ settled: true, run: 'idle', queued: 0, reply: 'Adding `/healthz`.\n\nDone.' })
})

test('wait on an idle worker settles only when a second reading agrees, since a message just typed may not show in its transcript yet', async ($, on) => {
  const cli = fake({ threads: [WORKER], detail: WORKER_DETAIL, conversation: { ...CONVERSATION, entries: CONVERSATION.entries.slice(0, 2), working: false } })
  const { clock } = await boot($, on, cli)
  const reads = () => cli.spawns.filter(argv => argv[0] === 'conversation').length
  const waiting = $.tool.call({ tool: 'mcp__nexus__wait', thread: WORKER.id, timeout_seconds: 60 } as never)
  await clock.settle()
  expect(reads()).toBe(1)
  await clock.advance(2_000)
  expect(JSON.parse(String((await waiting).result))).toMatchObject({ settled: true, run: 'idle', reply: 'Adding `/healthz`.' })
  expect(reads()).toBe(2)
})

test('wait on a worker reads on through a failed reading, as a watch outlives an outage, and says so while it lasts', async ($, on) => {
  const turn = CONVERSATION.entries.slice(0, 6)
  const cli = fake({ threads: [WORKER], detail: WORKER_DETAIL, conversation: { ...CONVERSATION, entries: turn, working: true } })
  const { clock } = await boot($, on, cli)
  const waiting = $.tool.call({ tool: 'mcp__nexus__wait', thread: WORKER.id, timeout_seconds: 60 } as never)
  await clock.settle()
  cli.fail = { conversation: { exitCode: 2, error: 'connect ECONNREFUSED' } }
  await clock.advance(2_000)
  cli.fail = {}
  cli.conversation = { ...CONVERSATION, entries: [...turn, { kind: 'reply', at: T0, text: 'Done.' }], working: false }
  await clock.advance(2_000)
  expect(JSON.parse(String((await waiting).result))).toMatchObject({ settled: true, run: 'idle' })
})

test('wait on an idle worker whose transcript ends at a prompt it never answered settles after the second reading, its reply null', async ($, on) => {
  const cli = fake({ threads: [WORKER], detail: WORKER_DETAIL, conversation: { ...CONVERSATION, entries: [...CONVERSATION.entries.slice(0, 2), { kind: 'prompt', at: T0, text: 'and then?', from: 'person' }], working: false } })
  const { clock } = await boot($, on, cli)
  const waiting = $.tool.call({ tool: 'mcp__nexus__wait', thread: WORKER.id, timeout_seconds: 60 } as never)
  await clock.settle()
  await clock.advance(2_000)
  expect(JSON.parse(String((await waiting).result))).toMatchObject({ settled: true, run: 'idle', reply: null })
})

test('a deadline too near for the second reading ends the wait unsettled, never taking the last answer as the reply to a new message', async ($, on) => {
  const cli = fake({ threads: [WORKER], detail: WORKER_DETAIL, conversation: { ...CONVERSATION, entries: CONVERSATION.entries.slice(0, 2), working: false } })
  const { clock } = await boot($, on, cli)
  const waiting = $.tool.call({ tool: 'mcp__nexus__wait', thread: WORKER.id, timeout_seconds: 1 } as never)
  await clock.advance(1_000)
  const waited = JSON.parse(String((await waiting).result))
  expect(waited).toMatchObject({ settled: false, timed_out: true })
  expect(cli.spawns.filter(argv => argv[0] === 'conversation')).toHaveLength(1)
})

const waitResult = async (call: Promise<unknown>) => JSON.parse(String(((await call) as { result: string }).result)) as Record<string, unknown>

test('wait on a worker still launching waits for a first turn, and a stalled launch ends the wait with its diagnostic', async ($, on) => {
  const launching = { ...WORKER_DETAIL, claudeWorker: { model: 'claude-opus-5-5', state: 'starting' } }
  const cli = fake({ threads: [WORKER], detail: launching, conversation: { ...CONVERSATION, entries: [], working: false, readAt: null } })
  const { clock } = await boot($, on, cli)
  let isDone = false
  const waiting = $.tool.call({ tool: 'mcp__nexus__wait', thread: WORKER.id, timeout_seconds: 60 } as never).then(got => ((isDone = true), got))
  await clock.advance(6_000)
  expect(isDone).toBe(false)
  // Started, but no turn in the transcript yet: still idle for want of one.
  cli.detail = WORKER_DETAIL
  await clock.advance(4_000)
  expect(isDone).toBe(false)
  cli.conversation = { ...CONVERSATION, entries: CONVERSATION.entries.slice(0, 2), working: false }
  await clock.advance(4_000)
  expect(await waitResult(waiting)).toMatchObject({ settled: true, run: 'idle', worker: { state: 'started' }, reply: 'Adding `/healthz`.' })
  cli.detail = { ...WORKER_DETAIL, claudeWorker: { model: 'claude-opus-5-5', state: 'stalled', message: 'pane line 20' } }
  cli.conversation = { ...CONVERSATION, entries: [], working: false, readAt: null }
  const reads = cli.spawns.length
  expect(await waitResult($.tool.call({ tool: 'mcp__nexus__wait', thread: WORKER.id, timeout_seconds: 60 } as never))).toMatchObject({ settled: true, worker: { state: 'stalled', message: 'pane line 20' }, reply: null })
  expect(cli.spawns.slice(reads).map(argv => argv[0])).toEqual(['show', 'conversation'])
})

test('a reading that outlasts the deadline ends the wait timed out with the last state, and the first reading counts inside it', async ($, on) => {
  const cli = fake({ threads: [WORKER], detail: WORKER_DETAIL, conversation: { ...CONVERSATION, working: true } })
  const { clock } = await boot($, on, cli)
  let isDone = false
  const waiting = $.tool.call({ tool: 'mcp__nexus__wait', thread: WORKER.id, timeout_seconds: 5 } as never).then(got => ((isDone = true), got))
  await clock.settle()
  cli.slow = { conversation: 30_000 }
  await clock.advance(4_900)
  expect(isDone).toBe(false)
  await clock.advance(100)
  expect(await waitResult(waiting)).toMatchObject({ thread: WORKER.id, settled: false, timed_out: true, run: 'working', worker: { state: 'started' } })
  cli.slow = { show: 4_000 }
  const late = $.tool.call({ tool: 'mcp__nexus__wait', thread: WORKER.id, timeout_seconds: 5 } as never)
  await clock.advance(4_000)
  expect(await waitResult(late)).toMatchObject({ settled: false, timed_out: true, run: 'working' })
})

test('cancelling a wait on a worker, asleep or mid-reading, returns it unsettled with the last state and reply', async () => {
  // The kit's $.tool.call has no abort option; give the registered handler a real signal at its process boundary.
  const handler = projectHandler('mcp__nexus__wait')
  const idle = { ...CONVERSATION, entries: CONVERSATION.entries.slice(0, 2), working: false }
  for (const phase of ['asleep', 'reading']) {
    const controller = new AbortController()
    let spawned = 0
    let reading = () => {}
    const third = new Promise<void>(resolve => { reading = resolve })
    const engine = {
      clock: {
        now: async () => T0,
        // Only the wait between readings ends, and only when the cancel is to come during the next reading.
        after: (ms: number, fire: () => void) => (phase === 'reading' && ms === 2_000 && void Promise.resolve().then(fire), { cancel() {} }),
      },
      process: { spawn: ({ argv }: { argv: string[] }) => {
        spawned++
        if (spawned > 2) {
          reading()
          return { next: () => new Promise(() => {}), return: async () => ({ done: true }) }
        }
        return (async function* () {
          yield { stream: 'stdout' as const, text: JSON.stringify(argv[1] === 'show' ? WORKER_DETAIL : idle) }
          return { code: 0, signal: null }
        })()
      } },
    }
    const call = handler(engine, { thread: WORKER.id, timeout_seconds: 60 }, { signal: controller.signal })
    if (phase === 'reading') await third
    else for (let tick = 0; tick < 200; tick++) await Promise.resolve()
    controller.abort()
    const got = JSON.parse(String(((await call) as { result: string }).result))
    expect(got).toMatchObject({ thread: WORKER.id, settled: false, cancelled: true, status: 'active', run: 'idle', worker: { state: 'started' }, reply: 'Adding `/healthz`.' })
    expect(got.timed_out).toBeUndefined()
  }
})

test("read and wait on a worker use the CLI's whole transcript window, not the rows the pane keeps", async ($, on) => {
  const notices = Array.from({ length: 401 }, (_, at) => ({ kind: 'notice', at: T0 - 50_000 + at, tone: 'info', text: `n${at}` }))
  const entries = [CONVERSATION.entries[0], ...notices, { kind: 'reply', at: T0, text: 'All done.' }]
  const cli = fake({ threads: [WORKER], detail: WORKER_DETAIL, conversation: { ...CONVERSATION, entries, working: false } })
  const { clock } = await boot($, on, cli)
  const read = await waitResult($.tool.call({ tool: 'mcp__nexus__read', thread: WORKER.id } as never))
  expect(read.conversation).toMatch(/^> \/poteto-mode add a health check\n\nn0\n/)
  const waiting = $.tool.call({ tool: 'mcp__nexus__wait', thread: WORKER.id, timeout_seconds: 60 } as never)
  await clock.advance(2_000)
  expect(await waitResult(waiting)).toMatchObject({ settled: true, reply: 'All done.' })
})

test('start begins a Claude Code worker with its model on the node asked for, and names the CLI an old one needs', async ($, on) => {
  const cli = fake()
  await boot($, on, cli)
  const start = (input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__nexus__start', project: 'web', ...input } as never)
  const started = (await start({ message: 'add a health check', claude: true, model: 'claude-sonnet-5-5', node: 'testbench' })) as { result: string }
  expect(JSON.parse(started.result)).toEqual({ id: 'th-123456789abc', project: 'web', title: 'New one' })
  expect(cli.runs.filter(argv => argv[0] === 'start')).toEqual([['start', '--json', '--project=web', '--claude=add a health check', '--model=claude-sonnet-5-5', '--node=testbench']])
  await start({ message: 'fix the login form', title: 'Login' })
  expect(cli.runs.filter(argv => argv[0] === 'start').at(-1)).toEqual(['start', '--json', '--project=web', '--title=Login', '--message=fix the login form'])
  expect(await start({ message: 'fix it', model: 'claude-sonnet-5-5' })).toEqual({ deny: 'model needs claude: true' })
  cli.version = '0.14.0'
  cli.fail.start = { exitCode: 64, error: "Unknown option '--claude'" }
  expect(await start({ message: 'add a health check', claude: true })).toEqual({ deny: 'nexus (invalid): nexus is 0.14.0: starting a Claude Code worker needs Nexus CLI 0.15.0 or later (nexus --version)' })
})
