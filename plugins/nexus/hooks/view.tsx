// How the pane looks: a dock with a title bar, the thread list grouped by project,
// one thread under three tabs (its conversation drawn as a Claude Code transcript
// draws its own, its details, its ports), the Actions menu, the key help and the
// start form. Each function takes the surface's elements, what the atoms hold and
// the handlers the hooks module made, and holds no state of its own. Every colour
// is a theme key, so the pane follows the person's theme.
import type {
  BoxProps,
  ButtonProps,
  CodeProps,
  ElementConstructor,
  InputProps,
  LinkProps,
  MarkdownProps,
  RenderChildren,
  RenderSurface,
  SelectProps,
  TextProps,
} from 'claude-code'

import type {
  NexusActual,
  NexusCatalog,
  NexusDesired,
  NexusDetail,
  NexusList,
  NexusLive,
  NexusPane,
  NexusPort,
  NexusPortChange,
  NexusPreview,
  NexusShown,
  NexusStartDraft,
  NexusTab,
  NexusThread,
  NexusThreadRow,
  NexusWatch,
} from '../types'
import { COMPOSE, type Command, type Effect, FILTER, HELP, KEYMAP, type MenuAction, type Nav, type NavItem, blockAt, fieldKey, keepInView, scrolledRows } from './keys'
import {
  ACTUAL_BADGE,
  type Block,
  DESIRED_TONE,
  FOLD_AT,
  HARNESS_LABEL,
  SESSION_TONE,
  type Tone,
  TONE_COLOR,
  type ToolRow,
  type ToolStatus,
  blocks,
  cells,
  clip,
  clock,
  closedKey,
  closedLabel,
  diffOf,
  exitCode,
  foldSummary,
  groupThreads,
  linkedPort,
  NO_CHANGE,
  portChange,
  previewLook,
  runOf,
  sentence,
  since,
  span,
  spinner,
  subjectOf,
  threadState,
  toolName,
  toolStatus,
} from './model'

export type Draw = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Button: ElementConstructor<ButtonProps>
  Input: ElementConstructor<InputProps>
  Select: ElementConstructor<SelectProps>
  Link: ElementConstructor<LinkProps>
  Code: ElementConstructor<CodeProps>
  Markdown: ElementConstructor<MarkdownProps>
}

/** Everything a drawing reads: the atoms, the clock and the body's size. */
export type Scene = {
  list: NexusList
  watch: NexusWatch | null
  /** The watch's latest live event for the thread shown. */
  live: NexusLive | null
  shown: NexusShown | null
  catalog: NexusCatalog
  pane: NexusPane
  now: number
  width: number
  /** The rows the pane's body has; the views fill them, so the title bar and the composer stay put. */
  rows: number
  /** Docked beside the transcript, or above the prompt, where the engine paints no background of its own. */
  placement: 'dock' | 'inline'
  isFocused: boolean
  surface: RenderSurface
}

export type PaneActions = {
  /** A key pressed, with what this drawing laid out for it to move over. */
  key: (command: Command, nav: Nav) => void
  /** What a click or Enter on one item asks, as a key would. */
  effect: (effect: Effect) => void
  /** Opens or closes a fold, a tool row or a group's closed threads, as drawn now. */
  toggle: (key: string, isOpen: boolean) => void
  tab: (tab: NexusTab) => void
  filter: (text: string) => void
  /** Enter in the filter: back to normal mode, the cursor on the first thread it keeps. */
  filterDone: (first: string | null) => void
  draft: (text: string) => void
  submit: (text: string) => void
  back: () => void
  startDraft: (change: Partial<NexusStartDraft>) => void
  /** Picks the form's project, which clears the node and branch chosen for the one before. */
  startProject: (project: string) => void
  /** Starts the thread, the field Enter was pressed in carrying its text: it may not have reported it yet. */
  startSubmit: (change?: Partial<Pick<NexusStartDraft, 'title' | 'branch' | 'message'>>) => void
}


/**
 * The dock paints the theme's composerSidebarBackground under everything a pane draws, and no prop clears it. A Box
 * painted over the whole body hides it: under dark-ansi `bashMessageBackgroundColor` is ANSI black, which most dark
 * palettes draw as (or next to) the terminal's own background. The title bar takes the user message's band.
 */
const BODY = 'bashMessageBackgroundColor'
const BAR = 'userMessageBackground'

/** The list's and the pills' colours: an agent at work is cyan, apart from the reds of a failure. */
const LOOK: Record<Tone, string> = { ...TONE_COLOR, work: 'planMode' }
const GLYPH: Record<Tone, string> = { ok: '●', work: '◉', busy: '◐', idle: '○', bad: '✕', muted: '◌' }

/** Covers the gutter and the rows the body can't reach; the dock still clips its close row, bottom row and divider. */
function Underlay({ Box }: Draw, scene: Scene) {
  return <Box key="underlay" position="absolute" top={-2} left={0} width={scene.width + 3} height={scene.rows + 4} backgroundColor={BODY} />
}

/** The pane's frame: the body's whole size, docked on the terminal's own background, so the title bar and footer stay put. */
function Frame(draw: Draw, scene: Scene, children: readonly RenderChildren[]) {
  const { Box } = draw
  const isDocked = scene.placement === 'dock'
  return (
    <Box flexDirection="column" width={scene.width} height={scene.rows} backgroundColor={isDocked ? BODY : undefined}>
      {isDocked && Underlay(draw, scene)}
      {children}
    </Box>
  )
}

/** Rows above or below the body that keep their height: the body alone gives way to the frame's. */
function Fixed({ Box }: Draw, key: string, children: RenderChildren) {
  return (
    <Box key={key} flexDirection="column" flexShrink={0}>
      {children}
    </Box>
  )
}

/** A status as a filled chip, the dashboard's badge: the tone's colour behind the label. */
function Pill({ Text }: Draw, label: string, tone: Tone) {
  return (
    <Text backgroundColor={LOOK[tone]} color="inverseText" bold>
      {` ${label} `}
    </Text>
  )
}

/** The pane's title bar: a band across the dock with where the person is and what is going on. */
function TitleBar(draw: Draw, scene: Scene, left: RenderChildren, right: string) {
  const { Box, Text } = draw
  return (
    <Box key="title" flexDirection="row" width={scene.width} backgroundColor={BAR} paddingX={1} justifyContent="space-between">
      <Box flexShrink={1}>
        <Text wrap="truncate-end">{left}</Text>
      </Box>
      <Text color="subtle">{right}</Text>
    </Box>
  )
}

function Rule({ Text }: Draw, scene: Scene, color = 'subtle') {
  return <Text color={color}>{'─'.repeat(scene.width)}</Text>
}

function SectionRule({ Box, Text }: Draw, scene: Scene, title: string, count: string, key: string) {
  return (
    <Box key={key} marginTop={1} flexDirection="row">
      <Text bold color="claude">
        {title.toUpperCase()}
      </Text>
      <Text color="subtle">{`${count ? ` ${count}` : ''} ${'─'.repeat(Math.max(0, scene.width - title.length - count.length - 2))}`}</Text>
    </Box>
  )
}

/**
 * Every letter the pane answers, as Buttons in a Box drawn as nothing: a hidden Button's hotkey still presses it, so
 * the keys need no room, and the mode line says which matter here. A focused field takes the letters before them.
 */
function KeyMap({ Box, Button }: Draw, actions: PaneActions, nav: Nav) {
  return (
    <Box key="keymap" display="none">
      {KEYMAP.map(key => (
        <Button key={`key-${key.hotkey}`} plain hotkey={key.hotkey} label={key.command} onPress={() => actions.key(key.command, nav)} />
      ))}
    </Box>
  )
}

const MODE_LOOK = { normal: ['NORMAL', 'idle'], insert: ['INSERT', 'ok'], filter: ['FILTER', 'busy'] } as const satisfies Record<NexusPane['mode'], [string, Tone]>

/**
 * The bottom line: the mode, so the person knows where letters go, and the keys that matter here. Without the
 * keyboard it says how to hand the pane the keys instead.
 */
function ModeLine(draw: Draw, scene: Scene, hints: readonly (readonly [string, string])[], mode: NexusPane['mode'] = scene.pane.mode) {
  const { Box, Text } = draw
  if (!scene.isFocused) {
    return (
      <Box key="mode" marginTop={1}>
        <Text wrap="truncate-end">
          <Text backgroundColor="warning" color="inverseText" bold>
            {' ctrl+x tab '}
          </Text>
          <Text color="warning">{' the keys are at the prompt: ctrl+x then tab, or a click, hands them to the pane'}</Text>
        </Text>
      </Box>
    )
  }
  const [label, tone] = MODE_LOOK[mode]
  return (
    <Box key="mode" marginTop={1}>
      <Text wrap="truncate-end">
        {Pill(draw, label, tone)}
        {scene.pane.pending ? <Text color="suggestion">{` ${scene.pane.pending}…`}</Text> : ''}
        {hints.map(([key, what]) => (
          <Text key={`hint-${key}`}>
            <Text color="suggestion">{`  ${key}`}</Text>
            <Text color="subtle">{` ${what}`}</Text>
          </Text>
        ))}
      </Text>
    </Box>
  )
}

function Notice({ Text }: Draw, pane: NexusPane) {
  if (!pane.notice) return null
  return (
    <Text key="notice" color={pane.notice.tone === 'error' ? 'error' : 'subtle'}>
      {pane.notice.text}
    </Text>
  )
}

const Dot = ({ Text }: Draw, tone: Tone) => <Text color={LOOK[tone]}>{GLYPH[tone]}</Text>

/** The cursor's mark at the head of a row the keys move over. */
const Pointer = ({ Text }: Draw, isCursor: boolean) => <Text color="suggestion">{isCursor ? '❯ ' : '  '}</Text>

/** Where a pylon's phase stands against what is wanted of it, for the list's "wants paused". */
const PHASE: Partial<Record<NexusActual, NexusDesired>> = { running: 'running', spawning: 'running', paused: 'paused', pausing: 'paused', deleting: 'deleted', absent: 'deleted' }

// The layout's rows, estimated from the built tree: the views fill a fixed height, so they say where things land.

type Element = { type: string; props?: Readonly<Record<string, unknown>>; children?: unknown }
const isElement = (node: unknown): node is Element => typeof node === 'object' && node !== null && !Array.isArray(node) && typeof (node as Element).type === 'string'
const num = (value: unknown) => (typeof value === 'number' ? value : 0)

/** The text an inline element draws: its strings, its nested Texts and its label. */
function inlineText(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(inlineText).join('')
  if (!isElement(node)) return ''
  const label = typeof node.props?.label === 'string' ? node.props.label : ''
  const hotkey = typeof node.props?.hotkey === 'string' && node.props.plain ? `${node.props.hotkey}: ` : ''
  return `${hotkey}${label}${inlineText(node.children)}`
}

/** Rows `text` takes at `width` cells, wrapped, each line at least one. */
function wrapped(text: string, width: number): number {
  const room = Math.max(1, width)
  return text.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(cells(line) / room)), 0)
}

/** The most rows a field grows to; a short pane gives it a quarter of its rows, which the body above needs more. */
const FIELD_ROWS = 6

/**
 * The rows a focused field's editor wraps `text` to in `columns`: as `Bun.wrapAnsi(text, columns - 1, { hard: true,
 * trim: false })` does in 2.1.310, the last cell kept for the cursor. A word moves whole to the next row, keeping the
 * space before it on the row it left, and one wider than a row breaks across rows.
 */
export function editorRows(text: string, columns: number): number {
  const width = columns - 1
  // The wrap reads a pasted `\r\n` as one line break.
  return text.replace(/\r\n/g, '\n').split('\n').reduce((sum, line) => {
    let rows = 1
    let used = 0
    for (const [index, word] of line.split(' ').entries()) {
      if (index > 0) {
        if (used >= width) {
          rows += 1
          used = 0
        }
        used += 1
      }
      const size = cells(word)
      if (size > width) {
        if (Math.floor((size - 1) / width) < 1 + Math.floor((size - (width - used) - 1) / width)) {
          rows += 1
          used = 0
        }
        const chars = [...word]
        for (const [at, char] of chars.entries()) {
          const taken = cells(char)
          if (used + taken > width) {
            rows += 1
            used = 0
          }
          used += taken
          if (used === width && at < chars.length - 1) {
            rows += 1
            used = 0
          }
        }
        continue
      }
      if (used > 0 && size > 0 && used + size > width) {
        rows += 1
        used = 0
      }
      used += size
    }
    return sum + rows
  }, 0)
}

/**
 * The rows an Input needs to show all of `text` in a pane `width` by `rows`, two at least while it has the keys: a
 * field of one row submits on `\⏎` instead of typing a newline. The engine sizes a focused field's editor from the
 * site's width less `label: ` and the Enter hint, never from the Box it sits in, so a field must span the site to wrap
 * where it is drawn. From two rows the hint also names the newline key, when that leaves the text half the width. The
 * key is `\⏎` or `shift+⏎` as the terminal allows, so the rows are the more of the two.
 */
export function fieldRows(text: string, label: string, submit: string, width: number, rows: number, hasKeys: boolean): number {
  const room = width - (label ? cells(label) + 2 : 0)
  const enter = ` ⏎ ${submit}`
  const rowsAt = (columns: number) => editorRows(text, Math.max(12, columns))
  if (!hasKeys && rowsAt(room - cells(enter)) <= 1) return 1
  const needed = Math.max(
    ...['\\⏎', 'shift+⏎'].map(key => {
      const newline = `${enter} · ${key} new line`
      const hint = room - cells(newline) >= width / 2 ? newline : enter
      return rowsAt(room - cells(hint))
    }),
  )
  return Math.max(2, Math.min(FIELD_ROWS, Math.floor(rows / 4), needed))
}

/** The rows a built tree takes at `width`, as the column it sits in stacks it. An estimate of the engine's layout. */
export function rowsOf(node: unknown, width: number): number {
  if (node === null || node === undefined || typeof node === 'boolean') return 0
  if (typeof node === 'string' || typeof node === 'number') return wrapped(String(node), width)
  if (Array.isArray(node)) return node.reduce((sum: number, child) => sum + rowsOf(child, width), 0)
  if (!isElement(node)) return 0
  const props = node.props ?? {}
  if (props.display === 'none' || props.position === 'absolute') return 0
  switch (node.type) {
    case 'Text':
    case 'Button':
    case 'Link': {
      const text = node.type === 'Link' && !inlineText(node) ? String(props.href ?? '') : inlineText(node)
      return props.wrap === 'truncate-end' ? text.split('\n').length : wrapped(text, width)
    }
    case 'Markdown':
      return wrapped(String(props.text ?? ''), width)
    case 'Code': {
      const source = String(props.source ?? '')
      return props.wrap === 'truncate-end' ? source.split('\n').length : wrapped(source, width - (props.format === 'diff' ? 7 : 0))
    }
    case 'Input':
      return Math.max(1, num(props.rows))
    case 'Select':
      return 1
    case 'Box': {
      const border = props.borderStyle ? 1 : 0
      const padX = num(props.paddingLeft ?? props.paddingX ?? props.padding) + num(props.paddingRight ?? props.paddingX ?? props.padding)
      const padY = num(props.paddingTop ?? props.paddingY ?? props.padding) + num(props.paddingBottom ?? props.paddingY ?? props.padding)
      const margin = num(props.marginTop ?? props.marginY ?? props.margin) + num(props.marginBottom ?? props.marginY ?? props.margin)
      if (typeof props.height === 'number') return props.height + margin
      const inner = Math.max(1, width - padX - 2 * border)
      const children = (Array.isArray(node.children) ? node.children.flat(Infinity) : [node.children]).filter(child => child !== null && child !== undefined && child !== false)
      let body: number
      if (props.flexDirection === 'row') {
        // Inline children take their text's width; the Boxes share what is left.
        const fixed = children.filter(child => !isElement(child) || child.type !== 'Box')
        const boxes = children.length - fixed.length
        const used = fixed.reduce((sum: number, child) => sum + Math.min(inner, cells(inlineText(child))), 0) + num(props.columnGap) * Math.max(0, children.length - 1)
        const share = boxes > 0 ? Math.max(1, Math.floor((inner - used) / boxes)) : inner
        body = children.reduce((most: number, child) => Math.max(most, isElement(child) && child.type === 'Box' ? rowsOf(child, share) : rowsOf(child, inner)), 0)
      } else {
        body = children.reduce((sum: number, child) => sum + rowsOf(child, inner), 0) + num(props.rowGap) * Math.max(0, children.length - 1)
      }
      return Math.max(body + padY + 2 * border, num(props.minHeight)) + margin
    }
    default:
      return 0
  }
}

// The thread list.

function TitleOfList(draw: Draw, scene: Scene) {
  const { Text } = draw
  const { list, catalog } = scene
  const threads = list.threads ?? []
  const open = threads.filter(thread => thread.status === 'active' || thread.status === 'idle').length
  const working = threads.filter(thread => thread.agentTurnRunning).length
  const online = catalog.nodes?.filter(node => node.state === 'online').length
  return TitleBar(
    draw,
    scene,
    <Text>
      <Text bold color="claude">
        ◆ Nexus
      </Text>
      {list.threads ? (
        <Text color="subtle">{`   ${working} working · ${open} open`}</Text>
      ) : list.failure ? (
        <Text color="error">{list.failure.kind === 'unreachable' ? '   unreachable' : '   not loaded'}</Text>
      ) : (
        <Text color="subtle">{'   connecting…'}</Text>
      )}
    </Text>,
    online === undefined ? '' : `${online}/${catalog.nodes!.length} nodes online`,
  )
}

export function ListView(draw: Draw, scene: Scene, actions: PaneActions) {
  const { Box, Text, Button, Input } = draw
  const { list, pane } = scene
  const threads = list.threads ?? []
  const groups = groupThreads(threads, pane.filter, pane.toggled)
  const now = list.polledAt ?? scene.now
  const isFiltering = pane.mode === 'filter'
  const order = groups.flatMap(group => [...group.open, ...(group.closed.length > 0 ? [{ id: closedKey(group.project) }] : []), ...(group.isUnfolded ? group.closed : [])])
  const cursor = order.some(one => one.id === pane.listCursor) ? pane.listCursor : (order[0]?.id ?? null)
  const items: NavItem[] = []
  const drawn: RenderChildren[] = []
  let y = 0
  const place = (node: RenderChildren, item?: Omit<NavItem, 'top' | 'height'>) => {
    const height = rowsOf(node, scene.width)
    if (item) items.push({ ...item, top: y, height })
    drawn.push(node)
    y += height
  }
  const row = (thread: NexusThreadRow) => {
    const [label, tone] = threadState(thread, thread.pylon.actualState)
    const age = thread.agentTurnRunning ? 'now' : (span(now - thread.lastActivityAt) ?? 'now')
    const pill = label === 'agent working' ? 'working' : label
    const room = Math.max(8, scene.width - 4 - (pill.length + 2) - 7)
    const title = clip(thread.title, room)
    const isCursor = cursor === thread.id
    const wants = PHASE[thread.pylon.actualState] !== thread.desired ? `wants ${thread.desired} · ` : ''
    place(
      <Box key={`row-${thread.id}`} flexDirection="column">
        <Button key={thread.id} plain autoFocus={isCursor && !isFiltering ? true : undefined} onPress={() => actions.effect({ kind: 'open', thread: thread.id })}>
          {Pointer(draw, isCursor)}
          {Dot(draw, tone)}
          <Text bold={isCursor} color={isCursor ? 'suggestion' : 'text'}>{` ${title}`}</Text>
          {' '.repeat(Math.max(1, room - cells(title)))}
          {Pill(draw, pill, tone)}
          <Text color="subtle">{` ${age.padStart(5)}`}</Text>
        </Button>
        {isCursor && (
          <Text color="subtle" wrap="truncate-end">{`    ${wants}${thread.pylon.node} · you ${span(now - thread.lastHumanActivityAt) ?? 'now'} · agent ${thread.agentTurnRunning ? 'working' : (span(now - thread.lastAgentActivityAt) ?? 'now')} · ${thread.id}`}</Text>
        )}
      </Box>,
      { key: thread.id, enter: { kind: 'open', thread: thread.id }, y: { kind: 'copy', text: thread.id } },
    )
  }
  for (const group of groups) {
    place(SectionRule(draw, scene, group.project, String(group.open.length), `project-${group.project}`))
    group.open.forEach(row)
    if (group.closed.length > 0) {
      const key = closedKey(group.project)
      place(
        <Button key={key} plain dimColor autoFocus={cursor === key && !isFiltering ? true : undefined} onPress={() => actions.toggle(key, group.isUnfolded)}>
          {Pointer(draw, cursor === key)}
          {`  ${group.isUnfolded ? '▾' : '▸'} ${closedLabel(group.closed)}`}
        </Button>,
        { key, enter: { kind: 'toggle', key, isOpen: group.isUnfolded } },
      )
    }
    if (group.isUnfolded) group.closed.forEach(row)
  }
  const header = [
    TitleOfList(draw, scene),
    list.failure && (
      <Text key="failure" color="error">
        {list.failure.kind === 'unreachable' ? 'Nexus is unreachable' : `nexus failed (${list.failure.kind})`}: {sentence(list.failure.message)}
        {list.threads ? ' The list is from the last poll that worked.' : ''}
      </Text>
    ),
    isFiltering ? (
      <Box key="filter-box" marginTop={1} borderStyle="round" borderColor="promptBorder" paddingX={1}>
        <Input key={fieldKey(pane.fields, FILTER)} autoFocus label="⌕" value={pane.fields[FILTER]?.text} placeholder="filter threads by title" submitLabel="done" onInput={actions.filter} onSubmit={() => actions.filterDone(order.find(one => !one.id.startsWith('closed-'))?.id ?? null)} />
      </Box>
    ) : (
      pane.filter && <Text key="filtered" color="subtle">{`⌕ ${pane.filter}   f edits it, an empty filter shows all`}</Text>
    ),
    list.threads && groups.length === 0 && (
      <Text key="empty" color="subtle">
        {pane.filter ? 'No thread title holds that.' : 'No threads yet. n starts one.'}
      </Text>
    ),
  ]
  const isHelp = pane.overlay?.kind === 'help'
  const hints: [string, string][] = isFiltering
    ? [['⏎', 'done'], ['esc', 'clear']]
    : isHelp
      ? [['j/k', 'scroll'], ['q', 'close the help']]
      : [['j/k', 'move'], ['l', 'open'], ['f', 'filter'], ['n', 'new'], ['s', 'keys'], ['q', 'close']]
  const footer = [Notice(draw, pane), ModeLine(draw, scene, hints)]
  const area = Math.max(3, scene.rows - rowsOf(header, scene.width) - rowsOf(footer, scene.width))
  const top = keepInView(Math.min(pane.listTop, Math.max(0, y - area)), items.find(item => item.key === cursor), area)
  const body: Body = isHelp
    ? HelpBody(draw, scene, actions, area)
    : {
        nav: { context: 'list', items, area },
        node: (
          <Box flexDirection="column" flexShrink={0} marginTop={-top}>
            {drawn}
          </Box>
        ),
      }
  const nav = body.nav
  return Frame(
    draw,
    scene,
    [
      Fixed(draw, 'head', header),
      <Box key="list" flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
        {body.node}
      </Box>,
      Fixed(draw, 'foot', footer),
      KeyMap(draw, actions, nav),
    ],
  )
}

// A thread: its header and tabs, then the tab's body, the run line, the composer and the mode line.

/** What the thread view knows of the thread: the `show` poll, else the list's row, else the watch. */
function threadOf(scene: Scene): { id: string; thread: NexusThread | undefined; detail: NexusDetail | null } {
  const id = scene.pane.selected ?? ''
  const detail = scene.shown?.thread === id ? scene.shown.detail : null
  return { id, thread: detail?.thread ?? scene.list.threads?.find(one => one.id === id), detail }
}

const TAB_LABEL: Record<NexusTab, string> = { conversation: 'Conversation', details: 'Details', ports: 'Ports' }

/** What the body laid out for the keys, filled in once it is drawn: Enter on the active tab acts on it as o does. */
type Holder = { nav: Nav }

function Header(draw: Draw, scene: Scene, actions: PaneActions, ports: number, holder: Holder) {
  const { Box, Text, Button } = draw
  const { id, thread, detail } = threadOf(scene)
  const watch = scene.watch?.thread === id ? scene.watch : null
  const state = watch?.state
  const row = scene.list.threads?.find(one => one.id === id)
  // The details, the watch's state or the list's row, whichever has come: none of them before the first poll.
  const pylon = detail?.pylon.actualState ?? (state?.pylon as NexusActual | undefined) ?? row?.pylon.actualState
  const facts = { status: state?.status ?? thread?.status ?? 'active', agentTurnRunning: state ? state.run === 'working' : (thread?.agentTurnRunning ?? false) }
  const known = pylon ? threadState(facts, pylon) : null
  const node = detail?.pylon.node ?? row?.pylon.node
  const run = watch && state?.run === 'working' ? runOf(watch.rows) : null
  const pill = known
    ? known[0] === 'agent working'
      ? `working${run?.since ? ` ${clock(scene.now - run.since)}` : ''}`
      : known[0]
    : watch?.ended
      ? 'not watching'
      : watch?.outage
        ? 'not connected'
        : 'connecting'
  const tab = (key: NexusTab) => {
    const label = `${TAB_LABEL[key]}${key === 'ports' && ports > 0 ? ` ${ports}` : ''}`
    const isOn = scene.pane.tab === key && !scene.pane.overlay
    return (
      <Button
        key={`tab-${key}`}
        plain
        autoFocus={isOn && scene.pane.mode === 'normal' ? true : undefined}
        onPress={() => (scene.pane.tab === key ? actions.key('open', holder.nav) : actions.tab(key))}
      >
        {isOn ? (
          <Text bold underline color="claude">
            {label}
          </Text>
        ) : (
          <Text color="subtle">{label}</Text>
        )}
      </Button>
    )
  }
  return (
    <Box key="header" flexDirection="column">
      {TitleBar(
        draw,
        scene,
        <Text>
          <Text color="subtle">{'‹ '}</Text>
          {thread && <Text color="subtle">{`${thread.project} / `}</Text>}
          <Text bold>{thread?.title ?? id}</Text>
        </Text>,
        id,
      )}
      <Text wrap="truncate-end">
        {Pill(draw, pill, known?.[1] ?? 'muted')}
        <Text color="subtle">{`  ${[node, watch?.model, thread ? `started ${since(thread.createdAt, scene.now)}` : null].filter(Boolean).join('  ·  ')}`}</Text>
      </Text>
      <Box flexDirection="row" columnGap={3}>
        {tab('conversation')}
        {tab('details')}
        {tab('ports')}
        <Box flexGrow={1} />
        <Text color={scene.pane.overlay?.kind === 'menu' ? 'claude' : 'subtle'}>m actions</Text>
      </Box>
      {Rule(draw, scene)}
      {watch?.outage && <Text color="error">{`${watch.outage} The watch keeps trying.`}</Text>}
      {watch?.ended && <Text color="error">{watch.ended}</Text>}
      {scene.shown?.thread === id && scene.shown.failure && <Text color="error">{`The thread's details did not load: ${sentence(scene.shown.failure.message)}`}</Text>}
    </Box>
  )
}

/**
 * The most text the thread view draws, a margin under the engine's 100000: it draws a tree's first 100000 characters
 * in the order written and cuts the rest, which would take the run line, the composer and the keys below the
 * conversation.
 */
const DRAWN_LIMIT = 90_000
/** Diff lines an edit shows before the person opens it. */
const DIFF_LINES = 40
/** Output lines a settled call shows before the person opens it, and a running call's live tail. */
const OUTPUT_LINES = 3

/** The Actions menu's entries for the thread as it stands: the rare and the destructive actions, delete last. */
function menuOf(scene: Scene): { action: MenuAction; label: string }[] {
  const { id, thread, detail } = threadOf(scene)
  const watch = scene.watch?.thread === id ? scene.watch : null
  const state = watch?.state ?? null
  const status = state?.status ?? thread?.status
  const failed = detail?.pylon.failed ?? state?.failed ?? null
  const refused = detail?.pylon.retryRefused ?? null
  return [
    ...(state?.run === 'working' ? [{ action: 'abort' as const, label: 'Abort the run' }] : []),
    ...(state?.run === 'parked' && status !== 'archived' ? [{ action: 'retry' as const, label: 'Retry the parked tasks' }] : []),
    ...(failed && !refused ? [{ action: 'retry-pylon' as const, label: 'Retry the pylon' }] : []),
    ...(failed ? [{ action: 'start-again' as const, label: 'Start again from its project and title' }] : []),
    ...(status === 'active' || status === 'idle' ? [{ action: 'archive' as const, label: 'Archive' }] : []),
    ...(status === 'archived' ? [{ action: 'unarchive' as const, label: 'Unarchive' }] : []),
    ...(detail ? [{ action: 'copy-attach' as const, label: 'Copy the attach command' }] : []),
    { action: 'rewatch' as const, label: 'Watch again' },
    ...(status !== 'deleted' ? [{ action: 'delete' as const, label: 'Delete…  (asks first, Keep is the default)' }] : []),
  ]
}

export function ThreadView(draw: Draw, scene: Scene, actions: PaneActions) {
  const { Box } = draw
  const { id, thread, detail } = threadOf(scene)
  const watch = scene.watch?.thread === id ? scene.watch : null
  const state = watch?.state ?? null
  const status = state?.status ?? thread?.status
  const failed = detail?.pylon.failed ?? state?.failed ?? null
  const refused = detail?.pylon.retryRefused ?? null
  // Only a live thread with a conversation and a pylon not given up on takes messages, so only it draws the composer.
  const canInsert = status !== 'deleted' && status !== 'archived' && !failed && (!detail || detail.hasConversation)
  const { pane } = scene
  const ports = detail ? portsOf(scene, detail) : null
  const holder: Holder = { nav: { context: 'none' } }
  const header = Header(draw, scene, actions, ports ? ports.previews.length + (ports.unpublished?.length ?? 0) : 0, holder)
  const runLine = RunLine(draw, scene)
  const composer = Composer(draw, scene, actions, { failed, refused }, canInsert)
  const isInserting = pane.mode === 'insert' && canInsert
  const scrolled = pane.tab === 'conversation' && pane.scroll !== null
  const hints: [string, string][] = pane.overlay?.kind === 'help'
    ? [['j/k', 'scroll'], ['q', 'close the help']]
    : pane.overlay?.kind === 'menu'
      ? [['j/k', 'move'], ['⏎', 'run'], ['q', 'close']]
      : isInserting
        ? [['⏎', state && state.run !== 'idle' ? 'queue' : 'send'], ['esc', 'normal mode'], ['empty ⏎', 'normal mode']]
        : pane.tab === 'conversation'
          ? [['j/k', 'block'], ['d/u', 'page'], ...(scrolled ? [['ge', 'follow'] as [string, string]] : []), ['o', 'open'], ['h/l', 'tabs'], ...(canInsert ? [['i', 'write'] as [string, string]] : []), ['m', 'actions'], ['s', 'keys']]
          : pane.tab === 'details'
            ? [['j/k', 'scroll'], ['y', 'copy attach'], ['h/l', 'tabs'], ['m', 'actions'], ['s', 'keys']]
            : [['j/k', 'move'], ['⏎', 'publish · copy'], ['x', 'unpublish'], ['y', 'copy URL'], ['h/l', 'tabs'], ['s', 'keys']]
  // A composer the thread's change took away leaves the letters to the keys.
  const footer = [runLine, composer, Notice(draw, pane), ModeLine(draw, scene, hints, isInserting ? 'insert' : 'normal')]
  const area = Math.max(3, scene.rows - rowsOf(header, scene.width) - rowsOf(footer, scene.width))
  const body =
    pane.overlay?.kind === 'help'
      ? HelpBody(draw, scene, actions, area)
      : pane.overlay?.kind === 'menu'
        ? MenuBody(draw, scene, actions, area)
        : pane.tab === 'conversation'
          ? Conversation(draw, scene, actions, area, DRAWN_LIMIT - drawnChars([header, footer]), canInsert)
          : pane.tab === 'details'
            ? DetailsBody(draw, scene, area, canInsert)
            : PortsBody(draw, scene, actions, area, canInsert)
  holder.nav = body.nav
  return Frame(
    draw,
    scene,
    [
      Fixed(draw, 'head', header),
      <Box
        key="body"
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        overflow="hidden"
        justifyContent={pane.tab === 'conversation' && !pane.overlay ? 'flex-end' : 'flex-start'}
      >
        {body.node}
      </Box>,
      Fixed(draw, 'foot', footer),
      KeyMap(draw, actions, body.nav),
    ],
  )
}

type Body = { node: RenderChildren; nav: Nav }

function HelpBody(draw: Draw, scene: Scene, actions: PaneActions, area: number): Body {
  const { Box, Text, Button } = draw
  const top = scene.pane.overlay?.kind === 'help' ? scene.pane.overlay.top : 0
  const node = (
    <Box key="help" flexDirection="column" flexShrink={0} marginTop={-top}>
      {HELP.map(section => (
        <Box key={`help-${section.title}`} flexDirection="column">
          <Text bold color="claude">
            {section.title}
          </Text>
          {section.keys.map(([keys, what]) => (
            <Text key={`help-${section.title}-${keys}`} wrap="truncate-end">
              <Text color="suggestion">{`  ${keys.padEnd(10)}`}</Text>
              <Text color="subtle">{what}</Text>
            </Text>
          ))}
        </Box>
      ))}
      <Box marginTop={1}>
        <Text color="subtle">Claude Code gives a pane only plain letters, so vim's G, ctrl+d, ctrl+u, / and ? are g e, d, u, f and s here.</Text>
      </Box>
      {/* The ring's home while the help covers the view, whose rows it hid: without one the keys would have nowhere to go. */}
      <Button key="help-close" plain autoFocus onPress={() => actions.key('close', nav)}>
        <Text color="suggestion">q</Text>
        <Text color="subtle"> or ⏎ closes the help</Text>
      </Button>
    </Box>
  )
  const nav: Nav = { context: 'help', total: rowsOf(node, scene.width) + top, area }
  return { nav, node }
}

function MenuBody(draw: Draw, scene: Scene, actions: PaneActions, area: number): Body {
  const { Box, Text, Button } = draw
  const entries = menuOf(scene)
  const items: NavItem[] = entries.map((entry, index) => ({ key: `menu-${entry.action}`, top: index + 1, height: 1, enter: { kind: 'run', action: entry.action } }))
  const chosen = scene.pane.overlay?.kind === 'menu' ? scene.pane.overlay.cursor : null
  const cursor = Math.max(0, items.findIndex(item => item.key === chosen))
  return {
    nav: { context: 'menu', items, area },
    node: (
      <Box key="menu" flexDirection="column" flexShrink={0}>
        <Text bold color="claude">
          Actions
        </Text>
        {entries.map((entry, index) => (
          <Button key={`menu-${entry.action}`} plain autoFocus={index === cursor ? true : undefined} onPress={() => actions.effect({ kind: 'run', action: entry.action })}>
            {Pointer(draw, index === cursor)}
            <Text color={entry.action === 'delete' || entry.action === 'abort' ? 'error' : index === cursor ? 'suggestion' : 'text'}>{entry.label}</Text>
          </Button>
        ))}
      </Box>
    ),
  }
}

/** One stop of the conversation the keys move over: a message, an answer, a notice, a call or a fold's line. */
type Stop = { key: string; node: RenderChildren; gap: 0 | 1; indent: number; enter?: NavItem['enter']; y?: Effect }

/** The conversation's stops, oldest first: each block, a fold's line and, while it is open, each of its steps. */
function stopsOf(draw: Draw, scene: Scene, actions: PaneActions, all: readonly Block[], isWorking: boolean, running: Map<string, string>): Stop[] {
  return all.flatMap((block): Stop[] => {
    if (block.kind !== 'tools') {
      return [{ key: block.key, node: BlockView(draw, block), gap: block.kind === 'notice' && block.tone === 'dim' ? 0 : 1, indent: 0, y: { kind: 'copy', text: block.text } }]
    }
    const tool = (one: ToolRow, indent: number): Stop => {
      const key = `tool-${one.id}`
      const isOpen = scene.pane.toggled[key] ?? false
      const subject = subjectOf(one)
      return {
        key,
        node: ToolView(draw, scene, actions, one, toolStatus(one, isWorking || running.has(one.id)), running.get(one.id), indent),
        gap: 1,
        indent,
        enter: { kind: 'toggle', key, isOpen },
        ...(subject ? { y: { kind: 'copy', text: subject.value } as Effect } : {}),
      }
    }
    if (block.tools.length < FOLD_AT) return block.tools.map(one => tool(one, 0))
    const fold = foldOf(scene, block, isWorking, running)
    return [
      { key: fold.key, node: FoldLine(draw, scene, actions, block, fold), gap: 1, indent: 0, enter: { kind: 'toggle', key: fold.key, isOpen: fold.isOpen } },
      ...(fold.isOpen ? block.tools.map(one => tool(one, 2)) : []),
    ]
  })
}

/**
 * The conversation, filling upward from the composer. It keeps the newest stops whose text fits in `room`, so a long
 * thread costs its tail, and draws those around the bottom edge, which j, k, d and u move; the edge holds still as
 * blocks arrive below it.
 */
function Conversation(draw: Draw, scene: Scene, actions: PaneActions, area: number, room: number, canInsert: boolean): Body {
  const { Box, Text } = draw
  const { id, thread, detail } = threadOf(scene)
  const watch = scene.watch?.thread === id ? scene.watch : null
  const empty = (text: string | null): Body => ({ nav: { context: 'conversation', items: [], total: 0, area, canInsert }, node: text && <Text color="subtle">{text}</Text> })
  if (thread?.status === 'deleted' || watch?.state?.status === 'deleted') return empty('The thread is deleted, so its conversation is gone.')
  if (detail && !detail.hasConversation) return empty('This thread has no agent conversation.')
  if (!watch?.state) return empty(null)
  const all = blocks(watch.rows, watch.dropped, scene.live)
  if (all.length === 0) return empty('No messages yet.')
  const isWorking = watch.state.run === 'working'
  const running = new Map((scene.live?.tools ?? []).map(tool => [tool.callId, tool.output]))
  const stops = stopsOf(draw, scene, actions, all, isWorking, running)
  const width = scene.width - 1
  // Newest first while the drawn text fits; the newest stop bigger than all of it is cut with a note.
  const kept: Stop[] = []
  let left = room
  for (let at = stops.length - 1; at >= 0; at -= 1) {
    const stop = stops[at]!
    const size = drawnChars(stop.node)
    if (size <= left) {
      kept.unshift(stop)
      left -= size
      continue
    }
    if (kept.length === 0) kept.unshift({ ...stop, node: Cut(draw, stop.node, left) })
    break
  }
  const omitted = stops.length - kept.length
  if (omitted > 0) kept.unshift({ key: 'left-out', node: <Text color="subtle">{`… ${plural(omitted, 'earlier block', 'earlier blocks')} left out of the pane`}</Text>, gap: 0, indent: 0 })
  let y = 0
  const items: NavItem[] = kept.map(stop => {
    const height = stop.gap + rowsOf(stop.node, width - stop.indent)
    const item: NavItem = { key: stop.key, top: y, height, ...(stop.enter ? { enter: stop.enter } : {}), ...(stop.y ? { y: stop.y } : {}) }
    y += height
    return item
  })
  const total = y
  const rows = scrolledRows(scene.pane.scroll, items, total, area)
  const current = blockAt(items, scene.pane.scroll)
  // Only what the window can reach is drawn: the stops wholly below its bottom edge are left out and the edge moves
  // by what is left, those far above it are left out as the window's top clips them anyway.
  const edge = total - rows
  const shown = kept.flatMap((stop, index) => {
    const item = items[index]!
    if (item.top >= edge || item.top + item.height <= edge - area) return []
    return [
      <Box key={`stop-${stop.key}`} flexDirection="row" marginTop={stop.gap} paddingLeft={stop.indent}>
        <Text color="suggestion">{index === current ? '▎' : ' '}</Text>
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          {stop.node}
        </Box>
      </Box>,
    ]
  })
  const below = items.filter(item => item.top >= edge).reduce((sum, item) => sum + item.height, 0)
  return {
    nav: { context: 'conversation', items, total, area, canInsert },
    node: (
      <Box key="conversation" flexDirection="column" flexShrink={0} marginBottom={-(rows - below)}>
        {shown}
      </Box>
    ),
  }
}

/** The props whose text an element draws; a field's `value` has a room of its own. */
const TEXT_PROPS = ['source', 'text', 'label', 'alt', 'placeholder'] as const
/** The elements whose one text prop may be cut; any other is drawn whole or left out, as the engine does a label. */
const CUT_PROP: Partial<Record<string, 'source' | 'text'>> = { Code: 'source', Markdown: 'text' }

function ownChars(node: Element): number {
  const props = node.props ?? {}
  const options = Array.isArray(props.options) ? props.options.reduce((sum: number, option) => sum + String((option as { label?: unknown }).label ?? '').length, 0) : 0
  return TEXT_PROPS.reduce((sum, prop) => sum + (typeof props[prop] === 'string' ? (props[prop] as string).length : 0), options)
}

/** The text a tree carries, as the engine counts it toward the 100000 it draws: children, sources, texts, labels. */
function drawnChars(node: unknown): number {
  if (typeof node === 'string') return node.length
  if (Array.isArray(node)) return node.reduce((sum: number, child) => sum + drawnChars(child), 0)
  return isElement(node) ? ownChars(node) + drawnChars(node.children) : 0
}

/** `node` with its text cut after `room` characters in the order written, and how many it kept. */
/**
 * The keys a drawing holds, and where the ring belongs in it: the last element drawn with `autoFocus`, which is the
 * view's most specific cursor (a row under the tab, an entry of the menu), else the tab itself.
 */
export function ringOf(tree: unknown): { keys: ReadonlySet<string>; home: string | null } {
  const keys = new Set<string>()
  let home: string | null = null
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (!isElement(node) || node.props?.display === 'none') return
    const key = node.props?.key
    if (typeof key === 'string') {
      keys.add(key)
      if (node.props?.autoFocus === true) home = key
    }
    walk(node.children)
  }
  walk(tree)
  return { keys, home }
}

export function cutTree(node: unknown, room: number): { node: unknown; used: number } {
  if (typeof node === 'string') return node.length <= room ? { node, used: node.length } : { node: node.slice(0, room), used: room }
  if (Array.isArray(node)) {
    const kept: unknown[] = []
    let used = 0
    for (const child of node) {
      if (used >= room) break
      const part = cutTree(child, room - used)
      // An element left out leaves no hole: a copied element's children are drawn as they stand.
      if (part.node !== null) kept.push(part.node)
      used += part.used
    }
    return { node: kept, used }
  }
  if (!isElement(node)) return { node, used: 0 }
  const own = ownChars(node)
  if (own <= room) {
    const children = cutTree(node.children, room - own)
    return { node: node.children === undefined ? node : { ...node, children: children.node }, used: own + children.used }
  }
  const prop = CUT_PROP[node.type]
  if (!prop || typeof node.props?.[prop] !== 'string') return { node: null, used: 0 }
  const text = node.props[prop] as string
  if (node.props.format === 'diff') {
    // A diff keeps its whole hunks that fit: one cut mid-hunk would not parse. With none, it is left out.
    const hunks = wholeHunks(text, room)
    return hunks ? { node: { ...node, props: { ...node.props, source: hunks } }, used: hunks.length } : { node: null, used: 0 }
  }
  return { node: { ...node, props: { ...node.props, [prop]: text.slice(0, room) } }, used: room }
}

/** The hunks of a diff that fit in `room` characters, whole, or null when not even the first does. */
function wholeHunks(source: string, room: number): string | null {
  let kept = ''
  for (const hunk of source.split(/\n(?=@@)/)) {
    const next = kept ? `${kept}\n${hunk}` : hunk
    if (next.length > room) break
    kept = next
  }
  return kept || null
}

/** What the line under a cut step takes of its room. */
const NOTE_CHARS = 80

/** `node` cut to fit in `room`, with a line that says how much of it was left out. */
function Cut(draw: Draw, node: RenderChildren, room: number) {
  const { Box, Text } = draw
  const kept = cutTree(node, Math.max(0, room - NOTE_CHARS))
  return (
    <Box flexDirection="column">
      {kept.node as RenderChildren}
      <Text color="subtle">{`… ${drawnChars(node) - kept.used} more characters of this step left out of the pane`}</Text>
    </Box>
  )
}

type Fold = { key: string; bad: number; busy: number; isOpen: boolean }

/** A fold's key and counts, and whether it is open: it opens itself while a step failed or runs, unless the person chose. */
function foldOf(scene: Scene, block: Extract<Block, { kind: 'tools' }>, isWorking: boolean, running: Map<string, string>): Fold {
  const statuses = block.tools.map(tool => toolStatus(tool, isWorking || running.has(tool.id)))
  const bad = statuses.filter(status => status === 'error').length
  const busy = statuses.filter(status => status === 'running').length
  const key = `fold-${block.tools[0]!.id}`
  return { key, bad, busy, isOpen: scene.pane.toggled[key] ?? (bad > 0 || busy > 0) }
}

/** A call's arguments besides its subject and what its diff shows, as an opened row draws them. */
function otherArgs(tool: ToolRow, diff: ReturnType<typeof diffOf>): string {
  const subject = subjectOf(tool)
  const rest = Object.fromEntries(Object.entries(tool.args).filter(([arg]) => arg !== subject?.key && !(diff && (arg === 'edits' || arg === 'content'))))
  return Object.keys(rest).length === 0 ? '' : JSON.stringify(rest, null, 2)
}

/** One text block of the conversation: the person's message, an answer or a notice. An answer streams under the key it keeps once committed. */
function BlockView(draw: Draw, block: Extract<Block, { kind: 'user' | 'assistant' | 'notice' }>) {
  const { Box, Text, Markdown } = draw
  switch (block.kind) {
    case 'user':
      return (
        <Box key={block.key} flexDirection="row">
          <Text color="subtle">{'❯ '}</Text>
          <Box flexDirection="column" flexShrink={1}>
            <Text color="text">{block.text}</Text>
            {block.isLive && <Text color="subtle">queued, sends after this run</Text>}
          </Box>
        </Box>
      )
    case 'assistant':
      return (
        <Box key={block.key} flexDirection="row">
          <Text color="text">{'⏺ '}</Text>
          <Box flexDirection="column" flexShrink={1}>
            <Markdown text={block.text} />
          </Box>
        </Box>
      )
    case 'notice':
      return block.tone === 'dim' ? (
        <Box key={block.key} flexDirection="row">
          <Text color="subtle">{'  ⎿  '}</Text>
          <Text color="subtle">{block.text}</Text>
        </Box>
      ) : (
        <Box key={block.key} flexDirection="row">
          <Text color={block.tone}>{'⏺ '}</Text>
          <Box flexShrink={1}>
            <Text color={block.tone}>{block.text}</Text>
          </Box>
        </Box>
      )
  }
}

/** A fold's line, "⏺ Read 4 files (4 steps, o to expand)", which opens or closes it: one line, as Claude Code's, so a run of many distinct tools names those that fit. */
function FoldLine(draw: Draw, scene: Scene, actions: PaneActions, block: Extract<Block, { kind: 'tools' }>, fold: Fold) {
  const { Text, Button } = draw
  return (
    <Button key={fold.key} plain onPress={() => actions.toggle(fold.key, fold.isOpen)}>
      <Text color={fold.bad > 0 ? 'error' : fold.busy > 0 ? 'inactive' : 'success'}>{'⏺ '}</Text>
      {clip(foldSummary(block.tools), Math.max(8, scene.width - 40))}
      <Text color="subtle">
        {`${fold.bad > 0 ? ` · ${fold.bad} failed` : ''}${fold.busy > 0 ? ` · ${fold.busy} running` : ''} (${block.tools.length} steps, o to ${fold.isOpen ? 'fold' : 'expand'})`}
      </Text>
    </Button>
  )
}

const STATUS_COLOR: Record<ToolStatus, string> = { running: 'inactive', none: 'subtle', ok: 'success', error: 'error' }

function ToolView(draw: Draw, scene: Scene, actions: PaneActions, tool: ToolRow, status: ToolStatus, live: string | undefined, indent: number) {
  const { Box, Text, Button, Code } = draw
  const key = `tool-${tool.id}`
  const isOpen = scene.pane.toggled[key] ?? false
  const subject = subjectOf(tool)
  const diff = diffOf(tool)
  const width = scene.width - 1 - indent
  const name = clip(toolName(tool.name), Math.max(8, Math.floor(width / 2)))
  const room = Math.max(8, width - cells(name) - 4)
  const shown = subject ? clip(subject.value.replace(/\s+/g, ' ').trim(), room) : ''
  const rest = otherArgs(tool, diff)
  return (
    <Box key={key} flexDirection="column">
      <Button key={key} plain onPress={() => actions.toggle(key, isOpen)}>
        <Text color={STATUS_COLOR[status]}>{'⏺ '}</Text>
        <Text bold>{name}</Text>
        {shown ? `(${shown})` : ''}
      </Button>
      <Box flexDirection="row">
        <Text color="subtle">{'  ⎿  '}</Text>
        <Box flexDirection="column" flexShrink={1}>
          {ResultLines(draw, tool, status, live, diff, isOpen)}
        </Box>
      </Box>
      {diff && (status !== 'error' || isOpen) && (
        <Box paddingLeft={5} flexDirection="column">
          <Code source={isOpen ? diff.source : firstHunks(diff.source, DIFF_LINES)} format="diff" wrap={isOpen ? 'wrap' : 'truncate-end'} />
        </Box>
      )}
      {isOpen && (
        <Box paddingLeft={5} flexDirection="column">
          {subject?.key === 'command' && subject.value !== shown && <Code source={subject.value} language="bash" />}
          {subject && subject.key !== 'command' && subject.value !== shown && <Text>{subject.value}</Text>}
          {rest && <Code source={rest} language="json" />}
        </Box>
      )}
    </Box>
  )
}

/** The hunks of a diff that fit in `max` lines, at least the first: a diff cut mid-hunk would not parse. */
function firstHunks(source: string, max: number): string {
  const hunks = source.split(/\n(?=@@)/)
  const kept: string[] = []
  let used = 0
  for (const hunk of hunks) {
    const lines = hunk.split('\n').length
    if (kept.length > 0 && used + lines > max) break
    kept.push(hunk)
    used += lines
  }
  return kept.join('\n')
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/** What follows a call's ⎿, as Claude Code words its results. */
function ResultLines(draw: Draw, tool: ToolRow, status: ToolStatus, live: string | undefined, diff: ReturnType<typeof diffOf>, isOpen: boolean) {
  const { Text } = draw
  const lines = (text: string) => text.trimEnd().split('\n')
  if (status === 'running') {
    const tail = live ? lines(live).slice(-OUTPUT_LINES) : []
    return tail.length > 0 ? tail.map((line, index) => <Text key={`live-${index}`} color="subtle">{line}</Text>) : <Text color="subtle">Running…</Text>
  }
  if (status === 'none') return <Text color="subtle">No result</Text>
  if (status === 'error') {
    const code = exitCode(tool.output)
    const shown = isOpen ? lines(tool.output) : lines(tool.output).slice(-OUTPUT_LINES - 1)
    return [
      <Text key="error" color="error">{code === undefined ? 'Error' : `Error: exit ${code}`}</Text>,
      ...(tool.output.trim() ? shown.map((line, index) => <Text key={`out-${index}`} color="error">{line}</Text>) : []),
    ]
  }
  const path = typeof tool.args.path === 'string' ? tool.args.path : ''
  if (diff) {
    const what = tool.name === 'write' ? `Wrote ${plural(diff.added, 'line', 'lines')} to ${path}` : `Updated ${path} with ${plural(diff.added, 'addition', 'additions')} and ${plural(diff.removed, 'removal', 'removals')}`
    return (
      <Text>
        {what}
        {!diff.isNumbered && <Text color="subtle"> (the call does not say where in the file, so lines count from 1)</Text>}
        {diff.omitted > 0 && <Text color="subtle">{` · ${plural(diff.omitted, 'more replacement', 'more replacements')} left out of the pane`}</Text>}
      </Text>
    )
  }
  if (tool.name === 'read' && !isOpen) return <Text>Read {plural(tool.lines, 'line', 'lines')}</Text>
  if (!tool.output.trim()) return <Text color="subtle">(No content)</Text>
  const all = lines(tool.output)
  const shown = isOpen ? all : all.slice(0, OUTPUT_LINES)
  const more = tool.lines - shown.length
  return [
    ...shown.map((line, index) => <Text key={`out-${index}`}>{line}</Text>),
    ...(!isOpen && more > 0 ? [<Text key="more" color="subtle">{`… +${plural(more, 'line', 'lines')} (o to expand)`}</Text>] : []),
  ]
}

/** The run's line above the composer: the spinner and clock while it works, the parked tasks while they hold it. */
function RunLine(draw: Draw, scene: Scene) {
  const { Box, Text } = draw
  const { id, thread } = threadOf(scene)
  const watch = scene.watch?.thread === id ? scene.watch : null
  const state = watch?.state
  if (!state || state.status === 'deleted') return null
  if (state.run === 'parked') {
    const archived = state.status === 'archived'
    return (
      <Box key="run" marginTop={1}>
        <Text color="warning">
          {`⚠ ${plural(state.parkedTasks, 'task', 'tasks')} hit the restart limit and hold the run. ${archived ? 'Unarchive the thread to retry them.' : 'm then Retry the parked tasks.'}`}
        </Text>
      </Box>
    )
  }
  if (state.run !== 'working') return null
  const run = runOf(watch.rows)
  const facts = [
    run.since !== null ? clock(scene.now - run.since) : null,
    `${plural(run.tools, 'tool', 'tools')} this turn`,
    (thread?.status ?? state.status) !== 'archived' ? 'new messages queue' : null,
    'm to abort',
  ].filter(Boolean)
  return (
    <Box key="run" marginTop={1}>
      <Text wrap="truncate-end">
        <Text color="claude">{`${spinner(scene.now)} Working… `}</Text>
        <Text color="subtle">({facts.join(' · ')})</Text>
      </Text>
    </Box>
  )
}

/** Why a thread takes no messages, or the prompt box, always drawn: a busy run queues what is sent, so the box says so. */
function Composer(draw: Draw, scene: Scene, actions: PaneActions, pylon: { failed: string | null; refused: string | null }, canInsert: boolean) {
  const { Box, Text, Input, Code } = draw
  const { id, thread, detail } = threadOf(scene)
  const watch = scene.watch?.thread === id ? scene.watch : null
  const status = watch?.state?.status ?? thread?.status
  if (status === 'deleted' || (detail && !detail.hasConversation)) return null
  // Only the planner giving up holds the pylon until a person acts. A pylon reported broken may still resume.
  if (pylon.failed) {
    return (
      <Box key="composer" flexDirection="column" marginTop={1} borderStyle="round" borderColor="error" paddingX={1}>
        <Text color="error">The planner gave up on this thread's pylon, so its agent cannot run tools and the thread takes no messages.</Text>
        <Text>
          {pylon.refused
            ? sentence(pylon.refused)
            : "Fix the cause, such as the project's git access, then m: retry the pylon, or start again from the same project. A retry runs setup again on a new pylon whose setup failed, and resumes a broken pylon from its newest disk."}
        </Text>
        <Code source={pylon.failed} language="text" wrap="truncate-end" />
      </Box>
    )
  }
  if (!canInsert) {
    return (
      <Box key="composer" marginTop={1} borderStyle="round" borderColor="subtle" paddingX={1}>
        <Text color="subtle">An archived thread takes no messages, because its pylon stays paused. m then Unarchive to send one.</Text>
      </Box>
    )
  }
  const queue = watch?.state ? watch.state.run !== 'idle' : false
  const pylonState = detail?.pylon.actualState ?? watch?.state?.pylon
  const placeholder = `${queue ? 'Queue a follow-up…' : 'Message the agent…'}${scene.pane.mode === 'insert' ? '' : '  (i to write)'}`
  const submitLabel = queue ? 'queue' : 'send'
  const border = scene.pane.mode === 'insert' ? 'promptBorder' : 'subtle'
  // Rules, as Claude Code's own prompt has, rather than a box: a field narrower than the pane does not wrap (fieldRows).
  return (
    <Box key="composer" flexDirection="column" marginTop={1}>
      {pylonState === 'paused' && <Text color="subtle">The pylon is paused. Sending a message wakes it.</Text>}
      {Rule(draw, scene, border)}
      <Input
        key={fieldKey(scene.pane.fields, COMPOSE)}
        autoFocus={scene.pane.mode === 'insert' ? true : undefined}
        label="❯"
        rows={fieldRows(scene.pane.draft, '❯', submitLabel, scene.width, scene.rows, scene.isFocused && scene.pane.mode === 'insert')}
        value={scene.pane.fields[COMPOSE]?.text} placeholder={placeholder} submitLabel={submitLabel} onInput={actions.draft} onSubmit={actions.submit} />
      {Rule(draw, scene, border)}
    </Box>
  )
}

/** Gondolin's ingress reaches only the pylon's 127.0.0.1, so a server bound only to ::1 is neither listed nor reachable. */
const UNREACHABLE_HINT = "A server bound only to ::1 can't be previewed, so bind it to 0.0.0.0 or 127.0.0.1."

/**
 * The previews and the ports with none, as Ports lists them with what the person confirmed since: a port just
 * unpublished is under Ports, one just published under Previews. `closable` holds the ports whose preview x can
 * unpublish: a linked port's, which the CLI closes, of a thread that can run, with no operation under way.
 */
function portsOf(scene: Scene, detail: NexusDetail) {
  const changes = scene.pane.portChanges[detail.thread.id] ?? {}
  const changeOf = (port: number) => portChange(changes, port, scene.shown?.askedSeq ?? 0)
  const confirmed = (port: number | null) => (port === null ? null : changeOf(port).confirmed)
  const listed = detail.previews.flatMap(preview => {
    const known = confirmed(linkedPort(preview))
    return known ? (known.preview ? [known.preview] : []) : [preview]
  })
  const published = Object.keys(changes).flatMap(port => {
    const preview = confirmed(Number(port))?.preview
    return preview && !listed.some(one => one.service === preview.service) ? [preview] : []
  })
  const previews = [...listed, ...published]
  const unpublished =
    detail.ports?.filter(one => {
      const known = confirmed(one.port)
      return (known ? known.preview : one.preview) === null
    }) ?? null
  const canRun = detail.thread.status === 'active' || detail.thread.status === 'idle'
  const closable = canRun ? previews.flatMap(preview => linkedPort(preview) ?? []).filter(port => !changeOf(port).pending) : []
  return { previews, unpublished, closable, changeOf, canRun }
}

/** Why x does nothing on a preview, said rather than ignored. */
function whyNotClosable(preview: NexusPreview, change: NexusPortChange, canRun: boolean): string {
  if (linkedPort(preview) === null) return `${preview.service} is a declared service's preview, which can't be unpublished.`
  if (!canRun) return "An archived thread's previews can't be unpublished."
  return change.pending === 'open' ? 'Its publish is still under way.' : 'It is closing already.'
}

/** The pylon, the thread's outputs, its sessions and the attach command: read-only, scrolled by the keys. */
function DetailsBody(draw: Draw, scene: Scene, area: number, canInsert: boolean): Body {
  const { Box, Text } = draw
  const { detail } = threadOf(scene)
  if (!detail) return { nav: { context: 'details', total: 0, area, canInsert, attach: null }, node: <Text color="subtle">{scene.shown?.failure ? '' : 'Loading the details…'}</Text> }
  const { thread, pylon } = detail
  const node = scene.catalog.nodes?.find(one => one.name === pylon.node)
  const offline = node?.state === 'offline'
  const kv = (label: string, value: RenderChildren, key: string) => (
    <Box key={key} flexDirection="row">
      <Text color="subtle">{label.padEnd(11)}</Text>
      <Box flexShrink={1}>{typeof value === 'string' ? <Text>{value}</Text> : value}</Box>
    </Box>
  )
  const state = (label: string, tone: Tone) => (
    <Text>
      {Dot(draw, tone)} {label}
    </Text>
  )
  // A preview output stays only for a preview the control plane no longer lists, as the dashboard's outputs do.
  const outputs = detail.outputs.filter(output => output.kind !== 'preview' || !detail.previews.some(preview => preview.service === output.ref))
  const observed = pylon.observedAt === null ? 'never' : `${since(Date.parse(pylon.observedAt), scene.now)}${offline ? ' (stale)' : ''}`
  const content = (
    <Box key="details" flexDirection="column" flexShrink={0} marginTop={-scene.pane.detailsTop}>
      {SectionRule(draw, scene, 'Pylon', '', 'pylon')}
      {kv('Desired', state(detail.desired, DESIRED_TONE[detail.desired]), 'desired')}
      {kv('Observed', state(...ACTUAL_BADGE[pylon.actualState]), 'observed')}
      {kv('Node', `${pylon.node}${offline ? ' (offline)' : ''}`, 'node')}
      {kv('Last seen', observed, 'seen')}
      {kv('Human', since(thread.lastHumanActivityAt, scene.now), 'human')}
      {kv('Agent', thread.agentTurnRunning ? 'turn running' : since(thread.lastAgentActivityAt, scene.now), 'agent')}
      <Text color="subtle">{pylon.id}</Text>
      {pylon.failed && <Text color="error">{`The planner gave up: ${pylon.failed}`}</Text>}
      {SectionRule(draw, scene, 'Outputs', String(outputs.length), 'outputs')}
      {outputs.length === 0 && <Text color="subtle">No outputs yet.</Text>}
      {outputs.map((output, index) => (
        <Box key={`output-${index}`} flexDirection="row" columnGap={1}>
          <Text color="subtle">{output.kind.padEnd(8)}</Text>
          <Text>{output.ref}</Text>
        </Box>
      ))}
      {SectionRule(draw, scene, 'Sessions', String(detail.sessions.length), 'sessions')}
      {detail.sessions.length === 0 && <Text color="subtle">No sessions.</Text>}
      {detail.sessions.map(session => (
        <Box key={`session-${session.herdrPane}`} flexDirection="row" columnGap={1}>
          <Text>{HARNESS_LABEL[session.harness]}</Text>
          {state(session.status, SESSION_TONE[session.status])}
          <Text color="subtle">{session.herdrPane}</Text>
          {session.harnessSessionId && <Text color="subtle">{`session ${session.harnessSessionId}`}</Text>}
        </Box>
      ))}
      {SectionRule(draw, scene, 'Attach', '', 'attach')}
      <Text color="subtle">From a shell in the pylon; y copies it:</Text>
      <Text>{`  ${detail.attach}`}</Text>
    </Box>
  )
  return { nav: { context: 'details', total: rowsOf(content, scene.width) + scene.pane.detailsTop, area, canInsert, attach: detail.attach }, node: content }
}

/**
 * The previews and the ports that listen with none, each port once, as rows the cursor moves over: Enter publishes a
 * port or copies a preview's URL, x unpublishes a linked port's preview. A row says so while the CLI runs, then the
 * port moves to where it now belongs, or the row says why it failed.
 */
function PortsBody(draw: Draw, scene: Scene, actions: PaneActions, area: number, canInsert: boolean): Body {
  const { Box, Text, Button, Link } = draw
  const { detail } = threadOf(scene)
  if (!detail) return { nav: { context: 'ports', items: [], area, canInsert, cursor: null }, node: <Text color="subtle">{scene.shown?.failure ? '' : 'Loading the ports…'}</Text> }
  const { pylon } = detail
  const { previews, unpublished, closable, changeOf, canRun } = portsOf(scene, detail)
  const portOf = new Map((detail.ports ?? []).flatMap(one => (one.preview ? [[one.preview.service, one.port] as const] : [])))
  const keys = [...previews.map(preview => `preview-${preview.service}`), ...(unpublished ?? []).filter(port => port.service === null).map(port => `port-${port.port}`)]
  // A port the person published or unpublished moves between the sections, and the cursor goes with it.
  const moved = (key: string | null) => {
    const port = key?.match(/^(?:preview-)?port-(\d+)$/)?.[1]
    const preview = port && previews.find(one => linkedPort(one) === Number(port))
    return preview ? `preview-${preview.service}` : port ? `port-${port}` : null
  }
  const wanted = scene.pane.portCursor
  const cursor = [wanted, moved(wanted)].find(key => key && keys.includes(key)) ?? keys[0] ?? null
  const items: NavItem[] = []
  const drawn: RenderChildren[] = []
  let y = 0
  const place = (node: RenderChildren, item?: Omit<NavItem, 'top' | 'height'>) => {
    const height = rowsOf(node, scene.width)
    if (item) items.push({ ...item, top: y, height })
    drawn.push(node)
    y += height
  }
  place(SectionRule(draw, scene, 'Previews', String(previews.length), 'previews'))
  if (previews.length === 0) place(<Text key="no-previews" color="subtle">No previews.</Text>)
  for (const preview of previews) {
    const key = `preview-${preview.service}`
    const port = portOf.get(preview.service)
    const linked = linkedPort(preview)
    const change = linked === null ? NO_CHANGE : changeOf(linked)
    const isCursor = cursor === key
    const look = change.pending
      ? { linked: false, label: change.pending === 'close' ? 'closing…' : 'opening…', tone: 'busy' as Tone, hint: pylon.actualState === 'paused' ? 'Waking the pylon first, which can take two minutes.' : null }
      : previewLook(detail, preview)
    const isClosable = linked !== null && closable.includes(linked)
    place(
      <Box key={`row-${key}`} flexDirection="column">
        <Box flexDirection="row" columnGap={1}>
          <Button key={key} plain autoFocus={isCursor ? true : undefined} onPress={() => actions.effect({ kind: 'copy', text: preview.url })}>
            {Pointer(draw, isCursor)}
            {Dot(draw, look.tone)} <Text bold>{preview.service}</Text>
            <Text color="subtle">{port !== undefined && preview.service !== `port-${port}` ? ` :${port}` : ''}</Text> {Pill(draw, look.label, look.tone)}
          </Button>
          {look.linked ? <Link href={preview.url} /> : <Text color="subtle">{preview.url}</Text>}
        </Box>
        {isCursor && <Text color="subtle">{`    ⏎ or y copies the URL${isClosable ? ' · x unpublishes it (a new publish may get a new URL)' : ''}`}</Text>}
        {look.hint && <Text color="subtle">{`    ${look.hint}`}</Text>}
        {change.failure && <Text color="error">{`    ${change.failure.message}`}</Text>}
      </Box>,
      {
        key,
        enter: { kind: 'copy', text: preview.url },
        y: { kind: 'copy', text: preview.url },
        x: isClosable ? { kind: 'unpublish', thread: detail.thread.id, port: linked } : { kind: 'say', text: whyNotClosable(preview, change, canRun) },
      },
    )
  }
  place(SectionRule(draw, scene, 'Ports', String(unpublished?.length ?? 0), 'ports'))
  if (unpublished === null) place(<Text key="ports-unknown" color="subtle">The pylon's ports could not be read.</Text>)
  else if (unpublished.length > 0) for (const port of unpublished) place(...PortRow(draw, actions, detail.thread.id, port, changeOf(port.port), cursor === `port-${port.port}`))
  else if (pylon.actualState !== 'running') place(<Text key="ports-none" color="subtle">Ports show while the pylon runs.</Text>)
  else place(<Text key="ports-none" color="subtle">{`${detail.ports?.length === 0 ? 'Nothing listens yet.' : 'Every port that listens is under Previews.'} ${UNREACHABLE_HINT}`}</Text>)
  const current = items.find(item => item.key === cursor)
  const top = keepInView(0, current, area)
  return {
    nav: { context: 'ports', items, area, canInsert, cursor },
    node: (
      <Box key="ports-list" flexDirection="column" flexShrink={0} marginTop={-top}>
        {drawn}
      </Box>
    ),
  }
}

/**
 * A port that listens with no preview. One no service owns publishes on Enter; it says so while the CLI waits for its
 * URL, then Previews lists it with its link, and a failure says why and publishes again. A service without a preview
 * cannot be previewed, which the CLI refuses, so its port only names it.
 */
function PortRow(draw: Draw, actions: PaneActions, thread: string, port: NexusPort, change: NexusPortChange, isCursor: boolean): [RenderChildren, Omit<NavItem, 'top' | 'height'>?] {
  const { Box, Text, Button } = draw
  const key = `port-${port.port}`
  if (port.service !== null) {
    return [
      <Box key={`row-${key}`} flexDirection="row">
        <Text>{'  '}</Text>
        {Dot(draw, 'muted')}
        <Text bold>{` ${port.port}`}</Text>
        <Text color="subtle">{`  ${port.service}, a service with no preview`}</Text>
      </Box>,
    ]
  }
  const [tone, note]: [Tone, string] =
    change.pending === 'open'
      ? ['busy', 'opening: publishing it and waiting for the node to serve its URL…']
      : change.pending === 'close'
        ? ['busy', 'closing: unpublishing its preview…']
        : change.failure?.action === 'open'
          ? ['bad', 'did not open; ⏎ tries again']
          : ['muted', isCursor ? 'not published; ⏎ publishes it' : 'not published']
  return [
    <Box key={`row-${key}`} flexDirection="column">
      <Button key={key} plain autoFocus={isCursor ? true : undefined} onPress={() => actions.effect({ kind: 'publish', thread, port: port.port })}>
        {Pointer(draw, isCursor)}
        {Dot(draw, tone)} <Text bold>{String(port.port)}</Text> <Text color="subtle">{note}</Text>
      </Button>
      {change.failure && <Text color="error">{`    ${change.failure.message}`}</Text>}
    </Box>,
    { key, enter: { kind: 'publish', thread, port: port.port }, x: { kind: 'say', text: `Port ${port.port} has no preview to unpublish.` } },
  ]
}

export const START_KEYS = { title: 'start-title', project: 'start-project', node: 'start-node', branch: 'start-branch', message: 'start-message' } as const

/** The dashboard's start dialog: a title, the project, the node and branch it boots, and a first message. */
export function StartView(draw: Draw, scene: Scene, actions: PaneActions) {
  const { Box, Text, Button, Input, Select } = draw
  const draft = scene.pane.start
  const { projects, nodes, projectsFailure } = scene.catalog
  if (!draft) return <Text color="subtle">The start form is closed.</Text>
  const chosen = projects?.find(project => project.id === draft.project)
  const defaultNode = chosen?.defaultNode ?? ''
  const node = draft.node || defaultNode
  const branch = draft.branch || chosen?.defaultBranch || ''
  return Frame(
    draw,
    scene,
    [
      <Box key="start" flexDirection="column" flexGrow={1}>
      {TitleBar(
        draw,
        scene,
        <Text>
          <Text bold color="claude">
            ◆ Nexus
          </Text>
          <Text color="subtle"> › </Text>
          <Text bold>Start a thread</Text>
        </Text>,
        'tab moves between the fields',
      )}
      {projectsFailure && <Text color="error">The projects did not load: {sentence(projectsFailure.message)}</Text>}
      {projects && projects.length === 0 && <Text color="subtle">No projects yet. Add one with POST /v1/projects.</Text>}
      {!projects && !projectsFailure && <Text color="subtle">Loading the projects…</Text>}
      {projects && projects.length > 0 && (
        <Box flexDirection="column" marginTop={1} rowGap={0}>
          <Input
            key={fieldKey(scene.pane.fields, START_KEYS.title)}
            autoFocus
            label="Title  "
            value={scene.pane.fields[START_KEYS.title]?.text}
            placeholder="What should this thread do?"
            submitLabel="start"
            onInput={title => actions.startDraft({ title })}
            onSubmit={title => actions.startSubmit({ title })}
          />
          <Select
            key={START_KEYS.project}
            label="Project"
            value={draft.project}
            options={projects.map(project => ({ value: project.id, label: `${project.id}  ${project.repoUrl}` }))}
            onSelect={actions.startProject}
          />
          <Select
            key={START_KEYS.node}
            label="Node   "
            value={draft.node}
            options={[
              { value: '', label: `${defaultNode} (project default)` },
              ...(nodes ?? []).map(one => ({ value: one.name, label: `${one.name}${one.state === 'offline' ? ', offline' : ''}` })),
            ]}
            onSelect={value => actions.startDraft({ node: value })}
          />
          <Input
            key={fieldKey(scene.pane.fields, START_KEYS.branch)}
            label="Branch "
            value={scene.pane.fields[START_KEYS.branch]?.text}
            placeholder={chosen?.defaultBranch ?? ''}
            submitLabel="start"
            onInput={value => actions.startDraft({ branch: value })}
            onSubmit={value => actions.startSubmit({ branch: value })}
          />
          <Input
            key={fieldKey(scene.pane.fields, START_KEYS.message)}
            label="Message"
            rows={fieldRows(draft.message, 'Message', 'start', scene.width, scene.rows, scene.isFocused && draft.focused === START_KEYS.message)}
            value={scene.pane.fields[START_KEYS.message]?.text}
            placeholder="The first message for the agent"
            submitLabel="start"
            onInput={message => actions.startDraft({ message })}
            onSubmit={message => actions.startSubmit({ message })}
          />
          <Text color="subtle">{`Boots a pylon on ${node} and checks out ${branch}.`}</Text>
          {draft.error && <Text color="error">{draft.error}</Text>}
          {Notice(draw, scene.pane)}
          <Box flexDirection="row" columnGap={2} marginTop={1}>
            <Button key="start-submit" variant="primary" label={draft.isStarting ? 'Starting…' : 'Start thread'} onPress={() => actions.startSubmit()} />
            <Button key="start-cancel" label="Cancel" onPress={actions.back} />
          </Box>
        </Box>
      )}
      {(!projects || projects.length === 0) && <Button key="start-cancel" label="Back" onPress={actions.back} />}
      </Box>,
    ],
  )
}
