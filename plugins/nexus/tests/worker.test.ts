import { expect, test } from 'claude-code/testing'

import { CONVERSATION, T0, WORKER, WORKER_DETAIL, boot, fake, field, state } from './fake-cli'

type Ui = Awaited<ReturnType<Awaited<ReturnType<typeof boot>>['mount']>>

const shows = async (ui: Ui, text: string | RegExp, type?: string) => (await ui.find({ ...(type ? { type } : {}), text })) !== undefined
async function keys(ui: Ui, letters: string) {
  for (const letter of letters) await ui.press({ key: `key-${letter}` })
}
const conversations = (spawns: string[][]) => spawns.filter(argv => argv[0] === 'conversation')

/** A worker thread open in the pane: its watch prints only its state, as `nexus watch` does for a Claude Code worker. */
async function opened($: Parameters<typeof boot>[0], on: Parameters<typeof boot>[1], change: Parameters<typeof fake>[0] = {}) {
  const cli = fake({ threads: [{ ...WORKER, attention: 'working' }], detail: WORKER_DETAIL, ...change })
  cli.watch = [{ type: 'reset', thread: WORKER.id, entries: [] }, state('idle', { thread: WORKER.id })]
  const booted = await boot($, on, cli)
  await booted.nexus(`open ${WORKER.id}`)
  await booted.clock.settle()
  return { cli, ...booted, ui: await booted.mount() }
}

test("a Claude Code worker's conversation is its transcript, read with each poll of its details, and its run is the session's", async ($, on) => {
  const { cli, clock, ui } = await opened($, on)
  expect(conversations(cli.spawns)).toEqual([['conversation', '--json', WORKER.id]])
  expect(await shows(ui, 'This thread has no agent conversation.')).toBe(false)
  expect(await shows(ui, /\/poteto-mode add a health check/)).toBe(true)
  expect(await shows(ui, 'Adding `/healthz`.', 'Markdown')).toBe(true)
  expect(await shows(ui, /Update\(src\/server\.ts\)/)).toBe(true)
  expect(await shows(ui, /Bash\(npm test\)/)).toBe(true)
  // The queued message shows under the turn, and the run line counts the turn's tools, with no abort, which the harness's is.
  expect(await shows(ui, /^❯ also update the docs\.?queued, Claude reads it at its next tool step or after this turn$/, 'Box')).toBe(true)
  expect((await ui.find({ type: 'Text', text: /Working…/ }))?.text).toMatch(/^. Working… \(1m 30s · 2 tools this turn · new messages queue\)$/)
  expect(await shows(ui, /^‹ web \/ Add a health check  ◉ working$/)).toBe(true)
  cli.conversation = { ...CONVERSATION, entries: [...CONVERSATION.entries, { kind: 'reply', at: T0, text: 'Done: `/healthz` answers 200.' }], working: false }
  await clock.advance(5_000)
  expect(conversations(cli.spawns)).toHaveLength(2)
  expect(await shows(ui, 'Done: `/healthz` answers 200.', 'Markdown')).toBe(true)
  expect(await shows(ui, /Working…/)).toBe(false)
})

test('a message to a worker is typed into its session, and the pane says whether Claude took it or queued it', async ($, on) => {
  const { cli, ui } = await opened($, on, { sent: { claude: { session: '5e55-10n', outcome: 'queued', resumed: false } } })
  await keys(ui, 'i')
  await ui.input({ key: await field(ui, 'compose'), text: 'and a readiness probe' })
  expect(cli.runs).toContainEqual(['send', '--json', WORKER.id, '--', 'and a readiness probe'])
  expect(await shows(ui, `Queued in the Claude Code session of ${WORKER.id}: Claude reads it at its next tool step, or after this turn.`)).toBe(true)
})

test("a worker's Actions menu offers no harness abort or retry, and Pylon shows its launch with a stalled one's diagnostic", async ($, on) => {
  const stalled = { ...WORKER_DETAIL, claudeWorker: { model: 'claude-opus-5-5', state: 'stalled', message: Array.from({ length: 20 }, (_, index) => `pane line ${index + 1}`).join('\n') } }
  const { ui } = await opened($, on, { detail: stalled })
  await keys(ui, 'm')
  const menu = (await ui.findAll({ type: 'Button' })).flatMap(one => (one.key?.startsWith('menu-') ? [one.key] : []))
  expect(menu).not.toContain('menu-abort')
  expect(menu).toContain('menu-archive')
  await keys(ui, 'q')
  await ui.press({ key: 'tab-pylon' })
  expect(await shows(ui, /^Worker\s+Claude Code · claude-opus-5-5 · stalled$/)).toBe(true)
  const diagnostic = await ui.find({ type: 'Text', text: /pane line 20$/ })
  expect(diagnostic?.text).toBe(Array.from({ length: 8 }, (_, index) => `pane line ${index + 13}`).join('\n'))
  expect(diagnostic?.props.color).toBe('error')
})

test("a worker's new reply is marked seen only once its transcript is read and drawn", async ($, on) => {
  const unread = { ...WORKER_DETAIL, attention: 'reply', thread: { ...WORKER, lastReplyAt: T0, seenAt: T0 - 60_000 } }
  const { cli, clock } = await opened($, on, { detail: unread, fail: { conversation: { exitCode: 2, error: 'connect ECONNREFUSED' } } })
  expect(conversations(cli.spawns)).toHaveLength(1)
  expect(cli.runs.filter(argv => argv[0] === 'seen')).toEqual([])
  cli.fail = {}
  await clock.advance(5_000)
  expect(cli.runs.filter(argv => argv[0] === 'seen')).toEqual([['seen', '--json', WORKER.id]])
})

test('a harness thread reads no transcript: its watch streams the conversation', async ($, on) => {
  const cli = fake()
  const { nexus, clock } = await boot($, on, cli)
  await nexus('')
  await clock.advance(10_000)
  expect(conversations(cli.spawns)).toEqual([])
})

test("a worker's reply is not marked while Changes is shown, and leaving after a failed transcript read marks nothing", async ($, on) => {
  const unread = { ...WORKER_DETAIL, attention: 'reply', thread: { ...WORKER, lastReplyAt: T0, seenAt: T0 - 60_000 } }
  const { cli, clock, ui } = await opened($, on, { detail: unread, fail: { conversation: { exitCode: 2, error: 'connect ECONNREFUSED' } } })
  await ui.press({ key: 'tab-changes' })
  cli.fail = {}
  await clock.advance(10_000)
  expect(conversations(cli.spawns).length).toBeGreaterThan(1)
  expect(cli.runs.filter(argv => argv[0] === 'seen')).toEqual([])
  await keys(ui, 'hh')
  await clock.settle()
  expect(cli.runs.filter(argv => argv[0] === 'seen')).toEqual([])
})

test("while the person is attached in a Herdr tab, the worker's transcript is not read; it is again once they detach", async ($, on) => {
  const { cli, clock, nexus } = await opened($, on, { env: { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w9' } })
  await nexus(`session attach ${WORKER.id}`)
  expect(cli.herdr.some(argv => argv[0] === 'pane' && argv[1] === 'run')).toBe(true)
  cli.attaching = true
  const before = conversations(cli.spawns).length
  await clock.advance(15_000)
  expect(conversations(cli.spawns)).toHaveLength(before)
  cli.attaching = false
  await clock.advance(5_000)
  expect(conversations(cli.spawns).length).toBeGreaterThan(before)
})

test("a send to a worker outlasts the CLI's two minutes of waking a paused pylon", async ($, on) => {
  const { cli, clock, ui } = await opened($, on, { sent: { claude: { session: '5e55-10n', outcome: 'sent', resumed: true } }, slow: { send: 80_000 } })
  await keys(ui, 'i')
  const sending = ui.input({ key: await field(ui, 'compose'), text: 'wake up and continue' })
  await clock.advance(80_000)
  await sending
  expect(cli.runs).toContainEqual(['send', '--json', WORKER.id, '--', 'wake up and continue'])
  expect(await shows(ui, `Sent to the Claude Code session of ${WORKER.id}. Nexus resumed the session first, as no pane ran it.`)).toBe(true)
})
