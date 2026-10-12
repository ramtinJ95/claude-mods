import type { Annotation, AnnotationKind, ReviewDoc, ReviewTarget } from '../types'
import { splitLines } from './layout'
import { KINDS, sortAnnotations, targetRows } from './model'
import type { AskEvent, FileNote } from './nvim'

function range(first: number, last: number): string {
  return first === last ? `line ${first}` : `lines ${first}-${last}`
}

/** Where a pane target points, in words: `Response line 4`. */
export function describeTarget(target: ReviewTarget): string {
  return target.kind === 'overall' ? 'Overall response' : `Response ${range(target.start + 1, target.end + 1)}`
}

const describeFile = (file: string, start: number, end: number) => `\`${file}\` ${range(start, end)}`

function fence(lines: readonly string[], language: string): string[] {
  const longest = Math.max(2, ...lines.map(line => Math.max(0, ...(line.match(/`+/g) ?? []).map(run => run.length))))
  const ticks = '`'.repeat(longest + 1)
  return [`${ticks}${language}`, ...lines, ticks]
}

/** The fence language for a file: its extension, which markdown highlighters mostly know. */
function language(file: string): string {
  const name = file.slice(file.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

const quoteResponse = (lines: readonly string[]) => lines.map(line => `> ${line}`)

type Item = { kind: AnnotationKind; where: string; quote: string[]; body: string }

/** The follow-up prompt for the person to edit and send: one numbered entry per annotation. */
function formatItems(intro: string, items: readonly Item[]): string {
  const output = [intro, '']
  items.forEach((item, index) => {
    const marker = `${index + 1}. `
    const indent = ' '.repeat(marker.length)
    output.push(`${marker}**[${KINDS[item.kind].label.toUpperCase()}]** ${item.where}`, '')
    if (item.quote.length > 0) output.push(...item.quote.map(line => `${indent}${line}`), '')
    output.push(...splitLines(item.body).map(line => `${indent}${line}`))
    if (index < items.length - 1) output.push('')
  })
  return output.join('\n')
}

/** The pane's review of a response. Questions are left out: they were answered in the pane. */
export function formatReview(doc: ReviewDoc, annotations: readonly Annotation[]): string {
  const ordered = sortAnnotations(annotations.filter(one => one.kind !== 'question'))
  if (ordered.length === 0) return ''
  return formatItems(
    'I reviewed your previous response. Please address these annotations.',
    ordered.map(one => ({
      kind: one.kind,
      where: describeTarget(one.target),
      quote: quoteResponse(targetRows(doc, one.target).map(row => row.text)),
      body: one.body,
    })),
  )
}

/** Neovim's review of the working diff, overall comments first, the rest in the order sent. Questions are left out. */
export function formatFileReview(title: string, notes: readonly FileNote[]): string {
  const kept = notes.filter(one => one.kind !== 'question')
  if (kept.length === 0) return ''
  const ordered = [...kept.filter(one => one.file === undefined), ...kept.filter(one => one.file !== undefined)]
  return formatItems(
    `I reviewed the ${title}. Please address these annotations.`,
    ordered.map(one => ({
      kind: one.kind,
      where: one.file === undefined ? 'The changes as a whole' : describeFile(one.file, one.start ?? 1, one.end ?? one.start ?? 1),
      quote: one.file !== undefined && one.lines ? fence(one.lines, language(one.file)) : [],
      body: one.body,
    })),
  )
}

const ANSWER_RULES =
  'Answer it from what you know of this conversation and the excerpt below. You cannot use tools here. Answer in plain text, concisely; say so when you would need to look something up to be sure.'

/** What `$.model.fork` is asked for a pane question: the lines it is about and the question. */
export function formatQuestion(doc: ReviewDoc, annotation: Annotation): string {
  const quoted = quoteResponse(targetRows(doc, annotation.target).map(row => row.text))
  return [
    `I am reviewing your previous response in a side pane and have a question. ${ANSWER_RULES}`,
    '',
    `Location: ${describeTarget(annotation.target)}`,
    ...(quoted.length > 0 ? ['', 'The lines the question is about:', ...quoted] : []),
    '',
    `Question: ${annotation.body}`,
  ].join('\n')
}

/** What `$.model.fork` is asked for a question from Neovim: the file around the lines, the lines and the question. */
export function formatFileQuestion(title: string, ask: AskEvent): string {
  const lang = language(ask.file)
  const contextEnd = ask.context.start + ask.context.lines.length - 1
  const isWider = ask.context.start !== ask.start || contextEnd !== ask.end
  return [
    `I am reviewing the ${title} in this repository in Neovim and have a question. ${ANSWER_RULES}`,
    '',
    `Location: ${describeFile(ask.file, ask.start, ask.end)}`,
    ...(isWider ? ['', `The file around them (${range(ask.context.start, contextEnd)}, as it is now):`, ...fence(ask.context.lines, lang)] : []),
    '',
    'The lines the question is about:',
    ...fence(ask.lines, lang),
    '',
    `Question: ${ask.body}`,
  ].join('\n')
}
