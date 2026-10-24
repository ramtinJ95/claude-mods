import { expect, test } from 'claude-code/testing'

import { cells } from '../hooks/model'
import { ID, THREADS, boot, fake, field, typing } from './fake-cli'

type Ui = Awaited<ReturnType<Awaited<ReturnType<typeof boot>>['mount']>>

const API = THREADS[2]!.id
const DOCS = 'git@github.com:me/docs.git'

async function keys(ui: Ui, letters: string) {
  for (const letter of letters) await ui.press({ key: `key-${letter}` })
}
const shows = async (ui: Ui, text: string | RegExp) => (await ui.find({ text })) !== undefined
/** The picker's rows as drawn: each Button's text, the cursor's mark included. */
const picker = async (ui: Ui) => (await ui.findAll({ type: 'Button' })).flatMap(one => (one.key?.startsWith('scope-') ? [one.text.trim()] : []))
const title = async (ui: Ui) => (await ui.find({ type: 'Text', text: /^◆ Nexus threads/ }))?.text

test('p opens the project picker: every project, each with its repo, and a new one, the one shown marked current', async ($, on) => {
  const cli = fake()
  const { nexus, mount } = await boot($, on, cli)
  await nexus('')
  const ui = await mount()
  await keys(ui, 'h')
  await keys(ui, 'p')
  expect(cli.runs).toContainEqual(['projects', '--json'])
  expect(await picker(ui)).toEqual([
    '❯ All projects    current',
    'web             git@github.com:me/web.git',
    'api             git@github.com:me/api.git',
    '+ New project…',
  ])
  expect(await shows(ui, /j\/k move\s+⏎ choose\s+q cancel/)).toBe(true)
  // q puts the picker away and changes nothing.
  await keys(ui, 'q')
  expect(await picker(ui)).toEqual([])
  expect(await title(ui)).toMatch(/^◆ Nexus threads · All projects/)
})

test('a project chosen scopes the list, its counts, the strip and the working thread /nexus opens, and is kept', async ($, on) => {
  const cli = fake()
  const { nexus, mount, strip } = await boot($, on, cli)
  await nexus('')
  const ui = await mount()
  await keys(ui, 'h')
  await keys(ui, 'pjjo')
  expect(cli.store.project).toBe('api')
  expect(await title(ui)).toMatch(/^◆ Nexus threads · api\s+0 working · 1 open/)
  expect(await ui.find({ type: 'Button', key: API })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: ID })).toBeUndefined()
  await keys(ui, 'p')
  expect((await picker(ui))[2]).toBe('❯ api             git@github.com:me/api.git  current')
  await keys(ui, 'kq')

  // /nexus opens a working thread only from the project shown.
  await nexus('close')
  await ui.unmount()
  await nexus('')
  const again = await mount()
  expect(await title(again)).toMatch(/^◆ Nexus threads · api/)
  await keys(again, 'pkko')
  await keys(again, 'p')
  await keys(again, 'jo')
  expect(cli.store.project).toBe('web')
  const band = await strip()
  expect(await band.find({ type: 'Button', key: ID })).toBeDefined()
  expect(await band.find({ type: 'Text', text: '◆ Nexus · web' })).toBeDefined()
  await nexus('close')
  await again.unmount()
  await nexus('')
  const third = await mount()
  expect(await shows(third, /^‹ web \/ Fix login form 500s$/)).toBe(true)
})

test("the strip shows only the project's threads, and names it", async ($, on) => {
  const working = { ...THREADS[2]!, agentTurnRunning: true }
  const cli = fake({ threads: [THREADS[0], THREADS[1], working], store: { themeNotice: true, project: 'api' } })
  const { clock, strip } = await boot($, on, cli)
  await clock.settle()
  const band = await strip()
  expect((await band.findAll({ type: 'Button' })).map(one => one.key)).toEqual([API])
  expect(await band.find({ type: 'Text', text: '◆ Nexus · api' })).toBeDefined()
})

test('a project remembered from an earlier session scopes the list and the start form', async ($, on) => {
  const cli = fake({ store: { themeNotice: true, project: 'api' } })
  const { nexus, mount } = await boot($, on, cli)
  await nexus('')
  const ui = await mount()
  expect(await title(ui)).toMatch(/^◆ Nexus threads · api/)
  await keys(ui, 'n')
  expect((await ui.find({ type: 'Select', key: 'start-project' }))?.props.value).toBe('api')
  expect(cli.toasts).toEqual([])
})

test('a remembered project that no longer exists goes back to every project, saying so once', async ($, on) => {
  const cli = fake({ store: { themeNotice: true, project: 'gone' } })
  const { clock, nexus, mount } = await boot($, on, cli)
  await clock.settle()
  expect(cli.toasts).toEqual(['The project gone no longer exists, so Nexus shows every project again.'])
  expect(cli.store.project).toBeNull()
  await nexus('')
  const ui = await mount()
  await keys(ui, 'h')
  expect(await title(ui)).toMatch(/^◆ Nexus threads · All projects/)
  await keys(ui, 'pq')
  await keys(ui, 'n')
  expect((await ui.find({ type: 'Select', key: 'start-project' }))?.props.value).toBe('web')
  expect(cli.toasts).toHaveLength(1)
})

test('the start form opened on a remembered project that is gone starts on the first, with no error', async ($, on) => {
  const cli = fake({ store: { themeNotice: true, project: 'gone' }, slow: { projects: 1_000 } })
  const { clock, nexus, mount } = await boot($, on, cli)
  await nexus('')
  const ui = await mount()
  await keys(ui, 'hn')
  await clock.advance(1_000)
  await clock.settle()
  expect((await ui.find({ type: 'Select', key: 'start-project' }))?.props.value).toBe('web')
  expect(await shows(ui, /is not offered here/)).toBe(false)
  expect(cli.toasts).toEqual(['The project gone no longer exists, so Nexus shows every project again.'])
})

test('the picker opens on the project shown: Enter keeps it, and a move starts from it', async ($, on) => {
  const cli = fake({ store: { themeNotice: true, project: 'api' } })
  const { nexus, mount } = await boot($, on, cli)
  await nexus('')
  const ui = await mount()
  await keys(ui, 'po')
  expect(cli.store.project).toBe('api')
  await keys(ui, 'pk')
  expect((await picker(ui))[1]).toBe('❯ web             git@github.com:me/web.git')
  await keys(ui, 'o')
  expect(cli.store.project).toBe('web')
  // Enter on a row is that row's press: it chooses and puts the picker away, from the list as from a thread.
  await keys(ui, 'p')
  await ui.press({ key: 'scope-project-api' })
  expect(cli.store.project).toBe('api')
  expect(await picker(ui)).toEqual([])
  expect(await title(ui)).toMatch(/^◆ Nexus threads · api/)
})

test('a narrow pane cuts the repo before the current mark, and the title before the nodes', async ($, on) => {
  const cli = fake({ store: { themeNotice: true, project: 'api' } })
  const { nexus, mount } = await boot($, on, cli)
  await nexus('')
  const ui = await mount(40)
  expect((await ui.find({ type: 'Text', text: /nodes online$/ }))?.text).toBe('1/2 nodes online')
  await keys(ui, 'p')
  expect((await picker(ui))[2]).toBe('❯ api             git@github.c…  current')
  // At 24 columns the IDs take half the row, the repo goes before the mark, and every row fits.
  await ui.unmount()
  await nexus('')
  // The picker stays open over the pane mounted again.
  const narrow = await mount(24)
  const rows = await picker(narrow)
  expect(rows[2]).toBe('❯ api          current')
  expect(rows[1]).toBe('web          git@gith…')
  expect(rows.filter(row => cells(row) > 22)).toEqual([])
})

test('p in a thread picks a project and opens its list', async ($, on) => {
  const cli = fake()
  const { nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  await keys(ui, 'p')
  expect(await picker(ui)).toContain('❯ All projects    current')
  await keys(ui, 'jo')
  expect(await title(ui)).toMatch(/^◆ Nexus threads · web/)
  expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: ID })).toBeDefined()
})

test('New project… adds the project from the form, on the first online node and main, and shows its threads', async ($, on) => {
  const cli = fake()
  const { nexus, mount } = await boot($, on, cli)
  await nexus(`open ${ID}`)
  const ui = await mount()
  await keys(ui, 'pgeo')
  expect(await shows(ui, 'Add a project')).toBe(true)
  expect((await ui.find({ type: 'Input', key: await field(ui, 'project-id') }))?.props.autoFocus).toBe(true)
  expect((await ui.find({ type: 'Select', key: 'project-node' }))?.props).toMatchObject({
    value: 'firebat',
    options: [
      { value: 'firebat', label: 'firebat' },
      { value: 'testbench', label: 'testbench, offline' },
    ],
  })
  const fields = typing(ui)
  await fields.type('project-id', 'docs')
  await fields.type('project-url', DOCS)
  await ui.input({ key: await field(ui, 'project-branch'), text: '' })
  expect(cli.runs).toContainEqual(['project', 'add', '--json', '--node=firebat', '--branch=main', '--', 'docs', DOCS])
  expect(cli.store.project).toBe('docs')
  expect(await title(ui)).toMatch(/^◆ Nexus threads · docs/)
  expect(await shows(ui, `Added the project docs (${DOCS}) on firebat. Nexus shows its threads.`)).toBe(true)
  expect(await shows(ui, 'No threads in docs yet. n starts one, p shows another project.')).toBe(true)
  await keys(ui, 'p')
  expect(await picker(ui)).toContain(`❯ docs            ${DOCS}  current`)
})

test('an ID or URL that starts with dashes reaches the CLI as given, not as one of its options', async ($, on) => {
  const cli = fake()
  const { nexus, mount } = await boot($, on, cli)
  await nexus('')
  const ui = await mount()
  await keys(ui, 'hpgeo')
  const fields = typing(ui)
  await fields.type('project-id', 'odd')
  await fields.type('project-url', '--branch=trunk')
  await ui.press({ key: 'project-submit' })
  expect(cli.projects.at(-1)).toMatchObject({ id: 'odd', repoUrl: '--branch=trunk', defaultBranch: 'main' })
  expect(await title(ui)).toMatch(/^◆ Nexus threads · odd/)
})

test("a refused add shows the CLI's message as printed and keeps the form filled; Cancel goes back to the picker", async ($, on) => {
  const cli = fake({ fail: { project: { exitCode: 5, error: 'project web exists' } } })
  const { nexus, mount } = await boot($, on, cli)
  await nexus('')
  const ui = await mount()
  await keys(ui, 'hpgeo')
  const fields = typing(ui)
  await ui.press({ key: 'project-submit' })
  expect(await shows(ui, 'A project needs an ID.')).toBe(true)
  expect(cli.runs.some(argv => argv[0] === 'project')).toBe(false)
  await fields.type('project-id', 'web')
  await fields.type('project-url', 'git@github.com:me/web.git')
  await fields.type('project-branch', 'trunk')
  await ui.press({ key: 'project-submit' })
  expect(cli.runs).toContainEqual(['project', 'add', '--json', '--node=firebat', '--branch=trunk', '--', 'web', 'git@github.com:me/web.git'])
  expect(await shows(ui, 'project web exists')).toBe(true)
  expect([await fields.shows('project-id'), await fields.shows('project-url'), await fields.shows('project-branch')]).toEqual(['web', 'git@github.com:me/web.git', 'trunk'])

  const invalid = 'invalid project:\n  id: must be lowercase letters, digits and hyphens\n  repoUrl: must be a URL'
  cli.fail.project = { exitCode: 64, error: invalid }
  await ui.press({ key: 'project-submit' })
  expect((await ui.find({ type: 'Text', text: /^invalid project:/ }))?.text).toBe(invalid)

  // Enter in a field submits; the field it empties shows its text again.
  cli.fail.project = { exitCode: 64, error: 'unknown command project' }
  await fields.submit('project-url')
  expect(await fields.shows('project-url')).toBe('git@github.com:me/web.git')
  expect(await shows(ui, 'nexus has no project add command: adding a project needs Nexus CLI 0.4.0 or later (nexus --version)')).toBe(true)

  await ui.press({ key: 'project-cancel' })
  expect(await picker(ui)).toContain('❯ + New project…')
  expect(await title(ui)).toMatch(/^◆ Nexus threads · All projects/)
})

test('/nexus project says which project is shown, switches it, refuses an unknown one, and adds one', async ($, on) => {
  const cli = fake()
  const { nexus } = await boot($, on, cli)
  expect(await nexus('project')).toEqual({ text: 'Nexus shows every project. /nexus project <id> shows one.' })
  expect(await nexus('project api')).toEqual({ text: 'Nexus shows the project api.' })
  expect(await nexus('project')).toEqual({ text: 'Nexus shows the project api. /nexus project all shows every project.' })
  expect(await nexus('project nosuch')).toEqual({ text: 'There is no project nosuch. The projects are web and api.' })
  expect(await nexus('project all')).toEqual({ text: 'Nexus shows every project.' })
  expect(cli.store.project).toBeNull()

  expect(await nexus(`project add docs ${DOCS} --node firebat`)).toEqual({ text: `Added the project docs (${DOCS}) on firebat. Nexus shows its threads.` })
  expect(cli.runs).toContainEqual(['project', 'add', '--json', '--node=firebat', '--branch=main', '--', 'docs', DOCS])
  expect(cli.store.project).toBe('docs')
  await nexus(`project add api2 ${DOCS} --node=testbench --branch trunk`)
  expect(cli.runs).toContainEqual(['project', 'add', '--json', '--node=testbench', '--branch=trunk', '--', 'api2', DOCS])

  // A failure is the CLI's message as it printed it, which the transcript heads with `nexus:`.
  cli.fail.project = { exitCode: 5, error: 'project web exists' }
  expect(await nexus(`project add web ${DOCS} --node firebat`)).toEqual({ text: 'project web exists' })
  expect((await nexus(`project add docs ${DOCS}`))?.text).toMatch(/^\/nexus project add needs --node <node>; nexus nodes lists them\./)
  expect((await nexus('project add docs')).text).toMatch(/^\/nexus project add takes a project ID and a repo URL\./)
  expect((await nexus('project web api')).text).toMatch(/^\/nexus project takes one project ID, all, or add\./)
})

test("the threads tool lists every project's threads whatever the pane shows", async ($, on) => {
  const cli = fake({ store: { themeNotice: true, project: 'api' } })
  await boot($, on, cli)
  const { result } = (await $.tool.call({ tool: 'mcp__nexus__threads' } as never)) as { result: unknown }
  expect(new Set((JSON.parse(String(result)) as { project: string }[]).map(one => one.project))).toEqual(new Set(['web', 'api']))
})
