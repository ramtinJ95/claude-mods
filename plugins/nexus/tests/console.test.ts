import { expect, test, type TestBody } from 'claude-code/testing'

import { KEYMAP } from '../hooks/keys'
import { cutTree } from '../hooks/view'
import { DETAIL, ENTRIES, ID, OPENED, PATCH, PUBLISHED, THEME_KEYS, THREAD, THREADS, WEB_PREVIEW, boot, fake, live, state } from './fake-cli'

type Ui = Awaited<ReturnType<Awaited<ReturnType<typeof boot>>['mount']>>

const texts = async (ui: Ui, type = 'Text') => (await ui.findAll({ type })).map(one => one.text)
const shows = async (ui: Ui, text: string | RegExp, type?: string) => (await ui.find({ ...(type ? { type } : {}), text })) !== undefined
const hotkeys = async (ui: Ui) => (await ui.findAll({ type: 'Button' })).flatMap(one => (typeof one.props.hotkey === 'string' ? [one.props.hotkey] : []))
const LETTERS = KEYMAP.map(key => key.hotkey)
/** Presses the letters in turn, as the person types them. */
async function keys(ui: Ui, letters: string) {
  for (const letter of letters) await ui.press({ key: `key-${letter}` })
}
/** The key of the row the cursor is on: the Button whose text starts with the cursor's mark. */
const cursorOn = async (ui: Ui) => (await ui.findAll({ type: 'Button' })).find(one => one.text.startsWith('❯'))?.key
/** The block under the conversation's cursor, which the pane marks. */
const marked = async (ui: Ui) => (await ui.findAll({ type: 'Box' })).find(one => one.key?.startsWith('stop-') && one.text.startsWith('▎'))?.key
const mode = async (ui: Ui) => (await ui.find({ type: 'Text', text: /^ (NORMAL|INSERT|FILTER) / }))?.text.trim().split(' ')[0]

/** The text a drawn tree carries, as the engine counts it toward the 100000 characters it draws of one tree. */
function carried(node: unknown): number {
  if (typeof node === 'string') return node.length
  if (Array.isArray(node)) return node.reduce((sum: number, child) => sum + carried(child), 0)
  if (typeof node !== 'object' || node === null) return 0
  const { props, children } = node as { props?: Record<string, unknown>; children?: unknown }
  return ['source', 'text', 'label'].reduce((sum, prop) => sum + (typeof props?.[prop] === 'string' ? (props[prop] as string).length : 0), 0) + carried(children)
}

/** Where a tree holds a null or undefined child, each a path of indexes from its root. */
function holes(node: unknown, at = ''): string[] {
  if (node === null || node === undefined) return [at || 'root']
  if (Array.isArray(node)) return node.flatMap((child, index) => holes(child, `${at}/${index}`))
  if (typeof node !== 'object' || !('children' in node)) return []
  return holes((node as { children: unknown }).children, at)
}

/** The drawing stays under the engine's limit and still ends with the view's keys, which a cut would take first. */
async function expectWhole(ui: Ui) {
  const tree = await ui.drawn()
  expect(holes(tree)).toEqual([])
  expect(carried(tree)).toBeLessThan(100_000)
  expect(await hotkeys(ui)).toEqual(LETTERS)
}

/** Every colour the drawing paints with is a theme key, so the pane follows the person's theme. */
async function expectThemeColours(ui: Ui) {
  const painted = (await ui.findAll({})).flatMap(one => ['color', 'borderColor', 'backgroundColor'].flatMap(prop => (typeof one.props[prop] === 'string' ? [one.props[prop] as string] : [])))
  expect(painted.length).toBeGreaterThan(0)
  expect(painted.filter(colour => !THEME_KEYS.has(colour))).toEqual([])
}

test('/nexus opens on the thread whose agent works; h goes back to the list with the cursor on it', async ($, on) => {
  const cli = fake()
  const { nexus, mount } = await boot($, on, cli)
  await nexus('')
  expect(cli.spawns).toContainEqual(['watch', ID, '--json'])
  const ui = await mount()
  expect(await shows(ui, /^‹ web \/ Fix login form 500s$/)).toBe(true)
  await keys(ui, 'h')
  expect(await cursorOn(ui)).toBe(ID)
  expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
  expect(cli.spawns).toContainEqual(['threads', '--json', '--all'])
})

test('/nexus with no agent working opens the list, the cursor on its first row', async ($, on) => {
  const cli = fake({ threads: THREADS.map(thread => ({ ...thread, agentTurnRunning: false })) })
  const { nexus, mount } = await boot($, on, cli)
  await nexus('')
  expect(cli.spawns.some(argv => argv[0] === 'watch')).toBe(false)
  const ui = await mount()
  expect(await cursorOn(ui)).toBe('th-7c0000000003')
})

test('the list groups threads by project, folds the closed ones and opens the row under the cursor', async ($, on) => {
  const cli = fake()
  const { nexus, mount } = await boot($, on, cli)
  await nexus('')
  expect(cli.runs).toContainEqual(['nodes', '--json'])
  const ui = await mount()
  await keys(ui, 'h')
  expect(await shows(ui, /◆ Nexus\s+1 working · 2 open/)).toBe(true)
  expect(await shows(ui, '1/2 nodes online')).toBe(true)
  expect((await ui.find({ type: 'Button', key: ID }))?.text).toMatch(/^❯ ◉ Fix login form 500s\s+ working \s+now$/)
  // The row under the cursor opens a line of its facts.
  expect(await shows(ui, `    firebat · you 2 min · agent working · ${ID}`)).toBe(true)
  expect((await ui.find({ type: 'Button', key: 'th-7c0000000003' }))?.text).toMatch(/^ {2}○ API docs\s+ paused \s+3 h$/)
  expect(await shows(ui, /testbench · you 3 h/)).toBe(false)
  expect(await ui.find({ type: 'Button', key: 'th-9b0000000002' })).toBeUndefined()
  expect((await ui.find({ type: 'Button', key: 'closed-web' }))?.text).toBe('    ▸ 1 archived')
  await keys(ui, 'j')
  expect(await cursorOn(ui)).toBe('closed-web')
  await keys(ui, 'o')
  expect((await ui.find({ type: 'Button', key: 'th-9b0000000002' }))?.text).toMatch(/Old idea\s+ archived /)
  await keys(ui, 'gg')
  expect(await cursorOn(ui)).toBe('th-7c0000000003')
  await keys(ui, 'ge')
  expect(await cursorOn(ui)).toBe('th-9b0000000002')
  expect(await hotkeys(ui)).toEqual(LETTERS)
  expect(await mode(ui)).toBe('NORMAL')
  await expectThemeColours(ui)
  await keys(ui, 'k')
  await keys(ui, 'k')
  await keys(ui, 'l')
  expect(await shows(ui, /^‹ web \/ Fix login form 500s$/)).toBe(true)
})

test('a pylon not yet where it is wanted says so under the cursor', async ($, on) => {
  const cli = fake({ threads: [{ ...THREAD, agentTurnRunning: false, pylon: { node: 'firebat', actualState: 'running', failed: null }, desired: 'paused' }] })
  const { nexus, mount } = await boot($, on, cli)
  await nexus('')
  const ui = await mount()
  expect(await shows(ui, /^ {4}wants paused · firebat · you 2 min · agent now/)).toBe(true)
})

test('f filters by title in filter mode, opens a closed group it matches, and Enter puts the cursor on the first match', async ($, on) => {
  const cli = fake()
  const { nexus, mount } = await boot($, on, cli)
  await nexus('')
  const ui = await mount()
  await keys(ui, 'h')
  await ui.press({ key: 'closed-web' })
  await ui.press({ key: 'closed-web' })
  expect(await ui.find({ type: 'Button', key: 'th-9b0000000002' })).toBeUndefined()
  await keys(ui, 'f')
  expect((await ui.find({ type: 'Input', key: 'filter' }))?.props.autoFocus).toBe(true)
  expect(await mode(ui)).toBe('FILTER')
  await ui.input({ key: 'filter', text: 'old', kind: 'change' })
  expect((await ui.findAll({ type: 'Button' })).flatMap(one => (one.props.hotkey ? [] : [one.key]))).toEqual(['closed-web', 'th-9b0000000002'])
  await ui.input({ key: 'filter', text: 'old' })
  expect(await mode(ui)).toBe('NORMAL')
  expect(await cursorOn(ui)).toBe('th-9b0000000002')
  expect(await shows(ui, /^⌕ old/)).toBe(true)
})

test('Esc from the filter, which hands the keys to the prompt, clears it and takes them back', async ($, on) => {
  const cli = fake()
  const { clock, nexus, mount } = await boot($, on, cli)
  await nexus('')
  const ui = await mount()
  await keys(ui, 'h')
  await keys(ui, 'f')
  await ui.input({ key: 'filter', text: 'old', kind: 'change' })
  const opens = cli.opens
  await ui.redraw({ title: 'Nexus', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} } as never)
  expect(await shows(ui, /the keys are at the prompt/)).toBe(true)
  await clock.advance(1)
  expect(cli.opens).toBe(opens + 1)
  await ui.redraw({ title: 'Nexus', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} } as never)
  expect(await mode(ui)).toBe('NORMAL')
  expect(await ui.find({ type: 'Input', key: 'filter' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'th-7c0000000003' })).toBeDefined()
})

test('a thread draws as a Claude Code transcript: prompts, ⏺ answers in Markdown, tool calls with ⎿ results, edits as diffs', async ($, on) => {
  const cli = fake()
  const { nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  expect(await shows(ui, /^‹ web \/ Fix login form 500s$/)).toBe(true)
  expect(await shows(ui, /^ working 1m 12s {3}firebat {2}· {2}claude-opus-5-5 {2}· {2}started 12 min ago$/)).toBe(true)
  expect((await ui.find({ type: 'Button', key: 'tab-conversation' }))?.props.autoFocus).toBe(true)
  expect(await shows(ui, /^❯ The login form answers 500/, 'Box')).toBe(true)
  // As Claude Code draws its own: the prompt and the answers' marks in the text colour.
  expect((await ui.find({ type: 'Text', text: /^The login form answers 500/ }))?.props.color).toBe('text')
  expect((await ui.findAll({ type: 'Text', text: /^⏺\s*$/ })).filter(one => one.props.color === 'text')).toHaveLength(2)
  expect((await ui.findAll({ type: 'Markdown' })).map(one => one.text)).toEqual(["I'll reproduce it **first**.", 'Fixed: the regex rejected plus addressing.'])
  expect((await ui.find({ type: 'Button', key: 'tool-b1' }))?.text).toBe('⏺ Bash(npm test -- login)')
  expect(await texts(ui)).toEqual(expect.arrayContaining(['Error: exit 1', 'Command exited with code 1']))
  expect((await ui.find({ type: 'Button', key: 'tool-e1' }))?.text).toBe('⏺ Update(src/auth/email.ts)')
  expect(await shows(ui, 'Updated src/auth/email.ts with 1 addition and 1 removal')).toBe(true)
  const diff = await ui.find({ type: 'Code' })
  expect(diff?.props).toMatchObject({ format: 'diff', wrap: 'truncate-end', source: PATCH.slice(PATCH.indexOf('@@')).replace(/\n$/, '') })
  // Opened, a row shows its long lines whole.
  await ui.press({ key: 'tool-e1' })
  expect((await ui.find({ type: 'Code' }))?.props.wrap).toBe('wrap')
  await ui.press({ key: 'tool-e1' })
  expect((await ui.find({ type: 'Button', key: 'fold-r-a' }))?.text).toBe('⏺ Read 4 files, ran 1 command · 1 running (5 steps, o to fold)')
  expect((await ui.find({ type: 'Text', text: /Working…/ }))?.text).toBe('· Working… (1m 12s · 7 tools this turn · new messages queue · m to abort)')
  expect((await ui.find({ type: 'Text', text: /^· Working… $/ }))?.props.color).toBe('claude')
  expect((await ui.find({ type: 'Input', key: 'compose' }))?.props.placeholder).toBe('Queue a follow-up…  (i to write)')
  expect(await mode(ui)).toBe('NORMAL')
  expect(await hotkeys(ui)).toEqual(LETTERS)
  await expectThemeColours(ui)
})

test("the live run draws the answer streaming, a retry waiting, the queued messages and a running call's output", async ($, on) => {
  const cli = fake()
  cli.watch = [
    { type: 'reset', thread: ID, entries: ENTRIES },
    state('working', { queued: 1 }),
    live({ queued: ['Also add a test.'], tools: [{ callId: 'call_b2|fc_9', output: 'running 40 tests\n12 passed\n13 passed\n14 passed' }], partial: 'Running the suite again', retry: 'overloaded' }),
  ]
  const { nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  expect((await ui.findAll({ type: 'Markdown' })).at(-1)?.text).toBe('Running the suite again')
  expect(await shows(ui, 'The model request failed and will be retried: overloaded')).toBe(true)
  expect(await shows(ui, /^❯ Also add a test\.queued, sends after this run$/, 'Box')).toBe(true)
  const output = await texts(ui)
  expect(output).toEqual(expect.arrayContaining(['12 passed', '13 passed', '14 passed']))
  expect(output).not.toContain('running 40 tests')
  // The live event's queue is the queued messages themselves, so no count stands in for them.
  expect(await shows(ui, /behind the run/)).toBe(false)
})

/** A turn whose answer streams at `hz` live events a second for `seconds`, each the whole partial so far, then commits. */
function streaming(hz: number, seconds: number) {
  const words = Array.from({ length: hz * seconds }, (_, n) => `word${n}`)
  const partial = (n: number) => `Running the suite: ${words.slice(0, n + 1).join(' ')}`
  const answer = partial(words.length - 1)
  const lives = words.flatMap((_, n) => [{ delay: 1_000 / hz }, live({ partial: partial(n) })])
  const commit = { type: 'entry', thread: ID, entry: { id: 12, model: [{ role: 'assistant', content: [{ type: 'text', text: answer }] }] }, text: answer }
  return { answer, partial, events: [{ type: 'reset', thread: ID, entries: ENTRIES.slice(0, -1) }, state('working'), live(), ...lives, commit, live(), state('idle')] }
}

/** Every write of the mod's `watch` and `live` values. */
function countWrites(on: Parameters<TestBody>[1]) {
  const writes = { watch: 0, live: 0 }
  on('state.set', async (_, e, next) => {
    if (e.plugin === 'nexus' && (e.key === 'watch' || e.key === 'live')) writes[e.key] += 1
    return next(e)
  })
  return writes
}

test('a 10 Hz stream writes the live event alone, at most every 100 ms, and draws its newest partial', async ($, on) => {
  const writes = countWrites(on)
  const cli = fake()
  const { answer, partial, events } = streaming(50, 2)
  cli.watch = events
  const { clock, nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  const before = { ...writes }
  await clock.advance(1_000)
  // 50 events in that second, written as at most one in each 100 ms, and none of them copies the rows.
  expect(writes.live - before.live).toBeGreaterThanOrEqual(9)
  expect(writes.live - before.live).toBeLessThanOrEqual(11)
  expect(writes.watch).toBe(before.watch)
  // Read 1.1 s in, 20 ms apart: the drawing is at most one write behind the newest.
  expect((await ui.findAll({ type: 'Markdown' })).at(-1)?.text).toMatch(new RegExp(`^${partial(49)}`))
  await clock.advance(1_100)
  expect((await ui.findAll({ type: 'Markdown' })).filter(one => one.text === answer)).toHaveLength(1)
  expect(await shows(ui, /Working…/)).toBe(false)
})

test('the streaming answer keeps its key as it commits, and no drawing shows it twice', async ($, on) => {
  const cli = fake()
  const { answer, events } = streaming(10, 3)
  cli.watch = events
  const { clock, nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  const keyOf = async () => (await ui.findAll({ type: 'Box' })).find(one => /^row-\d+$/.test(one.key ?? '') && one.text.includes('Running the suite'))?.key
  const streamed = new Set<string | undefined>()
  for (let tick = 0; tick < 32; tick += 1) {
    await clock.advance(100)
    const answers = (await ui.findAll({ type: 'Markdown' })).filter(one => one.text.startsWith('Running the suite'))
    expect(answers.length).toBeLessThanOrEqual(1)
    streamed.add(await keyOf())
  }
  expect((await ui.findAll({ type: 'Markdown' })).at(-1)?.text).toBe(answer)
  const committed = await keyOf()
  expect(committed).toMatch(/^row-\d+$/)
  expect([...streamed]).toEqual([committed])
})


test('k scrolls back a block at a time and the view holds still as an answer streams below; g e follows the end again', async ($, on) => {
  const cli = fake()
  const said = (id: number) => ({ entry: { id, model: [{ role: 'assistant', content: [{ type: 'text', text: `answer ${id} ${'z'.repeat(296)}` }] }] }, text: '' })
  const grown = (chars: number) => live({ partial: 'p'.repeat(chars) })
  cli.watch = [
    { type: 'reset', thread: ID, entries: [ENTRIES[0], ...Array.from({ length: 40 }, (_, n) => said(n + 2))] },
    state('working'),
    ...[100, 900, 1_700, 2_500].flatMap(chars => [{ delay: 1_000 }, grown(chars)]),
  ]
  const { clock, nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  await keys(ui, 'kkk')
  const held = await marked(ui)
  expect(held).toMatch(/^stop-row-/)
  const shown = await texts(ui, 'Markdown')
  for (let second = 0; second < 4; second += 1) {
    await clock.advance(1_000)
    expect(await marked(ui)).toBe(held)
    expect(await texts(ui, 'Markdown')).toEqual(shown)
  }
  await keys(ui, 'gg')
  expect(await shows(ui, /^❯ The login form answers 500/, 'Box')).toBe(true)
  await keys(ui, 'ge')
  expect(await marked(ui)).not.toBe(held)
  expect((await ui.findAll({ type: 'Markdown' })).at(-1)?.text).toBe('p'.repeat(2_500))
})

test('the run clock and spinner tick each second while the run works', async ($, on) => {
  const cli = fake()
  const { clock, nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  expect(await shows(ui, /^· Working… \(1m 12s/)).toBe(true)
  await clock.advance(1_000)
  expect(await shows(ui, /^✢ Working… \(1m 13s/)).toBe(true)
})

test('a tool row opens when pressed: its other arguments and all its output', async ($, on) => {
  const cli = fake()
  const { nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  expect(await ui.find({ type: 'Code', text: /timeout/ })).toBeUndefined()
  await ui.press({ key: 'tool-b1' })
  expect((await ui.find({ type: 'Code', text: /timeout/ }))?.props).toMatchObject({ language: 'json', source: '{\n  "timeout": 120\n}' })
  expect((await texts(ui)).filter(text => text === 'line')).toHaveLength(0)
  await ui.press({ key: 'tool-r-a' })
  expect((await texts(ui)).filter(text => text === 'line')).toHaveLength(10)
})

test('o and Enter on the tab open the block under the cursor, k moves it up, and y copies it', async ($, on) => {
  const cli = fake()
  cli.watch = [{ type: 'reset', thread: ID, entries: ENTRIES.slice(0, -1) }, state('idle'), live()]
  const { nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  expect((await ui.find({ type: 'Button', key: 'fold-r-a' }))?.text).toBe('⏺ Read 4 files (4 steps, o to expand)')
  expect(await marked(ui)).toBe('stop-fold-r-a')
  await keys(ui, 'o')
  expect(await ui.find({ type: 'Button', key: 'tool-r-a' })).toBeDefined()
  // The newest block is now the fold's last step; Enter presses the ring's element, the tab, which acts as o.
  expect(await marked(ui)).toBe('stop-tool-r-d')
  await ui.press({ key: 'tab-conversation' })
  expect((await texts(ui)).filter(text => text === 'line')).toHaveLength(13)
  await keys(ui, 'kkkkk')
  expect(await marked(ui)).toMatch(/^stop-row-/)
  await keys(ui, 'y')
  expect(cli.copied).toEqual(['Fixed: the regex rejected plus addressing.'])
})

test('i writes in insert mode: the composer sends while the run is idle, and an empty Enter is back to normal mode', async ($, on) => {
  const cli = fake()
  cli.watch = [{ type: 'reset', thread: ID, entries: ENTRIES.slice(0, -1) }, state('idle'), live()]
  const { nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  expect((await ui.find({ type: 'Input', key: 'compose' }))?.props).toMatchObject({ placeholder: 'Message the agent…  (i to write)', submitLabel: 'send' })
  await keys(ui, 'i')
  expect((await ui.find({ type: 'Input', key: 'compose' }))?.props).toMatchObject({ placeholder: 'Message the agent…', autoFocus: true })
  expect(await mode(ui)).toBe('INSERT')
  await ui.input({ key: 'compose', text: '-n add a test' })
  expect(cli.runs).toContainEqual(['send', '--json', ID, '--', '-n add a test'])
  expect(await mode(ui)).toBe('INSERT')
  await ui.input({ key: 'compose', text: '' })
  expect(await mode(ui)).toBe('NORMAL')
  expect(await ui.find({ type: 'Input', key: 'compose' })).toBeDefined()
})

test('Esc from the composer, which hands the keys to the prompt, is back to normal mode with the keys taken back', async ($, on) => {
  const cli = fake()
  const { clock, nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  await keys(ui, 'a')
  expect(await mode(ui)).toBe('INSERT')
  const opens = cli.opens
  const props = { title: 'Nexus', bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} }
  await ui.redraw({ ...props, isFocused: false } as never)
  await clock.advance(1)
  expect(cli.opens).toBe(opens + 1)
  await ui.redraw({ ...props, isFocused: true } as never)
  expect(await mode(ui)).toBe('NORMAL')
})

test("a composer the thread's change takes away leaves the letters to the keys: m then Unarchive", async ($, on) => {
  const cli = fake()
  const idle = { type: 'reset', thread: ID, entries: ENTRIES.slice(0, -1) }
  cli.watch = [idle, state('idle'), live(), { delay: 5_000 }, state('idle', { status: 'archived', pylon: 'paused' })]
  const { clock, nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  await keys(ui, 'i')
  await clock.advance(5_000)
  expect(await ui.find({ type: 'Input', key: 'compose' })).toBeUndefined()
  expect(await shows(ui, /^An archived thread takes no messages/)).toBe(true)
  expect(await mode(ui)).toBe('NORMAL')
  await keys(ui, 'm')
  await ui.press({ key: 'menu-unarchive' })
  expect(cli.runs).toContainEqual(['unarchive', '--json', ID])
})

test('a conversation too big to draw drops its oldest steps, says so at the top, and keeps the keys', async ($, on) => {
  const ids = ['e1', 'e2', 'e3', 'e4', 'e5', 'e6']
  // Each patch is under the row's bound, and six of them are past what one drawing takes.
  const patch = (n: number) => ['@@ -1,340 +1,340 @@', ...Array.from({ length: 340 }, (_, line) => ` line ${n}-${line} ${'x'.repeat(40)}`)].join('\n')
  const cli = fake()
  cli.watch = [
    {
      type: 'reset',
      thread: ID,
      entries: [
        ENTRIES[0],
        { entry: { id: 2, model: [{ role: 'assistant', content: ids.map(id => ({ type: 'toolCall', id, name: 'edit', arguments: { path: `src/${id}.ts`, edits: [] } })) }] }, text: '' },
        ...ids.map((id, n) => ({ entry: { id: 3 + n, model: [{ role: 'toolResult', toolCallId: id, toolName: 'edit', content: [{ type: 'text', text: 'ok' }], isError: false, details: { diff: '', patch: patch(n) } }] }, text: '' })),
      ],
    },
    state('idle'),
    live(),
  ]
  const { nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  await ui.press({ key: 'fold-e1' })
  for (const id of ids) if (await ui.find({ type: 'Button', key: `tool-${id}` })) await ui.press({ key: `tool-${id}` })
  expect(await ui.find({ type: 'Button', key: 'tool-e6' })).toBeDefined()
  await expectWhole(ui)
  await keys(ui, 'gg')
  expect(await shows(ui, /^… \d+ earlier blocks? left out of the pane$/)).toBe(true)
  expect(await ui.find({ type: 'Button', key: 'tool-e1' })).toBeUndefined()
  await expectWhole(ui)
})

test("running calls' live output counts toward what the conversation draws", async ($, on) => {
  const ids = Array.from({ length: 60 }, (_, n) => `call_b${n}|fc_${n}`)
  const cli = fake()
  cli.watch = [
    { type: 'reset', thread: ID, entries: [ENTRIES[0], { entry: { id: 2, model: [{ role: 'assistant', content: ids.map(id => ({ type: 'toolCall', id, name: 'bash', arguments: { command: 'make' } })) }] }, text: '' }] },
    state('working'),
    // The newest call has printed nothing yet, as a real live event says of one just started.
    live({ tools: ids.map((callId, n) => ({ callId, output: n === 59 ? '' : 'x'.repeat(2_000) })) }),
  ]
  const { nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  expect(await ui.find({ type: 'Button', key: 'tool-call_b59|fc_59' })).toBeDefined()
  expect(await shows(ui, 'Running…')).toBe(true)
  await expectWhole(ui)
  await keys(ui, 'gg')
  expect(await shows(ui, /^… \d+ earlier blocks left out of the pane$/)).toBe(true)
  expect(await ui.find({ type: 'Button', key: 'tool-call_b0|fc_0' })).toBeUndefined()
})

test('a hostile mix of tool names, live output, big diffs and long answers stays under the cap, measured as drawn', async ($, on) => {
  const answer = (id: number, text: string) => ({ entry: { id, model: [{ role: 'assistant', content: [{ type: 'text', text }] }] }, text: '' })
  const calls = (id: number, parts: { id: string; name: string; args: unknown }[]) => ({ entry: { id, model: [{ role: 'assistant', content: parts.map(part => ({ type: 'toolCall', id: part.id, name: part.name, arguments: part.args })) }] }, text: '' })
  const result = (id: number, callId: string, name: string, text: string, details?: unknown) => ({ entry: { id, model: [{ role: 'toolResult', toolCallId: callId, toolName: name, content: [{ type: 'text', text }], isError: false, ...(details ? { details } : {}) }] }, text: '' })
  // 150 calls of distinct 128-character tools fold under one line that names them all.
  const named = Array.from({ length: 150 }, (_, n) => ({ id: `n${n}`, name: `${n}-${'t'.repeat(124)}`, args: { command: 'go' } }))
  const patch = (n: number) => ['@@ -1,300 +1,300 @@', ...Array.from({ length: 300 }, (_, line) => ` ${n}-${line} ${'d'.repeat(50)}`)].join('\n')
  const edits = Array.from({ length: 8 }, (_, n) => ({ id: `e${n}`, name: 'edit', args: { path: `src/${n}.ts`, edits: [] } }))
  const running = Array.from({ length: 40 }, (_, n) => ({ id: `call_r${n}|fc_${n}`, name: 'bash', args: { command: `job ${n}` } }))
  const cli = fake()
  cli.watch = [
    {
      type: 'reset',
      thread: ID,
      entries: [
        ENTRIES[0],
        calls(2, named),
        ...named.map((call, n) => result(3 + n, call.id, call.name, 'ok')),
        answer(200, 'a'.repeat(59_500)),
        calls(201, edits),
        ...edits.map((call, n) => result(202 + n, call.id, 'edit', 'ok', { diff: '', patch: patch(n) })),
        answer(220, `${'long answer '.repeat(5_000)}`),
        calls(221, running),
      ],
    },
    state('working'),
    live({ tools: running.map(call => ({ callId: call.id, output: 'o'.repeat(2_000) })), partial: 'p'.repeat(30_000), queued: ['q'.repeat(20_000)] }),
  ]
  const { nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  await expectWhole(ui)
  // Opening every fold and row drawn, at each page up, only moves what is left out.
  const pressable = async (prefix: string) => (await ui.findAll({ type: 'Button' })).flatMap(one => (one.key?.startsWith(prefix) ? [one.key] : []))
  for (let page = 0; page < 6; page += 1) {
    for (const key of await pressable('fold-')) await ui.press({ key })
    for (const key of await pressable('tool-')) if (await ui.find({ type: 'Button', key })) await ui.press({ key })
    await expectWhole(ui)
    await keys(ui, 'u')
  }
  await keys(ui, 'gg')
  expect(await shows(ui, /left out of the pane$/)).toBe(true)
  await expectWhole(ui)
})

test('a fold of many distinct long tools keeps its line to one row and draws its steps', async ($, on) => {
  // 150 distinct 700-character tools, all running, so the fold opens itself over 105000 characters of names.
  const calls = Array.from({ length: 150 }, (_, n) => ({ type: 'toolCall', id: `c${n}`, name: `${n}-${'n'.repeat(696)}`, arguments: { command: 'go' } }))
  const cli = fake()
  cli.watch = [{ type: 'reset', thread: ID, entries: [ENTRIES[0], { entry: { id: 2, model: [{ role: 'assistant', content: calls }] }, text: '' }] }, state('working'), live()]
  const { nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  expect(await ui.find({ type: 'Button', key: 'tool-c149' })).toBeDefined()
  await keys(ui, 'gg')
  const line = (await ui.find({ type: 'Button', key: 'fold-c0' }))?.text ?? ''
  expect(line).toMatch(/^⏺ Called 0-n+/)
  expect(line.length).toBeLessThan(140)
  await expectWhole(ui)
})

test('a cut tree leaves out what does not fit without leaving a null in its place', () => {
  const button = (label: string) => ({ type: 'Button', props: { label }, children: undefined })
  const diff = { type: 'Code', props: { format: 'diff', source: `@@ -1 +1 @@\n-${'a'.repeat(40)}\n+${'b'.repeat(40)}` }, children: undefined }
  const tree = {
    type: 'Box',
    props: {},
    children: [
      { type: 'Text', props: {}, children: ['kept'] },
      button('a label drawn whole or not at all'),
      { type: 'Box', props: {}, children: [button('another label too long to fit'), diff] },
      { type: 'Text', props: {}, children: ['past the room'] },
    ],
  }
  const cut = cutTree(tree, 12)
  expect(holes(cut.node)).toEqual([])
  expect(cut.used).toBeLessThanOrEqual(12)
  expect(carried(cut.node)).toBe(cut.used)
  expect(JSON.stringify(cut.node)).toContain('kept')
  expect(JSON.stringify(cut.node)).not.toContain('Button')
})

test('a newest answer bigger than a drawing is cut with a note, the keys kept', async ($, on) => {
  const cli = fake()
  cli.watch = [{ type: 'reset', thread: ID, entries: [ENTRIES[0], { entry: { id: 2, model: [{ role: 'assistant', content: [{ type: 'text', text: 'word '.repeat(30_000) }] }] }, text: '' }] }, state('idle'), live()]
  const { nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  expect(await shows(ui, /^… \d+ more characters of this step left out of the pane$/)).toBe(true)
  await expectWhole(ui)
  await keys(ui, 'gg')
  expect(await shows(ui, /^… 1 earlier block left out of the pane$/)).toBe(true)
})

test('a newest step opened past what a drawing takes is cut with a note', async ($, on) => {
  const items = Array.from({ length: 40 }, (_, n) => `${n}${'y'.repeat(3_999)}`)
  const cli = fake()
  cli.watch = [{ type: 'reset', thread: ID, entries: [ENTRIES[0], { entry: { id: 2, model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'big', name: 'bash', arguments: { command: 'make', items } }] }] }, text: '' }] }, state('working'), live()]
  const { nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  await keys(ui, 'o')
  expect(await shows(ui, /^… \d+ more characters of this step left out of the pane$/)).toBe(true)
  await expectWhole(ui)
})

test('an edit whose call holds more replacements than a drawing takes says how many it left out', async ($, on) => {
  const edits = Array.from({ length: 14 }, (_, n) => ({ oldText: `${n}${'o'.repeat(3_999)}`, newText: `${n}${'n'.repeat(3_999)}` }))
  const cli = fake()
  cli.watch = [
    {
      type: 'reset',
      thread: ID,
      entries: [
        ENTRIES[0],
        { entry: { id: 2, model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'e1', name: 'edit', arguments: { path: 'src/a.ts', edits } }] }] }, text: '' },
        { entry: { id: 3, model: [{ role: 'toolResult', toolCallId: 'e1', toolName: 'edit', content: [{ type: 'text', text: 'ok' }], isError: false }] }, text: '' },
      ],
    },
    state('idle'),
    live(),
  ]
  const { nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  expect(String((await ui.find({ type: 'Code' }))?.props.source).length).toBeLessThanOrEqual(20_000)
  expect(await shows(ui, /12 more replacements left out of the pane/)).toBe(true)
})

/** The Actions menu's entries, in order. */
const menu = async (ui: Ui) => (await ui.findAll({ type: 'Button' })).flatMap(one => (one.key?.startsWith('menu-') ? [one.key.slice(5)] : []))

test('m opens the Actions menu: j and k move its cursor, o runs the entry, q closes it; a busy run queues and aborts', async ($, on) => {
  const cli = fake()
  const { nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  await keys(ui, 'i')
  expect((await ui.find({ type: 'Input', key: 'compose' }))?.props).toMatchObject({ placeholder: 'Queue a follow-up…', submitLabel: 'queue' })
  await ui.input({ key: 'compose', text: '' })
  await keys(ui, 'm')
  expect(await menu(ui)).toEqual(['abort', 'archive', 'copy-attach', 'rewatch', 'delete'])
  expect(await cursorOn(ui)).toBe('menu-abort')
  await keys(ui, 'jj')
  expect(await cursorOn(ui)).toBe('menu-copy-attach')
  await keys(ui, 'q')
  expect(await menu(ui)).toEqual([])
  expect(await ui.find({ type: 'Markdown' })).toBeDefined()
  await keys(ui, 'mo')
  expect(cli.runs).toContainEqual(['abort', '--json', ID])
  expect(await menu(ui)).toEqual([])
})

test('parked tasks hold the run: the line says so and the menu retries them', async ($, on) => {
  const cli = fake()
  cli.watch = [{ type: 'reset', thread: ID, entries: ENTRIES.slice(0, -1) }, state('parked', { parkedTasks: 2 }), live()]
  const { nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  expect((await ui.find({ type: 'Text', text: /restart limit/ }))?.props).toMatchObject({ color: 'warning' })
  expect(await shows(ui, '⚠ 2 tasks hit the restart limit and hold the run. m then Retry the parked tasks.')).toBe(true)
  await keys(ui, 'm')
  expect(await menu(ui)).not.toContain('abort')
  await ui.press({ key: 'menu-retry' })
  expect(cli.runs).toContainEqual(['retry', '--json', ID])
})

test('a failed pylon replaces the composer; the menu retries it or starts again from its project and title', async ($, on) => {
  const failure = 'setup failed: git clone exited 128'
  const cli = fake({ detail: { ...DETAIL, pylon: { ...DETAIL.pylon, actualState: 'failed', failed: failure } } })
  cli.watch = [{ type: 'reset', thread: ID, entries: ENTRIES.slice(0, -1) }, state('idle', { pylon: 'failed', failed: failure }), live()]
  const { nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  expect(await shows(ui, /^The planner gave up on this thread's pylon/)).toBe(true)
  expect((await ui.find({ type: 'Code', text: failure }))?.text).toBe(failure)
  expect(await ui.find({ type: 'Input', key: 'compose' })).toBeUndefined()
  await keys(ui, 'i')
  expect(await mode(ui)).toBe('NORMAL')
  await keys(ui, 'm')
  expect(await menu(ui)).toEqual(expect.arrayContaining(['retry-pylon', 'start-again']))
  await ui.press({ key: 'menu-retry-pylon' })
  expect(cli.runs).toContainEqual(['retry-pylon', '--json', ID])
  await keys(ui, 'm')
  await ui.press({ key: 'menu-start-again' })
  expect(cli.runs).toContainEqual(['projects', '--json'])
  expect((await ui.find({ type: 'Input', key: 'start-title' }))?.props.value).toBe('Fix login form 500s')
  expect((await ui.find({ type: 'Select', key: 'start-project' }))?.props.value).toBe('web')
})

test('a pylon whose node says a retry cannot help offers no retry, and says why', async ($, on) => {
  const cli = fake({ detail: { ...DETAIL, pylon: { ...DETAIL.pylon, actualState: 'failed', failed: 'disk lost', retryRefused: 'The pylon has no disk to resume from' } } })
  cli.watch = [{ type: 'reset', thread: ID, entries: ENTRIES.slice(0, -1) }, state('idle', { pylon: 'failed', failed: 'disk lost' }), live()]
  const { clock, nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  await clock.settle()
  const ui = await mount()
  expect(await shows(ui, 'The pylon has no disk to resume from.')).toBe(true)
  await keys(ui, 'm')
  expect(await menu(ui)).not.toContain('retry-pylon')
  expect(await menu(ui)).toContain('start-again')
})

test('the menu archives an open thread', async ($, on) => {
  const cli = fake()
  const { nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  await keys(ui, 'm')
  await ui.press({ key: 'menu-archive' })
  expect(cli.runs).toContainEqual(['archive', '--json', ID])
})

test('an archived thread says why it takes no messages, records no visit, and the menu unarchives it', async ($, on) => {
  const archived = { ...THREAD, status: 'archived', agentTurnRunning: false }
  const cli = fake({ threads: [archived], detail: { ...DETAIL, thread: archived } })
  cli.watch = [{ type: 'reset', thread: ID, entries: ENTRIES.slice(0, -1) }, state('idle', { status: 'archived', pylon: 'paused' }), live()]
  const { nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  expect(await shows(ui, /^An archived thread takes no messages/)).toBe(true)
  // An archived thread's visit is not human activity: its pylon stays paused.
  expect(cli.runs.some(argv => argv[0] === 'wake')).toBe(false)
  await keys(ui, 'm')
  expect(await menu(ui)).not.toContain('archive')
  await ui.press({ key: 'menu-unarchive' })
  expect(cli.runs).toContainEqual(['unarchive', '--json', ID])
})

test('delete names the thread and asks first, Keep being the default', async ($, on) => {
  const cli = fake()
  const { nexus, mount } = await boot($, on, cli)
  await nexus('')
  await nexus(`open ${ID}`)
  const ui = await mount()
  await keys(ui, 'm')
  await ui.press({ key: 'menu-delete' })
  expect(cli.asked).toEqual(['"Fix login form 500s" (th-4f2a00000001) and its pylon and conversation will be removed. Delete it?'])
  expect(cli.runs.some(argv => argv[0] === 'delete')).toBe(false)
  expect(await shows(ui, `Kept ${ID}.`)).toBe(true)
  cli.answer = 'Delete'
  await keys(ui, 'm')
  await ui.press({ key: 'menu-delete' })
  expect(cli.runs).toContainEqual(['delete', '--json', ID])
})

test('s shows the keys over the view, and q, s or h closes them', async ($, on) => {
  const cli = fake()
  const { nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  await keys(ui, 's')
  expect(await shows(ui, /^ {2}g g · g e\s+top · bottom/)).toBe(true)
  expect(await shows(ui, /vim's G, ctrl\+d, ctrl\+u, \/ and \? are g e, d, u, f and s here/)).toBe(true)
  expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
  // A key the help does not take does nothing under it.
  await keys(ui, 'm')
  expect(await shows(ui, /^ {2}g g · g e/)).toBe(true)
  await keys(ui, 'q')
  expect(await ui.find({ type: 'Markdown' })).toBeDefined()
  await keys(ui, 'sh')
  expect(await ui.find({ type: 'Markdown' })).toBeDefined()
  expect(await shows(ui, /^‹ web \/ Fix login form 500s$/)).toBe(true)
})

test('the help shows over the list too, and scrolls when the pane is too short for it', async ($, on) => {
  const cli = fake({ threads: THREADS.map(thread => ({ ...thread, agentTurnRunning: false })) })
  const { nexus, mount } = await boot($, on, cli)
  await nexus('')
  const ui = await mount(80, 16)
  const first = await cursorOn(ui)
  /** How far the help is scrolled: the rows it hides above the body. */
  const scrolled = async () => -((await ui.find({ type: 'Box', key: 'help' }))?.props.marginTop as number) || 0
  await keys(ui, 's')
  expect(await shows(ui, /^ {2}g g · g e\s+top · bottom/)).toBe(true)
  expect(await scrolled()).toBe(0)
  await keys(ui, 'jj')
  expect(await scrolled()).toBe(2)
  await keys(ui, 'ge')
  const most = await scrolled()
  expect(most).toBeGreaterThan(2)
  await keys(ui, 'j')
  expect(await scrolled()).toBe(most)
  await keys(ui, 'q')
  expect(await ui.find({ type: 'Box', key: 'help' })).toBeUndefined()
  expect(await cursorOn(ui)).toBe(first)
})

test("opening a thread records one visit, and its show poll stands in for the list's", async ($, on) => {
  const cli = fake()
  const { clock, nexus } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  expect(cli.runs.filter(argv => argv[0] === 'wake')).toEqual([['wake', '--json', ID]])
  const before = cli.spawns.length
  await clock.advance(5_000)
  const polled = cli.spawns.slice(before).filter(argv => argv[0] !== 'watch')
  expect(polled).toEqual([['show', '--json', ID]])
  expect(cli.runs.filter(argv => argv[0] === 'wake')).toHaveLength(1)
})

test('l walks the tabs: Details shows the pylon, outputs, sessions and the attach command y copies; h walks back to the list', async ($, on) => {
  const cli = fake()
  const { nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  await keys(ui, 'l')
  const rows = await texts(ui, 'Box')
  expect(rows).toEqual(expect.arrayContaining(['Desired    ● running', 'Observed   ● running', 'Node       firebat', 'Last seen  just now', 'Human      2 min ago', 'Agent      turn running']))
  // The preview output is the preview Ports lists, so the outputs leave it out.
  expect(await shows(ui, /^OUTPUTS 1 ─/, 'Box')).toBe(true)
  expect(await shows(ui, /^branch\s+fix\/login-plus$/, 'Box')).toBe(true)
  expect(await shows(ui, /^Claude Code◉ workingnexus:1\.2session 9c1e$/, 'Box')).toBe(true)
  expect(await ui.find({ type: 'Link' })).toBeUndefined()
  await keys(ui, 'y')
  expect(cli.copied).toEqual(['herdr --session nexus-7f3a'])
  expect(await shows(ui, 'Copied: herdr --session nexus-7f3a')).toBe(true)
  await expectThemeColours(ui)
  await keys(ui, 'h')
  expect(await ui.find({ type: 'Markdown' })).toBeDefined()
  await keys(ui, 'h')
  expect(await cursorOn(ui)).toBe(ID)
})

/** The Ports tab: l twice from the conversation. */
const toPorts = (ui: Ui) => keys(ui, 'll')

test('Ports lists the previews linked by their own URL and the ports with none, each once, under a cursor', async ($, on) => {
  const cli = fake()
  const { nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  await toPorts(ui)
  expect((await ui.findAll({ type: 'Link' })).map(link => [link.props.href, link.text])).toEqual([[WEB_PREVIEW.url, WEB_PREVIEW.url]])
  expect((await ui.find({ type: 'Button', key: 'preview-web' }))?.text).toBe('❯ ● web :3000  ready ')
  expect(await shows(ui, /^ {4}⏎ or y copies the URL$/)).toBe(true)
  expect(await shows(ui, /^ {2}◐ api {2}starting https:\/\/rj-firebat\.example\.ts\.net:10202\/$/, 'Box')).toBe(true)
  // Each port once: 3000 has its preview above, so Ports lists the other two.
  expect(await shows(ui, /^PORTS 2 ─/, 'Box')).toBe(true)
  expect((await ui.find({ type: 'Button', key: 'port-5173' }))?.text).toBe('  ◌ 5173 not published')
  expect(await shows(ui, /^ {2}◌ 9229 {2}worker, a service with no preview$/, 'Box')).toBe(true)
  expect(await ui.find({ type: 'Button', key: 'port-9229' })).toBeUndefined()
  expect(await ui.find({ key: 'port-3000' })).toBeUndefined()
  await keys(ui, 'jj')
  expect(await cursorOn(ui)).toBe('port-5173')
  expect((await ui.find({ type: 'Button', key: 'port-5173' }))?.text).toBe('❯ ◌ 5173 not published; ⏎ publishes it')
  await expectThemeColours(ui)
})

test("a preview's link is the CLI's URL, with or without the nodes", async ($, on) => {
  const cli = fake({ fail: { nodes: { exitCode: 1, error: 'the API answered 404' } } })
  const { nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  await toPorts(ui)
  expect((await ui.findAll({ type: 'Link' })).map(link => link.props.href)).toEqual([WEB_PREVIEW.url])
})

test('o on a port publishes it: progress while the CLI waits, then Previews lists it with its link, before the details do', async ($, on) => {
  const cli = fake({ slow: { preview: 3_000 } })
  const { clock, nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  await toPorts(ui)
  await keys(ui, 'ge')
  expect(await cursorOn(ui)).toBe('port-5173')
  await keys(ui, 'o')
  expect(cli.spawns).toContainEqual(['preview', '--json', ID, '5173', '--wait'])
  expect((await ui.find({ type: 'Button', key: 'port-5173' }))?.text).toBe('❯ ◐ 5173 opening: publishing it and waiting for the node to serve its URL…')
  await ui.press({ key: 'port-5173' })
  expect(cli.spawns.filter(argv => argv[0] === 'preview')).toHaveLength(1)
  const polled = cli.spawns.filter(argv => argv[0] === 'show').length
  await clock.advance(3_000)
  expect((await ui.find({ type: 'Link', text: OPENED.url }))?.props.href).toBe(OPENED.url)
  expect(await ui.find({ key: 'port-5173' })).toBeUndefined()
  expect((await ui.find({ type: 'Button', key: 'preview-port-5173' }))?.text).toMatch(/● port-5173 {2}ready $/)
  expect(cli.spawns.filter(argv => argv[0] === 'show').length).toBeGreaterThan(polled)
  // The next details list it too, once.
  cli.detail = PUBLISHED
  await clock.advance(5_000)
  expect(await ui.find({ key: 'port-5173' })).toBeUndefined()
  expect(await shows(ui, /^PORTS 1 ─/, 'Box')).toBe(true)
  expect(await ui.findAll({ type: 'Button', key: 'preview-port-5173' })).toHaveLength(1)
})

test('a port that does not open says why, and opens again when pressed', async ($, on) => {
  const cli = fake({ fail: { preview: { exitCode: 5, error: 'the pylon is not running' } } })
  const { nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  await toPorts(ui)
  await ui.press({ key: 'port-5173' })
  expect((await ui.find({ type: 'Button', key: 'port-5173' }))?.text).toBe('  ✕ 5173 did not open; ⏎ tries again')
  expect((await ui.find({ type: 'Text', text: /the pylon is not running/ }))?.props).toMatchObject({ color: 'error' })
  delete cli.fail.preview
  await ui.press({ key: 'port-5173' })
  expect(cli.spawns.filter(argv => argv[0] === 'preview')).toHaveLength(2)
  expect(await ui.find({ type: 'Link', text: OPENED.url })).toBeDefined()
})

/** Moves the Ports cursor down to `key`. */
async function cursorTo(ui: Ui, key: string) {
  for (let step = 0; step < 8 && (await cursorOn(ui)) !== key; step += 1) await keys(ui, 'j')
  expect(await cursorOn(ui)).toBe(key)
}

test("x unpublishes the linked preview under the cursor: closing… while the CLI runs, then the port is back under Ports", async ($, on) => {
  const cli = fake({ detail: PUBLISHED, slow: { unpreview: 3_000 } })
  const { clock, nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  await toPorts(ui)
  expect(await shows(ui, /^PREVIEWS 3 ─/, 'Box')).toBe(true)
  await cursorTo(ui, 'preview-port-5173')
  expect(await shows(ui, /^ {4}⏎ or y copies the URL · x unpublishes it \(a new publish may get a new URL\)$/)).toBe(true)
  await keys(ui, 'x')
  expect(cli.spawns).toContainEqual(['unpreview', '--json', ID, '5173'])
  expect((await ui.find({ type: 'Button', key: 'preview-port-5173' }))?.text).toMatch(/closing… $/)
  expect(await ui.find({ type: 'Link', text: OPENED.url })).toBeUndefined()
  // Nothing else starts on the port while it closes.
  await keys(ui, 'x')
  expect(cli.spawns.filter(argv => argv[0] === 'unpreview')).toHaveLength(1)
  expect(await shows(ui, 'It is closing already.')).toBe(true)
  const polled = cli.spawns.filter(argv => argv[0] === 'show').length
  await clock.advance(3_000)
  expect(cli.spawns.filter(argv => argv[0] === 'show').length).toBeGreaterThan(polled)
  // Closed: Ports lists it again, publishable, before the details catch up.
  expect(await shows(ui, /^PREVIEWS 2 ─/, 'Box')).toBe(true)
  expect(await shows(ui, /^PORTS 2 ─/, 'Box')).toBe(true)
  expect((await ui.find({ type: 'Button', key: 'port-5173' }))?.text).toMatch(/◌ 5173 not published/)
  cli.detail = DETAIL
  await clock.advance(5_000)
  expect((await ui.find({ type: 'Button', key: 'port-5173' }))?.text).toMatch(/◌ 5173 not published/)
  expect(cli.spawns.filter(argv => argv[0] === 'unpreview')).toHaveLength(1)
})

test('a preview that does not close says why on its row and keeps its link; an old CLI names the version it needs', async ($, on) => {
  const cli = fake({ detail: PUBLISHED, fail: { unpreview: { exitCode: 2, error: 'the node firebat cannot be reached' } } })
  const { nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  await toPorts(ui)
  await cursorTo(ui, 'preview-port-5173')
  await keys(ui, 'x')
  expect((await ui.find({ type: 'Text', text: /the node firebat cannot be reached\.$/ }))?.props).toMatchObject({ color: 'error' })
  expect(await ui.find({ type: 'Link', text: OPENED.url })).toBeDefined()
  cli.fail.unpreview = { exitCode: 64, error: 'unknown command unpreview' }
  await keys(ui, 'x')
  expect(await shows(ui, /nexus has no unpreview command: unpublishing a preview needs Nexus CLI 0.3.0 or later \(nexus --version\)\.$/)).toBe(true)
})

test('a publish still waiting is not offered for unpublishing, even once the details list its preview', async ($, on) => {
  const cli = fake({ slow: { preview: 10_000 } })
  const { clock, nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  await toPorts(ui)
  await ui.press({ key: 'port-5173' })
  // The control plane allocates the preview while `preview --wait` still waits for the node to serve it.
  const allocated = { ...OPENED, ready: false }
  cli.detail = { ...DETAIL, previews: [...DETAIL.previews, allocated], ports: DETAIL.ports.map(one => (one.port === 5173 ? { ...one, preview: allocated } : one)) }
  await clock.advance(5_000)
  expect((await ui.find({ type: 'Button', key: 'preview-port-5173' }))?.text).toMatch(/opening… $/)
  await cursorTo(ui, 'preview-port-5173')
  await keys(ui, 'x')
  expect(cli.spawns.some(argv => argv[0] === 'unpreview')).toBe(false)
  expect(await shows(ui, 'Its publish is still under way.')).toBe(true)
  cli.detail = PUBLISHED
  await clock.advance(5_000)
  expect(await ui.find({ type: 'Link', text: OPENED.url })).toBeDefined()
  await keys(ui, 'x')
  expect(cli.spawns).toContainEqual(['unpreview', '--json', ID, '5173'])
})

test('a publish under way is still known after leaving the thread and opening it again, and nothing else starts on its port', async ($, on) => {
  const cli = fake({ slow: { preview: 20_000 } })
  const { clock, nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  await toPorts(ui)
  await ui.press({ key: 'port-5173' })
  await keys(ui, 'hhh')
  expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
  await nexus(`open ${ID}`)
  await toPorts(ui)
  expect((await ui.find({ type: 'Button', key: 'port-5173' }))?.text).toMatch(/◐ 5173 opening: publishing it and waiting for the node to serve its URL…$/)
  // The control plane lists the allocated preview while `preview --wait` still waits.
  const allocated = { ...OPENED, ready: false }
  cli.detail = { ...DETAIL, previews: [...DETAIL.previews, allocated], ports: DETAIL.ports.map(one => (one.port === 5173 ? { ...one, preview: allocated } : one)) }
  await clock.advance(5_000)
  await cursorTo(ui, 'preview-port-5173')
  await keys(ui, 'x')
  expect((await ui.find({ type: 'Button', key: 'preview-port-5173' }))?.text).toMatch(/opening… $/)
  await clock.advance(15_000)
  expect(await ui.find({ type: 'Link', text: OPENED.url })).toBeDefined()
  expect(cli.spawns.filter(argv => argv[0] === 'preview' || argv[0] === 'unpreview')).toHaveLength(1)
})

test('the details asked for right after a publish ends count, even in the same millisecond: a preview another client closed at once does not linger', async ($, on) => {
  const cli = fake({ slow: { preview: 3_000 }, publishes: false })
  const { clock, nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  await toPorts(ui)
  await ui.press({ key: 'port-5173' })
  const polled = cli.spawns.filter(argv => argv[0] === 'show').length
  await clock.advance(3_000)
  expect(cli.spawns.filter(argv => argv[0] === 'show').length).toBe(polled + 1)
  expect(await ui.find({ type: 'Link', text: OPENED.url })).toBeUndefined()
  expect((await ui.find({ type: 'Button', key: 'port-5173' }))?.text).toMatch(/◌ 5173 not published/)
})

test('a port unpublished then published again before the details catch up stays under Ports, and says why the publish failed', async ($, on) => {
  const cli = fake({ detail: PUBLISHED })
  const { clock, nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  await toPorts(ui)
  // From here the details lag: every `show` hangs, so the pane keeps the snapshot that lists the preview.
  cli.slow.show = 600_000
  await cursorTo(ui, 'preview-port-5173')
  await keys(ui, 'x')
  expect(await shows(ui, /^PREVIEWS 2 ─/, 'Box')).toBe(true)
  cli.slow.preview = 3_000
  cli.fail.preview = { exitCode: 1, error: 'the node did not serve the preview within 120 s' }
  await ui.press({ key: 'port-5173' })
  expect(await shows(ui, /^PREVIEWS 2 ─/, 'Box')).toBe(true)
  expect((await ui.find({ type: 'Button', key: 'port-5173' }))?.text).toMatch(/◐ 5173 opening: publishing it and waiting for the node to serve its URL…$/)
  await clock.advance(3_000)
  expect(await shows(ui, /^PREVIEWS 2 ─/, 'Box')).toBe(true)
  expect(await ui.find({ type: 'Link', text: OPENED.url })).toBeUndefined()
  expect((await ui.find({ type: 'Button', key: 'port-5173' }))?.text).toMatch(/✕ 5173 did not open; ⏎ tries again$/)
  expect((await ui.find({ type: 'Text', text: /the node did not serve the preview within 120 s\.$/ }))?.props).toMatchObject({ color: 'error' })
})

test("x says why a service's preview, or an archived thread's, cannot be unpublished", async ($, on) => {
  const cli = fake()
  const { clock, nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  await toPorts(ui)
  await keys(ui, 'x')
  expect(await shows(ui, "web is a declared service's preview, which can't be unpublished.")).toBe(true)
  const archived = { ...THREAD, status: 'archived', agentTurnRunning: false }
  cli.detail = { ...PUBLISHED, thread: archived }
  await clock.advance(5_000)
  expect(await ui.find({ type: 'Link', text: OPENED.url })).toBeUndefined()
  expect((await ui.find({ type: 'Button', key: 'preview-port-5173' }))?.text).toMatch(/ paused $/)
  await cursorTo(ui, 'preview-port-5173')
  await keys(ui, 'x')
  expect(await shows(ui, "An archived thread's previews can't be unpublished.")).toBe(true)
  expect(cli.spawns.some(argv => argv[0] === 'unpreview')).toBe(false)
})

test('with no port to open, Ports says why: nothing listens and the ::1 hint, a pylon not running, or ports unknown', async ($, on) => {
  const hint = "A server bound only to ::1 can't be previewed, so bind it to 0.0.0.0 or 127.0.0.1."
  const cli = fake({ detail: { ...DETAIL, ports: [] } })
  const { clock, nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  await toPorts(ui)
  expect(await shows(ui, `Nothing listens yet. ${hint}`)).toBe(true)
  cli.detail = { ...DETAIL, ports: [DETAIL.ports[0]] }
  await clock.advance(5_000)
  expect(await shows(ui, `Every port that listens is under Previews. ${hint}`)).toBe(true)
  cli.detail = { ...DETAIL, pylon: { ...DETAIL.pylon, actualState: 'paused' }, ports: [] }
  await clock.advance(5_000)
  expect(await shows(ui, 'Ports show while the pylon runs.')).toBe(true)
  cli.detail = { ...DETAIL, ports: null }
  await clock.advance(5_000)
  expect(await shows(ui, "The pylon's ports could not be read.")).toBe(true)
})

test('the start form offers the projects and nodes, starts with every field it was given, and shows the new thread', async ($, on) => {
  const cli = fake()
  const { nexus, mount } = await boot($, on, cli)
  await nexus('')
  const ui = await mount()
  await keys(ui, 'n')
  const project = await ui.find({ type: 'Select', key: 'start-project' })
  expect(project?.props).toMatchObject({ value: 'web', options: [{ value: 'web', label: 'web  git@github.com:me/web.git' }, { value: 'api', label: 'api  git@github.com:me/api.git' }] })
  expect((await ui.find({ type: 'Select', key: 'start-node' }))?.props.options).toEqual([
    { value: '', label: 'firebat (project default)' },
    { value: 'firebat', label: 'firebat' },
    { value: 'testbench', label: 'testbench, offline' },
  ])
  expect(await shows(ui, 'Boots a pylon on firebat and checks out main.')).toBe(true)
  await ui.select({ key: 'start-project', value: 'api' })
  expect(await shows(ui, 'Boots a pylon on testbench and checks out trunk.')).toBe(true)
  await ui.input({ key: 'start-title', text: 'New one', kind: 'change' })
  await ui.select({ key: 'start-node', value: 'firebat' })
  await ui.input({ key: 'start-branch', text: 'dev', kind: 'change' })
  await ui.input({ key: 'start-message', text: 'build it' })
  expect(cli.runs).toContainEqual(['start', '--json', '--project=api', '--title=New one', '--message=build it', '--node=firebat', '--branch=dev'])
  expect(cli.spawns).toContainEqual(['watch', 'th-123456789abc', '--json'])
  await expectThemeColours(ui)
})

test('a start the person left while it ran only says how it went', async ($, on) => {
  const cli = fake({ slow: { start: 5_000 } })
  const { clock, nexus, mount } = await boot($, on, cli)
  await nexus('')
  const ui = await mount()
  await keys(ui, 'h')
  await keys(ui, 'n')
  await ui.input({ key: 'start-title', text: 'New one' })
  await ui.press({ key: 'start-cancel' })
  await clock.advance(5_000)
  expect(cli.runs).toContainEqual(['start', '--json', '--project=web', '--title=New one'])
  expect(await shows(ui, 'Started New one.')).toBe(true)
  expect(await ui.find({ type: 'Button', key: ID })).toBeDefined()
  expect(cli.spawns.some(argv => argv[1] === 'th-123456789abc')).toBe(false)
})

test('a start the person left for another form does not take that form over', async ($, on) => {
  const cli = fake({ slow: { start: 5_000 } })
  const { clock, nexus, mount } = await boot($, on, cli)
  await nexus('')
  const ui = await mount()
  await keys(ui, 'h')
  await keys(ui, 'n')
  await ui.input({ key: 'start-title', text: 'First' })
  await clock.advance(2_000)
  await ui.press({ key: 'start-cancel' })
  await keys(ui, 'n')
  await ui.input({ key: 'start-title', text: 'Second' })
  await clock.advance(3_000)
  // The first start ended: the second form stays, still starting.
  expect((await ui.find({ type: 'Button', key: 'start-submit' }))?.props.label).toBe('Starting…')
  expect(await shows(ui, 'Started New one.')).toBe(true)
  expect(cli.spawns.some(argv => argv[1] === 'th-123456789abc')).toBe(false)
  await clock.advance(2_000)
  expect(cli.runs.filter(argv => argv[0] === 'start')).toHaveLength(2)
  expect(cli.spawns).toContainEqual(['watch', 'th-123456789abc', '--json'])
})

test('a start whose switch to the thread loses a race to a new form follows nothing', async ($, on) => {
  const cli = fake({ slow: { start: 5_000 } })
  let isRaced = false
  // As the start's update writes the thread view, another form lands first: the update runs again on that form.
  on('state.set', async (_, e, next) => {
    if (isRaced || e.key !== 'pane' || e.ifVersion === undefined || e.value.view !== 'thread' || e.value.selected !== 'th-123456789abc' || !e.previous?.start) return next(e)
    isRaced = true
    const landed = await next({ ...e, value: { ...e.previous, start: { ...e.previous.start, title: 'Other', isStarting: false, request: -1 } } })
    return landed.value ? { value: { isSet: false, version: landed.value.version } } : landed
  })
  const { clock, nexus, mount } = await boot($, on, cli)
  await nexus('')
  const ui = await mount()
  await keys(ui, 'h')
  await keys(ui, 'n')
  await ui.input({ key: 'start-title', text: 'New one' })
  await clock.advance(5_000)
  expect(isRaced).toBe(true)
  expect((await ui.find({ type: 'Input', key: 'start-title' }))?.props.value).toBe('Other')
  expect(await shows(ui, 'Started New one.')).toBe(true)
  expect(cli.spawns.some(argv => argv[1] === 'th-123456789abc')).toBe(false)
})

test('a start that ends after the pane closed watches nothing until the pane opens again', async ($, on) => {
  const cli = fake({ slow: { start: 5_000 } })
  const { clock, nexus, mount } = await boot($, on, cli)
  await nexus('')
  const ui = await mount()
  await keys(ui, 'h')
  await keys(ui, 'n')
  await ui.input({ key: 'start-title', text: 'New one' })
  await nexus('close')
  const watches = cli.spawns.filter(argv => argv[0] === 'watch').length
  await clock.advance(5_000)
  expect(cli.runs).toContainEqual(['start', '--json', '--project=web', '--title=New one'])
  expect(cli.spawns.filter(argv => argv[0] === 'watch')).toHaveLength(watches)
  await nexus('')
  expect(cli.spawns).toContainEqual(['watch', 'th-123456789abc', '--json'])
})

test('a start the control plane refuses stays on the form with its reason', async ($, on) => {
  const cli = fake({ fail: { start: { exitCode: 1, error: 'no image is current' } } })
  const { nexus, mount } = await boot($, on, cli)
  await nexus('')
  const ui = await mount()
  await keys(ui, 'n')
  await ui.press({ key: 'start-submit' })
  expect(await shows(ui, 'Give the thread a title or a first message.')).toBe(true)
  await ui.input({ key: 'start-title', text: 'Try it' })
  expect(await shows(ui, 'no image is current.')).toBe(true)
  expect(await ui.find({ type: 'Input', key: 'start-title' })).toBeDefined()
})

test('a row or a show without a field docs/cli.md requires is a contract error, not a guess', async ($, on) => {
  const { pylon: _, ...bare } = THREAD
  const { attach: __, ...noAttach } = DETAIL
  const cli = fake({ threads: [bare], detail: noAttach })
  const { nexus, mount } = await boot($, on, cli)
  await nexus('')
  const ui = await mount()
  expect(await shows(ui, /a row \(th-4f2a00000001\) without its pylon, which docs\/cli\.md requires: the CLI and this mod disagree/)).toBe(true)
  await nexus(`open ${ID}`)
  expect(await shows(ui, /^The thread's details did not load: .*printed no attach, which docs\/cli\.md requires/)).toBe(true)
})

test('the first open says once how to draw the pane on the terminal background', async ($, on) => {
  const cli = fake({ store: {} })
  const { nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  expect(await shows(ui, 'Tip: pick "Dark (ANSI), Nexus pane on the terminal background" in /theme to draw this pane on your terminal\'s background.')).toBe(true)
  await nexus('close')
  await nexus(`open ${ID}`)
  expect(await shows(ui, /^Tip: pick/)).toBe(false)
})

test('the dock paints its body and title bar; above the prompt it paints nothing of its own', async ($, on) => {
  const cli = fake()
  const { nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  const painted = async () => (await ui.findAll({ type: 'Box' })).flatMap(one => (typeof one.props.backgroundColor === 'string' ? [one.props.backgroundColor] : []))
  expect(await painted()).toEqual(expect.arrayContaining(['bashMessageBackgroundColor', 'userMessageBackground']))
  await ui.redraw({ title: 'Nexus', isFocused: true, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 60 }, view: {} } as never)
  expect(await painted()).toEqual(['userMessageBackground'])
})
