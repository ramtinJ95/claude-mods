import { atom, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AnnotationKind, DiffBase, ReviewDoc, ReviewView } from '../types'
import { DIFF_FLAGS, GIT_CONFIG, parseDiff } from './diff'
import { describeTarget, formatQuestion, formatReview } from './format'
import { halfPage, layoutRows, splitLines, visibleOffset } from './layout'
import type { Layout } from './layout'
import { diffLook, hangAt, lookText, markdownLooks, plainLook, sliceLook, wrapLook } from './style'
import type { Look } from './style'
import {
  KINDS,
  activeAnnotation,
  annotationsAtRow,
  beginDraft,
  clearNotice,
  createView,
  currentTarget,
  deleteAnnotation,
  editAnnotation,
  fileRow,
  hasWork,
  moveTo,
  navigateAnnotation,
  saveDraft,
  scrollPreview,
  setDraftBody,
  setReply,
  sortAnnotations,
  toggleReading,
  toggleSelection,
} from './model'

const PANE = 'review-pane'
const DRAFT = 'draft'
const PRIORITY = Object.keys(KINDS) as AnnotationKind[]
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

const DOC = { plugin: 'review-pane', key: 'doc' } as const
const VIEW = { plugin: 'review-pane', key: 'view' } as const
const viewAtom = atom(VIEW, null)

type Source = ReviewDoc['source']

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

async function git($: EngineInterface, args: string[], init: { cwd?: string; env?: Record<string, string> } = {}) {
  return $.process.run(['git', ...GIT_CONFIG, ...args], { ...init, timeoutMs: 30_000 })
}

async function updateView($: EngineInterface, fn: (view: ReviewView) => ReviewView) {
  await update($, viewAtom, view => view && fn(view))
}

async function notify($: EngineInterface, notice: string) {
  await updateView($, view => ({ ...view, notice }))
}

async function defaultBranch($: EngineInterface, root: string): Promise<string | undefined> {
  const remote = await git($, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { cwd: root })
  if (remote.exitCode === 0 && remote.stdout.trim()) return remote.stdout.trim()
  for (const candidate of ['origin/main', 'origin/master', 'main', 'master']) {
    const found = await git($, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`], { cwd: root })
    if (found.exitCode === 0) return candidate
  }
  return undefined
}

/** The working tree against `base`, untracked files included; a string says why there is none. */
async function loadDiff($: EngineInterface, base: DiffBase): Promise<ReviewDoc | string> {
  const top = await git($, ['rev-parse', '--show-toplevel'])
  if (top.exitCode !== 0) return 'Not inside a git repository.'
  const root = top.stdout.trim()

  const head = await git($, ['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: root })
  const hasHead = head.exitCode === 0
  let from = hasHead ? 'HEAD' : EMPTY_TREE
  let title = 'uncommitted changes'
  if (base === 'merge-base') {
    const branch = await defaultBranch($, root)
    if (!branch) return 'No default branch found (origin/HEAD, main or master) to diff against.'
    const mergeBase = await git($, ['merge-base', 'HEAD', branch], { cwd: root })
    if (mergeBase.exitCode !== 0) return `No merge-base between HEAD and ${branch}.`
    from = mergeBase.stdout.trim()
    title = `changes since ${branch}`
  }

  // A throwaway copy of the index with every untracked file added as intent-to-add, so one
  // `git diff` shows new files too (staged ones, even ignored, stay) and the person's own index
  // is never touched.
  const located = await git($, ['rev-parse', '--path-format=absolute', '--git-path', 'index'], { cwd: root })
  if (located.exitCode !== 0) return `Could not locate the index: ${located.stderr.trim()}`
  const index = located.stdout.trim()
  const temp = await $.process.run(['mktemp', '-d'])
  const dir = temp.stdout.trim()
  if (temp.exitCode !== 0 || !dir.startsWith('/')) return `Could not create a temporary index: ${temp.stderr.trim()}`
  try {
    const env = { GIT_INDEX_FILE: `${dir}/index` }
    // A repository with no index file yet has an empty one, which is what the copy then starts from.
    if ((await $.process.run(['test', '-e', index])).exitCode === 0) {
      const copied = await $.process.run(['cp', index, env.GIT_INDEX_FILE])
      if (copied.exitCode !== 0) return `Could not copy the index: ${copied.stderr.trim()}`
    }
    const added = await git($, ['add', '--intent-to-add', '--all', '.'], { cwd: root, env })
    if (added.exitCode !== 0) return `git add failed: ${added.stderr.trim()}`
    const diff = await git($, ['diff', ...DIFF_FLAGS, from, '--'], { cwd: root, env })
    if (diff.exitCode !== 0) return `git diff failed: ${diff.stderr.trim()}`
    if (diff.isStdoutTruncated) return 'The diff is larger than 4 MiB; review it in smaller pieces.'
    return { source: 'diff', title, base, ...parseDiff(diff.stdout) }
  } finally {
    await $.process.run(['rm', '-rf', dir])
  }
}

async function loadResponse($: EngineInterface): Promise<ReviewDoc | string> {
  const messages = await $.session.messages()
  const last = [...messages].reverse().find(message => message.role === 'assistant' && message.text.trim())
  if (!last) return 'No assistant response to review yet.'
  const rows = splitLines(last.text.trim()).map(text => ({ kind: 'text' as const, text }))
  return { source: 'response', title: 'previous response', files: [], rows }
}

async function openPane($: EngineInterface): Promise<string> {
  const opened = await $.ui.open({ id: PANE, title: 'Review', focus: true, rows: 40, columns: 100 })
  return opened.isPlaced ? '' : ` The pane is not shown: ${'reason' in opened ? opened.reason : 'no room'}.`
}

async function startReview($: EngineInterface, source: Source, base: DiffBase): Promise<string> {
  const [{ value: doc }, before] = await Promise.all([$.state.get(DOC), $.state.get(VIEW)])
  const view = before.value
  if (doc && view && hasWork(view)) {
    const shown = await openPane($)
    if (doc.source === source && (source === 'response' || doc.base === base)) return `Resumed the open review.${shown}`
    return `A review of the ${doc.title} still has work in it: finish it (y) or discard it (q) first.${shown}`
  }
  const loaded = source === 'diff' ? await loadDiff($, base) : await loadResponse($)
  if (typeof loaded === 'string') return loaded
  if (!(await replaceReview($, loaded, before.version))) return 'The review changed while it loaded, so it was kept: run the command again to resume it.'
  return `Opened a review of the ${loaded.title}.${await openPane($)}`
}

async function endReview($: EngineInterface) {
  await $.state.set(VIEW, null)
  await $.state.set(DOC, null)
  await $.ui.close({ id: PANE })
}

async function switchBase($: EngineInterface, doc: ReviewDoc) {
  const before = await $.state.get(VIEW)
  if (!before.value || hasWork(before.value)) {
    await notify($, 'Switching the base would drop your annotations: finish or discard them first.')
    return
  }
  const loaded = await loadDiff($, doc.base === 'head' ? 'merge-base' : 'head')
  if (typeof loaded === 'string') {
    await notify($, loaded)
    return
  }
  if (!(await replaceReview($, loaded, before.version))) await notify($, 'The review changed while the diff loaded; the base was not switched.')
}

/** Puts `loaded` in place only over the view still at `version`: work added while it loaded would be lost. */
async function replaceReview($: EngineInterface, loaded: ReviewDoc, version: number): Promise<boolean> {
  const swapped = await $.state.set(VIEW, createView(), { ifVersion: version })
  if (swapped.isSet) await $.state.set(DOC, loaded)
  return swapped.isSet
}

async function askQuestion($: EngineInterface, doc: ReviewDoc, question: ReviewView['annotations'][number]) {
  const token = crypto.randomUUID()
  await updateView($, view => setReply(view, question.id, { state: 'pending', token }))
  const prompt = formatQuestion(doc, question)
  const forked = await $.model.fork({ prompt })
  // Before the first response there is no conversation to fork: answer from the excerpt alone, and say so.
  const isAlone = !forked.isAnswered && forked.reason === 'nothing-to-fork'
  const result = isAlone ? await $.model.complete({ model: await $.session.model(), prompt }) : forked
  const reply = result.isAnswered
    ? { state: 'answered' as const, text: isAlone ? `(No conversation yet: answered from the excerpt alone.)\n${result.text}` : result.text }
    : { state: 'failed' as const, error: `No answer (${result.reason}${'status' in result && result.status ? ` ${result.status}` : ''}).` }
  await updateView($, view => setReply(view, question.id, reply, token))
}

async function submitDraft($: EngineInterface, doc: ReviewDoc, body: string) {
  let saved: ReviewView['annotations'][number] | undefined
  await updateView($, view => {
    const result = saveDraft(view, body)
    saved = result.saved
    return result.view
  })
  if (saved?.kind === 'question') await askQuestion($, doc, saved)
}

async function finishReview($: EngineInterface) {
  const [{ value: doc }, { value: view }] = await Promise.all([$.state.get(DOC), $.state.get(VIEW)])
  if (!doc || !view) return
  const text = formatReview(doc, view.annotations)
  if (!text) {
    await notify($, 'Nothing to send: add a comment, suggestion or issue (questions stay here).')
    return
  }
  const box = await $.prompt.read()
  const filled = await $.prompt.fill(box.text.trim() ? { text: `\n\n${text}`, mode: 'append' } : { text })
  if (!filled.isFilled) {
    const why = filled.refusal === 'dialog' ? 'a dialog is open' : filled.refusal === 'no_composer' ? 'there is no prompt box' : 'another plugin refused it'
    await notify($, `Could not fill the prompt: ${why}.`)
    return
  }
  await endReview($)
  await $.ui.toast('Review loaded into the prompt. Edit it, then send it yourself.')
}

/** A key the pane binds: live with `onPress`, else drawn dim and answering `reason`. */
type Key = { hotkey: string; label: string; onPress?: () => void; reason?: string }

/** Buttons laid out in rows that fit `width`, so the chrome's height is known before drawing. */
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

/** The preview's display lines: labels plain, an annotation's body and answer drawn as markdown. */
function previewLines(doc: ReviewDoc, view: ReviewView, width: number): Look[] {
  const lines: Look[] = []
  const push = (text: string, style: { color?: string; dim?: boolean } = {}) => {
    for (const part of splitLines(text)) lines.push(...wrapLook(plainLook(part, style), width))
  }
  const pushMarkdown = (text: string) => {
    for (const look of markdownLooks(splitLines(text))) lines.push(...wrapLook(look, width))
  }
  if (view.mode.kind === 'draft') {
    const { draft } = view.mode
    push(`${draft.editingId ? 'Edit' : 'New'} ${KINDS[draft.kind].label.toLowerCase()} on ${describeTarget(doc, draft.target)}`, { color: KINDS[draft.kind].color })
    return lines
  }
  if (view.mode.kind === 'confirmDiscard') {
    push(`Discard ${plural(view.annotations.length, 'annotation')} and close?`, { color: 'warning' })
    return lines
  }
  const active = activeAnnotation(view)
  if (!active) return lines
  const ordered = sortAnnotations(view.annotations)
  const position = `${ordered.findIndex(one => one.id === active.id) + 1}/${ordered.length}`
  push(`${KINDS[active.kind].label} · ${describeTarget(doc, active.target)} · ${position}`, { color: KINDS[active.kind].color })
  pushMarkdown(active.body)
  switch (active.reply?.state) {
    case 'pending':
      push('Asking…', { dim: true })
      break
    case 'failed':
      push(active.reply.error, { color: 'error' })
      break
    case 'answered':
      lines.push({ spans: [] })
      pushMarkdown(active.reply.text)
      break
  }
  return lines
}

type Geometry = { version: number; width: number; labels: string[]; looks: Look[]; numberWidth: number; contentWidth: number; layout: Layout }

/** The drawn rows depend only on the doc and the width, so they are laid out once per pair, not per key. */
let geometry: Geometry | undefined

function geometryFor(doc: ReviewDoc, version: number, width: number): Geometry {
  if (geometry?.version === version && geometry.width === width) return geometry
  const labels = doc.rows.map((row, index) =>
    doc.source === 'response' ? String(index + 1) : String(row.newLine ?? row.oldLine ?? ''),
  )
  const numberWidth = labels.reduce((widest, label) => Math.max(widest, label.length), 3)
  const contentWidth = Math.max(10, width - (numberWidth + 3))
  const isProse = doc.source === 'response'
  const looks = isProse ? markdownLooks(doc.rows.map(row => row.text)) : doc.rows.map(row => diffLook(row, doc.files))
  const layout = layoutRows(looks.map(look => ({ text: lookText(look), hang: hangAt(look, contentWidth) })), contentWidth, isProse)
  geometry = { version, width, labels, looks, numberWidth, contentWidth, layout }
  return geometry
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'review-diff',
      description: 'Review the working diff in a pane: annotate lines, ask questions, prepare a follow-up',
      argumentHint: '[base]',
    })
    await $.command.register({
      name: 'review-response',
      description: 'Review the last response in a pane: annotate lines and prepare a follow-up',
    })
    return next(e)
  })

  on('command.run', { command: 'review-diff' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg && arg !== 'base') return { text: 'Usage: /review-diff [base]' }
    return { text: await startReview($, 'diff', arg === 'base' ? 'merge-base' : 'head') }
  })

  on('command.run', { command: 'review-response' }, async ($, e) => {
    if (e.args.trim()) return { text: 'Usage: /review-response' }
    return { text: await startReview($, 'response', 'head') }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface === 'mobile') {
      const { Text } = $.ui.resolve(e)
      return <Text dimColor>The review pane needs a surface with text fields.</Text>
    }
    const { Box, Text, Button, Input, Code } = $.ui.resolve(e)
    const [docRead, { value: view }] = await Promise.all([$.state.get(DOC), $.state.get(VIEW)])
    const doc = docRead.value
    if (!doc || !view) return <Text dimColor>No review open. Run /review-diff or /review-response.</Text>

    const width = Math.max(20, e.props.bodyColumns)
    const height = Math.max(8, e.props.scroll.bodyRows)
    const { labels, looks, numberWidth, contentWidth, layout } = geometryFor(doc, docRead.version, width)
    // One display line: its spans, then any code, cut at the edge (wrapping already happened).
    const drawLook = (look: Look) => [
      <Text key="spans" wrap="truncate-end">
        {look.spans.map((one, index) => (
          <Text key={`span-${index}`} color={one.color} bold={one.bold} italic={one.italic} underline={one.underline} strikethrough={one.strikethrough} dimColor={one.dim}>
            {one.text}
          </Text>
        ))}
      </Text>,
      ...(look.code ? [<Code key="code" source={look.code.text} language={look.code.language} path={look.code.path} wrap="truncate-end" />] : []),
    ]
    const { mode } = view
    const draft = mode.kind === 'draft' ? mode.draft : undefined
    const active = activeAnnotation(view)

    // The handlers read `viewport`, `textRoom` and `preview`, sized below from the key rows;
    // they run only on a press, after this draw has finished.
    const press = (fn: (current: ReviewView) => ReviewView) => () => void updateView($, current => fn(clearNotice(current)))
    const move = (to: (cursor: number) => number) => press(current => {
      const moved = moveTo(doc, current, to(current.cursor))
      return { ...moved, offset: visibleOffset(layout, moved.cursor, current.offset, viewport) }
    })
    const page = (direction: 1 | -1) => press(current => {
      if (current.mode.kind !== 'browse' && current.mode.kind !== 'select') return current
      const paged = halfPage(layout, current.cursor, visibleOffset(layout, current.cursor, current.offset, viewport), viewport, direction)
      return { ...moveTo(doc, current, paged.cursor), offset: paged.offset }
    })
    const openDraft = (fn: (current: ReviewView) => ReviewView) => async () => {
      await updateView($, current => fn(clearNotice(current)))
      await $.ui.focus({ requestId: PANE, key: DRAFT })
    }
    const annotate = (kind: AnnotationKind) => openDraft(current => beginDraft(doc, current, kind))
    // The annotation under the cursor as of the press: an `l` just before may have moved it.
    const onActive = (fn: (current: ReviewView, id: string) => ReviewView) => (current: ReviewView) => {
      const one = activeAnnotation(current)
      return one ? fn(current, one.id) : current
    }
    const scroll = (by: (room: number) => number) =>
      press(current => scrollPreview(current, by(textRoom), Math.max(0, preview.length - textRoom)))

    // Every mode draws the same keys, the ones that do not apply dim: a key no Button binds would fall
    // through to the prompt and take the keyboard with it.
    const browsing = mode.kind === 'browse' || mode.kind === 'select'
    const isBrowse = mode.kind === 'browse'
    const isRead = mode.kind === 'read'
    const isDiff = doc.source === 'diff'
    const half = (room: number) => Math.max(1, Math.floor(room / 2))
    const why =
      mode.kind === 'read' ? 'Press e to return to the diff first.'
      : mode.kind === 'select' ? 'Annotate the range or end it with v first.'
      : mode.kind === 'confirmDiscard' ? 'Answer y to discard or n to keep first.'
      : undefined
    const when = (isOn: boolean, onPress: () => void, reason?: string): Pick<Key, 'onPress' | 'reason'> =>
      isOn ? { onPress } : { reason: why ?? reason ?? 'Not available here.' }
    const keys: Key[] = [
      { hotkey: 'j', label: isRead ? 'scroll down' : 'down', ...(isRead ? { onPress: scroll(() => 1) } : when(browsing, move(cursor => cursor + 1))) },
      { hotkey: 'k', label: isRead ? 'scroll up' : 'up', ...(isRead ? { onPress: scroll(() => -1) } : when(browsing, move(cursor => cursor - 1))) },
      { hotkey: 'd', label: 'page down', ...(isRead ? { onPress: scroll(half) } : when(browsing, page(1))) },
      { hotkey: 'u', label: 'page up', ...(isRead ? { onPress: scroll(room => -half(room)) } : when(browsing, page(-1))) },
      { hotkey: 'g', label: 'top', ...when(browsing, move(() => 0)) },
      { hotkey: 'b', label: 'bottom', ...when(browsing, move(() => doc.rows.length - 1)) },
      mode.kind === 'confirmDiscard'
        ? { hotkey: 'n', label: 'keep', onPress: press(current => ({ ...current, mode: { kind: 'browse' } })) }
        : { hotkey: 'n', label: 'next file', ...when(browsing && isDiff, move(cursor => fileRow(doc, cursor, 1)), 'A response has no files.') },
      { hotkey: 'p', label: 'prev file', ...when(browsing && isDiff, move(cursor => fileRow(doc, cursor, -1)), 'A response has no files.') },
      { hotkey: 'v', label: mode.kind === 'select' ? 'end range' : 'range', ...when(browsing, press(toggleSelection)) },
      { hotkey: 'c', label: 'comment', ...when(browsing, annotate('comment')) },
      { hotkey: 's', label: 'suggest', ...when(browsing, annotate('suggestion')) },
      { hotkey: 'i', label: 'issue', ...when(browsing, annotate('issue')) },
      { hotkey: 'a', label: 'ask', ...when(browsing, annotate('question')) },
      { hotkey: 'o', label: 'overall', ...when(isBrowse, openDraft(current => beginDraft(doc, current, 'comment', { kind: 'overall' }))) },
      { hotkey: 'h', label: 'prev note', ...when(isBrowse && view.annotations.length > 0, press(current => navigateAnnotation(current, -1)), 'No annotations yet.') },
      { hotkey: 'l', label: 'next note', ...when(isBrowse && view.annotations.length > 0, press(current => navigateAnnotation(current, 1)), 'No annotations yet.') },
      { hotkey: 'r', label: 'edit', ...when(isBrowse && active !== undefined, openDraft(onActive(editAnnotation)), 'No annotation under the cursor.') },
      { hotkey: 'x', label: 'delete', ...when(isBrowse && active !== undefined, press(onActive(deleteAnnotation)), 'No annotation under the cursor.') },
      { hotkey: 'e', label: isRead ? 'back to the diff' : 'read', ...(isRead ? { onPress: press(toggleReading) } : when(isBrowse && active !== undefined, press(toggleReading), 'No annotation under the cursor.')) },
      { hotkey: 'f', label: doc.base === 'merge-base' ? 'vs HEAD' : 'vs branch', ...when(isBrowse && isDiff && !hasWork(view), () => void switchBase($, doc), isDiff ? 'Switching the base would drop your annotations: finish or discard them first.' : 'A response has no base.') },
      mode.kind === 'confirmDiscard'
        ? { hotkey: 'y', label: 'discard', onPress: () => void endReview($) }
        : { hotkey: 'y', label: 'finish', ...when(isBrowse, () => void finishReview($)) },
      {
        hotkey: 'q',
        label: 'close',
        ...when(isBrowse, hasWork(view) ? press(current => ({ ...current, mode: { kind: 'confirmDiscard' } })) : () => void endReview($)),
      },
    ]

    const hints = keyRows(draft ? [] : keys, width)
    const status = view.notice ?? (e.props.isFocused ? 'Esc returns to the prompt' : 'Run the command again or click here to use the keys')
    const header = [
      doc.source === 'diff' ? `Diff · ${doc.title}` : 'Response',
      ...(doc.source === 'diff' ? [plural(doc.files.length, 'file')] : []),
      plural(view.annotations.length, 'note'),
    ].join(' · ')

    const preview = previewLines(doc, view, width)
    // Reading mode leaves the diff three rows and keeps one for the position line. Otherwise the
    // preview gets a third of the pane, shrunk to what one diff row, its rule and cut line leave.
    const draftRows = draft ? 2 : 0
    const textRoom = mode.kind === 'read'
      ? Math.max(1, height - 2 - hints.length - 1 - 3 - 1)
      : Math.max(0, Math.min(Math.min(8, Math.floor(height / 3)) - draftRows, height - 2 - hints.length - 1 - 2 - draftRows))
    const previewOffset = mode.kind === 'read' ? Math.max(0, Math.min(mode.previewOffset, preview.length - textRoom)) : 0
    const shown = preview.slice(previewOffset, previewOffset + textRoom)
    const isCut = shown.length < preview.length
    const cutLine = mode.kind === 'read'
      ? `lines ${previewOffset + 1}-${previewOffset + shown.length} of ${preview.length}`
      : `… ${preview.length - shown.length} more lines: e to read all`
    const previewHeight = shown.length + (isCut ? 1 : 0) + draftRows
    const viewport = Math.max(1, height - 2 - (previewHeight > 0 ? previewHeight + 1 : 0) - hints.length)
    const offset = visibleOffset(layout, view.cursor, view.offset, viewport)

    const target = draft ? draft.target : mode.kind === 'select' ? currentTarget(view) : undefined
    const lines = layout.display.slice(offset, offset + viewport).map((line, index) => {
      const marks = line.isContinuation ? [] : annotationsAtRow(view.annotations, line.row)
      const mark = PRIORITY.find(kind => marks.some(one => one.kind === kind))
      const isCursor = line.row === view.cursor
      const isSelected = target?.kind === 'rows' && line.row >= target.start && line.row <= target.end
      const number = line.isContinuation ? '' : labels[line.row]!
      return (
        <Box key={`row-${offset + index}`} flexDirection="row" height={1}>
          <Text>
            <Text color={mark ? KINDS[mark].color : undefined}>{mark ? KINDS[mark].glyph : ' '}</Text>
            <Text color="claude" bold>{isCursor && !line.isContinuation ? '›' : ' '}</Text>
            <Text dimColor={!isCursor && !isSelected} inverse={isCursor || isSelected}>{number.padStart(numberWidth)}</Text>
            <Text> </Text>
          </Text>
          <Box flexDirection="row" width={contentWidth}>
            {drawLook(sliceLook(looks[line.row]!, line.start, line.end, line.isContinuation ? hangAt(looks[line.row]!, contentWidth) : 0))}
          </Box>
        </Box>
      )
    })

    return (
      <Box flexDirection="column" height={height} overflow="hidden">
        <Text bold wrap="truncate-end">{header}</Text>
        <Text dimColor={!view.notice} color={view.notice ? 'warning' : undefined} wrap="truncate-end">{status}</Text>
        <Box flexDirection="column" height={viewport}>
          {doc.rows.length === 0 ? <Text dimColor>{doc.source === 'diff' ? `No ${doc.title}.` : 'The response is empty.'}</Text> : lines}
        </Box>
        {previewHeight > 0 && (
          <Box flexDirection="column">
            <Text dimColor>{'─'.repeat(width)}</Text>
            {shown.map((line, index) => (
              <Box key={`preview-${index}`} flexDirection="row" height={1}>
                {drawLook(line)}
              </Box>
            ))}
            {isCut && <Text dimColor>{cutLine}</Text>}
            {draft && (
              <Box flexDirection="column">
                <Input
                  key={DRAFT}
                  autoFocus
                  value={draft.body}
                  placeholder="Enter saves · empty Enter cancels"
                  submitLabel="save"
                  onInput={value => void updateView($, current => setDraftBody(current, value))}
                  onSubmit={value => void submitDraft($, doc, value)}
                />
                <Text dimColor>{draft.kind === 'question' ? 'Answered here from the conversation; not sent with the review.' : 'Esc returns to the prompt; the draft stays.'}</Text>
              </Box>
            )}
          </Box>
        )}
        {hints.map((row, index) => (
          <Box key={`keys-${index}`} flexDirection="row" columnGap={2}>
            {row.map(key => (
              <Button
                key={`key-${key.hotkey}`}
                plain
                hotkey={key.hotkey}
                label={key.label}
                dimColor={!key.onPress}
                onPress={key.onPress ?? (() => void notify($, key.reason ?? 'Not available here.'))}
              />
            ))}
          </Box>
        ))}
      </Box>
    )
  })
}
