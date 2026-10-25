import { expect, mock, test, type TestBody } from 'claude-code/testing'

import { projectArgs } from '../hooks/tools'
import { register } from '../hooks/register'

import { boot, fake, OPENED } from './fake-cli'

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
  on('process.spawn', async function* () {
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
  expect(catalog).toMatchObject({ projects: cli.projects.map(({ id, repoUrl, defaultBranch, defaultNode }) => ({ id, repoUrl, defaultBranch, defaultNode })) })
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

test('cancelling before or during the node lookup never adds; cancelling an add stops its child', async () => {
  // The kit's $.tool.call has no abort option; give the registered handler a real signal at its process boundary.
  let handler: (engine: unknown, input: Record<string, unknown>, next: { signal: AbortSignal }) => Promise<unknown> = async () => { throw new Error('project_add was not registered') }
  register(((event: string, matcher: unknown, run: typeof handler) => {
    if (event === 'tool.call' && (matcher as { tool: string }).tool === 'mcp__nexus__project_add') handler = run
    return { catch() {} }
  }) as never, {})
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
