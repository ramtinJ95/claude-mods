import { expect, test, type TestBody } from 'claude-code/testing'

import { cells } from '../hooks/model'
import { NOTICE_KEY } from '../hooks/strip'
import { DETAIL, ENTRIES, ID, T0, THREAD, THREADS, boot, fake, state } from './fake-cli'

const FAILED = { ...THREAD, id: 'th-f00000000004', title: 'Broken setup', agentTurnRunning: false, lastAgentActivityAt: T0 - 600_000, pylon: { node: 'firebat', actualState: 'failed', failed: 'git clone exited 128' }, attention: 'failed' }
const REPLIED = { ...THREAD, id: 'th-e00000000005', title: 'Docs pass', agentTurnRunning: false, lastAgentActivityAt: T0 - 1_000, lastReplyAt: T0 - 1_000, seenAt: T0 - 60_000, pylon: { node: 'firebat', actualState: 'running', failed: null }, attention: 'reply' }
const PARKED = { ...THREAD, id: 'th-a00000000007', title: 'Flaky deploy', agentTurnRunning: false, lastAgentActivityAt: T0 - 120_000, attention: 'parked' }
const WAITING = { ...THREAD, id: 'th-b00000000008', title: 'Asks a question', agentTurnRunning: false, lastAgentActivityAt: T0 - 30_000, attention: 'waiting' }
const LIMITED = { ...THREAD, id: 'th-c00000000009', title: 'Rate limiter', agentTurnRunning: false, lastAgentActivityAt: T0 - 600_000, attention: 'limited' }
const DECIDING = { ...THREAD, id: 'th-d00000000006', title: 'Land the fix', agentTurnRunning: false, lastAgentActivityAt: T0 - 300_000, attention: 'decision' }
const STORE = { themeNotice: true, strip: { isOn: true } }

const chips = async (ui: Awaited<ReturnType<Awaited<ReturnType<typeof boot>>['strip']>>) => (await ui.findAll({ type: 'Button' })).map(one => [one.key, one.text.trim()])
const threadPolls = (runs: string[][]) => runs.filter(argv => argv[0] === 'threads').length

test('the strip folds every thread that needs the person into one notice, in the look of the most urgent, and leaves out the working ones', async ($, on) => {
  const cli = fake({ threads: [...THREADS, WAITING, REPLIED, LIMITED, PARKED, DECIDING, FAILED], store: STORE })
  const { clock, strip } = await boot($, on, cli)
  await clock.settle()
  const ui = await strip(300)
  expect(await chips(ui)).toEqual([[NOTICE_KEY, '✕ 5 threads need you · 1 new']])
  expect(await ui.find({ type: 'Text', text: '◆ Nexus' })).toBeDefined()
  // The strip paints no band of its own.
  expect((await ui.findAll({})).some(one => typeof one.props.backgroundColor === 'string')).toBe(false)
})

test("unread replies need no one, as the dashboard's Needs you counts: the strip says how many are new, and the review loop's own replies are not news", async ($, on) => {
  const builders = [1, 2, 3, 4, 5].map(n => ({ ...REPLIED, id: `th-e0000000001${n}`, title: `Builder ${n}`, startedBy: 'nodeAbc123CNTRL' }))
  const loop = [
    ...[1, 2, 3].map(n => ({ ...REPLIED, id: `th-e0000000002${n}`, title: `Review of #4${n}`, startedBy: 'nexus-review' })),
    { ...REPLIED, id: 'th-e00000000031', title: 'Check of #41', startedBy: 'nexus-check' },
  ]
  const cli = fake({ threads: [...THREADS, ...builders, ...loop], store: STORE })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Text({ children: ['the prompt as it was'] } as never))
  const { clock, strip, nexus, mount } = await boot($, on, cli)
  await clock.settle()
  const ui = await strip(300)
  expect(await chips(ui)).toEqual([[NOTICE_KEY, '● 5 new replies']])
  cli.threads = [...THREADS.map(thread => ({ ...thread, agentTurnRunning: false, attention: null })), ...loop]
  await clock.advance(10_000)
  expect(await chips(ui)).toEqual([])
  await nexus('')
  const pane = await mount()
  expect((await pane.find({ type: 'Button', key: loop[0]!.id }))?.text).toMatch(/Review of #41\s+ running/)
  expect(await pane.find({ type: 'Text', text: /new ·/ })).toBeUndefined()
})

test('what needs the person outranks the new replies, which it counts beside it, a failed reviewer among it, and a session waiting at a dialog counts whatever its attention', async ($, on) => {
  const reviewer = { ...FAILED, id: 'th-f00000000041', title: 'Review of #41', startedBy: 'nexus-review' }
  const builders = [1, 2].map(n => ({ ...REPLIED, id: `th-e0000000004${n}`, title: `Builder ${n}` }))
  const dialog = { ...REPLIED, id: 'th-b00000000042', title: 'Permission prompt', agentTurnRunning: true, attention: 'working', sessionWaiting: true }
  const cli = fake({ threads: [...THREADS, REPLIED, ...builders, reviewer], store: STORE })
  const { clock, strip } = await boot($, on, cli)
  await clock.settle()
  const ui = await strip(300)
  expect(await chips(ui)).toEqual([[NOTICE_KEY, '✕ Review of #41  failed · 3 new']])
  cli.threads = [...THREADS, REPLIED, dialog]
  await clock.advance(10_000)
  expect(await chips(ui)).toEqual([[NOTICE_KEY, '◇ Permission prompt  waiting for you · 1 new']])
  cli.threads = [...THREADS, REPLIED, { ...dialog, status: 'archived' }]
  await clock.advance(10_000)
  expect(await chips(ui)).toEqual([[NOTICE_KEY, '● Docs pass  new reply']])
})

test("an idle thread needs the person as an active one does, a deleted one never, a dialog behind a new reply is a wait, and a verify pylon's reply is the loop's", async ($, on) => {
  const quiet = THREADS.map(thread => ({ ...thread, agentTurnRunning: false, attention: null }))
  const idle = { ...DECIDING, status: 'idle' }
  const deleted = { ...FAILED, status: 'deleted' }
  const verify = { ...REPLIED, id: 'th-e00000000051', title: 'Verify #41', startedBy: 'nexus-verify' }
  const dialog = { ...REPLIED, id: 'th-b00000000052', title: 'Permission prompt', sessionWaiting: true }
  const cli = fake({ threads: [...quiet, idle, deleted, verify, dialog], store: STORE })
  const { clock, strip, nexus, mount } = await boot($, on, cli)
  await clock.settle()
  expect(await chips(await strip(300))).toEqual([[NOTICE_KEY, '! 2 threads need you']])
  await nexus('')
  const pane = await mount()
  expect((await pane.find({ type: 'Button', key: idle.id }))?.text).toMatch(/Land the fix\s+ needs you/)
  expect((await pane.find({ type: 'Button', key: dialog.id }))?.text).toMatch(/Permission prompt\s+ waiting/)
  expect((await pane.find({ type: 'Button', key: verify.id }))?.text).toMatch(/Verify #41\s+ running/)
  expect(await pane.find({ type: 'Text', text: /new ·/ })).toBeUndefined()
})

test('one thread that needs the person is named with what it asks, and a working one alone leaves the strip empty', async ($, on) => {
  const cli = fake({ threads: [...THREADS, LIMITED], store: STORE })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Text({ children: ['the prompt as it was'] } as never))
  const { clock, strip } = await boot($, on, cli)
  await clock.settle()
  const ui = await strip(300)
  expect(await chips(ui)).toEqual([[NOTICE_KEY, '◷ Rate limiter  usage limit']])
  cli.threads = THREADS
  await clock.advance(10_000)
  expect(await chips(ui)).toEqual([])
  expect(await ui.find({ type: 'Text', text: 'the prompt as it was' })).toBeDefined()
})

test("an archived thread's disk that waits on the person counts in the notice once a poll finds it past its time, and its project's fold says so", async ($, on) => {
  const DAY = 24 * 60 * 60_000
  // Three failed reads: its disk waits on the person 24 hours after the archive, 20 s after the first poll.
  const KEPT = { ...THREADS[1]!, id: 'th-5d0000000010', title: 'Spike on caching', archivedAt: T0 - DAY + 20_000, settleFailure: { reason: 'its pylon did not boot', at: T0, count: 3 }, attention: null }
  const quiet = THREADS.map(thread => ({ ...thread, agentTurnRunning: false, attention: null }))
  const cli = fake({ threads: [...quiet, KEPT], store: STORE })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Text({ children: ['the prompt as it was'] } as never))
  const { clock, strip, nexus, mount } = await boot($, on, cli)
  await clock.settle()
  const ui = await strip(300)
  expect(await chips(ui)).toEqual([])
  await clock.advance(20_000)
  expect(await chips(ui)).toEqual([[NOTICE_KEY, '◌ Spike on caching  disk kept']])
  await nexus('')
  const pane = await mount()
  expect((await pane.find({ type: 'Button', key: 'closed-web' }))?.text).toMatch(/2 archived · 1 disk kept$/)
})

test('pressing a notice for several threads opens the pane on the list', async ($, on) => {
  const cli = fake({ threads: [...THREADS, FAILED, PARKED], store: STORE })
  const { clock, strip, mount } = await boot($, on, cli)
  await clock.settle()
  await (await strip()).press({ key: NOTICE_KEY })
  expect(cli.isOpen).toBe(true)
  expect(cli.spawns.some(argv => argv[0] === 'watch')).toBe(false)
  expect(await (await mount()).find({ type: 'Button', key: FAILED.id })).toBeDefined()
})

test('pressing the notice for one thread opens it in the pane, which marks the reply seen on the control plane, and it is no longer news', async ($, on) => {
  const cli = fake({ threads: [...THREADS, REPLIED], detail: { ...DETAIL, thread: REPLIED, attention: 'reply', seenAt: REPLIED.seenAt, lastReplyAt: REPLIED.lastReplyAt }, store: STORE })
  cli.watch = [{ type: 'reset', thread: ID, entries: ENTRIES.slice(0, -1) }, state('idle')]
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Text({ children: ['the prompt as it was'] } as never))
  const { clock, strip, mount } = await boot($, on, cli)
  await clock.settle()
  const ui = await strip()
  await ui.press({ key: NOTICE_KEY })
  // The first poll reads the details before the watch has drawn the conversation; the next one marks.
  await clock.advance(5_000)
  expect(cli.isOpen).toBe(true)
  expect(cli.spawns).toContainEqual(['watch', REPLIED.id, '--json'])
  expect(await (await mount()).find({ type: 'Text', text: '‹ web / Docs pass' })).toBeDefined()
  expect(cli.runs.filter(argv => argv[0] === 'seen')).toEqual([['seen', '--json', REPLIED.id, `--last-reply-at=${REPLIED.lastReplyAt}`]])
  // The details read after the mark drop the reply from the strip before the strip's own poll.
  expect(threadPolls(cli.runs)).toBe(1)
  expect(await chips(ui)).toEqual([])
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

test("a narrow strip fits its one row: the project's name goes before the thread's title, a count says less, and the new replies beside it go first", async ($, on) => {
  const cli = fake({ threads: [...THREADS, FAILED], store: { ...STORE, project: 'web' } })
  const { clock, strip } = await boot($, on, cli)
  await clock.settle()
  const fits = async (ui: Awaited<ReturnType<typeof strip>>, width: number) => {
    const row = [(await ui.find({ type: 'Text', text: /^◆ Nexus/ }))!.text, ...(await chips(ui)).map(([, text]) => text)]
    expect(cells(row[0]!) + 2 + cells(row[1]!)).toBeLessThanOrEqual(width)
    return row
  }
  const ui = await strip(32)
  expect(await fits(ui, 32)).toEqual(['◆ Nexus', '✕ Broken setup  failed'])
  cli.threads = [...THREADS, FAILED, PARKED]
  await clock.advance(10_000)
  expect(await fits(ui, 32)).toEqual(['◆ Nexus', '✕ 2 threads need you'])
  cli.threads = [...THREADS, FAILED, PARKED, REPLIED]
  await clock.advance(10_000)
  expect(await fits(ui, 32)).toEqual(['◆ Nexus', '✕ 2 need you · 1 new'])
  await ui.unmount()
  expect(await fits(await strip(24), 24)).toEqual(['◆ Nexus', '✕ 2 need you'])
})

test('the list marks an unread reply and counts it; going back from its thread marks it seen before the list is read again', async ($, on) => {
  const quiet = THREADS.map(thread => ({ ...thread, agentTurnRunning: false, attention: null }))
  const cli = fake({ threads: [...quiet, REPLIED], store: STORE })
  cli.watch = [{ type: 'reset', thread: ID, entries: ENTRIES.slice(0, -1) }, state('idle')]
  const { clock, nexus, mount } = await boot($, on, cli)
  await nexus('')
  const ui = await mount()
  expect((await ui.find({ type: 'Button', key: REPLIED.id }))?.text).toMatch(/Docs pass\s+ new reply/)
  expect(await ui.find({ type: 'Text', text: '1 new · 3 open · 1 node offline' })).toBeDefined()
  // The details of the thread opened were marked seen by another client already: the pane marks nothing on opening it.
  cli.detail = { ...DETAIL, thread: { ...REPLIED, seenAt: REPLIED.lastReplyAt, attention: null }, attention: null, seenAt: REPLIED.lastReplyAt, lastReplyAt: REPLIED.lastReplyAt }
  await nexus('open e000')
  await clock.advance(5_000)
  expect(cli.runs.filter(argv => argv[0] === 'seen')).toEqual([])
  // Another client marks the reply unread while the person reads it here: leaving marks the reply the pane showed.
  cli.detail = { ...DETAIL, thread: REPLIED, attention: 'reply', seenAt: REPLIED.seenAt, lastReplyAt: REPLIED.lastReplyAt }
  await ui.press({ key: 'key-h' })
  await clock.settle()
  expect(cli.runs.filter(argv => argv[0] === 'seen')).toEqual([['seen', '--json', REPLIED.id, `--last-reply-at=${REPLIED.lastReplyAt}`]])
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
  expect(await chips(await strip())).toEqual([[NOTICE_KEY, '● Docs pass  new reply']])
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
  expect(cli.runs.filter(argv => argv[0] === 'seen')).toEqual([['seen', '--json', REPLIED.id, `--last-reply-at=${REPLIED.lastReplyAt}`]])
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
  expect(cli.runs.filter(argv => argv[0] === 'seen')).toEqual([['seen', '--json', REPLIED.id, `--last-reply-at=${REPLIED.lastReplyAt}`]])
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

test('CLI 0.19.0 marks only the reply the pane showed: leaving after a newer one came reads no details and leaves the newer one new', async ($, on) => {
  const unread = { ...DETAIL, thread: REPLIED, attention: 'reply', seenAt: REPLIED.seenAt, lastReplyAt: REPLIED.lastReplyAt }
  const cli = fake({ threads: [...THREADS, REPLIED], detail: unread, store: STORE, version: '0.19.0' })
  cli.watch = [{ type: 'reset', thread: ID, entries: ENTRIES.slice(0, -1) }, state('idle')]
  const { clock, nexus, mount } = await boot($, on, cli)
  await nexus('open e000')
  await clock.advance(5_000)
  expect(cli.runs.filter(argv => argv[0] === 'seen')).toEqual([['seen', '--json', REPLIED.id, `--last-reply-at=${REPLIED.lastReplyAt}`]])
  const ui = await mount()
  const newer = { ...REPLIED, seenAt: REPLIED.lastReplyAt, lastReplyAt: T0 + 4_000 }
  cli.detail = { ...DETAIL, thread: newer, attention: 'reply', seenAt: newer.seenAt, lastReplyAt: newer.lastReplyAt }
  cli.threads = [...THREADS, newer]
  const before = cli.runs.length
  await ui.press({ key: 'key-h' })
  await clock.settle()
  expect(cli.runs.slice(before).filter(argv => argv[0] === 'seen' || argv[0] === 'show')).toEqual([['seen', '--json', REPLIED.id, `--last-reply-at=${REPLIED.lastReplyAt}`]])
  expect((await ui.find({ type: 'Button', key: REPLIED.id }))?.text).toMatch(/Docs pass\s+ new reply/)
})

/** A thread with a new reply opened and left while every `nexus --version` prints `version`, or fails for null: the pane marks nothing and says `why` once. */
async function refusedVersion(...[$, on, version, why]: [...Parameters<TestBody>, string | null, string]) {
  const unread = { ...DETAIL, thread: REPLIED, attention: 'reply', seenAt: REPLIED.seenAt, lastReplyAt: REPLIED.lastReplyAt }
  const cli = fake({ threads: [...THREADS, REPLIED], detail: unread, store: STORE, versions: Array.from({ length: 20 }, () => version) })
  cli.watch = [{ type: 'reset', thread: ID, entries: ENTRIES.slice(0, -1) }, state('idle')]
  const notices: string[] = []
  on('state.set', (_, e, next) => {
    const notice = (e.value as { notice?: { text: string } | null } | null)?.notice
    if (e.key === 'pane' && notice && !notices.includes(notice.text)) notices.push(notice.text)
    return next(e)
  })
  const refused = `The reply in ${REPLIED.id} was not marked seen, so it still shows as new: ${why}`
  const { clock, nexus, mount } = await boot($, on, cli)
  await nexus('open e000')
  await clock.advance(15_000)
  const ui = await mount()
  expect(await ui.find({ type: 'Text', text: refused })).toBeDefined()
  await ui.press({ key: 'key-k' })
  await clock.advance(10_000)
  expect(await ui.find({ type: 'Text', text: refused }), 'later polls of the same reply say nothing again').toBeUndefined()
  await ui.press({ key: 'key-h' })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: refused }), 'leaving says nothing again').toBeUndefined()
  expect(cli.runs.filter(argv => argv[0] === 'seen')).toEqual([])
  expect(notices).toEqual([refused])
  expect((await ui.find({ type: 'Button', key: REPLIED.id }))?.text).toMatch(/Docs pass\s+ new reply/)
}

test('a version check that fails marks nothing, opening or leaving, and says so once for the reply', ($, on) => refusedVersion($, on, null, 'nexus --version gave no version, so the pane cannot mark only the reply it showed.'))

test('a version check that prints no version marks nothing, opening or leaving, and says so once for the reply', ($, on) => refusedVersion($, on, 'garbage', 'nexus --version gave no version, so the pane cannot mark only the reply it showed.'))

test('a CLI before 0.19.0, whose seen cannot name the reply shown, marks nothing and names the version it needs', ($, on) =>
  refusedVersion($, on, '0.18.0', 'nexus is 0.18.0: marking only the reply shown seen needs Nexus CLI 0.19.0 or later (nexus --version).'))

test('leaving reads the version once for its mark: a check that says 0.19.0 and a later one that fails cannot widen the mark to a newer reply', async ($, on) => {
  const read = { ...DETAIL, thread: { ...REPLIED, seenAt: REPLIED.lastReplyAt }, attention: null, seenAt: REPLIED.lastReplyAt, lastReplyAt: REPLIED.lastReplyAt }
  const cli = fake({ threads: [...THREADS, REPLIED], detail: read, store: STORE, version: '0.19.0' })
  cli.watch = [{ type: 'reset', thread: ID, entries: ENTRIES.slice(0, -1) }, state('idle')]
  const { clock, nexus, mount } = await boot($, on, cli)
  await nexus('open e000')
  await clock.advance(5_000)
  const ui = await mount()
  const newer = { ...REPLIED, seenAt: REPLIED.lastReplyAt, lastReplyAt: T0 + 4_000 }
  cli.detail = { ...DETAIL, thread: newer, attention: 'reply', seenAt: newer.seenAt, lastReplyAt: newer.lastReplyAt }
  cli.threads = [...THREADS, newer]
  cli.versions = ['0.19.0', null]
  const before = cli.runs.length
  await ui.press({ key: 'key-h' })
  await clock.settle()
  const since = cli.runs.slice(before)
  expect(since.filter(argv => argv[0] === 'seen')).toEqual([['seen', '--json', REPLIED.id, `--last-reply-at=${REPLIED.lastReplyAt}`]])
  expect(since.filter(argv => argv[0] === '--version')).toHaveLength(1)
  expect((await ui.find({ type: 'Button', key: REPLIED.id }))?.text).toMatch(/Docs pass\s+ new reply/)
})
