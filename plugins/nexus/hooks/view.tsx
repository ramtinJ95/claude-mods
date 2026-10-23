// How the pane looks: the thread list grouped by project, or one thread's
// state and conversation tail. Each function takes the surface's elements and
// the handlers the hooks module made, and holds no state of its own.
import type { BoxProps, ButtonProps, ElementConstructor, InputProps, TextProps } from 'claude-code'

import type { NexusList, NexusPane, NexusRunState, NexusThread, NexusWatch } from '../types'
import { type Line, ago, cells, clip, groupThreads, sentence, tailLines, wrap } from './model'

export type Draw = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Button: ElementConstructor<ButtonProps>
  Input: ElementConstructor<InputProps>
}

export type PaneActions = {
  open: (id: string) => void
  back: () => void
  refresh: () => void
  toggleArchived: () => void
  close: () => void
  compose: () => void
  draft: (text: string) => void
  submit: (text: string) => void
  askAbort: () => void
  abort: () => void
  keep: () => void
  archive: () => void
}

type Key = { hotkey: string; label: string; onPress: () => void }

export const COMPOSE = 'compose'

/** Buttons laid out in rows that fit `width`, so the footer's height is known before the tail is sized. */
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

function Keys({ Box, Button }: Draw, rows: Key[][]) {
  return rows.map((row, index) => (
    <Box key={`keys-${index}`} flexDirection="row" columnGap={2}>
      {row.map(key => (
        <Button key={`key-${key.hotkey}`} plain hotkey={key.hotkey} label={key.label} onPress={key.onPress} />
      ))}
    </Box>
  ))
}

function Spans({ Text }: Draw, line: Line, key: string) {
  if (line.length === 0) return <Text key={key}> </Text>
  return (
    <Text key={key} wrap="truncate-end">
      {line.map((span, index) => (
        <Text key={`${key}-${index}`} color={span.color} dimColor={span.dim} bold={span.bold}>
          {span.text}
        </Text>
      ))}
    </Text>
  )
}

const RUN = {
  working: { glyph: '●', color: 'claude', label: 'working' },
  parked: { glyph: '■', color: 'warning', label: 'parked' },
  idle: { glyph: '○', color: 'subtle', label: 'idle' },
} as const

const PYLON: Record<string, string> = {
  running: 'success',
  spawning: 'warning',
  pausing: 'warning',
  deleting: 'warning',
  unknown: 'warning',
  failed: 'error',
}

function threadGlyph(thread: NexusThread): { glyph: string; color: string; label: string } {
  if (thread.agentTurnRunning) return RUN.working
  if (thread.status === 'archived') return { glyph: '◌', color: 'subtle', label: 'archived' }
  return { glyph: '○', color: thread.status === 'active' ? 'success' : 'subtle', label: thread.status }
}

function failureLine(draw: Draw, list: NexusList) {
  if (!list.failure) return null
  const { Text } = draw
  const stale = list.threads ? ' The list below is from the last poll that worked.' : ''
  return (
    <Text color="error">
      {list.failure.kind === 'unreachable' ? 'Nexus is unreachable' : `nexus failed (${list.failure.kind})`}: {sentence(list.failure.message)}{stale}
    </Text>
  )
}

export function ListView(draw: Draw, list: NexusList, pane: NexusPane, actions: PaneActions, width: number, isFocused: boolean) {
  const { Box, Text, Button } = draw
  const threads = list.threads ?? []
  const groups = groupThreads(threads, pane.showArchived)
  const working = threads.filter(thread => thread.agentTurnRunning).length
  const archived = threads.filter(thread => thread.status === 'archived').length
  const now = list.polledAt ?? 0
  let index = 0
  const keys: Key[] = [
    { hotkey: 'r', label: 'refresh', onPress: actions.refresh },
    { hotkey: 'v', label: pane.showArchived ? 'hide archived' : `archived (${archived})`, onPress: actions.toggleArchived },
    { hotkey: 'q', label: 'close', onPress: actions.close },
  ]
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text bold>Nexus</Text>
        {list.threads ? (
          <Text dimColor>{`  ${threads.length - archived} open · ${working} working`}</Text>
        ) : list.failure ? (
          <Text color="error">{list.failure.kind === 'unreachable' ? '  unreachable' : '  not loaded'}</Text>
        ) : (
          <Text dimColor>  connecting…</Text>
        )}
      </Text>
      {failureLine(draw, list)}
      {list.threads && groups.length === 0 && <Text dimColor>No threads. /nexus new {'<project> <message>'} starts one.</Text>}
      {groups.map(group => (
        <Box key={`project-${group.project}`} flexDirection="column" marginTop={1}>
          <Text wrap="truncate-end">
            <Text bold color="suggestion">{group.project}</Text>
            {group.archived > 0 && <Text dimColor> · {group.archived} archived</Text>}
          </Text>
          {group.threads.map(thread => {
            index += 1
            const { glyph, color, label } = threadGlyph(thread)
            const right = `${label} ${ago(now - thread.lastActivityAt)}`
            const hotkey = index <= 9 ? String(index) : undefined
            const room = Math.max(4, width - (hotkey ? 3 : 0) - 2 - right.length - 1)
            const clipped = clip(thread.title, room)
            const title = clipped + ' '.repeat(Math.max(0, room - cells(clipped)))
            return (
              <Button key={thread.id} plain hotkey={hotkey} onPress={() => actions.open(thread.id)}>
                <Text color={color}>{glyph}</Text> {title} <Text dimColor>{right}</Text>
              </Button>
            )
          })}
        </Box>
      ))}
      <Box flexDirection="column" marginTop={1}>
        {Keys(draw, keyRows(keys, width))}
        {FocusHint(draw, isFocused)}
      </Box>
    </Box>
  )
}

/** The pane's keys work only while it holds the keyboard, which the person may have to hand it. */
function FocusHint({ Text }: Draw, isFocused: boolean) {
  return isFocused ? null : <Text dimColor>The keys work once the pane has focus: ctrl+x then tab, or a click.</Text>
}

function stateLine(state: NexusRunState): Line {
  const run = RUN[state.run]
  return [
    { text: `${run.glyph} `, color: run.color },
    { text: state.run === 'parked' ? `${state.parkedTasks} parked` : run.label },
    { text: ' · pylon ', dim: true },
    { text: state.pylon, color: PYLON[state.pylon] },
    ...(state.queued > 0 ? [{ text: ` · ${state.queued} queued`, dim: true }] : []),
    ...(state.status !== 'active' ? [{ text: ` · ${state.status}`, dim: true }] : []),
  ]
}

export function ThreadView(
  draw: Draw,
  watch: NexusWatch | null,
  thread: NexusThread | undefined,
  pane: NexusPane,
  actions: PaneActions,
  width: number,
  height: number,
  isFocused: boolean,
) {
  const { Box, Text, Input } = draw
  const id = watch?.thread ?? pane.selected ?? ''
  const state = watch?.state ?? null
  const header: Line[] = [
    [{ text: clip(thread?.title ?? id, width), bold: true }],
    [{ text: clip(`${id}${thread ? ` · ${thread.project}` : ''}`, width), dim: true }],
    state ? stateLine(state) : [{ text: watch?.ended ? 'not watching' : watch?.outage ? 'not connected' : 'connecting…', dim: true }],
    ...(state?.failed ? [[{ text: `pylon failed: ${state.failed}`, color: 'error' }]] : []),
    ...(state?.run === 'parked' ? [[{ text: `Parked tasks hold the run: /nexus retry ${id} runs them again.`, color: 'warning' }]] : []),
    ...(watch?.outage ? [[{ text: `${watch.outage} The watch keeps trying.`, color: 'error' }]] : []),
    ...(watch?.ended ? [[{ text: watch.ended, color: 'error' }]] : []),
  ]
  const isArchived = (state?.status ?? thread?.status) === 'archived'
  const keys: Key[] =
    pane.mode === 'confirm-abort'
      ? [
          { hotkey: 'y', label: 'abort the run', onPress: actions.abort },
          { hotkey: 'n', label: 'keep it', onPress: actions.keep },
        ]
      : [
          { hotkey: 'b', label: 'back', onPress: actions.back },
          { hotkey: 'm', label: 'message', onPress: actions.compose },
          { hotkey: 'x', label: 'abort', onPress: actions.askAbort },
          { hotkey: 'a', label: isArchived ? 'unarchive' : 'archive', onPress: actions.archive },
          { hotkey: 'r', label: 'rewatch', onPress: actions.refresh },
          { hotkey: 'q', label: 'close', onPress: actions.close },
        ]
  const footer = pane.mode === 'compose' ? [] : keyRows(keys, width)
  const hintRows = isFocused || pane.mode === 'compose' ? 0 : 1
  const notice: Line[] = [
    ...(pane.mode === 'confirm-abort' ? [[{ text: 'Abort the running turn?', color: 'warning' }]] : []),
    ...(pane.notice ? wrapNotice(pane.notice, width) : []),
  ]
  const composeRows = pane.mode === 'compose' ? 2 : 0
  const room = Math.max(1, height - header.length - 2 - notice.length - footer.length - composeRows - hintRows)
  const rows = watch?.rows ?? []
  const tail = tailLines(rows, width, room)
  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      {header.map((line, index) => Spans(draw, line, `head-${index}`))}
      <Text dimColor>{'─'.repeat(width)}</Text>
      <Box flexDirection="column" height={room} justifyContent="flex-end">
        {rows.length === 0 ? <Text dimColor>{state ? 'No messages yet.' : ''}</Text> : tail.map((line, index) => Spans(draw, line, `tail-${index}`))}
      </Box>
      <Text dimColor>{'─'.repeat(width)}</Text>
      {notice.map((line, index) => Spans(draw, line, `notice-${index}`))}
      {pane.mode === 'compose' ? (
        <Box flexDirection="column">
          <Input
            key={COMPOSE}
            autoFocus
            value={pane.draft}
            placeholder="Message the agent"
            submitLabel="send"
            onInput={actions.draft}
            onSubmit={actions.submit}
          />
          <Text dimColor>Enter sends, queued behind a running turn · empty Enter cancels</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          {Keys(draw, footer)}
          {FocusHint(draw, isFocused)}
        </Box>
      )}
    </Box>
  )
}

/** A notice in at most three lines. */
function wrapNotice(notice: NonNullable<NexusPane['notice']>, width: number): Line[] {
  const style = notice.tone === 'error' ? { color: 'error' } : { dim: true }
  return wrap(notice.text, width).slice(0, 3).map(text => [{ text, ...style }])
}
