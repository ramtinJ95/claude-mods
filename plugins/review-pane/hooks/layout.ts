import type { Row } from '../types'

const TAB = '    '

/** Tabs as spaces and control characters made visible, so a row draws as one line of known width. */
export function sanitize(text: string): string {
  let out = ''
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (char === '\t') out += TAB
    else if (code === 0x7f) out += '␡'
    else if (code < 0x20) out += String.fromCodePoint(0x2400 + code)
    else if ((code >= 0x80 && code <= 0x9f) || code === 0x061c || code === 0x200e || code === 0x200f || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069))
      out += `\\u{${code.toString(16).toUpperCase()}}`
    else out += char
  }
  return out
}

/** Cells a code point takes: two for the wide East Asian ranges and emoji, else one. */
function cells(code: number): number {
  return (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
    ? 2
    : 1
}

/** Splits text into chunks of at most `width` cells; an empty text is one empty chunk. */
export function wrap(text: string, width: number): string[] {
  const room = Math.max(1, width)
  const chunks: string[] = []
  let chunk = ''
  let used = 0
  for (const char of text) {
    const size = cells(char.codePointAt(0) ?? 0)
    if (used + size > room && chunk !== '') {
      chunks.push(chunk)
      chunk = ''
      used = 0
    }
    chunk += char
    used += size
  }
  chunks.push(chunk)
  return chunks
}

export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/)
}

type DisplayRow = { row: number; text: string; isContinuation: boolean }

/** The rows as drawn at one width, and where each logical row's first display row is. */
export type Layout = { display: DisplayRow[]; first: number[] }

export function layoutRows(rows: readonly Row[], width: number): Layout {
  const display: DisplayRow[] = []
  const first: number[] = []
  rows.forEach((row, index) => {
    first.push(display.length)
    wrap(sanitize(row.text), width).forEach((text, part) => display.push({ row: index, text, isContinuation: part > 0 }))
  })
  return { display, first }
}

function rowSpan({ display, first }: Layout, row: number): [number, number] {
  const start = first[row] ?? 0
  return [start, (first[row + 1] ?? display.length) - 1]
}

/**
 * The first display row to draw so the cursor's row shows, moving `offset` as
 * little as it can. A row taller than the view keeps the view while any of it
 * shows, so half pages can walk through it.
 */
export function visibleOffset(layout: Layout, cursor: number, offset: number, height: number): number {
  const { display } = layout
  if (display.length === 0) return 0
  const room = Math.max(1, height)
  const [start, end] = rowSpan(layout, cursor)
  const max = Math.max(0, display.length - room)
  let next = Math.max(0, Math.min(Math.trunc(offset), max))
  if (end - start + 1 <= room) {
    if (start < next) next = start
    else if (end >= next + room) next = end - room + 1
  } else if (end < next || start >= next + room) {
    next = start
  }
  return Math.min(next, max)
}

/** Half a page down (`direction` 1) or up (-1): the cursor and the view move together. */
export function halfPage(
  layout: Layout,
  cursor: number,
  offset: number,
  height: number,
  direction: 1 | -1,
): { cursor: number; offset: number } {
  const { display } = layout
  if (display.length === 0) return { cursor, offset }
  const room = Math.max(1, height)
  const distance = Math.max(1, Math.floor(room / 2))
  const max = Math.max(0, display.length - room)
  const [start, end] = rowSpan(layout, cursor)
  const from = direction < 0 ? Math.min(end, offset + room - 1) : Math.max(start, offset)
  const scrolled = Math.max(0, Math.min(max, offset + direction * distance))
  const land = (target: number) => {
    const next = display[Math.max(0, Math.min(display.length - 1, target))]!.row
    return { cursor: next, offset: visibleOffset(layout, next, scrolled, height) }
  }
  const paged = land(from + direction * distance)
  // Paging that would leave the cursor and view where they were (the end of the document, or a row the
  // view snaps back to whole) steps off the cursor's row instead.
  if (paged.cursor === cursor && paged.offset === offset) return land(direction > 0 ? end + 1 : start - 1)
  return paged
}
