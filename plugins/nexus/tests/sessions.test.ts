import { expect, test } from 'claude-code/testing'

import { SSH_HINT } from '../hooks/model'
import { TOOLS } from '../hooks/tools'
import { DETAIL, ID, THEME_KEYS, boot, fake, field, typing } from './fake-cli'

type Ui = Awaited<ReturnType<Awaited<ReturnType<typeof boot>>['mount']>>

const shows = async (ui: Ui, text: string | RegExp) => (await ui.find({ text })) !== undefined
async function keys(ui: Ui, letters: string) {
  for (const letter of letters) await ui.press({ key: `key-${letter}` })
}
const cursorOn = async (ui: Ui) => (await ui.findAll({ type: 'Button' })).find(one => one.text.startsWith('❯'))?.key
const row = async (ui: Ui, pane: string) => (await ui.find({ type: 'Button', key: `session-${pane}` }))?.text
/** The Sessions tab: l three times from the conversation. */
const toSessions = (ui: Ui) => keys(ui, 'lll')

const CLAUDE = { herdrPane: 'nexus:1.2', harness: 'claude-code', harnessSessionId: '9c1e', status: 'working', title: 'claude', pylon: 'pylon-7f3a' }
const SHELL = { herdrPane: 'nexus:3.1', harness: 'shell', harnessSessionId: null, status: 'idle', title: null, pylon: 'pylon-7f3a' }
/** What `show` lists once the node reports the shell `session open` answered with `nexus:2.1`. */
const REPORTED = { herdrPane: 'nexus:2.1', harness: 'shell', harnessSessionId: null, status: 'idle', title: 'probe', pylon: 'pylon-7f3a' }

test('Sessions lists each session with its harness, title, state, pane and session ID, then how to attach from this Mac', async ($, on) => {
  const cli = fake({ detail: { ...DETAIL, sessions: [CLAUDE, SHELL] } })
  const { nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  expect((await ui.find({ type: 'Button', key: 'tab-sessions' }))?.text).toBe('Sessions 2')
  await toSessions(ui)
  expect(await row(ui, 'nexus:1.2')).toMatch(/^❯ Claude Code claude {2}◉ working {2}nexus:1\.2 {2}session 9c1e$/)
  expect(await row(ui, 'nexus:3.1')).toMatch(/^ {2}Shell {7}○ idle {2}nexus:3\.1$/)
  expect(await shows(ui, '⏎ or y copies nexus attach, x closes the session')).toBe(true)
  expect(await shows(ui, /^ATTACH FROM THIS MAC/)).toBe(true)
  expect(await shows(ui, `  nexus attach ${ID}`)).toBe(true)
  expect(await shows(ui, SSH_HINT)).toBe(true)
  await keys(ui, 'j')
  expect(await cursorOn(ui)).toBe('session-nexus:3.1')
  const painted = (await ui.findAll({})).flatMap(one => ['color', 'borderColor', 'backgroundColor'].flatMap(prop => (typeof one.props[prop] === 'string' ? [one.props[prop] as string] : [])))
  expect(painted.filter(colour => !THEME_KEYS.has(colour))).toEqual([])
})

test('a pylon with no sessions says n opens one, and Details no longer lists them', async ($, on) => {
  const cli = fake({ detail: { ...DETAIL, sessions: [] } })
  const { nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  expect((await ui.find({ type: 'Button', key: 'tab-sessions' }))?.text).toBe('Sessions')
  await toSessions(ui)
  expect(await shows(ui, 'No sessions. n opens one: Claude Code, pi or a shell.')).toBe(true)
  await keys(ui, 'x')
  expect(await shows(ui, 'No session to close. n opens one.')).toBe(true)
})

test('n opens the form: the harness and an optional title; Enter opens it, opening… while the CLI waits, then the session until the node reports it', async ($, on) => {
  const cli = fake({ detail: { ...DETAIL, sessions: [CLAUDE] }, slow: { 'session open': 20_000 } })
  const { clock, nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  await keys(ui, 'n')
  expect(await shows(ui, 'Open a session in the pylon')).toBe(true)
  expect((await ui.find({ type: 'Select', key: 'open-session-harness' }))?.props).toMatchObject({
    value: 'claude-code',
    options: [
      { value: 'claude-code', label: 'Claude Code' },
      { value: 'pi', label: 'pi' },
      { value: 'shell', label: 'Shell' },
    ],
  })
  await ui.select({ key: 'open-session-harness', value: 'shell' })
  expect((await ui.find({ type: 'Input', key: await field(ui, 'open-session-title') }))?.props.placeholder).toBe('optional; shell when empty')
  const fields = typing(ui)
  await fields.type('open-session-title', 'probe')
  await fields.submit('open-session-title')
  // The form gives way to Sessions at once, where the open shows while the CLI wakes the pylon and starts the agent.
  expect((await ui.find({ type: 'Button', key: 'tab-sessions' }))?.props.autoFocus).toBe(true)
  expect(await shows(ui, ' Opening Shell "probe"…')).toBe(true)
  expect(await shows(ui, 'Opening Shell "probe". Its agent can take a minute to start.')).toBe(true)
  await clock.advance(20_000)
  expect(cli.runs).toContainEqual(['session', 'open', '--json', '--harness=shell', '--title=probe', '--', ID])
  expect(await shows(ui, ' Opening Shell "probe"…')).toBe(false)
  expect(await shows(ui, `Opened Shell "probe" in pane nexus:2.1. ⏎ in Sessions copies nexus attach: run it in a terminal and pick the session's workspace in Herdr.`)).toBe(true)
  // The details do not list it yet: it shows as opened, its row from what the CLI answered.
  expect(await row(ui, 'nexus:2.1')).toMatch(/^ {2}Shell {7}probe {2}◌ opened {2}nexus:2\.1$/)
  cli.detail = { ...DETAIL, sessions: [CLAUDE, REPORTED] }
  await clock.advance(5_000)
  expect(await row(ui, 'nexus:2.1')).toMatch(/○ idle/)
})

test('an open the node never reports goes with the first details 30 s after it, and one that fails says why', async ($, on) => {
  const cli = fake({ detail: { ...DETAIL, sessions: [] } })
  const { clock, nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  await keys(ui, 'n')
  await ui.press({ key: 'open-session-submit' })
  expect(cli.runs).toContainEqual(['session', 'open', '--json', '--harness=claude-code', '--', ID])
  expect(await row(ui, 'nexus:2.1')).toMatch(/Claude Code claude-code {2}◌ opened/)
  await clock.advance(25_000)
  expect(await row(ui, 'nexus:2.1')).toMatch(/opened/)
  await clock.advance(10_000)
  expect(await row(ui, 'nexus:2.1')).toBeUndefined()
  cli.fail = { 'session open': { exitCode: 5, error: 'thread th-4f2a00000001 is archived' } }
  await keys(ui, 'n')
  await ui.press({ key: 'open-session-submit' })
  expect((await ui.find({ type: 'Text', text: /did not open/ }))?.text).toBe('The session did not open: thread th-4f2a00000001 is archived.')
  expect(await shows(ui, /Opening Claude Code…/)).toBe(false)
})

test('Cancel leaves the form for the thread, opening nothing', async ($, on) => {
  const cli = fake()
  const { nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  await keys(ui, 'n')
  await ui.press({ key: 'open-session-cancel' })
  expect(await shows(ui, /^‹ web \/ Fix login form 500s$/)).toBe(true)
  expect(cli.runs.some(argv => argv[0] === 'session')).toBe(false)
})

test('x asks before it closes the session under the cursor, Keep first; Close runs session close and the row goes', async ($, on) => {
  const cli = fake({ detail: { ...DETAIL, sessions: [CLAUDE, SHELL] }, slow: { 'session close': 3_000 } })
  const { clock, nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  await toSessions(ui)
  await keys(ui, 'jx')
  expect(cli.asked).toEqual(['Close Shell in pane nexus:3.1? Its agent ends.'])
  expect(cli.offered).toEqual([['Keep', 'Close']])
  expect(await shows(ui, 'Kept the session.')).toBe(true)
  expect(cli.runs.some(argv => argv[0] === 'session')).toBe(false)
  cli.answer = 'Close'
  await keys(ui, 'x')
  expect(await row(ui, 'nexus:3.1')).toMatch(/◐ closing…/)
  expect(await shows(ui, 'Closing pane nexus:3.1…')).toBe(true)
  await clock.advance(3_000)
  expect(cli.runs).toContainEqual(['session', 'close', '--json', '--', ID, 'nexus:3.1'])
  expect(await shows(ui, 'Closed pane nexus:3.1.')).toBe(true)
  // The details still list it until the node reads its sessions again.
  expect(await row(ui, 'nexus:3.1')).toBeUndefined()
  expect(await cursorOn(ui)).toBe('session-nexus:1.2')
})

test('Enter and y copy nexus attach and say where to run it, since Claude Code cannot give its terminal to it', async ($, on) => {
  const cli = fake({ detail: { ...DETAIL, sessions: [CLAUDE] } })
  const { nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  await toSessions(ui)
  await keys(ui, 'o')
  await keys(ui, 'y')
  expect(cli.copied).toEqual([`nexus attach ${ID}`, `nexus attach ${ID}`])
  expect(await shows(ui, `Copied nexus attach ${ID}: run it in a terminal or a Herdr tab, pick the session's workspace in Herdr, and detach from Herdr to come back.`)).toBe(true)
  await keys(ui, 'm')
  expect((await ui.findAll({ type: 'Button' })).flatMap(one => (one.key?.startsWith('menu-') ? [one.text.trim()] : []))).toEqual(
    expect.arrayContaining(['Open a session: Claude Code, pi or a shell', 'Attach: copy nexus attach, to run in a terminal']),
  )
})

test('a CLI before 0.5.0 says which version opening and closing a session need', async ($, on) => {
  const old = { exitCode: 64, error: 'unknown command session' }
  const cli = fake({ detail: { ...DETAIL, sessions: [CLAUDE] }, fail: { 'session open': old, 'session close': old }, answer: 'Close' })
  const { nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  await keys(ui, 'n')
  await ui.press({ key: 'open-session-submit' })
  expect(await shows(ui, 'The session did not open: nexus has no session open command: opening a session needs Nexus CLI 0.5.0 or later (nexus --version).')).toBe(true)
  await keys(ui, 'x')
  expect(await shows(ui, 'Pane nexus:1.2 was not closed: nexus has no session close command: closing a session needs Nexus CLI 0.5.0 or later (nexus --version).')).toBe(true)
  expect((await nexus(`session open ${ID}`)).text).toBe('Nexus has no session open command: opening a session needs Nexus CLI 0.5.0 or later (nexus --version).')
})

test('/nexus session open, close and attach: a quoted title, a close that asks which, Keep them all first, and the command to run', async ($, on) => {
  const cli = fake({ detail: { ...DETAIL, sessions: [CLAUDE, SHELL] } })
  const { nexus } = await boot($, on, cli)
  expect((await nexus(`session open ${ID} --harness pi --title "two words"`)).text).toBe(
    `Opened pi "two words" in pane nexus:2.1 of ${ID}. /nexus session attach ${ID} gives the command that attaches a terminal to it.`,
  )
  expect(cli.runs).toContainEqual(['session', 'open', '--json', '--harness=pi', '--title=two words', '--', ID])
  expect(cli.toasts).toContain(`Opening pi "two words" in ${ID}. Its agent can take a minute to start.`)
  expect((await nexus(`session close ${ID}`)).text).toBe(`Kept the sessions of ${ID}.`)
  expect(cli.asked).toEqual([`Close which session of ${ID}? Its agent ends.`])
  expect(cli.offered).toEqual([['Keep them all', 'Claude Code "claude" in pane nexus:1.2, working', 'Shell in pane nexus:3.1, idle']])
  cli.answer = 'Shell in pane nexus:3.1, idle'
  expect((await nexus(`session close ${ID}`)).text).toBe(`Closed pane nexus:3.1 of ${ID}.`)
  expect(cli.runs).toContainEqual(['session', 'close', '--json', '--', ID, 'nexus:3.1'])
  expect((await nexus(`session close ${ID} nexus:1.2`)).text).toBe(`Closed pane nexus:1.2 of ${ID}.`)
  expect((await nexus(`session attach ${ID}`)).text).toContain(`run this in a terminal or a Herdr tab:\n\n  nexus attach ${ID}\n\n`)
  expect((await nexus(`session open ${ID} --harness vim`)).text).toMatch(/^\/nexus session open takes a harness of claude-code, pi, shell, not vim\./)
})

test('no model tool opens, closes or attaches to a session', () => {
  expect(Object.keys(TOOLS).sort()).toEqual(['archive', 'preview', 'read', 'send', 'start', 'threads', 'unpublish', 'wait'])
})
