// The worker side, in a Claude Code session another Shepherdr controls: its
// open AskUserQuestion takes the controller's `answer` in place of the dialog,
// whichever comes first. Claude Code records a question only once settled, so
// the hook publishes the open one where the controller's bridge reads it.

export type AnswerPayload = {
  answers: Record<string, string>
  annotations?: Record<string, { notes: string }>
}

// The whole message inside Claude Code's cross-session wrapper, so a task
// quoting a frame stays a task. The controller escapes `<` in the JSON, so its
// body never holds the closing tag.
const FRAME =
  /^\s*(?:<cross-session-message\b[^>]*>\s*)?<shepherdr_answer ask="([^"]+)">([^<]*)<\/shepherdr_answer>\s*(?:<\/cross-session-message>\s*)?$/

const waiting = new Map<string, (payload: AnswerPayload) => void>()

function isPayload(value: unknown): value is AnswerPayload {
  if (!value || typeof value !== 'object') return false
  const { answers } = value as { answers?: unknown }
  return (
    !!answers && typeof answers === 'object' && Object.values(answers).every(answer => typeof answer === 'string')
  )
}

/** Whether `text` is a controller's answer frame; one for an open question settles it. */
export function takeAnswer(text: string): 'answered' | 'closed' | undefined {
  const match = FRAME.exec(text)
  if (!match) return undefined
  let payload: unknown
  try {
    payload = JSON.parse(match[2]!)
  } catch {
    return 'closed'
  }
  const settle = waiting.get(match[1]!)
  if (!settle || !isPayload(payload)) return 'closed'
  settle(payload)
  return 'answered'
}

/** Resolves when a controller answers the question; `cancel` once the dialog settled it instead. */
export function awaitAnswer(toolUseId: string): { answered: Promise<AnswerPayload>; cancel: () => void } {
  let settle!: (payload: AnswerPayload) => void
  const answered = new Promise<AnswerPayload>(resolve => {
    settle = resolve
  })
  waiting.set(toolUseId, settle)
  return {
    answered,
    cancel: () => {
      if (waiting.get(toolUseId) === settle) waiting.delete(toolUseId)
    },
  }
}
