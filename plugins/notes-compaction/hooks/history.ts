import type { SessionMessage } from 'claude-code'
import { integer } from './notes.ts'
import { promptAfterMarker, windowMarker } from './windows.ts'

interface HistoryItem {
  window_id: string
  item_id: string
  role: 'user' | 'assistant' | 'tool'
  tool_name?: string
  content: string
}

/** Characters one read or listing answers with. */
const RESULT_LIMIT = 8000

/** FNV-1a: a short, synchronous content key. */
function hash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** $.session.messages() answers the newest 4096 messages; past that, positions shift and old rows drop. */
export const MESSAGE_LIMIT = 4096

/**
 * The session's own transcript is the archive: compaction replaces what the model reads,
 * not what $.session.messages() returns. Item IDs survive the sliding message limit:
 * tool use IDs where a row has one, otherwise a content key.
 */
export function useHistory(
  messages: readonly SessionMessage[],
  params: Record<string, unknown>,
  currentWindowId: string,
): Record<string, unknown> {
  const coverage =
    messages.length >= MESSAGE_LIMIT ? { coverage: `Newest ${MESSAGE_LIMIT} messages only; older rows are unavailable` } : {}
  return { ...answer(messages, params, currentWindowId), ...coverage }
}

function answer(
  messages: readonly SessionMessage[],
  params: Record<string, unknown>,
  currentWindowId: string,
): Record<string, unknown> {
  // Duplicate content is numbered within its window, so one window's rows never renumber another's.
  const seen = new Map<string, number>()
  const stableId = (key: string) => {
    const n = seen.get(`${windowId}:${key}`) ?? 0
    seen.set(`${windowId}:${key}`, n + 1)
    return n ? `${key}~${n}` : key
  }
  // Rows before the first boundary in view belong to the window it names as previous, or to its own window when it
  // only repeats that window's marker after Claude Code's compaction; with no boundary in view, every row belongs to
  // the current window.
  const markers = messages.map(windowMarker)
  const first = markers.find((marker) => marker !== undefined)
  let windowId = first ? (first.repeated ? first.current : (first.previous ?? currentWindowId)) : currentWindowId
  const windows = new Map<string, HistoryItem[]>([[windowId, []]])
  const toolNames = new Map<string, string>()
  for (const [index, message] of messages.entries()) {
    const boundary = markers[index]
    if (boundary) {
      windowId = boundary.current
      if (!windows.has(windowId)) windows.set(windowId, [])
      // A window that waited for the user carries its marker on their next prompt.
      const prompt = promptAfterMarker(message.text)
      if (prompt)
        windows.get(windowId)!.push({ window_id: windowId, item_id: stableId(`u-${hash(prompt)}`), role: 'user', content: prompt })
      continue
    }
    const items = windows.get(windowId)!
    if (message.role === 'assistant') {
      for (const use of message.toolUses) toolNames.set(use.tool_use_id, use.tool)
      const calls = message.toolUses.map((use) => JSON.stringify({ tool: use.tool, arguments: use.input }))
      const content = [message.text, ...calls].filter(Boolean).join('\n')
      items.push({
        window_id: windowId,
        item_id: stableId(message.toolUses[0] ? `call-${message.toolUses[0].tool_use_id}` : `a-${hash(content)}`),
        role: 'assistant',
        ...(message.toolUses[0] ? { tool_name: message.toolUses[0].tool } : {}),
        content,
      })
      continue
    }
    if (message.text)
      items.push({ window_id: windowId, item_id: stableId(`u-${hash(message.text)}`), role: 'user', content: message.text })
    for (const result of message.toolResults ?? []) {
      const tool = toolNames.get(result.tool_use_id)
      items.push({
        window_id: windowId,
        item_id: stableId(`result-${result.tool_use_id}`),
        role: 'tool',
        ...(tool ? { tool_name: tool } : {}),
        content: result.text,
      })
    }
  }

  const action = params['action']
  if (action === 'list_windows') {
    let values = [...windows].filter(([, items]) => items.length)
    if (params['recent_first'] === true) values = values.reverse()
    const limit = integer(params['limit'], 20, 100)
    return {
      windows: values.slice(0, limit).map(([id, items]) => ({ window_id: id, item_count: items.length })),
      truncated: values.length > limit,
    }
  }
  if (action === 'read_item') {
    const item = windows.get(String(params['window_id']))?.find((item) => item.item_id === params['item_id'])
    if (!item) return { item: null }
    const offset = integer(params['offset_chars'], 0, item.content.length, 0)
    const limit = integer(params['limit_chars'], RESULT_LIMIT, RESULT_LIMIT)
    const content = item.content.slice(offset, offset + limit)
    return {
      item: {
        ...item,
        content,
        total_chars: item.content.length,
        ...(offset + content.length < item.content.length ? { next_offset_chars: offset + content.length } : {}),
      },
    }
  }
  // list_items or search_contents
  const query = String(params['query'])
  let items = [...windows.values()]
    .flat()
    .filter(
      (item) =>
        (!params['window_id'] || item.window_id === params['window_id']) &&
        (!params['role'] || item.role === params['role']) &&
        (!params['tool_name'] || item.tool_name === params['tool_name']) &&
        (action !== 'search_contents' || item.content.includes(query)),
    )
  if (params['recent_first'] === true) items = items.reverse()
  const limit = integer(params['limit'], 10, 25)
  const previewChars = integer(params['max_chars_per_item'], 1000, 1000)
  const previews = []
  let size = 0
  for (const item of items) {
    const { content, ...metadata } = item
    const preview = { ...metadata, truncated_content: content.slice(0, previewChars), content_chars: content.length }
    const chars = JSON.stringify(preview).length
    if (previews.length >= limit || size + chars > RESULT_LIMIT) break
    previews.push(preview)
    size += chars
  }
  return { items: previews, truncated: previews.length < items.length }
}
