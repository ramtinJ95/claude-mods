import { sanitize, textWidth, wrap } from './layout'

/** A run of text drawn in one style; colours are theme keys, so they follow the person's theme. */
export type Span = {
  text: string
  color?: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strikethrough?: boolean
  dim?: boolean
}

type Style = Omit<Span, 'text'>

/** Code the engine's highlighter colours by `language`. */
export type CodeText = { text: string; language?: string }

/**
 * How one row draws: styled spans, then code when the row holds some. Its text is what wraps;
 * `hang` starts each wrapped line after the first, as a list item's text lines up under itself.
 */
export type Look = { spans: Span[]; code?: CodeText; hang?: Span }

const span = (text: string, style: Style = {}): Span => ({ text: sanitize(text), ...style })

export function lookText(look: Look): string {
  return look.spans.map(one => one.text).join('') + (look.code?.text ?? '')
}

/** The cells a wrapped line of `look` is indented by at `width`: its hang, at most half the line. */
export const hangAt = (look: Look, width: number): number =>
  Math.min(look.hang ? textWidth(look.hang.text) : 0, Math.floor(width / 2))

/**
 * The part of `look` from `start` to `end` in its text, for one wrapped display line, behind
 * `indent` cells of its hang (the hang's characters are one cell each).
 */
export function sliceLook(look: Look, start: number, end: number, indent = 0): Look {
  const spans: Span[] = indent > 0 && look.hang ? [{ ...look.hang, text: look.hang.text.slice(0, indent) }] : []
  let at = 0
  for (const one of look.spans) {
    const from = Math.max(start, at)
    const to = Math.min(end, at + one.text.length)
    if (from < to) spans.push({ ...one, text: one.text.slice(from - at, to - at) })
    at += one.text.length
  }
  if (!look.code) return { spans }
  const text = look.code.text.slice(Math.max(0, start - at), Math.max(0, end - at))
  return text ? { spans, code: { ...look.code, text } } : { spans }
}

// A backtick fence's info string holds no backtick, so ```a``` on one line is inline code, not a fence.
const FENCE = /^ {0,3}(?:(`{3,})([^`]*)|(~{3,})(.*))$/
const FENCE_END = /^ {0,3}(`{3,}|~{3,})\s*$/
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(\s+#+)?\s*$/
const RULE = /^ {0,3}([-*_])( *\1){2,} *$/
const QUOTE = /^ {0,3}>\s?(.*)$/
const BULLET = /^(\s*)([-*+])\s+(.*)$/
const NUMBERED = /^(\s*)(\d+[.)])\s+(.*)$/

/**
 * Markdown drawn one source line per row, as Claude Code draws a reply: emphasis, inline code,
 * headings, quotes and tables styled, fenced code highlighted by its language, markers hidden.
 * One row per line keeps row indices those of the text the annotations quote.
 */
export function markdownLooks(lines: readonly string[]): Look[] {
  const looks: Look[] = []
  let fence: { marker: string; language: string } | undefined
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    if (fence) {
      const end = FENCE_END.exec(line)?.[1]
      const closes = end !== undefined && end[0] === fence.marker[0] && end.length >= fence.marker.length
      looks.push(closes ? { spans: [] } : codeLine(line, fence.language))
      if (closes) fence = undefined
      continue
    }
    const opener = FENCE.exec(line)
    if (opener) {
      fence = { marker: (opener[1] ?? opener[3])!, language: (opener[2] ?? opener[4] ?? '').trim().split(/\s+/)[0] ?? '' }
      looks.push({ spans: fence.language ? [span(fence.language, { dim: true })] : [] })
      continue
    }
    if (isTableStart(line, lines[index + 1])) {
      let end = index + 2
      while (end < lines.length && isTableRow(lines[end]!)) end++
      looks.push(...tableLooks(lines.slice(index, end)))
      index = end - 1
      continue
    }
    looks.push(blockLook(line))
  }
  return looks
}

function codeLine(line: string, language: string): Look {
  // A fence with no language draws as Claude Code draws one: plain, in the inline-code colour.
  return language ? { spans: [], code: { text: sanitize(line), language } } : { spans: [span(line, { color: 'permission' })] }
}

function blockLook(line: string): Look {
  const heading = HEADING.exec(line)
  if (heading) return { spans: inline(heading[2]!, heading[1]!.length === 1 ? { bold: true, italic: true, underline: true } : { bold: true }) }
  if (RULE.test(line)) return { spans: [span('─'.repeat(24), { dim: true })] }
  const quote = QUOTE.exec(line)
  if (quote) {
    const bar = span('▎ ', { dim: true })
    return { spans: [bar, ...inline(quote[1]!, { italic: true })], hang: bar }
  }
  const bullet = BULLET.exec(line) ?? NUMBERED.exec(line)
  if (bullet) {
    const marker = span(`${bullet[1]}${bullet[2]} `)
    return { spans: [marker, ...inline(bullet[3]!)], hang: span(' '.repeat(textWidth(marker.text))) }
  }
  return { spans: inline(line) }
}

const isTableRow = (line: string) => line.trim().startsWith('|')

/** A header row, then a rule of as many columns: a lone `---` under a row with pipes is not one. */
function isTableStart(line: string, next: string | undefined): boolean {
  return isTableRow(line) && next !== undefined && next.includes('|') && TABLE_RULE.test(next) &&
    cellsOf(next).length === cellsOf(line).length
}

function cellsOf(line: string): string[] {
  const cells: string[] = []
  let cell = ''
  for (let at = 0; at < line.length; at++) {
    const char = line[at]!
    if (char === '\\' && line[at + 1] === '|') {
      cell += '|'
      at++
    } else if (char === '|') {
      cells.push(cell.trim())
      cell = ''
    } else cell += char
  }
  cells.push(cell.trim())
  const trimmed = line.trim()
  return cells.slice(trimmed.startsWith('|') ? 1 : 0, trimmed.endsWith('|') && !trimmed.endsWith('\\|') ? -1 : undefined)
}

/** A table's rows with their columns padded to one width each; the header bold, the rule drawn as a line. */
function tableLooks(lines: readonly string[]): Look[] {
  const rows = lines.map((line, index) => (index === 1 ? undefined : cellsOf(line).map(cell => inline(cell, index === 0 ? { bold: true } : {}))))
  const widths: number[] = []
  for (const row of rows) row?.forEach((cell, column) => { widths[column] = Math.max(widths[column] ?? 0, textWidth(cell.map(one => one.text).join(''))) })
  const divider = span(' │ ', { dim: true })
  return rows.map(row => {
    if (!row) return { spans: [span(widths.map(width => '─'.repeat(width)).join('─┼─'), { dim: true })] }
    const spans: Span[] = []
    widths.forEach((width, column) => {
      const cell = row[column] ?? []
      if (column > 0) spans.push(divider)
      spans.push(...cell, span(' '.repeat(width - textWidth(cell.map(one => one.text).join('')))))
    })
    return { spans }
  })
}

const PUNCTUATION = /[!-/:-@[-`{-~]/
const WORD = /[\p{L}\p{N}]/u

/** Inline markdown as spans: code, strong, emphasis, strikethrough, links and escapes; anything unclosed stays literal. */
export function inline(text: string, style: Style = {}): Span[] {
  const spans: Span[] = []
  let literal = ''
  const flush = () => {
    if (literal) spans.push(span(literal, style))
    literal = ''
  }
  let at = 0
  while (at < text.length) {
    const rest = text.slice(at)
    const char = text[at]!
    if (char === '\\' && PUNCTUATION.test(text[at + 1] ?? '')) {
      literal += text[at + 1]
      at += 2
      continue
    }
    if (char === '`') {
      const code = codeSpan(text, at)
      if (code) {
        flush()
        spans.push(span(code.text, { ...style, color: 'permission' }))
        at = code.end
      } else {
        const run = /^`+/.exec(rest)![0]
        literal += run
        at += run.length
      }
      continue
    }
    const link = /^(!?)\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/.exec(rest)
    if (link) {
      flush()
      spans.push(...inline(link[2] || link[3]!, link[1] ? { ...style, dim: true } : { ...style, underline: true }))
      at += link[0].length
      continue
    }
    const autolink = /^<(https?:\/\/[^>\s]+)>/.exec(rest)
    if (autolink) {
      flush()
      spans.push(span(autolink[1]!, { ...style, underline: true }))
      at += autolink[0].length
      continue
    }
    const opens = ['***', '**', '__', '~~', '*', '_'].filter(one => rest.startsWith(one))
    // The longest delimiter that closes wins: `***a* b**` is strong text holding emphasis.
    const delimiter = opens.find(one => closing(text, one, at) !== undefined) ?? opens[0]
    if (delimiter) {
      const close = closing(text, delimiter, at)
      if (close !== undefined) {
        flush()
        const inner =
          delimiter === '~~' ? { strikethrough: true } : delimiter === '***' ? { bold: true, italic: true } : delimiter.length === 2 ? { bold: true } : { italic: true }
        spans.push(...inline(text.slice(at + delimiter.length, close), { ...style, ...inner }))
        at = close + delimiter.length
        continue
      }
      literal += delimiter
      at += delimiter.length
      continue
    }
    literal += char
    at++
  }
  flush()
  return spans
}

/** A code span opening at `at`: its text and where it ends; undefined when its backticks never close. */
function codeSpan(text: string, at: number): { text: string; end: number } | undefined {
  const run = /^`+/.exec(text.slice(at))![0]
  for (let close = text.indexOf(run, at + run.length); close !== -1; close = text.indexOf(run, close + 1)) {
    // The closing run is exactly as long as the opening one.
    if (text[close - 1] === '`' || text[close + run.length] === '`') continue
    let code = text.slice(at + run.length, close)
    if (code.length > 1 && code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1)
    return { text: code, end: close + run.length }
  }
  return undefined
}

/**
 * Where `delimiter` opened at `at` closes, under CommonMark's flanking rules in short; undefined
 * when it does not. Escapes and code spans close nothing, and a run that opens emphasis of its
 * own is stepped over to its closer, so `*a **b** c*` closes at the last star. A longer closing
 * run closes with its first characters: `**bold***` leaves the last star literal.
 */
function closing(text: string, delimiter: string, at: number): number | undefined {
  const open = at + delimiter.length
  const mark = delimiter[0]!
  if (!text[open] || /\s/.test(text[open]!)) return undefined
  if (mark === '_' && WORD.test(text[at - 1] ?? '')) return undefined
  for (let close = open; close < text.length; ) {
    const char = text[close]!
    if (char === '\\') {
      close += 2
      continue
    }
    if (char === '`') {
      close = codeSpan(text, close)?.end ?? close + /^`+/.exec(text.slice(close))![0].length
      continue
    }
    if (char !== mark) {
      close++
      continue
    }
    const run = /^(.)\1*/.exec(text.slice(close))![0].length
    const canClose = close > open && !/\s/.test(text[close - 1]!) && !(mark === '_' && WORD.test(text[close + run] ?? ''))
    if (canClose && run >= delimiter.length) return close
    const nested = mark.repeat(Math.min(run, 3))
    const inner = canClose ? undefined : closing(text, nested, close)
    close = inner === undefined ? close + run : inner + nested.length
  }
  return undefined
}

export function plainLook(text: string, style: Style = {}): Look {
  return { spans: [span(text, style)] }
}

/** A look cut into display lines of at most `width` cells. */
export function wrapLook(look: Look, width: number): Look[] {
  const indent = hangAt(look, width)
  return wrap(lookText(look), width, true, indent).map(([start, end], part) => sliceLook(look, start, end, part > 0 ? indent : 0))
}
