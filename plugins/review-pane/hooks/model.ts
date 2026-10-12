import type {
  Annotation,
  AnnotationKind,
  Reply,
  ReviewDoc,
  ReviewTarget,
  ReviewView,
  Row,
} from '../types'

/** How each kind of annotation is named and marked, in the order the gutter prefers one mark over another. */
export const KINDS: Record<AnnotationKind, { label: string; glyph: string; color: string }> = {
  issue: { label: 'Issue', glyph: '!', color: 'error' },
  suggestion: { label: 'Suggestion', glyph: '+', color: 'success' },
  question: { label: 'Question', glyph: '?', color: 'warning' },
  comment: { label: 'Comment', glyph: '•', color: 'suggestion' },
}

export function createView(): ReviewView {
  return { cursor: 0, offset: 0, mode: { kind: 'browse' }, annotations: [], nextId: 1 }
}

/** Whether the review holds work a reload would lose: annotations or an open draft. */
export function hasWork(view: ReviewView): boolean {
  return view.annotations.length > 0 || view.mode.kind === 'draft'
}

export function clearNotice(view: ReviewView): ReviewView {
  const { notice: _, ...rest } = view
  return rest
}

function clearActive(view: ReviewView): ReviewView {
  const { activeId: _, ...rest } = view
  return rest
}

function clampRow(doc: ReviewDoc, row: number): number {
  return Math.max(0, Math.min(doc.rows.length - 1, Math.trunc(row)))
}

export function currentTarget(view: ReviewView): ReviewTarget {
  const anchor = view.mode.kind === 'select' ? view.mode.anchor : view.cursor
  return { kind: 'rows', start: Math.min(anchor, view.cursor), end: Math.max(anchor, view.cursor) }
}

/** Why a target cannot be annotated, or undefined when it can. */
function targetProblem(doc: ReviewDoc, target: ReviewTarget): string | undefined {
  if (target.kind === 'overall') return undefined
  if (doc.rows.length === 0) return 'Nothing to annotate'
  return undefined
}

/** Overall annotations first, then by position; the sort is stable, so ties keep the order they were made in. */
export function sortAnnotations(annotations: readonly Annotation[]): Annotation[] {
  return [...annotations].sort((left, right) => {
    if (left.target.kind !== right.target.kind) return left.target.kind === 'overall' ? -1 : 1
    if (left.target.kind === 'rows' && right.target.kind === 'rows') {
      return left.target.start - right.target.start || left.target.end - right.target.end
    }
    return 0
  })
}

export function annotationsAtRow(annotations: readonly Annotation[], row: number): Annotation[] {
  return sortAnnotations(
    annotations.filter(one => one.target.kind === 'rows' && one.target.start <= row && one.target.end >= row),
  )
}

export function activeAnnotation(view: ReviewView): Annotation | undefined {
  return view.annotations.find(one => one.id === view.activeId) ?? annotationsAtRow(view.annotations, view.cursor)[0]
}

export function moveTo(doc: ReviewDoc, view: ReviewView, row: number): ReviewView {
  if (view.mode.kind !== 'browse' && view.mode.kind !== 'select') return view
  return { ...clearActive(view), cursor: clampRow(doc, row) }
}

export function toggleSelection(view: ReviewView): ReviewView {
  if (view.mode.kind === 'browse') return { ...clearActive(view), mode: { kind: 'select', anchor: view.cursor } }
  if (view.mode.kind === 'select') return { ...view, mode: { kind: 'browse' } }
  return view
}

export function toggleReading(view: ReviewView): ReviewView {
  if (view.mode.kind === 'browse') return { ...view, mode: { kind: 'read', previewOffset: 0 } }
  if (view.mode.kind === 'read') return { ...view, mode: { kind: 'browse' } }
  return view
}

/** Scrolls the preview in reading mode, within `[0, max]`. */
export function scrollPreview(view: ReviewView, by: number, max: number): ReviewView {
  if (view.mode.kind !== 'read') return view
  return { ...view, mode: { kind: 'read', previewOffset: Math.max(0, Math.min(max, view.mode.previewOffset + by)) } }
}

export function beginDraft(
  doc: ReviewDoc,
  view: ReviewView,
  kind: AnnotationKind,
  target: ReviewTarget = currentTarget(view),
): ReviewView {
  if (view.mode.kind !== 'browse' && view.mode.kind !== 'select') return view
  const problem = targetProblem(doc, target)
  if (problem) return { ...view, notice: problem }
  return { ...clearActive(view), mode: { kind: 'draft', draft: { kind, target, body: '' } } }
}

export function setDraftBody(view: ReviewView, body: string): ReviewView {
  return view.mode.kind === 'draft' ? { ...view, mode: { kind: 'draft', draft: { ...view.mode.draft, body } } } : view
}

/** Saves the open draft; an empty body cancels it. Answers the saved annotation. */
export function saveDraft(view: ReviewView, body: string): { view: ReviewView; saved?: Annotation } {
  if (view.mode.kind !== 'draft') return { view }
  if (!body.trim()) return { view: { ...view, mode: { kind: 'browse' } } }
  const { kind, target, editingId } = view.mode.draft
  // An edit drops the answer to the previous text.
  const saved: Annotation = { id: editingId ?? `annotation-${view.nextId}`, kind, target, body, reply: null }
  const annotations = editingId
    ? view.annotations.map(one => (one.id === editingId ? saved : one))
    : [...view.annotations, saved]
  return {
    view: { ...view, annotations, activeId: saved.id, nextId: editingId ? view.nextId : view.nextId + 1, mode: { kind: 'browse' } },
    saved,
  }
}

export function editAnnotation(view: ReviewView, id: string): ReviewView {
  if (view.mode.kind !== 'browse') return view
  const annotation = view.annotations.find(one => one.id === id)
  if (!annotation) return view
  return {
    ...view,
    activeId: id,
    mode: { kind: 'draft', draft: { kind: annotation.kind, target: annotation.target, editingId: id, body: annotation.body } },
  }
}

export function deleteAnnotation(view: ReviewView, id: string): ReviewView {
  if (view.mode.kind !== 'browse') return view
  return { ...clearActive(view), annotations: view.annotations.filter(one => one.id !== id) }
}

export function navigateAnnotation(view: ReviewView, delta: 1 | -1): ReviewView {
  if (view.mode.kind !== 'browse' || view.annotations.length === 0) return view
  const ordered = sortAnnotations(view.annotations)
  const index = ordered.findIndex(one => one.id === view.activeId)
  const base = index < 0 ? (delta > 0 ? -1 : 0) : index
  const next = ordered[(base + delta + ordered.length) % ordered.length]!
  return { ...view, activeId: next.id, cursor: next.target.kind === 'rows' ? next.target.start : view.cursor }
}

/**
 * Sets a question's reply. Given `token`, only while the question still waits
 * on that ask: an edit, a new ask or a new review drops a late answer.
 */
export function setReply(view: ReviewView, id: string, reply: Reply, token?: string): ReviewView {
  return {
    ...view,
    annotations: view.annotations.map(one =>
      one.id === id && (token === undefined || (one.reply?.state === 'pending' && one.reply.token === token))
        ? { ...one, reply }
        : one,
    ),
  }
}

/** The rows a target quotes. */
export function targetRows(doc: ReviewDoc, target: ReviewTarget): Row[] {
  if (target.kind === 'overall') return []
  return doc.rows.slice(target.start, target.end + 1)
}
