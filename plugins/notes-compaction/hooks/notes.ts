export interface Note {
  path: string
  text: string
  createdAt: number
  updatedAt: number
}

/** Hashed file names keep long virtual paths inside file-name limits. */
export async function noteFileName(path: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(path))
  return `${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')}.json`
}

/** The main conversation's agent name; a subagent is `/root/<agentId>`. */
export const ROOT = '/root'

export function agentName(agentId: string | undefined): string {
  return agentId === undefined ? ROOT : `${ROOT}/${agentId}`
}

export function recentPaths(notes: ReadonlyMap<string, Note>, agent: string): string[] {
  return [...notes.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 5)
    .map((note) => `${agent}/notes/${note.path}`)
}

/**
 * Virtual paths: relative belongs to the calling agent; `<agent>/notes[/path]` names any agent
 * of this session. The shortest agent prefix wins, so `/root/notes/notes/x` is root's `notes/x`.
 */
export function resolvePath(path: unknown, self: string, required: boolean): { agent: string; path: string } {
  if (typeof path !== 'string' || !path.trim()) {
    if (required) throw new Error('Supply a note path')
    return { agent: self, path: '' }
  }
  let agent = self
  let value = path
  if (path.startsWith('/')) {
    const match = /^(\/root(?:\/[A-Za-z0-9_-]+)*?)\/notes(?:\/(.*))?$/.exec(path)
    if (!match) throw new Error("Use a relative path for your own notes, or <agent>/notes/<path> for another agent's")
    agent = match[1]!
    value = match[2] ?? ''
  }
  if (
    (required && !value) ||
    value.split('/').some((part) => part === '..' || part === '.') ||
    /[\0\r\n]/.test(value)
  )
    throw new Error('Use a virtual note path without dot segments or control characters')
  return { agent, path: value }
}

function integer(value: unknown, fallback: number, max: number): number {
  return typeof value === 'number' && Number.isInteger(value) ? Math.max(1, Math.min(value, max)) : fallback
}

/**
 * Runs one action on one agent's notes. Path fields arrive resolved relative to that agent
 * (resolvePath); `root` (`<agent>/notes/`) prefixes every path shown back.
 * Returns the action's JSON payload, and for a write the note the caller must persist.
 */
export function useNotes(
  notes: ReadonlyMap<string, Note>,
  params: Record<string, unknown>,
  now: number,
  root: string,
): { payload: Record<string, unknown>; write?: Note } {
  const action = params['action']
  if (action === 'write_file' || action === 'append_to_file') {
    const path = String(params['path'])
    const text = params['text']
    if (typeof text !== 'string') throw new Error('Supply note text')
    const previous = notes.get(path)
    const next = action === 'append_to_file' ? (previous?.text ?? '') + text : text
    if (new TextEncoder().encode(next).length > 1_000_000)
      throw new Error('Note exceeds 1 MB. Split it into separate paths.')
    return {
      payload: { path: `${root}${path}`, chars: next.length },
      write: { path, text: next, createdAt: previous?.createdAt ?? now, updatedAt: now },
    }
  }
  if (action === 'read_file') {
    const path = String(params['path'])
    const note = notes.get(path)
    if (!note) return { payload: { path: `${root}${path}`, file: null } }
    const lines = note.text.split('\n')
    const start = integer(params['start_line'], 1, lines.length + 1)
    const stop = integer(params['stop_line'], lines.length, lines.length)
    let text = ''
    let next = start
    while (next <= stop) {
      const line = lines[next - 1] ?? ''
      if (text.length + line.length > 32_000) {
        if (!text) throw new Error('This note line exceeds 32000 characters. Rewrite it as shorter lines to read it.')
        break
      }
      text += `${next > start ? '\n' : ''}${line}`
      next++
    }
    return {
      payload: {
        path: `${root}${path}`,
        text,
        start_line: start,
        total_lines: lines.length,
        ...(next <= stop ? { next_start_line: next } : {}),
      },
    }
  }
  if (action === 'list_files_by_prefix') {
    const prefix = String(params['prefix'] ?? '')
    const files = [...notes.values()].filter((note) => note.path.startsWith(prefix))
    const by = params['file_order_by']
    files.sort((a, b) =>
      by === 'created_at'
        ? a.createdAt - b.createdAt
        : by === 'updated_at'
          ? a.updatedAt - b.updatedAt
          : a.path.localeCompare(b.path),
    )
    if (params['file_order'] === 'descending') files.reverse()
    const maximum = integer(params['max_results'], 100, 100)
    return {
      payload: {
        files: files
          .slice(0, maximum)
          .map((note) => ({ path: `${root}${note.path}`, chars: note.text.length, updated_at: note.updatedAt })),
        truncated: files.length > maximum,
      },
    }
  }
  const query = params['query']
  if (action !== 'search_contents' || typeof query !== 'string' || !query)
    throw new Error('Supply a nonempty search query')
  const prefix = String(params['path_prefix'] ?? '')
  const files = [...notes.values()].filter((note) => note.path.startsWith(prefix))
  if (params['recent_file_first'] === true) files.sort((a, b) => b.updatedAt - a.updatedAt)
  const found: { path: string; matches: { line: number; text: string }[]; truncated: boolean }[] = []
  let chars = 0
  let truncated = false
  for (const note of files) {
    const all = note.text
      .split('\n')
      .flatMap((line, i) => (line.includes(query) ? [{ line: i + 1, text: line.slice(0, 1000) }] : []))
    if (!all.length) continue
    const matches = all.slice(0, integer(params['max_matches_per_file'], 10, 100))
    const size = JSON.stringify(matches).length
    if (found.length >= integer(params['max_files'], 20, 100) || chars + size > 32_000) {
      truncated = true
      break
    }
    found.push({ path: `${root}${note.path}`, matches, truncated: matches.length < all.length })
    chars += size
  }
  return { payload: { files: found, truncated } }
}
