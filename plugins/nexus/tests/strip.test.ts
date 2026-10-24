import { expect, test } from 'claude-code/testing'

import { ID, T0, THREAD, THREADS, boot, fake, state } from './fake-cli'

const FAILED = { ...THREAD, id: 'th-f00000000004', title: 'Broken setup', agentTurnRunning: false, lastAgentActivityAt: T0 - 600_000, pylon: { node: 'firebat', actualState: 'failed', failed: 'git clone exited 128' } }
const REPLIED = { ...THREAD, id: 'th-e00000000005', title: 'Docs pass', agentTurnRunning: false, lastAgentActivityAt: T0 - 1_000, lastActivityAt: T0 - 1_000, pylon: { node: 'firebat', actualState: 'running', failed: null } }
/** The strip as stored a minute before T0: a reply since then is news. */
const STORE = { themeNotice: true, strip: { isOn: true, seen: {}, since: T0 - 60_000 } }

const chips = async (ui: Awaited<ReturnType<Awaited<ReturnType<typeof boot>>['strip']>>) => (await ui.findAll({ type: 'Button' })).map(one => [one.key, one.text.trim()])
const threadPolls = (runs: string[][]) => runs.filter(argv => argv[0] === 'threads').length

test('the strip shows a chip per thread that wants a look, most urgent first, and none for a quiet one', async ($, on) => {
  const cli = fake({ threads: [...THREADS, FAILED, REPLIED], store: STORE })
  const { clock, strip } = await boot($, on, cli)
  await clock.settle()
  const ui = await strip()
  expect(await chips(ui)).toEqual([
    [FAILED.id, '✕ Broken setup  needs you'],
    [REPLIED.id, '● Docs pass  new reply'],
    [ID, '◉ Fix login form 500s  working 2 min'],
  ])
  expect(await ui.find({ type: 'Text', text: '◆ Nexus' })).toBeDefined()
  // The archived thread and the idle one with nothing new are not there, and the strip paints no band of its own.
  expect((await ui.findAll({})).some(one => typeof one.props.backgroundColor === 'string')).toBe(false)
})

test('a narrow strip keeps the chips that fit and counts the rest', async ($, on) => {
  const cli = fake({ threads: [...THREADS, FAILED, REPLIED], store: STORE })
  const { clock, strip } = await boot($, on, cli)
  await clock.settle()
  const ui = await strip(60)
  expect((await chips(ui)).map(([key]) => key)).toEqual([FAILED.id])
  expect(await ui.find({ type: 'Text', text: '+2' })).toBeDefined()
})

test('pressing a chip opens its thread in the pane, and a reply seen there is no longer news', async ($, on) => {
  const cli = fake({ threads: [...THREADS, REPLIED], store: STORE })
  cli.watch = [state('idle')]
  const { clock, strip, mount } = await boot($, on, cli)
  await clock.settle()
  const ui = await strip()
  await ui.press({ key: REPLIED.id })
  expect(cli.isOpen).toBe(true)
  expect(cli.spawns).toContainEqual(['watch', REPLIED.id, '--json'])
  expect(await (await mount()).find({ type: 'Text', text: REPLIED.id })).toBeDefined()
  expect((await chips(ui)).map(([key]) => key)).toEqual([ID])
})

test('the strip polls the list every 10 s on its own, not while the pane polls it, and /nexus strip off stops it', async ($, on) => {
  const cli = fake({ threads: THREADS.map(thread => ({ ...thread, agentTurnRunning: false })), store: STORE })
  // Off, the band is the engine's own drawing, which the test stands for.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Text({ children: ['the prompt as it was'] } as never))
  const { clock, nexus, strip } = await boot($, on, cli)
  await clock.settle()
  const first = threadPolls(cli.runs)
  expect(first).toBe(1)
  await clock.advance(10_000)
  expect(threadPolls(cli.runs)).toBe(2)
  // The pane shows the list and polls it itself: the strip does not poll too.
  await nexus('')
  await clock.advance(20_000)
  expect(threadPolls(cli.runs)).toBe(2)
  expect(cli.spawns.filter(argv => argv[0] === 'threads').length).toBeGreaterThan(1)
  await nexus('close')
  expect(await nexus('strip off')).toMatchObject({ text: 'The Nexus strip above the prompt is off. /nexus strip on shows it again.' })
  await clock.advance(30_000)
  expect(threadPolls(cli.runs)).toBe(2)
  const ui = await strip()
  expect(await ui.find({ type: 'Text', text: '◆ Nexus' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'the prompt as it was' })).toBeDefined()
  await nexus('strip on')
  expect(threadPolls(cli.runs)).toBe(3)
})

test('an unreachable Nexus says so on the strip rather than showing nothing', async ($, on) => {
  const cli = fake({ fail: { threads: { exitCode: 2, error: 'connect ECONNREFUSED' } }, store: STORE })
  const { clock, strip } = await boot($, on, cli)
  await clock.settle()
  const ui = await strip()
  expect(await ui.find({ type: 'Text', text: '◆ Nexus  unreachable: connect ECONNREFUSED' })).toBeDefined()
})

test("a strip poll that ends after the pane's newer one writes nothing", async ($, on) => {
  const IDLE = THREADS.map(thread => ({ ...thread, agentTurnRunning: false }))
  const NEW = { ...IDLE[0]!, id: 'th-d00000000006', title: 'Fresh one' }
  const cli = fake({ threads: IDLE, slow: { threads: 3_000 }, store: STORE })
  const { clock, nexus, mount } = await boot($, on, cli)
  // The strip's first poll is in flight; the pane opens on the list and reads a newer one at once.
  cli.slow = {}
  cli.threads = [...IDLE, NEW]
  await nexus('')
  const ui = await mount()
  expect(await ui.find({ type: 'Button', key: NEW.id })).toBeDefined()
  // The strip's poll answers the older list after the pane's.
  cli.threads = IDLE
  await clock.advance(3_000)
  expect(await ui.find({ type: 'Button', key: NEW.id })).toBeDefined()
})

test("a project's name in a narrow strip shortens the first chip's title rather than hide every chip", async ($, on) => {
  const cli = fake({ threads: [...THREADS, FAILED, REPLIED], store: { ...STORE, project: 'web' } })
  const { clock, strip } = await boot($, on, cli)
  await clock.settle()
  const ui = await strip(44)
  expect(await ui.find({ type: 'Text', text: '◆ Nexus · web' })).toBeDefined()
  expect(await chips(ui)).toEqual([[FAILED.id, '✕ Broken s…  needs you']])
  expect(await ui.find({ type: 'Text', text: '+2' })).toBeDefined()
})
