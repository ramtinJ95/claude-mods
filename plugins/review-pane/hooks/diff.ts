/** One line of `git diff`: a file or hunk header, or a line numbered on the old and new side. */
export type DiffRow = {
  kind: 'file' | 'hunk' | 'add' | 'del' | 'ctx' | 'note'
  text: string
  /** Index into the parsed `files`. */
  file: number
  oldLine?: number
  newLine?: number
}

/**
 * What `parseDiff` reads is pinned against user config that changes its shape:
 * quoted paths and blank context lines without their space (GIT_CONFIG), then
 * colour, external diff tools and path prefixes (DIFF_FLAGS).
 */
export const GIT_CONFIG = ['-c', 'core.quotepath=off', '-c', 'diff.suppressBlankEmpty=false'] as const

export const DIFF_FLAGS = [
  '--no-color',
  '--no-ext-diff',
  '--no-relative',
  '--src-prefix=a/',
  '--dst-prefix=b/',
  '-M',
] as const

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 }

/** Decodes a path git quoted C-style (it does for tabs, quotes and backslashes even with core.quotepath off). */
function unquote(path: string): string {
  if (!(path.length >= 2 && path.startsWith('"') && path.endsWith('"'))) return path
  const bytes: number[] = []
  const chars = Array.from(path.slice(1, -1))
  const encoder = new TextEncoder()
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index]!
    if (char !== '\\') {
      bytes.push(...encoder.encode(char))
      continue
    }
    const next = chars[index + 1] ?? ''
    const octal = /^[0-7]{3}/.exec(chars.slice(index + 1, index + 4).join(''))
    if (octal) {
      bytes.push(parseInt(octal[0], 8))
      index += 3
    } else {
      bytes.push(ESCAPES[next] ?? next.charCodeAt(0))
      index += 1
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

const QUOTED = '"(?:[^"\\\\]|\\\\.)*"'
const QUOTED_HEADER = new RegExp(`^(${QUOTED}) (${QUOTED})$`)

function stripPrefix(path: string): string {
  const plain = unquote(path.replace(/\t.*$/, ''))
  if (plain === '/dev/null') return plain
  return plain.replace(/^[ab]\//, '')
}

/** The path a `diff --git` header names, where it says so unambiguously. */
function headerPath(rest: string): string | undefined {
  const quoted = QUOTED_HEADER.exec(rest)
  if (quoted) return stripPrefix(quoted[2]!)
  return /^a\/(.+) b\/\1$/.exec(rest)?.[1]
}

/**
 * Parses `git diff` output (with DIFF_FLAGS) into rows: a `file` row per file,
 * a `hunk` row per hunk, and its lines numbered on the old and new side.
 */
export function parseDiff(text: string): { files: string[]; rows: DiffRow[] } {
  const files: string[] = []
  const rows: DiffRow[] = []
  let file = -1
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  let notes: string[] = []
  let oldPath = ''
  /** The file's path once known; its row opens at the first line that belongs to it. */
  let pending: string | undefined

  const flush = () => {
    if (file >= 0 || pending === undefined) return
    file = files.length
    files.push(pending)
    const status = notes.length > 0 ? ` (${notes.join(', ')})` : ''
    rows.push({ kind: 'file', text: `${pending}${status}`, file })
  }

  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush()
      inHunk = false
      notes = []
      oldPath = ''
      file = -1
      pending = headerPath(line.slice('diff --git '.length))
      continue
    }
    if (!inHunk) {
      if (line.startsWith('new file mode')) notes.push('new file')
      else if (line.startsWith('deleted file mode')) notes.push('deleted')
      else if (line.startsWith('new mode ')) notes.push('mode changed')
      else if (line.startsWith('rename from ')) notes.push(`renamed from ${unquote(line.slice('rename from '.length))}`)
      else if (line.startsWith('rename to ')) pending = unquote(line.slice('rename to '.length))
      else if (line.startsWith('--- ')) oldPath = stripPrefix(line.slice(4))
      else if (line.startsWith('+++ ')) {
        const newPath = stripPrefix(line.slice(4))
        pending = newPath === '/dev/null' ? oldPath : newPath
        flush()
      } else if (line.startsWith('Binary files ')) {
        const named = / and (.*) differ$/.exec(line)?.[1]
        pending ??= named === undefined ? 'binary file' : stripPrefix(named)
        flush()
        rows.push({ kind: 'note', text: 'Binary file differs', file })
      }
    }
    const hunk = HUNK.exec(line)
    if (hunk && file >= 0) {
      inHunk = true
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      rows.push({ kind: 'hunk', text: line, file })
      continue
    }
    if (!inHunk || file < 0) continue
    if (line.startsWith('+')) rows.push({ kind: 'add', text: line, file, newLine: newLine++ })
    else if (line.startsWith('-')) rows.push({ kind: 'del', text: line, file, oldLine: oldLine++ })
    else if (line.startsWith(' ')) rows.push({ kind: 'ctx', text: line, file, oldLine: oldLine++, newLine: newLine++ })
    else if (line.startsWith('\\')) rows.push({ kind: 'note', text: line, file })
  }
  flush()
  return { files, rows }
}
