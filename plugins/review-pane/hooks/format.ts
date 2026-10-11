import type { Annotation, ReviewDoc, ReviewTarget, Row } from '../types'
import { splitLines } from './layout'
import { KINDS, hunkContext, sortAnnotations, targetRows } from './model'

function range(numbers: number[]): string | undefined {
  if (numbers.length === 0) return undefined
  const first = Math.min(...numbers)
  const last = Math.max(...numbers)
  return first === last ? `line ${first}` : `lines ${first}-${last}`
}

/**
 * Where a target points, in words: `src/a.ts lines 3-9`, `Response line 4`.
 * `path` dresses the file's path, as code in a prompt and plain in the pane.
 */
export function describeTarget(doc: ReviewDoc, target: ReviewTarget, path = (name: string) => name): string {
  if (target.kind === 'overall') return doc.source === 'diff' ? 'The changes as a whole' : 'Overall response'
  if (doc.source === 'response') return `Response ${range([target.start + 1, target.end + 1])}`
  const rows = targetRows(doc, target)
  const file = path(doc.files[rows[0]?.file ?? -1] ?? 'unknown file')
  if (rows.every(row => row.kind === 'file')) return `${file} (whole file)`
  const added = range(rows.flatMap(row => (row.newLine === undefined ? [] : [row.newLine])))
  const removed = range(rows.flatMap(row => (row.kind === 'del' && row.oldLine !== undefined ? [row.oldLine] : [])))
  const parts = [added, removed && `removed ${removed}`].filter(Boolean)
  return `${file} ${parts.join(', ') || 'header'}`
}

const asCode = (name: string) => `\`${name}\``

function fence(lines: readonly string[], language: string): string[] {
  const longest = Math.max(2, ...lines.map(line => Math.max(0, ...(line.match(/`+/g) ?? []).map(run => run.length))))
  const ticks = '`'.repeat(longest + 1)
  return [`${ticks}${language}`, ...lines, ticks]
}

function quote(doc: ReviewDoc, rows: readonly Row[]): string[] {
  const lines = rows.filter(row => row.kind !== 'file').map(row => row.text)
  if (lines.length === 0) return []
  return doc.source === 'diff' ? fence(lines, 'diff') : lines.map(line => `> ${line}`)
}

/**
 * The follow-up prompt for the person to edit and send. Questions are left
 * out: they were answered in the pane.
 */
export function formatReview(doc: ReviewDoc, annotations: readonly Annotation[]): string {
  const ordered = sortAnnotations(annotations.filter(one => one.kind !== 'question'))
  if (ordered.length === 0) return ''
  const intro =
    doc.source === 'diff'
      ? `I reviewed the ${doc.title}. Please address these annotations.`
      : 'I reviewed your previous response. Please address these annotations.'
  const output = [intro, '']
  ordered.forEach((annotation, index) => {
    const marker = `${index + 1}. `
    const indent = ' '.repeat(marker.length)
    output.push(`${marker}**[${KINDS[annotation.kind].label.toUpperCase()}]** ${describeTarget(doc, annotation.target, asCode)}`, '')
    const quoted = quote(doc, targetRows(doc, annotation.target))
    if (quoted.length > 0) output.push(...quoted.map(line => `${indent}${line}`), '')
    output.push(...splitLines(annotation.body).map(line => `${indent}${line}`))
    if (index < ordered.length - 1) output.push('')
  })
  return output.join('\n')
}

/** What `$.model.fork` is asked for a question: the hunks it touches and the question. */
export function formatQuestion(doc: ReviewDoc, annotation: Annotation): string {
  const contextRows = hunkContext(doc, annotation.target)
  const askedRows = targetRows(doc, annotation.target)
  const context = quote(doc, contextRows)
  const subject = doc.source === 'diff' ? `the ${doc.title} in this repository` : 'your previous response'
  return [
    `I am reviewing ${subject} in a side pane and have a question. Answer it from what you know of this conversation and the excerpt below. You cannot use tools here. Answer in plain text, concisely; say so when you would need to look something up to be sure.`,
    '',
    `Location: ${describeTarget(doc, annotation.target, asCode)}`,
    ...(context.length > 0 ? ['', 'Context:', ...context] : []),
    ...(askedRows.length > 0 && contextRows.length !== askedRows.length ? ['', 'The lines the question is about:', ...quote(doc, askedRows)] : []),
    '',
    `Question: ${annotation.body}`,
  ].join('\n')
}
