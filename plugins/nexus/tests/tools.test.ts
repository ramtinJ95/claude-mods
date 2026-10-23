import { expect, mock, test, type TestBody } from 'claude-code/testing'

import { boot, fake, OPENED } from './fake-cli'

const ID = 'th-4f2a00000001'
const healthy = { type: 'state', thread: ID, status: 'active', run: 'idle', parkedTasks: 0, queued: 0, pylon: 'running', failed: null, ports: [] }
const asked = { type: 'reset', thread: ID, entries: [{ entry: { id: 1, model: [{ role: 'user', content: 'go' }] }, text: '> go' }] }
const reply = (id: number, text: string) => ({ type: 'entry', thread: ID, entry: { id, model: [{ role: 'assistant', content: [{ type: 'text', text }] }] }, text })
const said = reply(2, 'Done.')

/** The mod's `wait` and `read` tools over a watch that prints the given events and then holds, as a live watch does. */
async function tools(...[$, on]: Parameters<TestBody>) {
  const clock = mock.clock(on)
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
