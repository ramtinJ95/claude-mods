// How the pane looks: the thread list grouped by project, one thread drawn as a
// Claude Code transcript draws its own, the thread's details, or the start form.
// Each function takes the surface's elements, what the atoms hold and the
// handlers the hooks module made, and holds no state of its own. Every colour
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

import type { NexusActual, NexusCatalog, NexusDesired, NexusDetail, NexusList, NexusNode, NexusPane, NexusShown, NexusStartDraft, NexusThread, NexusThreadRow, NexusWatch } from '../types'
import {
  type Action,
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
  previewLook,
  previewUrl,
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
  shown: NexusShown | null
  catalog: NexusCatalog
  pane: NexusPane
  now: number
  width: number
  isFocused: boolean
  surface: RenderSurface
}

export type PaneActions = {
  open: (id: string) => void
  back: () => void
  refresh: () => void
  close: () => void
  /** Opens or closes a fold, a tool row or a group's closed threads, as drawn now. */
  toggle: (key: string, isOpen: boolean) => void
  /** Hands the keys to the composer or the filter, or back to the Buttons. */
  field: (field: NexusPane['field']) => void
  filter: (text: string) => void
  draft: (text: string) => void
  submit: (text: string) => void
  act: (action: Exclude<Action, 'delete'>) => void
  remove: () => void
  details: () => void
  newThread: () => void
  startAgain: () => void
  startDraft: (change: Partial<NexusStartDraft>) => void
  /** Starts the thread, the field Enter was pressed in carrying its text: it may not have reported it yet. */
  startSubmit: (change?: Partial<NexusStartDraft>) => void
  copy: (text: string, surface: RenderSurface) => void
}

type Key = { hotkey: string; label: string; onPress: () => void }

export const COMPOSE = 'compose'
export const FILTER = 'filter'

/** Buttons laid out in rows that fit `width`. */
function keyRows(keys: readonly Key[], width: number): Key[][] {
  const rows: Key[][] = []
  let row: Key[] = []
  let used = 0
  for (const key of keys) {
    const size = key.hotkey.length + 2 + key.label.length
    if (row.length > 0 && used + 2 + size > width) {
      rows.push(row)
      row = []
      used = 0
    }
    used += (row.length > 0 ? 2 : 0) + size
    row.push(key)
  }
  if (row.length > 0) rows.push(row)
  return rows
}

/**
 * The view's keys, left out while a drawn field has them: a letter typed into a field must not press a Button. A
 * field the view no longer draws, as the composer of a thread just archived, leaves them drawn.
 */
function Keys(draw: Draw, scene: Scene, keys: readonly Key[], hasField: boolean) {
  const { Box, Button } = draw
  if (hasField) return null
  return (
    <Box flexDirection="column" marginTop={1}>
      {keyRows(keys, scene.width).map((row, index) => (
        <Box key={`keys-${index}`} flexDirection="row" columnGap={2}>
          {row.map(key => (
            <Button key={`key-${key.hotkey}`} plain dimColor hotkey={key.hotkey} label={key.label} onPress={key.onPress} />
          ))}
        </Box>
      ))}
      {FocusHint(draw, scene.isFocused)}
    </Box>
  )
}

/** The pane's keys work only while it holds the keyboard, which the person may have to hand it. */
function FocusHint({ Text }: Draw, isFocused: boolean) {
  return isFocused ? null : <Text color="subtle">The keys work once the pane has focus: ctrl+x then tab, or a click.</Text>
}

function Notice({ Text }: Draw, pane: NexusPane) {
  if (!pane.notice) return null
  return <Text color={pane.notice.tone === 'error' ? 'error' : 'subtle'}>{pane.notice.text}</Text>
}

const Dot = ({ Text }: Draw, tone: Tone) => <Text color={TONE_COLOR[tone]}>●</Text>

/** Where a pylon's phase stands against what is wanted of it, for the list's "wants paused". */
const PHASE: Partial<Record<NexusActual, NexusDesired>> = { running: 'running', spawning: 'running', paused: 'paused', pausing: 'paused', deleting: 'deleted', absent: 'deleted' }

function listMeta(thread: NexusThreadRow, now: number): string {
  const [label] = threadState(thread, thread.pylon.actualState)
  const wants = PHASE[thread.pylon.actualState] !== thread.desired ? `wants ${thread.desired}` : null
  const agent = thread.agentTurnRunning ? 'turn running' : `agent ${span(now - thread.lastAgentActivityAt) ?? 'now'}`
  return [label, thread.pylon.node, wants, `you ${span(now - thread.lastHumanActivityAt) ?? 'now'}`, agent].filter(Boolean).join(' · ')
}

export function ListView(draw: Draw, scene: Scene, actions: PaneActions) {
  const { Box, Text, Button, Input } = draw
  const { list, pane, catalog } = scene
  const threads = list.threads ?? []
  const groups = groupThreads(threads, pane.filter, pane.toggled)
  const open = threads.filter(thread => thread.status === 'active' || thread.status === 'idle').length
  const working = threads.filter(thread => thread.agentTurnRunning).length
  const now = list.polledAt ?? scene.now
  const isTyping = pane.field === 'filter'
  let index = 0
  const row = (thread: NexusThreadRow) => {
    index += 1
    const [, tone] = threadState(thread, thread.pylon.actualState)
    const meta = listMeta(thread, now)
    const hotkey = !isTyping && index <= 9 ? String(index) : undefined
    const room = Math.max(8, scene.width - (hotkey ? 3 : 0) - 4 - cells(meta) - 2)
    const title = clip(thread.title, room)
    return (
      <Button key={thread.id} plain hotkey={hotkey} onPress={() => actions.open(thread.id)}>
        {Dot(draw, tone)} {title}
        {' '.repeat(Math.max(1, room - cells(title) + 1))}
        <Text color="subtle">{meta}</Text>
      </Button>
    )
  }
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text bold>Nexus</Text>
        {list.threads ? (
          <Text color="subtle">{`  ${open} open · ${working} working`}</Text>
        ) : list.failure ? (
          <Text color="error">{list.failure.kind === 'unreachable' ? '  unreachable' : '  not loaded'}</Text>
        ) : (
          <Text color="subtle">  connecting…</Text>
        )}
      </Text>
      {list.failure && (
        <Text color="error">
          {list.failure.kind === 'unreachable' ? 'Nexus is unreachable' : `nexus failed (${list.failure.kind})`}: {sentence(list.failure.message)}
          {list.threads ? ' The list below is from the last poll that worked.' : ''}
        </Text>
      )}
      {pane.field === 'filter' ? (
        <Input key={FILTER} autoFocus label="Filter" value={pane.filter} placeholder="part of a title" submitLabel="done" onInput={actions.filter} onSubmit={() => actions.field('none')} />
      ) : (
        pane.filter && <Text color="subtle">Filtered by "{pane.filter}"</Text>
      )}
      {list.threads && groups.length === 0 && (
        <Text color="subtle">{pane.filter ? 'No thread title holds that.' : 'No threads yet. n starts one.'}</Text>
      )}
      {groups.map(group => (
        <Box key={`project-${group.project}`} flexDirection="column" marginTop={1}>
          <Text wrap="truncate-end">
            <Text bold>{group.project}</Text>
            <Text color="subtle"> {group.open.length}</Text>
          </Text>
          {group.open.map(row)}
          {group.closed.length > 0 && (
            <Button key={closedKey(group.project)} plain dimColor onPress={() => actions.toggle(closedKey(group.project), group.isUnfolded)}>
              {group.isUnfolded ? '▾' : '▸'} {closedLabel(group.closed)}
            </Button>
          )}
          {group.isUnfolded && group.closed.map(row)}
        </Box>
      ))}
      {NodesLine(draw, catalog.nodes)}
      {Notice(draw, pane)}
      {Keys(draw, scene, [
        { hotkey: 'n', label: 'new thread', onPress: actions.newThread },
        { hotkey: 'f', label: 'filter', onPress: () => actions.field('filter') },
        { hotkey: 'r', label: 'refresh', onPress: actions.refresh },
        { hotkey: 'q', label: 'close', onPress: actions.close },
      ], isTyping)}
    </Box>
  )
}

function NodesLine(draw: Draw, nodes: NexusNode[] | null) {
  const { Box, Text } = draw
  if (!nodes || nodes.length === 0) return null
  return (
    <Box marginTop={1}>
      <Text wrap="truncate-end">
        <Text color="subtle">nodes </Text>
        {nodes.map(node => (
          <Text key={node.name}>
            {' '}
            {Dot(draw, node.state === 'online' ? 'ok' : 'muted')} {node.name}
            {node.state === 'offline' && <Text color="subtle"> offline</Text>}
          </Text>
        ))}
      </Text>
    </Box>
  )
}

/** What the thread view knows of the thread: the `show` poll, else the list's row, else the watch. */
function threadOf(scene: Scene): { id: string; thread: NexusThread | undefined; detail: NexusDetail | null } {
  const id = scene.pane.selected ?? ''
  const detail = scene.shown?.thread === id ? scene.shown.detail : null
  return { id, thread: detail?.thread ?? scene.list.threads?.find(one => one.id === id), detail }
}

function Header(draw: Draw, scene: Scene) {
  const { Box, Text } = draw
  const { id, thread, detail } = threadOf(scene)
  const watch = scene.watch?.thread === id ? scene.watch : null
  const state = watch?.state
  const row = scene.list.threads?.find(one => one.id === id)
  // The details, the watch's state or the list's row, whichever has come: none of them before the first poll.
  const pylon = detail?.pylon.actualState ?? (state?.pylon as NexusActual | undefined) ?? row?.pylon.actualState
  const facts = { status: state?.status ?? thread?.status ?? 'active', agentTurnRunning: state ? state.run === 'working' : (thread?.agentTurnRunning ?? false) }
  const known = pylon ? threadState(facts, pylon) : null
  const node = detail?.pylon.node ?? row?.pylon.node
  const started = thread ? `started ${since(thread.createdAt, scene.now)}` : null
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        {thread && <Text color="subtle">{thread.project} / </Text>}
        <Text bold>{thread?.title ?? id}</Text>
      </Text>
      <Text wrap="truncate-end">
        {known ? (
          <Text>
            {Dot(draw, known[1])} {known[0]}
            {node ? ` · ${node}` : ''}
          </Text>
        ) : (
          <Text color="subtle">{watch?.ended ? 'not watching' : watch?.outage ? 'not connected' : 'connecting…'}</Text>
        )}
        <Text color="subtle">{['', id, started, watch?.model].filter(part => part !== null && part !== undefined).join(' · ')}</Text>
      </Text>
      {watch?.outage && <Text color="error">{watch.outage} The watch keeps trying.</Text>}
      {watch?.ended && <Text color="error">{watch.ended}</Text>}
      {scene.shown?.thread === id && scene.shown.failure && (
        <Text color="error">The thread's details did not load: {sentence(scene.shown.failure.message)}</Text>
      )}
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

export function ThreadView(draw: Draw, scene: Scene, actions: PaneActions) {
  const { Box } = draw
  const { id, thread, detail } = threadOf(scene)
  const watch = scene.watch?.thread === id ? scene.watch : null
  const state = watch?.state ?? null
  const status = state?.status ?? thread?.status
  const failed = detail?.pylon.failed ?? state?.failed ?? null
  const refused = detail?.pylon.retryRefused ?? null
  const isWorking = state?.run === 'working'
  // Only a live thread with a conversation and a pylon not given up on takes messages, so only it draws the composer.
  const takesMessages = status !== 'deleted' && status !== 'archived' && !failed && (!detail || detail.hasConversation)
  const isComposing = scene.pane.view === 'thread' && scene.pane.field === 'compose' && takesMessages
  const keys: Key[] = [
    { hotkey: 'b', label: 'back', onPress: actions.back },
    ...(takesMessages ? [{ hotkey: 'm', label: 'message', onPress: () => actions.field('compose') }] : []),
    { hotkey: 'i', label: 'details', onPress: actions.details },
    ...(isWorking ? [{ hotkey: 'x', label: 'abort', onPress: () => actions.act('abort') }] : []),
    ...(state?.run === 'parked' && status !== 'archived' ? [{ hotkey: 't', label: 'retry tasks', onPress: () => actions.act('retry') }] : []),
    ...(failed && !refused ? [{ hotkey: 'p', label: 'retry pylon', onPress: () => actions.act('retry-pylon') }] : []),
    ...(failed ? [{ hotkey: 's', label: 'start again', onPress: actions.startAgain }] : []),
    ...(status === 'active' || status === 'idle' ? [{ hotkey: 'a', label: 'archive', onPress: () => actions.act('archive') }] : []),
    ...(status === 'archived' ? [{ hotkey: 'u', label: 'unarchive', onPress: () => actions.act('unarchive') }] : []),
    ...(status !== 'deleted' ? [{ hotkey: 'd', label: 'delete', onPress: actions.remove }] : []),
    { hotkey: 'r', label: 'rewatch', onPress: actions.refresh },
    { hotkey: 'q', label: 'close', onPress: actions.close },
  ]
  const isThread = scene.pane.view === 'thread'
  const header = Header(draw, scene)
  const runLine = isThread ? RunLine(draw, scene) : null
  const composer = isThread ? Composer(draw, scene, actions, { failed, refused }, isComposing) : null
  const notice = Notice(draw, scene.pane)
  const keyRows = Keys(draw, scene, isThread ? keys : detailsKeys(scene, actions, keys, detail), isComposing)
  // The conversation takes what the rest of the view leaves of the limit, measured as drawn.
  const room = DRAWN_LIMIT - drawnChars([header, runLine, composer, notice, keyRows])
  return (
    <Box flexDirection="column">
      {header}
      {isThread ? Conversation(draw, scene, actions, room) : DetailsBody(draw, scene, actions)}
      {runLine}
      {composer}
      {notice}
      {keyRows}
    </Box>
  )
}

function Conversation(draw: Draw, scene: Scene, actions: PaneActions, room: number) {
  const { Box, Text } = draw
  const { id, thread, detail } = threadOf(scene)
  const watch = scene.watch?.thread === id ? scene.watch : null
  if (thread?.status === 'deleted' || watch?.state?.status === 'deleted') {
    return <Text color="subtle">The thread is deleted, so its conversation is gone.</Text>
  }
  if (detail && !detail.hasConversation) return <Text color="subtle">This thread has no agent conversation.</Text>
  if (!watch?.state) return null
  const all = blocks(watch.rows, watch.live)
  if (all.length === 0) return <Text color="subtle">No messages yet.</Text>
  const isWorking = watch.state.run === 'working'
  const running = new Map((watch.live?.tools ?? []).map(tool => [tool.callId, tool.output]))
  // Newest first while the drawn text fits in `room`, so a long thread costs its tail. A block that does not fit
  // draws its newest steps, and the newest block, step or text bigger than all of `room` is cut with a note.
  const drawn: RenderChildren[] = []
  let left = room
  let at = all.length - 1
  let steps = 0
  for (; at >= 0; at -= 1) {
    const block = all[at]!
    const isNewest = drawn.length === 0
    if (block.kind !== 'tools') {
      const node = BlockView(draw, block, at)
      const size = drawnChars(node)
      if (size <= left) {
        drawn.unshift(node)
        left -= size
        continue
      }
      if (isNewest) {
        drawn.unshift(Cut(draw, node, left))
        at -= 1
      }
      break
    }
    const fold = block.tools.length >= FOLD_AT ? foldOf(scene, block, isWorking, running) : null
    const header = fold ? FoldLine(draw, scene, actions, block, fold) : null
    const tools = fold && !fold.isOpen ? [] : block.tools.map(tool => ToolView(draw, scene, actions, tool, toolStatus(tool, isWorking || running.has(tool.id)), running.get(tool.id)))
    const sizes = tools.map(drawnChars)
    let size = drawnChars(header)
    let from = tools.length
    while (from > 0 && size + sizes[from - 1]! <= left) size += sizes[--from]!
    if (from === 0 && size <= left) {
      drawn.unshift(ToolsBlock(draw, at, header, tools))
      left -= size
      continue
    }
    if (from === tools.length) {
      if (!isNewest) break
      // The fold's line and the newest step are cut together, so neither can take more than the room.
      from = Math.max(0, tools.length - 1)
      drawn.unshift(Cut(draw, ToolsBlock(draw, at, header, tools.slice(from)), left))
    } else drawn.unshift(ToolsBlock(draw, at, header, tools.slice(from)))
    steps = from
    at -= 1
    break
  }
  const omitted = [at >= 0 && plural(at + 1, 'earlier block', 'earlier blocks'), steps > 0 && plural(steps, 'earlier step', 'earlier steps')].filter(Boolean)
  return (
    <Box flexDirection="column">
      {omitted.length > 0 && <Text color="subtle">{`… ${omitted.join(' and ')} left out of the pane`}</Text>}
      {drawn}
    </Box>
  )
}

type Element = { type: string; props?: Readonly<Record<string, unknown>>; children?: unknown }
const isElement = (node: unknown): node is Element => typeof node === 'object' && node !== null && !Array.isArray(node) && typeof (node as Element).type === 'string'
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

/** One text block of the conversation: the person's message, an answer or a notice. */
function BlockView(draw: Draw, block: Exclude<Block, { kind: 'tools' }>, index: number) {
  const { Box, Text, Markdown } = draw
  switch (block.kind) {
    case 'user':
      return (
        <Box key={`block-${index}`} flexDirection="row" marginTop={1}>
          <Text color="subtle">{'❯ '}</Text>
          <Box flexDirection="column" flexShrink={1}>
            <Text color="text">{block.text}</Text>
            {block.queued && <Text color="subtle">queued, sends after this run</Text>}
          </Box>
        </Box>
      )
    case 'assistant':
      return (
        <Box key={`block-${index}`} flexDirection="row" marginTop={1}>
          <Text color="text">{'⏺ '}</Text>
          <Box flexDirection="column" flexShrink={1}>
            <Markdown text={block.text} />
          </Box>
        </Box>
      )
    case 'notice':
      return block.tone === 'dim' ? (
        <Box key={`block-${index}`} flexDirection="row">
          <Text color="subtle">{'  ⎿  '}</Text>
          <Text color="subtle">{block.text}</Text>
        </Box>
      ) : (
        <Box key={`block-${index}`} flexDirection="row" marginTop={1}>
          <Text color={block.tone}>{'⏺ '}</Text>
          <Box flexShrink={1}>
            <Text color={block.tone}>{block.text}</Text>
          </Box>
        </Box>
      )
  }
}

/** A fold's line, "⏺ Read 4 files (4 steps, enter to expand)", which opens or closes it: one line, as Claude Code's, so a run of many distinct tools names those that fit. */
function FoldLine(draw: Draw, scene: Scene, actions: PaneActions, block: Extract<Block, { kind: 'tools' }>, fold: Fold) {
  const { Box, Text, Button } = draw
  return (
    <Box marginTop={1}>
      <Button key={fold.key} plain onPress={() => actions.toggle(fold.key, fold.isOpen)}>
        <Text color={fold.bad > 0 ? 'error' : fold.busy > 0 ? 'inactive' : 'success'}>{'⏺ '}</Text>
        {clip(foldSummary(block.tools), Math.max(8, scene.width - 40))}
        <Text color="subtle">
          {`${fold.bad > 0 ? ` · ${fold.bad} failed` : ''}${fold.busy > 0 ? ` · ${fold.busy} running` : ''} (${block.tools.length} steps, enter to ${fold.isOpen ? 'fold' : 'expand'})`}
        </Text>
      </Button>
    </Box>
  )
}

/** A run of calls: its fold's line, when it folds, over the steps drawn. */
function ToolsBlock(draw: Draw, index: number, header: RenderChildren, tools: readonly RenderChildren[]) {
  const { Box } = draw
  return (
    <Box key={`block-${index}`} flexDirection="column">
      {header}
      {tools.length > 0 && (header ? <Box flexDirection="column" paddingLeft={2}>{tools}</Box> : tools)}
    </Box>
  )
}

const STATUS_COLOR: Record<ToolStatus, string> = { running: 'inactive', none: 'subtle', ok: 'success', error: 'error' }

function ToolView(draw: Draw, scene: Scene, actions: PaneActions, tool: ToolRow, status: ToolStatus, live: string | undefined) {
  const { Box, Text, Button, Code } = draw
  const key = `tool-${tool.id}`
  const isOpen = scene.pane.toggled[key] ?? false
  const subject = subjectOf(tool)
  const diff = diffOf(tool)
  const name = clip(toolName(tool.name), Math.max(8, Math.floor(scene.width / 2)))
  const room = Math.max(8, scene.width - cells(name) - 4)
  const shown = subject ? clip(subject.value.replace(/\s+/g, ' ').trim(), room) : ''
  const rest = otherArgs(tool, diff)
  return (
    <Box key={key} flexDirection="column" marginTop={1}>
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
    ...(!isOpen && more > 0 ? [<Text key="more" color="subtle">{`… +${plural(more, 'line', 'lines')} (enter to expand)`}</Text>] : []),
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
      <Box marginTop={1}>
        <Text color="warning">
          {`⚠ ${plural(state.parkedTasks, 'task', 'tasks')} hit the restart limit and hold the run. ${archived ? 'Unarchive the thread to retry them.' : 't retries them.'}`}
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
    'x to abort',
  ].filter(Boolean)
  return (
    <Box marginTop={1}>
      <Text wrap="truncate-end">
        <Text color="claude">{`${spinner(scene.now)} Working… `}</Text>
        <Text color="subtle">({facts.join(' · ')})</Text>
      </Text>
    </Box>
  )
}

/** Why a thread takes no messages, or the prompt box: a busy run queues what is sent, so the box says so. */
function Composer(draw: Draw, scene: Scene, actions: PaneActions, pylon: { failed: string | null; refused: string | null }, isComposing: boolean) {
  const { Box, Text, Input, Code } = draw
  const { id, thread, detail } = threadOf(scene)
  const watch = scene.watch?.thread === id ? scene.watch : null
  const status = watch?.state?.status ?? thread?.status
  if (status === 'deleted' || (detail && !detail.hasConversation)) return null
  // Only the planner giving up holds the pylon until a person acts. A pylon reported broken may still resume.
  if (pylon.failed) {
    return (
      <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="error" paddingX={1}>
        <Text color="error">The planner gave up on this thread's pylon, so its agent cannot run tools and the thread takes no messages.</Text>
        <Text>
          {pylon.refused
            ? sentence(pylon.refused)
            : "Fix the cause, such as the project's git access, and retry, or start again from the same project. A retry runs setup again on a new pylon whose setup failed, and resumes a broken pylon from its newest disk."}
        </Text>
        <Code source={pylon.failed} language="text" />
      </Box>
    )
  }
  if (status === 'archived') {
    return (
      <Box marginTop={1} borderStyle="round" borderColor="subtle" paddingX={1}>
        <Text color="subtle">An archived thread takes no messages, because its pylon stays paused. Unarchive the thread to send one.</Text>
      </Box>
    )
  }
  const queue = watch?.state ? watch.state.run !== 'idle' : false
  const placeholder = queue ? 'Queue a follow-up…' : 'Message the agent…'
  const pylonState = detail?.pylon.actualState ?? watch?.state?.pylon
  return (
    <Box flexDirection="column" marginTop={1}>
      {pylonState === 'paused' && <Text color="subtle">The pylon is paused. Sending a message wakes it.</Text>}
      <Box borderStyle="round" borderColor="promptBorder" paddingX={1}>
        {isComposing ? (
          <Input
            key={COMPOSE}
            autoFocus
            label="❯"
            value={scene.pane.draft}
            placeholder={placeholder}
            submitLabel={queue ? 'queue' : 'send'}
            onInput={actions.draft}
            onSubmit={actions.submit}
          />
        ) : (
          <Text color="subtle">{`❯ ${scene.pane.draft || placeholder}`}</Text>
        )}
      </Box>
      {isComposing && <Text color="subtle">{`Enter ${queue ? 'queues it behind the run' : 'sends'} · an empty Enter hands the keys back`}</Text>}
    </Box>
  )
}

function detailsKeys(scene: Scene, actions: PaneActions, threadKeys: readonly Key[], detail: NexusDetail | null): Key[] {
  const keep = new Set(['a', 'u', 'd', 'p', 's', 'q'])
  return [
    { hotkey: 'b', label: 'conversation', onPress: actions.details },
    ...(detail ? [{ hotkey: 'c', label: 'copy attach command', onPress: () => actions.copy(detail.attach, scene.surface) }] : []),
    ...threadKeys.filter(key => keep.has(key.hotkey)),
  ]
}

/** The dashboard's inspector: the pylon, its previews, the thread's outputs and its sessions. */
function DetailsBody(draw: Draw, scene: Scene, _actions: PaneActions) {
  const { Box, Text, Link } = draw
  const { detail } = threadOf(scene)
  if (!detail) return <Text color="subtle">{scene.shown?.failure ? '' : 'Loading the details…'}</Text>
  const { thread, pylon } = detail
  const node = scene.catalog.nodes?.find(one => one.name === pylon.node)
  const offline = node?.state === 'offline'
  const kv = (label: string, value: unknown, key: string) => (
    <Box key={key} flexDirection="row">
      <Text color="subtle">{label.padEnd(11)}</Text>
      <Box flexShrink={1}>{typeof value === 'string' ? <Text>{value}</Text> : (value as never)}</Box>
    </Box>
  )
  const state = (label: string, tone: Tone) => (
    <Text>
      {Dot(draw, tone)} {label}
    </Text>
  )
  const heading = (title: string, count?: number) => (
    <Box marginTop={1}>
      <Text bold>
        {title}
        {count !== undefined && <Text color="subtle"> {count}</Text>}
      </Text>
    </Box>
  )
  const previewOf = new Map(detail.previews.map(preview => [preview.service, preview]))
  const linkFor = (port: number) => (node?.tailnetHost ? previewUrl(node, port) : null)
  const observed = pylon.observedAt === null ? 'never' : `${since(Date.parse(pylon.observedAt), scene.now)}${offline ? ' (stale)' : ''}`
  return (
    <Box flexDirection="column">
      {heading('Pylon')}
      {kv('Desired', state(detail.desired, DESIRED_TONE[detail.desired]), 'desired')}
      {kv('Observed', state(...ACTUAL_BADGE[pylon.actualState]), 'observed')}
      {kv('Node', `${pylon.node}${offline ? ' (offline)' : ''}`, 'node')}
      {kv('Last seen', observed, 'seen')}
      {kv('Human', since(thread.lastHumanActivityAt, scene.now), 'human')}
      {kv('Agent', thread.agentTurnRunning ? 'turn running' : since(thread.lastAgentActivityAt, scene.now), 'agent')}
      <Text color="subtle">{pylon.id}</Text>
      {pylon.failed && <Text color="error">The planner gave up: {pylon.failed}</Text>}
      {heading('Previews', detail.previews.length)}
      {detail.previews.length === 0 && <Text color="subtle">No previews.</Text>}
      {detail.previews.map(preview => {
        const look = previewLook(detail, preview)
        const url = linkFor(preview.httpsPort)
        return (
          <Box key={`preview-${preview.service}`} flexDirection="column">
            <Box flexDirection="row" columnGap={1}>
              {Dot(draw, look.tone)}
              <Text bold>{preview.service}</Text>
              <Text color="subtle">{look.label}</Text>
              {look.linked && url ? <Link href={url} label={url} /> : <Text color="subtle">{`port ${preview.httpsPort}`}</Text>}
            </Box>
            {look.hint && <Text color="subtle">{`  ${look.hint}`}</Text>}
          </Box>
        )
      })}
      {heading('Outputs', detail.outputs.length)}
      {detail.outputs.length === 0 && <Text color="subtle">No outputs yet.</Text>}
      {detail.outputs.map((output, index) => {
        const preview = output.kind === 'preview' ? previewOf.get(output.ref) : undefined
        const url = preview && previewLook(detail, preview).linked ? linkFor(preview.httpsPort) : null
        return (
          <Box key={`output-${index}`} flexDirection="row" columnGap={1}>
            <Text color="subtle">{output.kind.padEnd(8)}</Text>
            {url ? <Link href={url} label={output.ref} /> : <Text>{output.ref}</Text>}
          </Box>
        )
      })}
      {heading('Sessions', detail.sessions.length)}
      {detail.sessions.length === 0 && <Text color="subtle">No sessions.</Text>}
      {detail.sessions.map(session => (
        <Box key={`session-${session.herdrPane}`} flexDirection="row" columnGap={1}>
          <Text>{HARNESS_LABEL[session.harness]}</Text>
          {state(session.status, SESSION_TONE[session.status])}
          <Text color="subtle">{session.herdrPane}</Text>
          {session.harnessSessionId && <Text color="subtle">{`session ${session.harnessSessionId}`}</Text>}
        </Box>
      ))}
      <Box marginTop={1} flexDirection="column">
        <Text color="subtle">Attach from a shell in the pylon:</Text>
        <Text>{`  ${detail.attach}`}</Text>
      </Box>
    </Box>
  )
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
  return (
    <Box flexDirection="column">
      <Text bold>Start a thread</Text>
      {projectsFailure && <Text color="error">The projects did not load: {sentence(projectsFailure.message)}</Text>}
      {projects && projects.length === 0 && <Text color="subtle">No projects yet. Add one with POST /v1/projects.</Text>}
      {!projects && !projectsFailure && <Text color="subtle">Loading the projects…</Text>}
      {projects && projects.length > 0 && (
        <Box flexDirection="column" marginTop={1} rowGap={0}>
          <Input
            key={START_KEYS.title}
            autoFocus
            label="Title  "
            value={draft.title}
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
            onSelect={project => actions.startDraft({ project, node: '', branch: '' })}
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
            key={START_KEYS.branch}
            label="Branch "
            value={draft.branch}
            placeholder={chosen?.defaultBranch ?? ''}
            submitLabel="start"
            onInput={value => actions.startDraft({ branch: value })}
            onSubmit={value => actions.startSubmit({ branch: value })}
          />
          <Input
            key={START_KEYS.message}
            label="Message"
            rows={3}
            value={draft.message}
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
    </Box>
  )
}
