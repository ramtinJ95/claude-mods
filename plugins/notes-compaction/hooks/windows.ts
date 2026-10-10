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
}

export const GUIDANCE = `<context_window_guidance>
Keep one checkpoint per task at a stable notes path: request, constraints, decisions, progress, next steps, history IDs. Replace stale state; mark completion in place. Keep reusable findings and deferred ideas in separate topic notes; link, don't copy. Recording isn't permission to implement.

Save changed state after substantial work, before replying, and before new_context or handoff. Skip routine or unchanged state. Include checkpoint paths in handoffs. After rollover, read the checkpoint, then linked notes as needed; history only for missing details.
</context_window_guidance>`

export const WINDOW_OPEN = '<context_window>'
const CURRENT = 'Current context window id: '
const PREVIOUS = 'Previous context window id: '

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

export function windowText(ids: WindowIdentity, recentNotes: readonly string[]): string {
  const lines = [`First context window id: ${ids.firstWindowId}`, `${CURRENT}${ids.currentWindowId}`]
  if (ids.previousWindowId) lines.push(`${PREVIOUS}${ids.previousWindowId}`)
  if (recentNotes.length) lines.push(`Recent notes: ${recentNotes.join(', ')}`)
  return `${WINDOW_OPEN}\n${lines.join('\n')}\n</context_window>`
}

/** Window boundary written by windowText, read back from the transcript. */
export function parseWindow(text: string): { current: string; previous?: string } | undefined {
  if (!text.startsWith(WINDOW_OPEN)) return
  const field = (prefix: string) =>
    text
      .split('\n')
      .find((line) => line.startsWith(prefix))
      ?.slice(prefix.length)
      .trim()
  const current = field(CURRENT)
  return current ? { current, previous: field(PREVIOUS) } : undefined
}

export function reminderFor(state: SessionState, percentUsed: number | undefined): string | undefined {
  if (percentUsed === undefined) return
  const kind = percentUsed >= 90 ? 'urgent' : percentUsed >= 85 ? 'reminder' : undefined
  const id = state.window.currentWindowId
  if (!kind || state.reminded.includes(`${id}:${kind}`)) return
  state.reminded.push(`${id}:reminder`)
  if (kind === 'urgent') state.reminded.push(`${id}:urgent`)
  const remaining = Math.round((100 - percentUsed) * 10) / 10
  return `<context_window_reminder>\n${kind === 'urgent' ? 'Urgent: ' : ''}${remaining}% remaining. Checkpoint the active request, state and known history IDs in notes, then call new_context ${kind === 'urgent' ? 'now, before other work' : 'before continuing work'}.\n</context_window_reminder>`
}
