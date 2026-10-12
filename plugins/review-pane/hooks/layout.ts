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

export function textWidth(text: string): number {
  let width = 0
  for (const char of text) width += cells(char.codePointAt(0) ?? 0)
  return width
}

/**
 * Cuts text into lines of at most `width` cells, as `[start, end)` offsets; an empty text is one
 * empty line. With `byWords` a line breaks at its last space, as prose wraps, and the space it
 * breaks at is drawn on neither line. Lines after the first leave `hang` cells for an indent.
 */
export function wrap(text: string, width: number, byWords = false, hang = 0): Array<[number, number]> {
  let room = Math.max(1, width)
  const lines: Array<[number, number]> = []
  let start = 0
  let used = 0
  let space = -1
  for (let at = 0; at < text.length; ) {
    const code = text.codePointAt(at) ?? 0
    const length = code > 0xffff ? 2 : 1
    const size = cells(code)
    if (used + size > room && at > start) {
      room = Math.max(1, width - hang)
      if (byWords && code === 0x20) {
        lines.push([start, at])
        start = at + 1
        used = 0
        space = -1
        at += 1
        continue
      }
      // The word carried down must fit beside the indent, or the line is cut where it stands.
      const breaksAtSpace =
        byWords && space > start && text.slice(start, space).trim() !== '' && textWidth(text.slice(space + 1, at)) + size <= room
      lines.push([start, breaksAtSpace ? space : at])
      start = breaksAtSpace ? space + 1 : at
      used = textWidth(text.slice(start, at))
      space = -1
    }
    if (code === 0x20) space = at
    used += size
    at += length
  }
  lines.push([start, text.length])
  return lines
}

export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/)
}

/** One wrapped line: its row, and where in the row's drawn text it starts and ends. */
type DisplayRow = { row: number; start: number; end: number; isContinuation: boolean }

/** The rows as drawn at one width, and where each logical row's first display row is. */
export type Layout = { display: DisplayRow[]; first: number[] }

/** Wraps each row's drawn text (sanitized, markers already styled away) at `width`, leaving its `hang`. */
export function layoutRows(rows: ReadonlyArray<{ text: string; hang: number }>, width: number, byWords: boolean): Layout {
  const display: DisplayRow[] = []
  const first: number[] = []
  rows.forEach(({ text, hang }, index) => {
    first.push(display.length)
    wrap(text, width, byWords, hang).forEach(([start, end], part) => display.push({ row: index, start, end, isContinuation: part > 0 }))
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
