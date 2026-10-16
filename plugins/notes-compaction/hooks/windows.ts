export interface WindowIdentity {
  firstWindowId: string
  currentWindowId: string
  previousWindowId?: string
  windowNumber: number
}
export interface SessionState {
  window: WindowIdentity
  /** `<windowId>:reminder` and `<windowId>:urgent`, each sent once per window. */
  reminded: string[]
  /** Subagents that wrote notes in this session or that its transcript launched, kept beyond the sliding view. */
  agents?: string[]
  /** The Claude Code transcripts folder this session belongs to; prune judges only its own profile's sessions. */
  projects?: string
  /** The fork record this session was restored from, which prune keeps while the session stays. */
  restoredFrom?: string
}

export const GUIDANCE = `<context_window_guidance>
Notes persist across windows. Keep one checkpoint per task at a stable notes path, covering the request, constraints, decisions, progress and how it was verified, next steps and identifiers needed to act (history IDs too), so you can resume without rereading the conversation. Replace stale state; mark completion in place. Keep reusable findings and deferred ideas in separate topic notes; link, don't copy. Recording isn't permission to implement.

Save changed state after substantial work, before replying, and before new_context or handoff. Skip routine or unchanged state; raw output stays in history. Include checkpoint paths in handoffs. After rollover, read the checkpoint, then linked notes as needed. History retrieves earlier conversation; use it only for missing details.
</context_window_guidance>`

const WINDOW_OPEN = '<context_window>'
const FIRST = 'First context window id: '
const CURRENT = 'Current context window id: '
const PREVIOUS = 'Previous context window id: '
/** Marks a window's marker repeated after Claude Code's own compaction, as opposed to a window boundary. */
const RECOVERY = 'If no checkpoint is available, use history to recover missing context.'

export function newState(): SessionState {
  const id = crypto.randomUUID()
  return { window: { firstWindowId: id, currentWindowId: id, windowNumber: 0 }, reminded: [] }
}

export function nextWindow(current: WindowIdentity): WindowIdentity {
  return {
    firstWindowId: current.firstWindowId,
    currentWindowId: crypto.randomUUID(),
    previousWindowId: current.currentWindowId,
    windowNumber: current.windowNumber + 1,
  }
}

/** `repeated` is the marker put back after Claude Code compacted the window on its own: it adds where to look when no checkpoint covers the work. */
export function windowText(agent: string, ids: WindowIdentity, recentNotes: readonly string[], repeated = false): string {
  const lines = [`Agent name: ${agent}`, `${FIRST}${ids.firstWindowId}`, `${CURRENT}${ids.currentWindowId}`]
  if (ids.previousWindowId) lines.push(`${PREVIOUS}${ids.previousWindowId}`)
  if (recentNotes.length) lines.push(`Recent notes (read them with the notes tool): ${recentNotes.join(', ')}`)
  if (repeated) lines.push(RECOVERY)
  return `${WINDOW_OPEN}\n${lines.join('\n')}\n</context_window>`
}

/** The window boundary windowText wrote, read back from a transcript message: on its first or second line. */
export function windowMarker(message: {
  role: string
  text: string
}): { first?: string; current: string; previous?: string; repeated?: true } | undefined {
  if (message.role !== 'user') return
  const { text } = message
  const open = `${WINDOW_OPEN}\n`
  const start = text.startsWith(open) ? 0 : text.indexOf('\n') + 1
  if (!text.startsWith(open, start)) return
  const lines = text.slice(start).split('\n')
  const field = (prefix: string) =>
    lines
      .find((line) => line.startsWith(prefix))
      ?.slice(prefix.length)
      .trim()
  const current = field(CURRENT)
  if (!current) return
  return { first: field(FIRST), current, previous: field(PREVIOUS), ...(lines.includes(RECOVERY) ? { repeated: true as const } : {}) }
}

/** Both reminders went out in this window: nothing left to measure for. */
export function remindersDone(state: SessionState): boolean {
  return state.reminded.includes(`${state.window.currentWindowId}:urgent`)
}

export function reminderFor(state: SessionState, percentUsed: number | undefined): string | undefined {
  if (percentUsed === undefined) return
  const kind = percentUsed >= 90 ? 'urgent' : percentUsed >= 85 ? 'reminder' : undefined
  const id = state.window.currentWindowId
  if (!kind || state.reminded.includes(`${id}:${kind}`)) return
  state.reminded.push(`${id}:reminder`)
  if (kind === 'urgent') state.reminded.push(`${id}:urgent`)
  // Estimates lean early and can pass the limit.
  const remaining = Math.max(0, Math.round((100 - percentUsed) * 10) / 10)
  return `<context_window_reminder>\n${kind === 'urgent' ? 'Urgent: ' : ''}${remaining}% context remaining. Save the task state in notes, then call new_context ${kind === 'urgent' ? 'now, before other work' : 'before continuing work'}.\n</context_window_reminder>`
}
