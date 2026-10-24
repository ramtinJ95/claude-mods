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
  detailsTop: 0,
  portCursor: null,
  sessionCursor: null,
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
    const details = press(PANE, 'right', nav)
    expect(details.pane.tab).toBe('details')
    expect(details.effects).toEqual([{ kind: 'tab', tab: 'details' }])
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

describe('the list and ports', () => {
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
      context: 'ports',
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
    expect(ringMoved({ ...PANE, mode: 'insert' }, 'tab-details')).toMatchObject({ mode: 'normal' })
    expect(ringMoved({ ...PANE, tab: 'ports' }, 'port-5173')).toMatchObject({ portCursor: 'port-5173' })
    expect(ringMoved({ ...PANE, view: 'list' }, 'th-2')).toMatchObject({ listCursor: 'th-2' })
    expect(ringMoved({ ...PANE, overlay: { kind: 'menu', cursor: null } }, 'menu-delete').overlay).toEqual({ kind: 'menu', cursor: 'menu-delete' })
    const form = { title: '', project: 'web', node: '', branch: '', message: '', error: null, isStarting: false, request: 0, focused: null }
    expect(ringMoved({ ...PANE, view: 'start', start: form }, 'start-message').start).toMatchObject({ focused: 'start-message' })
  })
})
