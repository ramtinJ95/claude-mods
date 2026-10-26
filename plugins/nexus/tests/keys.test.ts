import { describe, expect, test } from 'claude-code/testing'

import type { NexusPane } from '../types'
import { type Command, type Nav, type NavItem, press, ringMoved, scrolledRows } from '../hooks/keys'

const PANE: NexusPane = {
  view: 'thread',
  tab: 'conversation',
  selected: 'th-1',
  mode: 'normal',
  overlay: null,
  pending: null,
  listCursor: null,
  listTop: 0,
  isRetaken: false,
  scroll: null,
  changesCursor: null,
  diff: null,
  portCursor: null,
  pylonCursor: null,
  toggled: {},
  filter: '',
  draft: '',
  start: null,
  project: null,
  session: null,
  fields: {},
  notice: null,
  portChanges: {},
  sessionChanges: {},
}

/** Items of the given heights stacked from the top, keyed `b0`, `b1`, … */
function stack(heights: number[]): NavItem[] {
  let top = 0
  return heights.map((height, index) => {
    const item = { key: `b${index}`, top, height, enter: { kind: 'toggle' as const, key: `b${index}`, isOpen: false } }
    top += height
    return item
  })
}

const conversation = (heights: number[], area: number): Extract<Nav, { context: 'conversation' }> => ({
  context: 'conversation',
  items: stack(heights),
  total: heights.reduce((sum, height) => sum + height, 0),
  area,
  canInsert: true,
})

/** Presses each command in turn on what one layout gives. */
function run(pane: NexusPane, nav: Nav, commands: Command[]) {
  return commands.reduce((step, command) => press(step.pane, command, nav), { pane, effects: [] as ReturnType<typeof press>['effects'] })
}

describe('the conversation', () => {
  const nav = conversation([5, 5, 5, 30, 5, 5], 20)
  const edge = (pane: NexusPane) => nav.total - scrolledRows(pane.scroll, nav.items, nav.total, nav.area)

  test('k steps the cursor a block up, moving the window only to show it; j steps back down and past the end follows', () => {
    const up = run(PANE, nav, ['up']).pane
    expect(up.scroll?.anchor).toBe('b4')
    expect(edge(up)).toBe(nav.total)
    // b3 starts above the window, so the window moves to show its top, then b2's.
    const twice = run(up, nav, ['up']).pane
    expect(twice.scroll?.anchor).toBe('b3')
    expect(edge(twice)).toBe(15 + 20)
    const thrice = run(twice, nav, ['up']).pane
    expect(thrice.scroll?.anchor).toBe('b2')
    expect(edge(thrice)).toBe(10 + 20)
    expect(run(thrice, nav, ['down', 'down', 'down']).pane.scroll?.anchor).toBe('b5')
    expect(run(thrice, nav, ['down', 'down', 'down', 'down']).pane.scroll).toBeNull()
  })

  test('g g goes to the first block, g e follows the end; g then another key is that key', () => {
    const top = run(PANE, nav, ['g', 'g']).pane
    expect(top.scroll?.anchor).toBe('b0')
    expect(edge(top)).toBe(20)
    expect(top.pending).toBeNull()
    expect(run(top, nav, ['g', 'e']).pane.scroll).toBeNull()
    const waiting = press(top, 'g', nav).pane
    expect(waiting.pending).toBe('g')
    expect(press(waiting, 'down', nav).pane.scroll?.anchor).toBe('b1')
  })

  test('d and u move the window half its height, through a block taller than it', () => {
    const half = run(PANE, nav, ['halfUp']).pane
    expect(edge(half)).toBe(nav.total - 10)
    expect(half.scroll?.anchor).toBe('b3')
    expect(edge(run(half, nav, ['halfUp']).pane)).toBe(nav.total - 20)
    expect(run(half, nav, ['halfDown']).pane.scroll).toBeNull()
  })

  test('the window holds still as blocks arrive below it', () => {
    const back = run(PANE, nav, ['up', 'up', 'up']).pane
    const grown = conversation([5, 5, 5, 30, 5, 5, 12, 40], 20)
    expect(grown.total - scrolledRows(back.scroll, grown.items, grown.total, grown.area)).toBe(edge(back))
  })

  test('the focus follows the cursor onto a block that is a button, else back to the tab', () => {
    const mixed: Nav = { ...nav, items: nav.items.map((item, index) => (index === 4 ? { key: item.key, top: item.top, height: item.height } : item)) }
    expect(press(PANE, 'up', mixed).effects).toEqual([{ kind: 'focus', key: 'tab-conversation' }])
    expect(run(PANE, mixed, ['up', 'up']).effects).toEqual([{ kind: 'focus', key: 'b3' }])
  })

  test('a conversation shorter than the window moves the cursor and not the window', () => {
    const short = conversation([3, 3, 3], 20)
    const step = run(PANE, short, ['up', 'up'])
    expect(step.pane.scroll?.anchor).toBe('b0')
    expect(scrolledRows(step.pane.scroll, short.items, short.total, short.area)).toBe(0)
    expect(run(step.pane, short, ['open']).pane.toggled).toEqual({ b0: true })
  })

  test('h on Conversation goes back, l walks the tabs, i writes only where the thread takes messages', () => {
    expect(press(PANE, 'left', nav).effects).toEqual([{ kind: 'back' }])
    const changes = press(PANE, 'right', nav)
    expect(changes.pane.tab).toBe('changes')
    expect(changes.effects).toEqual([{ kind: 'tab', tab: 'changes' }])
    expect(press(PANE, 'insert', nav)).toMatchObject({ pane: { mode: 'insert' }, effects: [{ kind: 'insert' }] })
    expect(press(PANE, 'insert', { ...nav, canInsert: false })).toMatchObject({ pane: { mode: 'normal' }, effects: [] })
  })
})

describe('the menu and the help', () => {
  const menu: Nav = { context: 'menu', area: 10, items: ['abort', 'archive', 'delete'].map((action, index) => ({ key: `menu-${action}`, top: index, height: 1, enter: { kind: 'run', action } as never })) }

  test('m opens the menu over the tab, j moves its cursor and focuses it, o runs and closes it', () => {
    const open = press(PANE, 'menu', conversation([5], 20)).pane
    expect(open.overlay).toEqual({ kind: 'menu', cursor: null })
    const moved = press(open, 'down', menu)
    expect(moved.pane.overlay).toEqual({ kind: 'menu', cursor: 'menu-archive' })
    expect(moved.effects).toEqual([{ kind: 'focus', key: 'menu-archive' }])
    expect(press(moved.pane, 'open', menu)).toMatchObject({ pane: { overlay: null }, effects: [{ kind: 'run', action: 'archive' }] })
    expect(press(moved.pane, 'close', menu).pane.overlay).toBeNull()
  })

  test('s opens the help, which scrolls when taller than the body and takes no other key but those that close it', () => {
    const help = press(PANE, 'help', conversation([5], 20)).pane
    expect(help.overlay).toEqual({ kind: 'help', top: 0 })
    const tall: Nav = { context: 'help', total: 30, area: 10 }
    expect(run(help, tall, ['down', 'down']).pane.overlay).toEqual({ kind: 'help', top: 2 })
    expect(run(help, tall, ['g', 'e']).pane.overlay).toEqual({ kind: 'help', top: 20 })
    expect(run(help, tall, ['g', 'e', 'halfUp']).pane.overlay).toEqual({ kind: 'help', top: 15 })
    expect(press(help, 'down', { context: 'help', total: 8, area: 10 }).pane.overlay).toEqual({ kind: 'help', top: 0 })
    expect(press(help, 'menu', tall)).toMatchObject({ pane: { overlay: { kind: 'help', top: 0 } }, effects: [] })
    expect(press(help, 'close', tall).effects).toEqual([])
    expect(press(help, 'close', tall).pane.overlay).toBeNull()
  })
})

describe('the list and previews', () => {
  const list: Nav = { context: 'list', area: 4, items: stack([2, 1, 2, 1, 1]) }

  test('j moves the cursor and the list scrolls only as far as shows it', () => {
    const step = run({ ...PANE, view: 'list' }, list, ['down', 'down', 'down'])
    expect(step.pane.listCursor).toBe('b3')
    expect(step.pane.listTop).toBe(2)
    expect(step.effects).toEqual([{ kind: 'focus', key: 'b3' }])
    expect(run(step.pane, list, ['g', 'g']).pane).toMatchObject({ listCursor: 'b0', listTop: 0 })
    expect(press({ ...PANE, view: 'list' }, 'filter', list)).toMatchObject({ pane: { mode: 'filter' }, effects: [{ kind: 'filter' }] })
  })

  test('x acts on the row under the cursor and o on its Enter', () => {
    const ports: Nav = {
      context: 'previews',
      area: 10,
      canInsert: true,
      cursor: null,
      items: [
        { key: 'preview-port-5173', top: 0, height: 1, x: { kind: 'unpublish', thread: 'th-1', port: 5173 } },
        { key: 'port-8080', top: 1, height: 1, enter: { kind: 'publish', thread: 'th-1', port: 8080 }, x: { kind: 'say', text: 'not a preview' } },
      ],
    }
    expect(press(PANE, 'unpublish', ports).effects).toEqual([{ kind: 'unpublish', thread: 'th-1', port: 5173 }])
    const down = press(PANE, 'down', ports).pane
    expect(down.portCursor).toBe('port-8080')
    const drawn = { ...ports, cursor: down.portCursor }
    expect(press(down, 'open', drawn).effects).toEqual([{ kind: 'publish', thread: 'th-1', port: 8080 }])
    expect(press(down, 'unpublish', drawn).effects).toEqual([{ kind: 'say', text: 'not a preview' }])
  })

  test('the ring moved by the arrows, Tab or a click carries the cursor and the mode', () => {
    expect(ringMoved(PANE, 'compose')).toMatchObject({ mode: 'insert' })
    expect(ringMoved({ ...PANE, mode: 'insert' }, 'tab-pylon')).toMatchObject({ mode: 'normal' })
    expect(ringMoved({ ...PANE, tab: 'previews' }, 'port-5173')).toMatchObject({ portCursor: 'port-5173' })
    expect(ringMoved({ ...PANE, view: 'list' }, 'th-2')).toMatchObject({ listCursor: 'th-2' })
    expect(ringMoved({ ...PANE, overlay: { kind: 'menu', cursor: null } }, 'menu-delete').overlay).toEqual({ kind: 'menu', cursor: 'menu-delete' })
    const form = { title: '', project: 'web', node: '', branch: '', message: '', error: null, isStarting: false, request: 0, focused: null }
    expect(ringMoved({ ...PANE, view: 'start', start: form }, 'start-message').start).toMatchObject({ focused: 'start-message' })
  })
})

describe('changes and pylon', () => {
  const file = { path: 'src/a.ts', oldPath: null, status: 'modified' as const, additions: 1, deletions: 0 }
  const changes: Nav = {
    context: 'changes',
    area: 10,
    canInsert: true,
    cursor: null,
    thread: 'th-1',
    items: [
      { key: 'dir-src', top: 0, height: 1, enter: { kind: 'toggle', key: 'dir-src', isOpen: true } },
      { key: 'file-src/a.ts', top: 1, height: 1, enter: { kind: 'open-diff', thread: 'th-1', file }, y: { kind: 'copy', text: 'src/a.ts' } },
    ],
  }
  const onTab = { ...PANE, tab: 'changes' as const }

  test('the tabs run Conversation, Changes, Previews, Pylon, and h walks back', () => {
    const walked = ['right', 'right', 'right'].reduce<NexusPane[]>((panes, command) => [...panes, press(panes.at(-1)!, command as Command, changes).pane], [PANE])
    expect(walked.map(pane => pane.tab)).toEqual(['conversation', 'changes', 'previews', 'pylon'])
    expect(press(onTab, 'left', changes).pane.tab).toBe('conversation')
  })

  test('j moves over the tree, Enter opens a diff, y copies the path, r reads again and c switches the base', () => {
    const down = press(onTab, 'down', changes)
    expect(down.pane.changesCursor).toBe('file-src/a.ts')
    const drawn = { ...changes, cursor: down.pane.changesCursor }
    expect(press(down.pane, 'open', drawn).effects).toEqual([{ kind: 'open-diff', thread: 'th-1', file }])
    expect(press(down.pane, 'yank', drawn).effects).toEqual([{ kind: 'copy', text: 'src/a.ts' }])
    expect(press(onTab, 'refresh', changes).effects).toEqual([{ kind: 'read-changes', thread: 'th-1' }])
    expect(press(onTab, 'base', changes).effects).toEqual([{ kind: 'base' }])
  })

  test('a diff scrolls with the keys, y copies its path, and h goes back to the tree with the cursor on its file', () => {
    const open = { ...onTab, diff: { path: 'src/a.ts', top: 0 } }
    const diff: Nav = { context: 'diff', total: 50, area: 10, canInsert: true, thread: 'th-1', path: 'src/a.ts' }
    expect(press(open, 'halfDown', diff).pane.diff).toEqual({ path: 'src/a.ts', top: 5 })
    expect(run(open, diff, ['g', 'e']).pane.diff).toEqual({ path: 'src/a.ts', top: 40 })
    expect(press(open, 'yank', diff).effects).toEqual([{ kind: 'copy', text: 'src/a.ts' }])
    const back = press(open, 'left', diff)
    expect(back.pane).toMatchObject({ tab: 'changes', diff: null, changesCursor: 'file-src/a.ts' })
    expect(back.effects).toEqual([{ kind: 'focus', key: 'file-src/a.ts' }])
  })

  test('in Pylon, the cursor stops on the details and the sessions, and x on a row with no session says so', () => {
    const pylon: Nav = {
      context: 'pylon',
      area: 10,
      canInsert: true,
      cursor: null,
      items: [
        { key: 'pylon-details', top: 0, height: 4, y: { kind: 'copy', text: 'herdr --session x' } },
        { key: 'session-1.2', top: 4, height: 1, enter: { kind: 'attach', thread: 'th-1', isCopy: false }, x: { kind: 'close-session', thread: 'th-1', id: '1.2' } },
      ],
    }
    const onPylon = { ...PANE, tab: 'pylon' as const }
    expect(press(onPylon, 'yank', pylon).effects).toEqual([{ kind: 'copy', text: 'herdr --session x' }])
    expect(press(onPylon, 'unpublish', pylon).effects).toEqual([{ kind: 'say', text: 'No session to close. n opens one.' }])
    const down = press(onPylon, 'down', pylon)
    expect(down).toMatchObject({ pane: { pylonCursor: 'session-1.2' }, effects: [{ kind: 'focus', key: 'session-1.2' }] })
    expect(press(down.pane, 'open', { ...pylon, cursor: 'session-1.2' }).effects).toEqual([{ kind: 'attach', thread: 'th-1', isCopy: false }])
    expect(press(down.pane, 'up', { ...pylon, cursor: 'session-1.2' }).effects).toEqual([{ kind: 'focus', key: 'tab-pylon' }])
  })
})
