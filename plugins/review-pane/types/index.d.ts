/** One logical line under review: a diff line, a file or hunk header, or a line of a response. */
export type Row = {
  kind: 'file' | 'hunk' | 'add' | 'del' | 'ctx' | 'note' | 'text'
  text: string
  /** Index into `ReviewDoc.files`; absent on a response's rows. */
  file?: number
  oldLine?: number
  newLine?: number
}

export type DiffBase = 'head' | 'merge-base'

export type ReviewDoc = {
  source: 'diff' | 'response'
  /** What the rows are, for the pane's header and the prepared prompt. */
  title: string
  base?: DiffBase
  files: string[]
  rows: Row[]
}

export type AnnotationKind = 'comment' | 'suggestion' | 'issue' | 'question'

export type ReviewTarget = { kind: 'overall' } | { kind: 'rows'; start: number; end: number }

/** Where a question's inline answer stands; the token names the ask, so a late answer to an older one is dropped. */
export type Reply =
  | { state: 'pending'; token: string }
  | { state: 'answered'; text: string }
  | { state: 'failed'; error: string }

export type Annotation = {
  id: string
  target: ReviewTarget
  kind: AnnotationKind
  body: string
  /** A question's answer; null until asked, and again once the question is edited. */
  reply: Reply | null
}

export type ReviewDraft = {
  kind: AnnotationKind
  target: ReviewTarget
  editingId?: string
  /** The text typed so far, kept so a redraw or a resumed review does not lose it. */
  body: string
}

export type ReviewMode =
  | { kind: 'browse' }
  | { kind: 'select'; anchor: number }
  | { kind: 'draft'; draft: ReviewDraft }
  /** The annotation preview takes most of the pane and the keys scroll it. */
  | { kind: 'read'; previewOffset: number }
  | { kind: 'confirmDiscard' }

export type ReviewView = {
  cursor: number
  /** The first display row drawn. */
  offset: number
  mode: ReviewMode
  annotations: Annotation[]
  activeId?: string
  /** Numbers the next annotation's id, so ids stay unique after a delete. */
  nextId: number
  /** A one-line message for the person, cleared by their next key. */
  notice?: string
}

declare module 'claude-code' {
  interface PluginState {
    'review-pane': { doc: ReviewDoc | null; view: ReviewView | null }
  }
}
