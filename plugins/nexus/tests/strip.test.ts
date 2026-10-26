import { expect, test } from 'claude-code/testing'

import { DETAIL, ENTRIES, ID, T0, THREAD, THREADS, boot, fake, state } from './fake-cli'

const FAILED = { ...THREAD, id: 'th-f00000000004', title: 'Broken setup', agentTurnRunning: false, lastAgentActivityAt: T0 - 600_000, pylon: { node: 'firebat', actualState: 'failed', failed: 'git clone exited 128' }, attention: 'failed' }
const REPLIED = { ...THREAD, id: 'th-e00000000005', title: 'Docs pass', agentTurnRunning: false, lastAgentActivityAt: T0 - 1_000, lastReplyAt: T0 - 1_000, seenAt: T0 - 60_000, pylon: { node: 'firebat', actualState: 'running', failed: null }, attention: 'reply' }
const PARKED = { ...THREAD, id: 'th-a00000000007', title: 'Flaky deploy', agentTurnRunning: false, lastAgentActivityAt: T0 - 120_000, attention: 'parked' }
const WAITING = { ...THREAD, id: 'th-b00000000008', title: 'Asks a question', agentTurnRunning: false, lastAgentActivityAt: T0 - 30_000, attention: 'waiting' }
const DECIDING = { ...THREAD, id: 'th-d00000000006', title: 'Land the fix', agentTurnRunning: false, lastAgentActivityAt: T0 - 300_000, attention: 'decision' }
const STORE = { themeNotice: true, strip: { isOn: true } }

const chips = async (ui: Awaited<ReturnType<Awaited<ReturnType<typeof boot>>['strip']>>) => (await ui.findAll({ type: 'Button' })).map(one => [one.key, one.text.trim()])
const threadPolls = (runs: string[][]) => runs.filter(argv => argv[0] === 'threads').length

test("the strip shows a chip per thread whose attention asks for a look, in the control plane's order, and none for a quiet one", async ($, on) => {
  const cli = fake({ threads: [...THREADS, WAITING, REPLIED, PARKED, DECIDING, FAILED], store: STORE })
  const { clock, strip } = await boot($, on, cli)
  await clock.settle()
  const ui = await strip(300)
  expect(await chips(ui)).toEqual([
    [FAILED.id, '✕ Broken setup  needs you'],
    [DECIDING.id, '! Land the fix  needs you'],
    [PARKED.id, '✕ Flaky deploy  needs you'],
    [REPLIED.id, '● Docs pass  new reply'],
    [ID, '◉ Fix login form 500s  working 2 min'],
    [WAITING.id, '◇ Asks a question  waiting for you'],
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

test('pressing a chip opens its thread in the pane, which marks the reply seen on the control plane, and it is no longer news', async ($, on) => {
  const cli = fake({ threads: [...THREADS, REPLIED], detail: { ...DETAIL, thread: REPLIED, attention: 'reply', seenAt: REPLIED.seenAt, lastReplyAt: REPLIED.lastReplyAt }, store: STORE })
  cli.watch = [{ type: 'reset', thread: ID, entries: ENTRIES.slice(0, -1) }, state('idle')]
  const { clock, strip, mount } = await boot($, on, cli)
  await clock.settle()
  const ui = await strip()
  await ui.press({ key: REPLIED.id })
  // The first poll reads the details before the watch has drawn the conversation; the next one marks.
  await clock.advance(5_000)
  expect(cli.isOpen).toBe(true)
  expect(cli.spawns).toContainEqual(['watch', REPLIED.id, '--json'])
  expect(await (await mount()).find({ type: 'Text', text: REPLIED.id })).toBeDefined()
  expect(cli.runs.filter(argv => argv[0] === 'seen')).toEqual([['seen', '--json', REPLIED.id]])
  // The details read after the mark drop the reply from the strip before the strip's own poll.
  expect(threadPolls(cli.runs)).toBe(1)
  expect((await chips(ui)).map(([key]) => key)).toEqual([ID])
  // Nothing is kept of it on this machine: the store holds only whether the strip shows.
  expect(cli.store.strip).toEqual({ isOn: true })
})

test('a strip kept by an earlier version drops what the person saw, which the control plane keeps now', async ($, on) => {
  const cli = fake({ store: { themeNotice: true, strip: { isOn: false, seen: { [ID]: T0 - 5_000 }, since: T0 - 60_000 } } })
  const { clock } = await boot($, on, cli)
  await clock.settle()
  expect(cli.store.strip).toEqual({ isOn: false })
  expect(threadPolls(cli.runs)).toBe(0)
})

test('a CLI before 0.10.0, whose threads carry no attention, is named with the version the strip needs', async ($, on) => {
  const old = THREADS.map(({ attention: _, seenAt: __, lastReplyAt: ___, ...thread }) => thread)
  const cli = fake({ threads: old, version: '0.9.0', store: STORE })
  const { clock, strip } = await boot($, on, cli)
  await clock.settle()
  const ui = await strip(300)
  expect(await ui.find({ type: 'Text', text: '◆ Nexus  failed: nexus is 0.9.0: reading threads with their unread replies needs Nexus CLI 0.10.0 or later (nexus --version)' })).toBeDefined()
  expect(await chips(ui)).toEqual([])
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

test('the list marks an unread reply and counts it; going back from its thread marks it seen before the list is read again', async ($, on) => {
  const quiet = THREADS.map(thread => ({ ...thread, agentTurnRunning: false, attention: null }))
  const cli = fake({ threads: [...quiet, REPLIED], store: STORE })
  cli.watch = [{ type: 'reset', thread: ID, entries: ENTRIES.slice(0, -1) }, state('idle')]
  const { clock, nexus, mount } = await boot($, on, cli)
  await nexus('')
  const ui = await mount()
  expect((await ui.find({ type: 'Button', key: REPLIED.id }))?.text).toMatch(/Docs pass\s+ new reply/)
  expect((await ui.find({ type: 'Text', text: /^◆ Nexus threads/ }))?.text).toMatch(/1 new · 0 working · 3 open/)
  // The details of the thread opened were marked seen by another client already: the pane marks nothing on opening it.
  cli.detail = { ...DETAIL, thread: { ...REPLIED, seenAt: REPLIED.lastReplyAt, attention: null }, attention: null, seenAt: REPLIED.lastReplyAt, lastReplyAt: REPLIED.lastReplyAt }
  await nexus('open e000')
  await clock.advance(5_000)
  expect(cli.runs.filter(argv => argv[0] === 'seen')).toEqual([])
  // Another client marks the reply unread while the person reads it here: leaving marks the reply the pane showed.
  cli.detail = { ...DETAIL, thread: REPLIED, attention: 'reply', seenAt: REPLIED.seenAt, lastReplyAt: REPLIED.lastReplyAt }
  await ui.press({ key: 'key-h' })
  await clock.settle()
  expect(cli.runs.filter(argv => argv[0] === 'seen')).toEqual([['seen', '--json', REPLIED.id]])
  const marked = cli.runs.findIndex(argv => argv[0] === 'seen')
  expect(cli.spawns.at(-1)).toEqual(['threads', '--json', '--all'])
  expect(cli.runs.slice(marked).some(argv => argv[0] === 'threads')).toBe(false)
  expect((await ui.find({ type: 'Button', key: REPLIED.id }))?.text).toMatch(/Docs pass\s+ running/)
})

test('a mark the control plane refuses says so in the pane, and the reply stays new', async ($, on) => {
  const cli = fake({ threads: [...THREADS, REPLIED], detail: { ...DETAIL, thread: REPLIED, attention: 'reply', seenAt: REPLIED.seenAt, lastReplyAt: REPLIED.lastReplyAt }, fail: { seen: { exitCode: 2, error: 'connect ECONNREFUSED' } }, store: STORE })
  cli.watch = [{ type: 'reset', thread: ID, entries: ENTRIES.slice(0, -1) }, state('idle')]
  const { clock, nexus, mount, strip } = await boot($, on, cli)
  await nexus('open e000')
  await clock.advance(5_000)
  const ui = await mount()
  expect(await ui.find({ type: 'Text', text: `The reply in ${REPLIED.id} was not marked seen, so it still shows as new: connect ECONNREFUSED.` })).toBeDefined()
  expect((await chips(await strip())).map(([key]) => key)).toContain(REPLIED.id)
  // The polls after it leave that reply alone rather than ask again every five seconds.
  await clock.advance(15_000)
  expect(cli.runs.filter(argv => argv[0] === 'seen')).toHaveLength(1)
})

test('a reply is not marked seen before the watch has drawn the conversation, nor while another tab is shown', async ($, on) => {
  const unread = { ...DETAIL, thread: REPLIED, attention: 'reply', seenAt: REPLIED.seenAt, lastReplyAt: REPLIED.lastReplyAt }
  const cli = fake({ threads: [...THREADS, REPLIED], detail: unread, store: STORE })
  cli.watch = [{ delay: 60_000 }, { type: 'reset', thread: ID, entries: ENTRIES.slice(0, -1) }, state('idle')]
  const { clock, nexus, mount } = await boot($, on, cli)
  await nexus('open e000')
  await clock.advance(30_000)
  expect(cli.runs.filter(argv => argv[0] === 'seen')).toEqual([])
  const ui = await mount()
  await ui.press({ key: 'tab-changes' })
  await clock.advance(40_000)
  expect(cli.runs.filter(argv => argv[0] === 'seen')).toEqual([])
  await ui.press({ key: 'tab-conversation' })
  await clock.advance(5_000)
  expect(cli.runs.filter(argv => argv[0] === 'seen')).toEqual([['seen', '--json', REPLIED.id]])
})

test("an earlier answer on screen marks nothing while the watch has the run working: the details' newer reply has not arrived", async ($, on) => {
  const unread = { ...DETAIL, thread: REPLIED, attention: 'reply', seenAt: REPLIED.seenAt, lastReplyAt: REPLIED.lastReplyAt }
  const answer = { type: 'entry', thread: ID, entry: { id: 12, model: [{ role: 'assistant', content: [{ type: 'text', text: 'All green now.' }] }] }, text: 'All green now.' }
  const cli = fake({ threads: [...THREADS, REPLIED], detail: unread, store: STORE })
  cli.watch = [{ type: 'reset', thread: ID, entries: ENTRIES.slice(0, -1) }, state('working'), { delay: 20_000 }, answer, state('idle')]
  const { clock, nexus } = await boot($, on, cli)
  await nexus('open e000')
  await clock.advance(15_000)
  expect(cli.runs.filter(argv => argv[0] === 'seen')).toEqual([])
  await clock.advance(10_000)
  expect(cli.runs.filter(argv => argv[0] === 'seen')).toEqual([['seen', '--json', REPLIED.id]])
})

test('leaving a thread marks nothing once a newer reply than the one shown has come', async ($, on) => {
  const read = { ...DETAIL, thread: { ...REPLIED, seenAt: REPLIED.lastReplyAt }, attention: null, seenAt: REPLIED.lastReplyAt, lastReplyAt: REPLIED.lastReplyAt }
  const cli = fake({ threads: [...THREADS, REPLIED], detail: read, store: STORE })
  cli.watch = [{ type: 'reset', thread: ID, entries: ENTRIES.slice(0, -1) }, state('idle')]
  const { clock, nexus, mount } = await boot($, on, cli)
  await nexus('open e000')
  await clock.advance(5_000)
  const ui = await mount()
  const newer = { ...REPLIED, lastReplyAt: T0 + 4_000 }
  cli.detail = { ...DETAIL, thread: newer, attention: 'reply', seenAt: newer.seenAt, lastReplyAt: newer.lastReplyAt }
  await ui.press({ key: 'key-h' })
  await clock.settle()
  expect(cli.runs.filter(argv => argv[0] === 'seen')).toEqual([])
})

test("a review that ended for the person reads needs you in the list, and Pylon lists the review's reasons", async ($, on) => {
  const reasons = ['A Claude reviewer approved the landing: a person must land it.', 'The PR description changed after approval.']
  const review = { id: 'rv-0a1b2c3d', phase: { kind: 'needs-person', reasons } }
  const quiet = THREADS.map(thread => ({ ...thread, agentTurnRunning: false, attention: null }))
  const cli = fake({ threads: [...quiet, DECIDING], detail: { ...DETAIL, thread: DECIDING, attention: 'decision', review }, store: STORE })
  const { nexus, mount } = await boot($, on, cli)
  await nexus('')
  const ui = await mount()
  const row = await ui.find({ type: 'Button', key: DECIDING.id })
  expect(row?.text).toMatch(/Land the fix\s+ needs you/)
  expect((await ui.find({ type: 'Text', text: ' Land the fix' }))?.props.bold).toBe(true)
  await nexus('open d000')
  await ui.press({ key: 'tab-pylon' })
  for (const reason of reasons) expect((await ui.find({ type: 'Text', text: `Needs you: ${reason}` }))?.props.color).toBe('warning')
})
