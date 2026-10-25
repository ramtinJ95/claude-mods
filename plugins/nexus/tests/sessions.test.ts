import { expect, test } from 'claude-code/testing'

import { cells } from '../hooks/model'
import { rowsOf } from '../hooks/view'
import { TOOLS } from '../hooks/tools'
import { DETAIL, ID, THEME_KEYS, THREAD, boot, fake, field, state, typing } from './fake-cli'

type Ui = Awaited<ReturnType<Awaited<ReturnType<typeof boot>>['mount']>>

const shows = async (ui: Ui, text: string | RegExp) => (await ui.find({ text })) !== undefined
async function keys(ui: Ui, letters: string) {
  for (const letter of letters) await ui.press({ key: `key-${letter}` })
}
const cursorOn = async (ui: Ui) => (await ui.findAll({ type: 'Button' })).find(one => one.text.startsWith('❯'))?.key
const row = async (ui: Ui, pane: string) => (await ui.find({ type: 'Button', key: `session-${pane}` }))?.text
/** The Pylon tab, l three times from the conversation, and j past its three blocks of details onto the first session. */
const toSessions = (ui: Ui) => keys(ui, 'llljjj')
const ATTACH_NEEDS = 'Attaching needs Nexus CLI 0.9.0 or newer and goes through the control plane.'

const CLAUDE = { herdrPane: 'nexus:1.2', harness: 'claude-code', harnessSessionId: '9c1e', status: 'working', title: 'claude', pylon: 'pylon-7f3a' }
const SHELL = { herdrPane: 'nexus:3.1', harness: 'shell', harnessSessionId: null, status: 'idle', title: null, pylon: 'pylon-7f3a' }
/** What `show` lists once the node reports the shell `session open` answered with `nexus:2.1`. */
const REPORTED = { herdrPane: 'nexus:2.1', harness: 'shell', harnessSessionId: null, status: 'idle', title: 'probe', pylon: 'pylon-7f3a' }

test('Pylon lists each session with its harness, title, state, pane and session ID, then how to attach from this Mac', async ($, on) => {
  const cli = fake({ detail: { ...DETAIL, sessions: [CLAUDE, SHELL] } })
  const { nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  expect((await ui.find({ type: 'Button', key: 'tab-pylon' }))?.text).toBe('Pylon')
  await toSessions(ui)
  expect(await shows(ui, /^SESSIONS 2 ─/)).toBe(true)
  expect(await row(ui, 'nexus:1.2')).toMatch(/^❯ Claude Code claude {2}◉ working {2}nexus:1\.2 {2}session 9c1e$/)
  expect(await row(ui, 'nexus:3.1')).toMatch(/^ {2}Shell {15}○ idle {2}nexus:3\.1$/)
  expect(await shows(ui, '⏎ or y copies nexus attach, x closes the session')).toBe(true)
  expect(await shows(ui, /^ATTACH FROM THIS MAC/)).toBe(true)
  expect(await shows(ui, `  nexus attach ${ID}`)).toBe(true)
  expect(await shows(ui, ATTACH_NEEDS)).toBe(true)
  await keys(ui, 'j')
  expect(await cursorOn(ui)).toBe('session-nexus:3.1')
  const painted = (await ui.findAll({})).flatMap(one => ['color', 'borderColor', 'backgroundColor'].flatMap(prop => (typeof one.props[prop] === 'string' ? [one.props[prop] as string] : [])))
  expect(painted.filter(colour => !THEME_KEYS.has(colour))).toEqual([])
})

test('a pylon with no sessions says n opens one, and x says there is none to close', async ($, on) => {
  const cli = fake({ detail: { ...DETAIL, sessions: [] } })
  const { nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
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
  // The form gives way to Pylon at once, where the open shows while the CLI wakes the pylon and starts the agent.
  expect((await ui.find({ type: 'Button', key: 'tab-pylon' }))?.props.autoFocus).toBe(true)
  expect(await shows(ui, ' Opening Shell "probe"…')).toBe(true)
  expect(await shows(ui, 'Opening Shell "probe". Its agent can take a minute to start.')).toBe(true)
  await clock.advance(20_000)
  expect(cli.runs).toContainEqual(['session', 'open', '--json', '--harness=shell', '--title=probe', '--', ID])
  expect(await shows(ui, ' Opening Shell "probe"…')).toBe(false)
  expect(await shows(ui, `Opened Shell "probe" in pane nexus:2.1. ⏎ on it in Pylon copies nexus attach: run it in a terminal and pick the session's workspace in Herdr.`)).toBe(true)
  // The details do not list it yet: it shows as opened, its row from what the CLI answered.
  expect(await row(ui, 'nexus:2.1')).toMatch(/^ {2}Shell {7}probe {3}◌ opened {2}nexus:2\.1$/)
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
  expect(await shows(ui, /^‹ web \/ Fix login form 500s  ◉ working$/)).toBe(true)
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

/** Claude Code as Herdr runs it, in workspace w9. */
const HERDR = { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w9' }
const TAB_OPENED = `Opened the Herdr tab "nexus attach ${THREAD.title}" in this workspace, attaching to the pylon's Herdr: pick a session's workspace there. To come back, detach from the pylon's Herdr, then close that tab or switch back to this one.`

test(
  "inside Herdr, Enter and the menu's Attach run nexus attach in a new tab of the workspace, the CLI and ID quoted for its shell; y still copies",
  { options: { cli: "/Users/me/My Tools/it's/nexus" } },
  async ($, on) => {
    const cli = fake({ detail: { ...DETAIL, sessions: [CLAUDE] }, env: HERDR })
    const { nexus, mount } = await boot($, on, cli)
    await nexus(`open ${ID}`)
    const ui = await mount()
    await toSessions(ui)
    expect(await shows(ui, '⏎ attaches in a new Herdr tab, y copies nexus attach, x closes the session')).toBe(true)
    await keys(ui, 'o')
    const attaching = [
      ['tab', 'create', '--workspace', 'w9', '--label', `nexus attach ${THREAD.title}`, '--focus'],
      ['pane', 'run', 'w9:p7', `'/Users/me/My Tools/it'\\''s/nexus' attach ${ID}`],
    ]
    expect(cli.herdr).toEqual(attaching)
    expect(await shows(ui, TAB_OPENED)).toBe(true)
    expect(cli.copied).toEqual([])
    await keys(ui, 'y')
    expect(cli.copied).toEqual([attaching[1]![3]])
    expect(cli.herdr).toHaveLength(2)
    await keys(ui, 'm')
    await ui.press({ key: 'menu-attach' })
    expect(cli.herdr).toEqual([...attaching, ...attaching])
    expect((await nexus(`session attach ${ID}`)).text).toBe(TAB_OPENED)
    expect(cli.herdr).toHaveLength(6)
  },
)

test('a herdr that fails leaves the attach to the copied command, and says why', async ($, on) => {
  const cli = fake({ detail: { ...DETAIL, sessions: [CLAUDE] }, herdrFail: { 'tab create': 'workspace w9 not found' }, env: HERDR })
  const { nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  await toSessions(ui)
  await keys(ui, 'o')
  expect(cli.copied).toEqual([`nexus attach ${ID}`])
  expect(
    await shows(ui, `The Herdr tab did not open: herdr tab create failed: workspace w9 not found. Copied nexus attach ${ID}: run it in a terminal or a Herdr tab, pick the session's workspace in Herdr, and detach from Herdr to come back.`),
  ).toBe(true)
  cli.herdrFail = { 'pane run': 'pane w9:p7 not found' }
  expect((await nexus(`session attach ${ID}`)).text).toMatch(/^The Herdr tab did not open: herdr pane run failed: pane w9:p7 not found\. Claude Code cannot give its terminal/)
})

test('outside Herdr, or with no workspace to open the tab in, nothing runs herdr', async ($, on) => {
  const cli = fake({ detail: { ...DETAIL, sessions: [CLAUDE] }, env: { HERDR_WORKSPACE_ID: 'w9' } })
  const { nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  await toSessions(ui)
  await keys(ui, 'o')
  expect((await nexus(`session attach ${ID}`)).text).toBe(
    `Claude Code cannot give its terminal to the attach, so run this in a terminal or a Herdr tab:\n\n  nexus attach ${ID}\n\nEach session is a workspace in the pylon's Herdr: pick one there, and detach from Herdr to come back. ${ATTACH_NEEDS}`,
  )
  expect(cli.herdr).toEqual([])
  expect(cli.copied).toEqual([`nexus attach ${ID}`])
})

test('a CLI set by path is the one the copied and shown attach command names, quoted for a shell', { options: { cli: "/Users/me/My Tools/it's/nexus" } }, async ($, on) => {
  const command = `'/Users/me/My Tools/it'\\''s/nexus' attach ${ID}`
  const cli = fake({ detail: { ...DETAIL, sessions: [CLAUDE] } })
  const { nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  await toSessions(ui)
  expect(await shows(ui, `  ${command}`)).toBe(true)
  await keys(ui, 'y')
  expect(cli.copied).toEqual([command])
  expect(await shows(ui, `Copied ${command}: run it in a terminal or a Herdr tab, pick the session's workspace in Herdr, and detach from Herdr to come back.`)).toBe(true)
  expect((await nexus(`session attach ${ID}`)).text).toContain(`\n\n  ${command}\n\n`)
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
  // The form gave way to Pylon, its cursor on the details: x there points at the rows.
  await keys(ui, 'x')
  expect(await shows(ui, 'x closes the session under the cursor: j or k moves onto one.')).toBe(true)
  await keys(ui, 'jjjx')
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
  expect(cli.asked).toEqual([`Close which session of ${ID}?`])
  expect(cli.offered).toEqual([['Keep them all', 'Claude Code "claude" in pane nexus:1.2, working', 'Shell in pane nexus:3.1, idle']])
  cli.answer = 'Shell in pane nexus:3.1, idle'
  expect((await nexus(`session close ${ID}`)).text).toBe(`Closed pane nexus:3.1 of ${ID}.`)
  expect(cli.runs).toContainEqual(['session', 'close', '--json', '--', ID, 'nexus:3.1'])
  expect((await nexus(`session close ${ID} nexus:1.2`)).text).toBe(`Closed session nexus:1.2 of ${ID}.`)
  expect((await nexus(`session attach ${ID}`)).text).toContain(`run this in a terminal or a Herdr tab:\n\n  nexus attach ${ID}\n\n`)
  expect((await nexus(`session open ${ID} --harness vim`)).text).toMatch(/^\/nexus session open takes a harness of claude-code, pi, shell, not vim\./)
})

/** What the next wake brings back, and what the last one did not, as a control plane from CLI 0.8.0 lists them. */
const PAUSED = { ...CLAUDE, id: 'nexus:1.2', state: 'paused', message: null }
const FAILED = {
  id: 'failed-0123456789ab',
  herdrPane: null,
  harness: 'pi',
  harnessSessionId: '/home/user/.pi/agent/sessions/s.jsonl',
  status: 'unknown',
  title: 'plan',
  pylon: 'pylon-7f3a',
  state: 'failed',
  message: 'herdr agent start: the agent did not start.',
}
const RUNNING = { ...SHELL, id: 'nexus:3.1', state: 'running', message: null }

test('long session rows stay one measured row with an ellipsis; the failure reason still wraps', async ($, on) => {
  const message = 'The agent did not start. '.repeat(8).trim()
  const cli = fake({ detail: { ...DETAIL, sessions: [{ ...FAILED, message }, { ...RUNNING, title: '計画🧪', harnessSessionId: '計画🧪'.repeat(30) }] } })
  const { nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const width = 72
  const ui = await mount(width)
  await toSessions(ui)
  for (const id of [FAILED.id, RUNNING.id]) {
    const button = await ui.find({ type: 'Button', key: `session-${id}` })
    expect(button?.text).toMatch(/…$/)
    expect(button?.text).not.toContain('\n')
    expect(cells(button!.text)).toBeLessThanOrEqual(width)
    expect(rowsOf(button, width)).toBe(1)
  }
  expect(await row(ui, FAILED.id)).toContain('session /home/')
  const failure = await ui.find({ type: 'Text', text: message })
  expect(failure?.props.color).toBe('error')
  expect(failure?.props.wrap).toBeUndefined()
  expect(rowsOf(failure, width - 4)).toBeGreaterThan(1)
  await keys(ui, 'j')
  expect(await cursorOn(ui)).toBe(`session-${RUNNING.id}`)
})

test('a paused session reads paused, resumes on wake; a failed one says failed with its message, by its ID when it has no pane', async ($, on) => {
  const cli = fake({ detail: { ...DETAIL, sessions: [PAUSED, FAILED, RUNNING] } })
  const { nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  await toSessions(ui)
  expect(await shows(ui, /^SESSIONS 3 ─/)).toBe(true)
  expect(await row(ui, 'nexus:1.2')).toMatch(/^❯ Claude Code claude {2}◌ paused, resumes on wake {2}nexus:1\.2 {2}session 9c1e$/)
  expect(await shows(ui, '⏎ or y copies nexus attach, which wakes the pylon')).toBe(true)
  expect(await row(ui, 'failed-0123456789ab')).toMatch(/^ {2}pi {10}plan {4}✕ failed {2}failed-0123456789ab {2}session \/home\/user\/\.pi\/agent\/sessions\/s\.jsonl$/)
  expect((await ui.find({ type: 'Text', text: 'herdr agent start: the agent did not start.' }))?.props.color).toBe('error')
  // A running row is as before.
  expect(await row(ui, 'nexus:3.1')).toMatch(/^ {2}Shell {15}○ idle {2}nexus:3\.1$/)
  const painted = (await ui.findAll({})).flatMap(one => ['color', 'borderColor', 'backgroundColor'].flatMap(prop => (typeof one.props[prop] === 'string' ? [one.props[prop] as string] : [])))
  expect(painted.filter(colour => !THEME_KEYS.has(colour))).toEqual([])
})

test("an archived thread's paused session resumes on unarchive", async ($, on) => {
  const archived = { ...THREAD, status: 'archived' }
  const cli = fake({ detail: { ...DETAIL, thread: archived, sessions: [PAUSED] }, watch: [{ type: 'reset', thread: ID, entries: [] }, state('idle', { status: 'archived' })] })
  const { nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  await toSessions(ui)
  expect(await row(ui, 'nexus:1.2')).toMatch(/◌ paused, resumes on unarchive/)
  expect(await shows(ui, '⏎ or y copies nexus attach')).toBe(true)
  await keys(ui, 'x')
  expect(await shows(ui, 'Claude Code "claude" is paused: it resumes on unarchive, and can be closed once it runs.')).toBe(true)
})

test('x on a paused session says why it cannot close it, asking nothing and running no close; Enter still attaches', async ($, on) => {
  const cli = fake({ detail: { ...DETAIL, sessions: [PAUSED] }, answer: 'Close' })
  const { nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  await toSessions(ui)
  await keys(ui, 'x')
  expect(await shows(ui, 'Claude Code "claude" is paused: it resumes on wake, and can be closed once it runs.')).toBe(true)
  expect(cli.asked).toEqual([])
  expect(cli.runs.some(argv => argv[0] === 'session')).toBe(false)
  // Enter on the row presses it, as the ring's Button.
  await ui.press({ key: 'session-nexus:1.2' })
  expect(cli.copied).toEqual([`nexus attach ${ID}`])
})

test('x on a failed session asks, then closes it by its ID, which drops it; the row goes', async ($, on) => {
  const cli = fake({ detail: { ...DETAIL, sessions: [FAILED, RUNNING] }, answer: 'Close' })
  const { nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  await toSessions(ui)
  await keys(ui, 'x')
  expect(cli.asked).toEqual(['Close pi "plan", which the last wake did not bring back?'])
  expect(cli.runs).toContainEqual(['session', 'close', '--json', '--', ID, 'failed-0123456789ab'])
  expect(await shows(ui, 'Closed session failed-0123456789ab.')).toBe(true)
  // The details still list it until the node reads its sessions again.
  expect(await row(ui, 'failed-0123456789ab')).toBeUndefined()
  expect(await cursorOn(ui)).toBe('session-nexus:3.1')
})

test("a close the CLI refuses shows its message as printed, 409 or 404, and is run once, not again", async ($, on) => {
  const paused = 'session nexus:3.1 is paused with its pylon and resumes when its pylon wakes. Close it once it runs'
  const gone = 'no session is open in pane nexus:3.1 of pylon pylon-7f3a. A wake may have moved it to another pane, which the thread\'s sessions list'
  const cli = fake({ detail: { ...DETAIL, sessions: [RUNNING] }, answer: 'Close', fail: { 'session close': { exitCode: 5, error: paused } } })
  const { nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  await toSessions(ui)
  await keys(ui, 'x')
  expect(await shows(ui, `Pane nexus:3.1 was not closed: ${paused}.`)).toBe(true)
  expect(await row(ui, 'nexus:3.1')).toMatch(/○ idle/)
  cli.fail = { 'session close': { exitCode: 4, error: gone } }
  await keys(ui, 'x')
  expect(await shows(ui, `Pane nexus:3.1 was not closed: ${gone}.`)).toBe(true)
  expect(cli.runs.filter(argv => argv[0] === 'session')).toHaveLength(2)
  expect((await nexus(`session close ${ID} nexus:3.1`)).text).toBe(`No session is open in pane nexus:3.1 of pylon pylon-7f3a. A wake may have moved it to another pane, which the thread's sessions list.`)
})

test('a failed session whose close fails on a CLI before 0.8.0 says which version closing it needs', async ($, on) => {
  const cli = fake({ detail: { ...DETAIL, sessions: [FAILED] }, answer: 'Close', version: '0.7.0', fail: { 'session close': { exitCode: 4, error: 'pylon pylon-7f3a has no pane failed-0123456789ab' } } })
  const { nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  await toSessions(ui)
  await keys(ui, 'x')
  expect(await shows(ui, 'Session failed-0123456789ab was not closed: nexus is 0.7.0: closing a failed session needs Nexus CLI 0.8.0 or later (nexus --version).')).toBe(true)
  expect((await nexus(`session close ${ID} failed-0123456789ab`)).text).toBe('Nexus is 0.7.0: closing a failed session needs Nexus CLI 0.8.0 or later (nexus --version).')
  // A CLI from 0.8.0 on gets its own message.
  cli.version = '0.8.0'
  expect((await nexus(`session close ${ID} failed-0123456789ab`)).text).toBe('Pylon pylon-7f3a has no pane failed-0123456789ab.')
})

test('/nexus session close offers only the sessions that can be closed, and says when every one is paused', async ($, on) => {
  const cli = fake({ detail: { ...DETAIL, sessions: [PAUSED, FAILED, RUNNING] } })
  const { nexus } = await boot($, on, cli)
  expect((await nexus(`session close ${ID}`)).text).toBe(`Kept the sessions of ${ID}.`)
  expect(cli.offered).toEqual([['Keep them all', 'pi "plan" in session failed-0123456789ab, failed', 'Shell in pane nexus:3.1, idle']])
  cli.answer = 'pi "plan" in session failed-0123456789ab, failed'
  expect((await nexus(`session close ${ID}`)).text).toBe(`Closed session failed-0123456789ab of ${ID}.`)
  expect(cli.runs).toContainEqual(['session', 'close', '--json', '--', ID, 'failed-0123456789ab'])
  cli.detail = { ...DETAIL, sessions: [PAUSED] }
  expect((await nexus(`session close ${ID}`)).text).toBe(`The sessions of ${ID} are paused: they resume on wake, and can be closed once they run.`)
})

test('no model tool opens, closes or attaches to a session', () => {
  expect(Object.keys(TOOLS).sort()).toEqual(['archive', 'preview', 'project_add', 'projects', 'read', 'send', 'start', 'threads', 'unpublish', 'wait'])
})
