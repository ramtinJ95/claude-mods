// The pane's keys: one table of the letters it answers, and what a press does to
// the pane, as a pure step from the pane and what the drawing laid out to the next
// pane and the effects the hooks module carries out. Claude Code gives a pane's
// hotkeys one lowercase letter or digit, Shift folded in, so vim's G, ctrl+d and
// ctrl+u, / and ? are spelled ge, d, u, f and s here.
import type { NexusField, NexusMode, NexusPane, NexusTab } from '../types'
import type { Action } from './model'

export type Command =
  | 'down'
  | 'up'
  | 'g'
  | 'e'
  | 'halfDown'
  | 'halfUp'
  | 'left'
  | 'right'
  | 'open'
  | 'insert'
  | 'filter'
  | 'unpublish'
  | 'yank'
  | 'menu'
  | 'new'
  | 'refresh'
  | 'help'
  | 'close'

/** Every letter the pane answers, drawn as a hidden Button each, in every view but the start form. */
export const KEYMAP: readonly { hotkey: string; command: Command }[] = [
  { hotkey: 'j', command: 'down' },
  { hotkey: 'k', command: 'up' },
  { hotkey: 'g', command: 'g' },
  { hotkey: 'e', command: 'e' },
  { hotkey: 'd', command: 'halfDown' },
  { hotkey: 'u', command: 'halfUp' },
  { hotkey: 'h', command: 'left' },
  { hotkey: 'l', command: 'right' },
  { hotkey: 'o', command: 'open' },
  { hotkey: 'i', command: 'insert' },
  { hotkey: 'a', command: 'insert' },
  { hotkey: 'f', command: 'filter' },
  { hotkey: 'x', command: 'unpublish' },
  { hotkey: 'y', command: 'yank' },
  { hotkey: 'm', command: 'menu' },
  { hotkey: 'n', command: 'new' },
  { hotkey: 'r', command: 'refresh' },
  { hotkey: 's', command: 'help' },
  { hotkey: 'q', command: 'close' },
]

/** The key help, by where it applies: what `s` shows. */
export const HELP: readonly { title: string; keys: readonly [keys: string, what: string][] }[] = [
  {
    title: 'Everywhere',
    keys: [
      ['j k ↓ ↑', 'move the cursor, or scroll a block at a time'],
      ['g g · g e', 'top · bottom (the end follows the conversation again)'],
      ['d u', 'half a page down · up'],
      ['enter o', 'open or press what is under the cursor'],
      ['s', 'this help'],
      ['q', 'close what is open: the help, the menu, else the pane'],
      ['esc', 'leave the composer or the filter; else hand the keys to the prompt'],
    ],
  },
  { title: 'Threads', keys: [['l', 'open the thread'], ['f', 'filter by title'], ['n', 'start a thread'], ['y', "copy the thread's ID"], ['r', 'refresh']] },
  {
    title: 'A thread',
    keys: [
      ['h l', 'previous · next tab; h on Conversation goes back to the threads'],
      ['i a', 'write a message (insert mode); enter sends, an empty enter or esc leaves'],
      ['m', 'actions: abort, retry, archive, delete, start again, copy attach'],
      ['y', 'copy the block under the cursor, a URL, or the attach command'],
      ['r', 'watch again'],
    ],
  },
  { title: 'Ports', keys: [['enter', 'publish a port, or copy a preview’s URL'], ['x', 'unpublish the linked preview under the cursor']] },
]

/** What a single press asks for that only the hooks module can do. */
export type Effect =
  | { kind: 'open'; thread: string }
  | { kind: 'back' }
  | { kind: 'tab'; tab: NexusTab }
  | { kind: 'focus'; key: string }
  /** A port change names the thread it was drawn for: a press that lands after the pane moved on changes nothing. */
  | { kind: 'publish'; thread: string; port: number }
  | { kind: 'unpublish'; thread: string; port: number }
  | { kind: 'copy'; text: string }
  /** A notice instead of a press that cannot do what it asks, such as x on a declared service's preview. */
  | { kind: 'say'; text: string }
  | { kind: 'run'; action: MenuAction }
  | { kind: 'insert' }
  | { kind: 'filter' }
  | { kind: 'new' }
  | { kind: 'refresh' }
  | { kind: 'close' }

/** What the Actions menu runs: the CLI's verbs on a thread, and the pane's own. */
export type MenuAction = Action | 'start-again' | 'copy-attach' | 'rewatch'

/** A press on an item that changes only the pane: a fold, a tool row or a closed group opened or closed. */
export type Toggle = { kind: 'toggle'; key: string; isOpen: boolean }

/**
 * One row the cursor stops on, as laid out: its key, its place in rows from the top of its list, and what Enter, x
 * and y do on it.
 */
export type NavItem = { key: string; top: number; height: number; enter?: Effect | Toggle; x?: Effect; y?: Effect }

/** What the drawing laid out for the keys to move over, `area` being the rows the scrolled part shows. */
export type Nav =
  | { context: 'list'; items: NavItem[]; area: number }
  | { context: 'conversation'; items: NavItem[]; total: number; area: number; canInsert: boolean }
  | { context: 'details'; total: number; area: number; canInsert: boolean; attach: string | null }
  /** `cursor` as drawn: a port that moved between Previews and Ports keeps it. */
  | { context: 'ports'; items: NavItem[]; area: number; canInsert: boolean; cursor: string | null }
  | { context: 'menu'; items: NavItem[]; area: number }
  | { context: 'help'; total: number; area: number }
  | { context: 'none' }

export const TABS: readonly NexusTab[] = ['conversation', 'details', 'ports']

/** The keys of the composer and the list's filter, the two fields that take typed letters. */
export const COMPOSE = 'compose'
export const FILTER = 'filter'

/** `fields` with each of `texts`, keyed by field name, put in its field. */
export const putFields = (fields: Readonly<Record<string, NexusField>>, texts: Readonly<Record<string, string>>): Record<string, NexusField> => ({
  ...fields,
  ...Object.fromEntries(Object.entries(texts).map(([name, text]) => [name, { text, puts: (fields[name]?.puts ?? 0) + 1 }])),
})

/**
 * The key the field `name` is drawn under: a new one for each put. The engine keeps what is typed in a field by key,
 * and a `value` replaces it only when it differs from the one this mount last drew, so a put drawn under the same key
 * could leave older typing in its place.
 */
export const fieldKey = (fields: Readonly<Record<string, NexusField>>, name: string) => `${name}#${fields[name]?.puts ?? 0}`

/** The field a drawn key belongs to, or the key itself when it is no field's. */
export const fieldOf = (key: string) => key.replace(/#\d+$/, '')

type Step = { pane: NexusPane; effects: Effect[] }

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value))

/** The key of the item a motion lands on, from the one under the cursor (the first when none is). */
function moveOver(items: readonly NavItem[], current: string | null, command: Command, area: number): string | undefined {
  if (items.length === 0) return undefined
  const at = Math.max(0, items.findIndex(item => item.key === current))
  const here = items[at]!
  const half = Math.max(1, Math.floor(area / 2))
  switch (command) {
    case 'down':
      return items[Math.min(items.length - 1, at + 1)]!.key
    case 'up':
      return items[Math.max(0, at - 1)]!.key
    case 'g':
      return items[0]!.key
    case 'e':
      return items.at(-1)!.key
    case 'halfDown':
      return (items.find(item => item.top >= here.top + half) ?? items.at(-1)!).key
    case 'halfUp':
      return (items.findLast(item => item.top <= here.top - half) ?? items[0]!).key
    default:
      return here.key
  }
}

const isMotion = (command: Command) => command === 'down' || command === 'up' || command === 'g' || command === 'e' || command === 'halfDown' || command === 'halfUp'

/** The first row to show so that `item` shows whole, moving `top` as little as it can. */
export function keepInView(top: number, item: Pick<NavItem, 'top' | 'height'> | undefined, area: number): number {
  if (!item) return 0
  if (item.top < top) return item.top
  if (item.top + item.height > top + area) return item.top + item.height - area
  return top
}

/** Rows the conversation's bottom edge stands above its end: 0 follows it. */
export function scrolledRows(scroll: NexusPane['scroll'], items: readonly NavItem[], total: number, area: number): number {
  const anchor = scroll && items.find(item => item.key === scroll.anchor)
  if (!anchor) return 0
  return clamp(total - (anchor.top + anchor.height - scroll.rows), 0, Math.max(0, total - area))
}

/** The block under the conversation's cursor, which o, Enter and y act on: the anchor, else the newest. */
export function blockAt(items: readonly NavItem[], scroll: NexusPane['scroll']): number {
  const at = scroll ? items.findIndex(item => item.key === scroll.anchor) : -1
  return at >= 0 ? at : items.length - 1
}

/** The scroll whose bottom edge stands `rows` above the end, the cursor on the block that edge falls in; null at the end. */
function scrollTo(items: readonly NavItem[], total: number, rows: number): NexusPane['scroll'] {
  if (rows <= 0 || items.length === 0) return null
  const edge = total - rows
  const block = items.find(item => item.top < edge && item.top + item.height >= edge) ?? items[0]!
  return { anchor: block.key, rows: block.top + block.height - edge }
}

/** The cursor on `items[index]`, the window moved as little as shows the block's top. */
function moveTo(items: readonly NavItem[], total: number, area: number, rows: number, index: number): NexusPane['scroll'] {
  const target = items[index]!
  let edge = total - rows
  if (target.top >= edge) edge = Math.min(target.top + target.height, target.top + area)
  else if (target.top < edge - area) edge = target.top + area
  edge = clamp(edge, Math.min(area, total), total)
  return { anchor: target.key, rows: target.top + target.height - edge }
}

function scrollConversation(pane: NexusPane, command: Command, nav: Extract<Nav, { context: 'conversation' }>): NexusPane['scroll'] {
  const { items, total, area } = nav
  if (items.length === 0) return null
  const rows = scrolledRows(pane.scroll, items, total, area)
  const half = Math.max(1, Math.floor(area / 2))
  const at = blockAt(items, pane.scroll)
  // j and k step the cursor a block; d and u move the window half its height, through a long block too.
  switch (command) {
    case 'down':
      return at + 1 >= items.length ? null : moveTo(items, total, area, rows, at + 1)
    case 'up':
      return moveTo(items, total, area, rows, Math.max(0, at - 1))
    case 'g':
      return moveTo(items, total, area, rows, 0)
    case 'e':
      return null
    case 'halfDown':
      return scrollTo(items, total, rows - half)
    case 'halfUp':
      return scrollTo(items, total, Math.min(Math.max(0, total - area), rows + half)) ?? moveTo(items, total, area, rows, Math.max(0, at - 1))
    default:
      return pane.scroll
  }
}

/** The pane after `command` with what the drawing laid out, and what the hooks module must do for it. */
export function press(before: NexusPane, pressed: Command, nav: Nav): Step {
  let command = pressed
  // g waits for its second key: g g is the top, g e the bottom, and any other key goes on as itself.
  if (before.pending === 'g' && (pressed === 'g' || pressed === 'e')) command = pressed
  else if (pressed === 'g') return { pane: { ...before, pending: 'g' }, effects: [] }
  else if (pressed === 'e') return { pane: { ...before, pending: null }, effects: [] }
  const pane: NexusPane = { ...before, pending: null, notice: null }
  const done = (change: Partial<NexusPane> = {}, effects: Effect[] = []): Step => ({ pane: { ...pane, ...change }, effects })
  const apply = (effect: Effect | Toggle | undefined, change: Partial<NexusPane> = {}): Step => {
    if (!effect) return done(change)
    if (effect.kind === 'toggle') return done({ ...change, toggled: { ...pane.toggled, [effect.key]: !effect.isOpen } })
    return done(change, [effect])
  }
  const mode = (next: NexusMode): Partial<NexusPane> => ({ mode: next })

  if (pane.overlay?.kind === 'help') {
    if (command === 'close' || command === 'help' || command === 'left') return done({ overlay: null })
    // Taller than the body, the help scrolls; it takes no other key.
    const most = nav.context === 'help' ? Math.max(0, nav.total - nav.area) : 0
    const half = nav.context === 'help' ? Math.max(1, Math.floor(nav.area / 2)) : 1
    const moved: Partial<Record<Command, number>> = { down: 1, up: -1, halfDown: half, halfUp: -half, g: -Infinity, e: Infinity }
    const by = moved[command]
    return by === undefined ? done() : done({ overlay: { kind: 'help', top: clamp(pane.overlay.top + by, 0, most) } })
  }
  if (nav.context === 'menu' && pane.overlay?.kind === 'menu') {
    if (command === 'close' || command === 'menu' || command === 'left') return done({ overlay: null })
    const chosen = pane.overlay.cursor
    const current = nav.items.find(item => item.key === chosen) ?? nav.items[0]
    if (isMotion(command)) {
      const key = moveOver(nav.items, current?.key ?? null, command, nav.area)
      return done({ overlay: { kind: 'menu', cursor: key ?? null } }, key ? [{ kind: 'focus', key }] : [])
    }
    if (command === 'open' || command === 'right') return apply(current?.enter, { overlay: null })
    return done()
  }

  // What every thread tab answers alike.
  const thread = nav.context === 'conversation' || nav.context === 'details' || nav.context === 'ports' ? nav : null
  if (thread) {
    switch (command) {
      case 'menu':
        return done({ overlay: { kind: 'menu', cursor: null } })
      case 'insert':
        return thread.canInsert ? done({ tab: 'conversation', ...mode('insert') }, [{ kind: 'insert' }]) : done()
      case 'left': {
        const at = TABS.indexOf(pane.tab)
        if (at <= 0) return done(mode('normal'), [{ kind: 'back' }])
        return done({ tab: TABS[at - 1]!, ...mode('normal') }, [{ kind: 'tab', tab: TABS[at - 1]! }])
      }
      case 'right': {
        const at = TABS.indexOf(pane.tab)
        if (at >= TABS.length - 1) return done()
        return done({ tab: TABS[at + 1]!, ...mode('normal') }, [{ kind: 'tab', tab: TABS[at + 1]! }])
      }
    }
  }
  switch (command) {
    case 'help':
      return done({ overlay: { kind: 'help', top: 0 } })
    case 'close':
      return done({}, [{ kind: 'close' }])
    case 'new':
      return done({}, [{ kind: 'new' }])
    case 'refresh':
      return done({}, [{ kind: 'refresh' }])
  }

  switch (nav.context) {
    case 'list': {
      const current = nav.items.find(item => item.key === pane.listCursor) ?? nav.items[0]
      if (isMotion(command)) {
        const key = moveOver(nav.items, current?.key ?? null, command, nav.area)
        const item = nav.items.find(one => one.key === key)
        return done({ listCursor: key ?? null, listTop: keepInView(pane.listTop, item, nav.area) }, key ? [{ kind: 'focus', key }] : [])
      }
      if (command === 'open' || command === 'right') return apply(current?.enter)
      if (command === 'yank') return apply(current?.y)
      if (command === 'filter') return done(mode('filter'), [{ kind: 'filter' }])
      return done()
    }
    case 'conversation': {
      if (isMotion(command)) {
        // The ring follows the cursor: onto the block when it is a button, else back to the tab, so Tab and ⏎ act where the marker is.
        const scroll = scrollConversation(pane, command, nav)
        const block = nav.items[blockAt(nav.items, scroll)]
        return done({ scroll }, [{ kind: 'focus', key: block?.enter ? block.key : 'tab-conversation' }])
      }
      const current = nav.items[blockAt(nav.items, pane.scroll)]
      if (command === 'open') return apply(current?.enter)
      if (command === 'yank') return apply(current?.y)
      return done()
    }
    case 'details': {
      const most = Math.max(0, nav.total - nav.area)
      const half = Math.max(1, Math.floor(nav.area / 2))
      const moved: Partial<Record<Command, number>> = { down: 1, up: -1, halfDown: half, halfUp: -half, g: -Infinity, e: Infinity }
      const by = moved[command]
      if (by !== undefined) return done({ detailsTop: clamp(pane.detailsTop + by, 0, most) })
      if (command === 'yank' && nav.attach) return done({}, [{ kind: 'copy', text: nav.attach }])
      return done()
    }
    case 'ports': {
      const current = nav.items.find(item => item.key === nav.cursor) ?? nav.items[0]
      if (isMotion(command)) {
        const key = moveOver(nav.items, current?.key ?? null, command, nav.area)
        return done({ portCursor: key ?? null }, key ? [{ kind: 'focus', key }] : [])
      }
      if (command === 'open') return apply(current?.enter)
      if (command === 'unpublish') return apply(current?.x)
      if (command === 'yank') return apply(current?.y)
      return done()
    }
    default:
      return done()
  }
}

/** The pane's state after a person moved the ring onto `element` with the arrows, Tab or a click. */
export function ringMoved(pane: NexusPane, element: string): NexusPane {
  const field = fieldOf(element)
  if (field === COMPOSE) return { ...pane, mode: 'insert', overlay: null, tab: 'conversation' }
  if (field === FILTER) return { ...pane, mode: 'filter' }
  // Leaving a field by the ring is leaving its mode.
  const base: NexusPane = pane.mode === 'normal' ? pane : { ...pane, mode: 'normal' }
  if (element.startsWith('menu-') && pane.overlay?.kind === 'menu') return { ...base, overlay: { kind: 'menu', cursor: element } }
  if (element.startsWith('preview-') || element.startsWith('port-')) return { ...base, portCursor: element }
  if (pane.view === 'list') return { ...base, listCursor: element }
  if (pane.view === 'start' && pane.start) return { ...base, start: { ...pane.start, focused: field } }
  return base
}
