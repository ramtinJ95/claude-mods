import { describe, expect, test } from 'claude-code/testing'

import type { NexusChangedFile } from '../types'
import { type CheckoutFacts, STATUS_LETTER, changeTree, changesSummary, checkoutTrigger, diffArgv, parseChanges, parseDiff } from '../hooks/model'
import { CHANGES, DETAIL, DIFF, ID, THEME_KEYS, THREAD, boot, fake } from './fake-cli'

type Ui = Awaited<ReturnType<Awaited<ReturnType<typeof boot>>['mount']>>

const shows = async (ui: Ui, text: string | RegExp) => (await ui.find({ text })) !== undefined
async function keys(ui: Ui, letters: string) {
  for (const letter of letters) await ui.press({ key: `key-${letter}` })
}
const cursorOn = async (ui: Ui) => (await ui.findAll({ type: 'Button' })).find(one => one.text.startsWith('❯'))?.key
/** The tree's rows in order, folders and files, by key. */
const treeRows = async (ui: Ui) => (await ui.findAll({ type: 'Button' })).flatMap(one => (one.key?.startsWith('dir-') || one.key?.startsWith('file-') ? [one.key] : []))
const reads = (spawns: string[][]) => spawns.filter(argv => argv[0] === 'changes')
/** The Changes tab: l once from the conversation. */
const toChanges = (ui: Ui) => keys(ui, 'l')

const MIN = 60_000
const file = (path: string, status: NexusChangedFile['status'] = 'modified', additions: number | null = 1, deletions: number | null = 0): NexusChangedFile => ({ path, oldPath: null, status, additions, deletions })
const PAUSED = { ...DETAIL, pylon: { ...DETAIL.pylon, actualState: 'paused' } }

describe('the tree', () => {
  test('a folder that holds only one folder merges into it; folders come first, then files, each by name', () => {
    const rows = changeTree([file('src/checkout/view.ts'), file('src/checkout/model.ts'), file('README.md'), file('docs/a.md'), file('docs/guide/b.md')], {})
    expect(rows.map(row => `${'  '.repeat(row.depth)}${row.kind === 'dir' ? `${row.name}/` : row.name}`)).toEqual([
      'docs/',
      '  guide/',
      '    b.md',
      '  a.md',
      'src/checkout/',
      '  model.ts',
      '  view.ts',
      'README.md',
    ])
  })

  test('a folded folder hides what it holds, keyed by its path', () => {
    const rows = changeTree([file('src/a/x.ts'), file('src/b/y.ts')], { 'dir-src/a': false })
    expect(rows.map(row => row.key)).toEqual(['dir-src', 'dir-src/a', 'dir-src/b', 'file-src/b/y.ts'])
    expect(rows[1]).toMatchObject({ kind: 'dir', isOpen: false })
  })

  test('each status has its one-letter badge, and a binary file has no counts', () => {
    expect(STATUS_LETTER).toEqual({ added: 'A', modified: 'M', deleted: 'D', renamed: 'R', copied: 'C', typechange: 'T' })
    expect(parseChanges(CHANGES).files.find(one => one.path === 'src/ui/logo.png')).toMatchObject({ additions: null, deletions: null })
  })

  test('the summary counts the lines and names the base, or what stands for a null commit', () => {
    const changes = parseChanges(CHANGES)
    expect(changesSummary(changes)).toEqual({ counts: '5 files', added: 15, deleted: 45, since: 'since the pylon booted, a1b2c3d' })
    expect(changesSummary({ ...changes, base: { kind: 'start', commit: null } }).since).toBe('since the pylon booted, an empty repository')
    expect(changesSummary({ ...changes, base: { kind: 'head', commit: null } }).since).toBe('since the last commit, no commit yet')
    expect(() => parseChanges({ base: CHANGES.base, files: [{ path: 'a', status: 'mystery' }] })).toThrow(/a file without its path or status/)
  })

  test("a renamed file's diff names both paths", () => {
    expect(diffArgv(ID, { ...file('src/new.ts', 'renamed'), oldPath: 'src/old.ts' }, true)).toEqual(['diff', '--uncommitted', '--', ID, 'src/new.ts', 'src/old.ts'])
  })
})

describe('the diff', () => {
  test("hunks carry their heading, lines the new file's number, a removed line none", () => {
    const { rows, meta, isCut, isBinary } = parseDiff(DIFF.diff)
    expect(meta).toEqual([])
    expect(isCut).toBe(false)
    expect(isBinary).toBe(false)
    expect(rows).toEqual([
      { kind: 'hunk', text: 'export async function login(form: FormData) {' },
      { kind: 'ctx', line: 10, text: "  const email = form.get('email')" },
      { kind: 'del', line: null, text: '  const user = await db.find(email)' },
      { kind: 'add', line: 11, text: '  const user = await db.users.find(email)' },
      { kind: 'add', line: 12, text: "  if (!user) throw new HttpError(401, 'unknown user')" },
      { kind: 'ctx', line: 13, text: '  return session(user)' },
      { kind: 'ctx', line: 14, text: '}' },
      { kind: 'hunk', text: 'function session(user: User) {' },
      { kind: 'del', line: null, text: '  return sign(user.id)' },
      { kind: 'add', line: 41, text: '  return sign(user.id, { ttl: HOUR })' },
      { kind: 'ctx', line: 42, text: '}' },
    ])
  })

  test("what git says beyond the lines is meta, and a binary file or a pure rename has no rows", () => {
    const rename = ['diff --git a/old.ts b/new.ts', 'similarity index 100%', 'rename from old.ts', 'rename to new.ts', ''].join('\n')
    expect(parseDiff(rename)).toEqual({ rows: [], meta: ['similarity index 100%', 'rename from old.ts', 'rename to new.ts'], isCut: false, isBinary: false })
    const binary = ['diff --git a/logo.png b/logo.png', 'new file mode 100644', 'Binary files /dev/null and b/logo.png differ', ''].join('\n')
    expect(parseDiff(binary)).toMatchObject({ rows: [], meta: ['new file mode 100644'], isBinary: true })
  })

  test('the rows stop at the cap, which says the diff was cut', () => {
    const { rows, isCut } = parseDiff(DIFF.diff, 4)
    expect(rows).toHaveLength(4)
    expect(isCut).toBe(true)
    expect(parseDiff(`@@ -1 +1 @@\n+${'x'.repeat(1000)}\n`).rows[1]).toMatchObject({ text: 'x'.repeat(400) })
  })
})

describe('when to read', () => {
  const facts = (change: Partial<CheckoutFacts> = {}): CheckoutFacts => ({ status: 'active', pylon: 'running', turn: true, agentAt: 1, ...change })
  const waiting = { isWanted: false, isFirst: false }

  test('a turn that ended on a running pylon reads, as does one between two polls; nothing else does', () => {
    expect(checkoutTrigger(facts(), facts({ turn: false }), waiting)).toBe(true)
    expect(checkoutTrigger(facts({ turn: false }), facts({ turn: false, agentAt: 2 }), waiting)).toBe(true)
    expect(checkoutTrigger(facts({ turn: false }), facts({ turn: false }), waiting)).toBe(false)
    expect(checkoutTrigger(facts(), facts({ agentAt: 2 }), waiting)).toBe(false)
    expect(checkoutTrigger(null, facts({ turn: false }), waiting)).toBe(false)
  })

  test('never on a pylon not running or a closed thread; a pylon that starts reads only when someone waits for it', () => {
    expect(checkoutTrigger(facts(), facts({ turn: false, pylon: 'paused' }), waiting)).toBe(false)
    expect(checkoutTrigger(facts(), facts({ turn: false, status: 'archived' }), waiting)).toBe(false)
    expect(checkoutTrigger(facts({ pylon: 'paused', turn: false }), facts({ turn: false }), waiting)).toBe(false)
    expect(checkoutTrigger(facts({ pylon: 'spawning', turn: false }), facts({ turn: false }), { isWanted: true, isFirst: false })).toBe(true)
    expect(checkoutTrigger(facts({ pylon: 'paused', turn: false }), facts({ turn: false }), { isWanted: false, isFirst: true })).toBe(true)
  })
})

describe('the Changes tab', () => {
  test('first shown it reads the changes once and draws the summary and the tree; r reads again, a timer never does', async ($, on) => {
    const cli = fake()
    const { clock, nexus, mount } = await boot($, on, cli)
    await nexus(`open ${ID}`)
    const ui = await mount()
    expect(reads(cli.spawns)).toEqual([])
    expect((await ui.find({ type: 'Button', key: 'tab-changes' }))?.text).toBe('Changes')
    await toChanges(ui)
    expect(reads(cli.spawns)).toEqual([['changes', '--json', '--', ID]])
    expect((await ui.find({ type: 'Button', key: 'tab-changes' }))?.text).toBe('Changes 5')
    expect(await shows(ui, '5 files · +15 −45  since the pylon booted, a1b2c3d')).toBe(true)
    expect(await treeRows(ui)).toEqual(['dir-src', 'dir-src/auth', 'file-src/auth/login.ts', 'file-src/auth/session.ts', 'dir-src/ui', 'file-src/ui/Form.tsx', 'file-src/ui/logo.png', 'file-README.md'])
    expect((await ui.find({ type: 'Button', key: 'file-src/auth/login.ts' }))?.text).toMatch(/^ {2} {4}M login\.ts\s+\+12 −3$/)
    expect((await ui.find({ type: 'Button', key: 'file-src/auth/session.ts' }))?.text).toMatch(/^ {2} {4}R session\.ts {2}← src\/auth\/old-session\.ts\s+\+2 −2$/)
    expect((await ui.find({ type: 'Button', key: 'file-src/ui/logo.png' }))?.text).toMatch(/A logo\.png\s+binary$/)
    // Shown again, the tab keeps what it read; only an ended turn or r reads again.
    await keys(ui, 'hl')
    await clock.advance(MIN)
    expect(reads(cli.spawns)).toHaveLength(1)
    await keys(ui, 'r')
    expect(reads(cli.spawns)).toHaveLength(2)
    const painted = (await ui.findAll({})).flatMap(one => ['color', 'borderColor', 'backgroundColor'].flatMap(prop => (typeof one.props[prop] === 'string' ? [one.props[prop] as string] : [])))
    expect(painted.filter(colour => !THEME_KEYS.has(colour))).toEqual([])
  })

  test('j moves over the tree, Enter folds a folder, y copies a path', async ($, on) => {
    const cli = fake()
    const { nexus, mount } = await boot($, on, cli)
    await nexus(`open ${ID}`)
    const ui = await mount()
    await toChanges(ui)
    await keys(ui, 'j')
    expect(await cursorOn(ui)).toBe('dir-src/auth')
    await keys(ui, 'o')
    expect(await treeRows(ui)).toEqual(['dir-src', 'dir-src/auth', 'dir-src/ui', 'file-src/ui/Form.tsx', 'file-src/ui/logo.png', 'file-README.md'])
    expect((await ui.find({ type: 'Button', key: 'dir-src/auth' }))?.text).toMatch(/▸ auth$/)
    await keys(ui, 'jjy')
    expect(cli.copied).toEqual(['src/ui/Form.tsx'])
  })

  test('an agent turn that ends reads the changes again; the details polled with nothing new do not', async ($, on) => {
    const cli = fake()
    const { clock, nexus, mount } = await boot($, on, cli)
    await nexus(`open ${ID}`)
    const ui = await mount()
    await toChanges(ui)
    await clock.advance(10_000)
    expect(reads(cli.spawns)).toHaveLength(1)
    cli.detail = { ...DETAIL, thread: { ...THREAD, agentTurnRunning: false, lastAgentActivityAt: THREAD.lastAgentActivityAt + 5_000 } }
    cli.changes = { ...CHANGES, files: CHANGES.files.slice(0, 1) }
    await clock.advance(5_000)
    expect(reads(cli.spawns)).toHaveLength(2)
    expect(await shows(ui, /^1 file · \+12 −3/)).toBe(true)
    await clock.advance(30_000)
    expect(reads(cli.spawns)).toHaveLength(2)
  })

  test('on a paused pylon it reads nothing and offers to wake it; Enter wakes it and reads, saying so meanwhile', async ($, on) => {
    const cli = fake({ detail: PAUSED, slow: { changes: 8_000 } })
    const { clock, nexus, mount } = await boot($, on, cli)
    await nexus(`open ${ID}`)
    const ui = await mount()
    await toChanges(ui)
    await clock.advance(30_000)
    expect(reads(cli.spawns)).toEqual([])
    expect(await shows(ui, 'The pylon is paused. Reading its changes wakes it.')).toBe(true)
    expect(await cursorOn(ui)).toBe('changes-wake')
    await keys(ui, 'o')
    expect(reads(cli.spawns)).toHaveLength(1)
    expect(await shows(ui, 'Waking the pylon. Its changes show once it runs.')).toBe(true)
    cli.detail = DETAIL
    await clock.advance(8_000)
    expect(await shows(ui, /^5 files/)).toBe(true)
    expect(reads(cli.spawns)).toHaveLength(1)
  })

  test('an archived thread is never read, nor a deleted one, even on r', async ($, on) => {
    const cli = fake({ detail: { ...PAUSED, thread: { ...THREAD, status: 'archived', agentTurnRunning: false } } })
    const { clock, nexus, mount } = await boot($, on, cli)
    await nexus(`open ${ID}`)
    const ui = await mount()
    await toChanges(ui)
    await keys(ui, 'r')
    expect(await shows(ui, "An archived thread's pylon stays paused, so its changes can't be read. Unarchive the thread to read them.")).toBe(true)
    cli.detail = { ...DETAIL, thread: { ...THREAD, status: 'deleted', agentTurnRunning: false } }
    await clock.advance(5_000)
    await keys(ui, 'r')
    expect(await shows(ui, 'The thread is deleted, so its checkout is gone.')).toBe(true)
    expect(reads(cli.spawns)).toEqual([])
  })

  test('c during a read reads again once it ends, for the base now chosen, its reply for the old base dropped; the choice is kept', async ($, on) => {
    const cli = fake({ slow: { changes: 3_000 } })
    const { clock, nexus, mount } = await boot($, on, cli)
    await nexus(`open ${ID}`)
    const ui = await mount()
    await toChanges(ui)
    await keys(ui, 'c')
    expect(reads(cli.spawns)).toHaveLength(1)
    await clock.advance(3_000)
    expect(reads(cli.spawns)).toEqual([
      ['changes', '--json', '--', ID],
      ['changes', '--json', '--uncommitted', '--', ID],
    ])
    expect(await shows(ui, /since the pylon booted/)).toBe(false)
    await clock.advance(3_000)
    expect(await shows(ui, '5 files · +15 −45  since the last commit, f00d123')).toBe(true)
    expect(cli.store.uncommitted).toBe(true)
    expect(reads(cli.spawns)).toHaveLength(2)
  })

  test('a first read the pane\'s close cut short runs again with the next details once the pane is back', async ($, on) => {
    const cli = fake({ slow: { changes: 20_000 } })
    const { clock, nexus, mount } = await boot($, on, cli)
    await nexus(`open ${ID}`)
    const ui = await mount()
    await toChanges(ui)
    expect(reads(cli.spawns)).toHaveLength(1)
    await nexus('close')
    await ui.unmount()
    await clock.advance(1_000)
    cli.slow = {}
    await nexus(`open ${ID}`)
    const again = await mount()
    if ((await again.find({ type: 'Button', key: 'tab-changes' }))?.props.autoFocus !== true) await toChanges(again)
    await clock.advance(5_000)
    expect(reads(cli.spawns)).toHaveLength(2)
    expect(await shows(again, /^5 files/)).toBe(true)
  })

  test('a tree of 3000 files draws only the rows on screen, under the engine\'s limit, and the keys reach its end', async ($, on) => {
    const many = Array.from({ length: 3000 }, (_, index) => ({ path: `src/module-${String(index).padStart(4, '0')}/a-rather-long-file-name-${index}.ts`, oldPath: null, status: 'modified', additions: 10, deletions: 2 }))
    const cli = fake({ changes: { ...CHANGES, files: many, truncated: true } })
    const { nexus, mount } = await boot($, on, cli)
    await nexus(`open ${ID}`)
    const ui = await mount()
    await toChanges(ui)
    expect((await treeRows(ui)).length).toBeLessThan(60)
    await keys(ui, 'ge')
    expect(await cursorOn(ui)).toBe('file-src/module-2999/a-rather-long-file-name-2999.ts')
    expect(await shows(ui, 'Showing the first 3000 files.')).toBe(true)
    expect(JSON.stringify(await ui.drawn()).length).toBeLessThan(100_000)
    expect((await ui.findAll({ type: 'Button' })).some(one => one.key === 'key-q')).toBe(true)
  })

  test('nothing changed, and the first files of a truncated list, say so', async ($, on) => {
    const cli = fake({ changes: { ...CHANGES, files: [] } })
    const { nexus, mount } = await boot($, on, cli)
    await nexus(`open ${ID}`)
    const ui = await mount()
    await toChanges(ui)
    expect(await shows(ui, 'Nothing has changed since the pylon booted.')).toBe(true)
    await keys(ui, 'c')
    expect(await shows(ui, 'No uncommitted changes.')).toBe(true)
    cli.changes = { ...CHANGES, truncated: true }
    await keys(ui, 'c')
    expect(await shows(ui, 'Showing the first 5 files.')).toBe(true)
  })

  test('a CLI before 0.6.0 says which version Changes needs, and a refused boot base suggests c', async ($, on) => {
    const cli = fake({ fail: { changes: { exitCode: 64, error: 'unknown command changes' } } })
    const { nexus, mount } = await boot($, on, cli)
    await nexus(`open ${ID}`)
    const ui = await mount()
    await toChanges(ui)
    expect(await shows(ui, 'nexus has no changes command: reading the changes needs Nexus CLI 0.6.0 or later (nexus --version).')).toBe(true)
    cli.fail = { changes: { exitCode: 1, error: 'The pylon booted before Nexus recorded refs/nexus/base. Ask for the changes since HEAD with --uncommitted.' } }
    await keys(ui, 'r')
    expect(await shows(ui, /^The pylon booted before Nexus recorded refs\/nexus\/base/)).toBe(true)
    expect(await shows(ui, 'c shows the uncommitted changes instead, since the last commit.')).toBe(true)
  })
})

describe('the diff view', () => {
  test("Enter on a file opens its diff in place of the tree: header, hunks, numbered lines; h goes back to the file", async ($, on) => {
    const cli = fake()
    const { nexus, mount } = await boot($, on, cli)
    await nexus(`open ${ID}`)
    const ui = await mount()
    await toChanges(ui)
    await keys(ui, 'jjo')
    expect(cli.spawns.filter(argv => argv[0] === 'diff')).toEqual([['diff', '--json', '--', ID, 'src/auth/login.ts']])
    expect(await shows(ui, /^M src\/auth\/login\.ts {2}vs boot\s+\+12 −3$/)).toBe(true)
    expect(await shows(ui, '  ⋯   export async function login(form: FormData) {')).toBe(true)
    expect(await shows(ui, /^ 10 {5}const email = form\.get\('email'\)\s*$/)).toBe(true)
    const removed = await ui.find({ type: 'Text', text: /^ {4}− {3}const user = await db\.find\(email\)\s*$/ })
    expect(removed?.props.backgroundColor).toBe('diffRemoved')
    expect((await ui.find({ type: 'Text', text: /^ 11 \+ {3}const user = await db\.users\.find/ }))?.props.backgroundColor).toBe('diffAdded')
    expect(await treeRows(ui)).toEqual([])
    await keys(ui, 'y')
    expect(cli.copied).toEqual(['src/auth/login.ts'])
    await keys(ui, 'h')
    expect(await cursorOn(ui)).toBe('file-src/auth/login.ts')
  })

  test("a renamed file's diff asks with both paths and shows git's rename lines; a binary one says it has no diff", async ($, on) => {
    const cli = fake({ diff: { ...DIFF, diff: 'diff --git a/src/auth/old-session.ts b/src/auth/session.ts\nsimilarity index 100%\nrename from src/auth/old-session.ts\nrename to src/auth/session.ts\n' } })
    const { nexus, mount } = await boot($, on, cli)
    await nexus(`open ${ID}`)
    const ui = await mount()
    await toChanges(ui)
    await keys(ui, 'jjjo')
    expect(cli.spawns.filter(argv => argv[0] === 'diff').at(-1)).toEqual(['diff', '--json', '--', ID, 'src/auth/session.ts', 'src/auth/old-session.ts'])
    expect(await shows(ui, 'rename from src/auth/old-session.ts')).toBe(true)
    expect(await shows(ui, 'No lines changed.')).toBe(true)
    cli.diff = { ...DIFF, diff: 'diff --git a/src/ui/logo.png b/src/ui/logo.png\nBinary files /dev/null and b/src/ui/logo.png differ\n' }
    await keys(ui, 'hjjjo')
    expect(await shows(ui, 'The file is binary, so there is no diff to show.')).toBe(true)
  })

  test('a diff the CLI cut says so at its end', async ($, on) => {
    const cli = fake({ diff: { ...DIFF, truncated: true } })
    const { nexus, mount } = await boot($, on, cli)
    await nexus(`open ${ID}`)
    const ui = await mount()
    await toChanges(ui)
    await keys(ui, 'jjo')
    expect(await shows(ui, 'The diff is cut short here, because the whole of it is too long to show.')).toBe(true)
  })

  test('a file opened on a paused pylon offers to wake it rather than waking it; Enter wakes it and reads', async ($, on) => {
    const cli = fake()
    const { clock, nexus, mount } = await boot($, on, cli)
    await nexus(`open ${ID}`)
    const ui = await mount()
    await toChanges(ui)
    cli.detail = PAUSED
    await clock.advance(5_000)
    await keys(ui, 'jjo')
    expect(cli.spawns.filter(argv => argv[0] === 'diff')).toEqual([])
    expect(await shows(ui, 'The pylon is paused. Reading the diff wakes it.')).toBe(true)
    await keys(ui, 'o')
    expect(reads(cli.spawns)).toHaveLength(2)
    // The CLI answered once the pylon ran, so the diff reads at once, though the details still say paused.
    expect(cli.spawns.filter(argv => argv[0] === 'diff')).toHaveLength(1)
    expect(await shows(ui, /^ 10 {5}const email/)).toBe(true)
  })
})
