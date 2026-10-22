export interface Note {
  path: string
  text: string
  createdAt: number
  updatedAt: number
}

/** The main conversation's agent name; a subagent is `/root/<agentId>`. */
export const ROOT = '/root'
const AGENT_ID = '[A-Za-z0-9_-]+'

export const WRITE_ACTIONS: readonly unknown[] = ['write_file', 'append_to_file']

export function agentName(agentId: string | undefined): string {
  return agentId === undefined ? ROOT : `${ROOT}/${agentId}`
}

/** agentName's inverse: undefined for root, the subagent's ID otherwise. */
export function agentIdOf(name: string): string | undefined {
  if (name === ROOT) return undefined
  const id = name.slice(ROOT.length + 1)
  if (!name.startsWith(`${ROOT}/`) || !new RegExp(`^${AGENT_ID}$`).test(id))
    throw new Error(`Name agents as note paths do: ${ROOT} or ${ROOT}/<agentId>.`)
  return id
}

export const notesPrefix = (agent: string) => `${agent}/notes/`

/** Hashed file names keep long virtual paths inside file-name limits. */
export async function noteFileName(path: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(path))
  return `${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')}.json`
}

export function recentPaths(notes: ReadonlyMap<string, Note>, agent: string): string[] {
  return [...notes.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 5)
    .map((note) => notesPrefix(agent) + note.path)
}

/**
 * Virtual paths: relative belongs to the calling agent; `<agent>/notes[/path]` names any agent
 * of this session. Root wins the ambiguity, so `/root/notes/notes/x` is root's `notes/x`.
 */
export function resolvePath(path: unknown, self: string, required: boolean): { agent: string; path: string } {
  if (typeof path !== 'string' || !path.trim()) {
    if (required) throw new Error('Supply a note path')
    return { agent: self, path: '' }
  }
  let agent = self
  let value = path
  if (path.startsWith('/')) {
    const match = new RegExp(`^(${ROOT}(?:/${AGENT_ID})??)/notes(?:/(.*))?$`).exec(path)
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

export function integer(value: unknown, fallback: number, max: number, min = 1): number {
  return typeof value === 'number' && Number.isInteger(value) ? Math.max(min, Math.min(value, max)) : fallback
}

/** Characters one read or search answers with. */
const RESULT_LIMIT = 32_000

/**
 * Runs one action on one agent's notes. Required fields are present (the caller checks them) and
 * path fields arrive resolved relative to `agent`, whose `<agent>/notes/` prefixes every path shown.
 * Returns the action's JSON payload, and for a write the note the caller must persist.
 */
export function useNotes(
  notes: ReadonlyMap<string, Note>,
  params: Record<string, unknown>,
  now: number,
  agent: string,
): { payload: Record<string, unknown>; write?: Note } {
  const root = notesPrefix(agent)
  const action = params['action']
  if (WRITE_ACTIONS.includes(action)) {
    const path = String(params['path'])
    const previous = notes.get(path)
    const next = action === 'append_to_file' ? (previous?.text ?? '') + String(params['text']) : String(params['text'])
    if (new TextEncoder().encode(next).length > 1_000_000)
      throw new Error('Note exceeds 1 MB. Split it into separate paths.')
    return {
      payload: { path: root + path },
      write: { path, text: next, createdAt: previous?.createdAt ?? now, updatedAt: now },
    }
  }
  if (action === 'read_file') {
    const path = String(params['path'])
    const note = notes.get(path)
    if (!note) return { payload: { path: root + path, file: null } }
    const lines = note.text.split('\n')
    const start = integer(params['start_line'], 1, lines.length + 1)
    const stop = integer(params['stop_line'], lines.length, lines.length)
    let text = ''
    let next = start
    while (next <= stop) {
      const line = lines[next - 1] ?? ''
      if (text.length + line.length > RESULT_LIMIT) {
        if (!text)
          throw new Error(`This note line exceeds ${RESULT_LIMIT} characters. Rewrite it as shorter lines to read it.`)
        break
      }
      text += `${next > start ? '\n' : ''}${line}`
      next++
    }
    return {
      payload: {
        path: root + path,
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
          .map((note) => ({ path: root + note.path, chars: note.text.length, updated_at: note.updatedAt })),
        truncated: files.length > maximum,
      },
    }
  }
  // search_contents
  const query = String(params['query'])
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
    if (found.length >= integer(params['max_files'], 20, 100) || chars + size > RESULT_LIMIT) {
      truncated = true
      break
    }
    found.push({ path: root + note.path, matches, truncated: matches.length < all.length })
    chars += size
  }
  return { payload: { files: found, truncated } }
}
