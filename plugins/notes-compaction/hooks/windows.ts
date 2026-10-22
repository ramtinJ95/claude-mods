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
  /**
   * The marker of a window opened from Claude Code's summary that waits for the user (/compact). It leads their next
   * plain prompt, the one message that can carry it there, and is kept here so a resumed session still delivers it.
   */
  unsentMarker?: string
}

export const GUIDANCE = `<context_window_guidance>
Notes are recovery state, not a diary. Keep one concise, authoritative note per task or topic at a stable notes path. Task checkpoints cover request, constraints, decisions, status and how it was verified, next steps and identifiers needed to act (history IDs too). Use write_file to replace stale state and mark completion. Link to existing notes instead of copying or summarising their contents. Recording isn't permission to implement.

Batch saves at meaningful milestones, not every reply or intermediate step. Before new_context or handoff, save current state and wait for success; include the checkpoint path in handoffs. After rollover, read the checkpoint, then only needed links, and read again the skills the current task needs: earlier skill reads don't carry into a new window. Don't reread notes still in context unless they may have changed. Use history for missing details.
</context_window_guidance>`

const WINDOW_OPEN = '<context_window>'
const WINDOW_CLOSE = '</context_window>'
/**
 * How a new window starts. `continue` follows new_context, called mid-task. `resume` follows idle compaction: the
 * agent ended its last turn, perhaps short of the user's request. `wait` follows /compact typed by the user.
 */
export type Opening = 'continue' | 'resume' | 'wait'
/** The prompt that starts each window that does not wait. */
export const OPENING_PROMPTS: Readonly<Record<Exclude<Opening, 'wait'>, string>> = {
  continue: 'Continue.',
  resume:
    "Read your checkpoint. If the user's latest request is unfinished and needs nothing more from them, continue it. Otherwise reply in one line with what you are waiting for.",
}
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
  return `${WINDOW_OPEN}\n${lines.join('\n')}\n${WINDOW_CLOSE}`
}

/** A marker message's own prompt after the marker, if any besides the plugin's own opening prompt. */
export function promptAfterMarker(text: string): string | undefined {
  const end = text.indexOf(WINDOW_CLOSE)
  const rest = end < 0 ? '' : text.slice(end + WINDOW_CLOSE.length).trim()
  return rest && !Object.values(OPENING_PROMPTS).includes(rest) ? rest : undefined
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
