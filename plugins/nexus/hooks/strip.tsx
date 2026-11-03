// The strip: one row above the prompt with a single notice when Nexus needs the
// person, its most urgent thread named, or how many threads need them, and while
// none does, the new replies. It opens that thread, or the list when there are
// several. It draws on the prompt's own background.
import type { BoxProps, ButtonProps, ElementConstructor, TextProps } from 'claude-code'

import type { NexusList } from '../types'
import { type Ask, type StripNotice, cells, clip, scopeLabel } from './model'

type Draw = { Box: ElementConstructor<BoxProps>; Text: ElementConstructor<TextProps>; Button: ElementConstructor<ButtonProps> }

const LOOK: Record<Ask, { glyph: string; color: string }> = {
  failed: { glyph: '✕', color: 'error' },
  decision: { glyph: '!', color: 'warning' },
  parked: { glyph: '✕', color: 'error' },
  limited: { glyph: '◷', color: 'warning' },
  reply: { glyph: '●', color: 'success' },
  waiting: { glyph: '◇', color: 'warning' },
}

const HEAD = '◆ Nexus'

/** The least a thread's title takes beside the project's name; narrower, the name goes. */
const LEAST_TITLE_CELLS = 8

/** The strip's one button, which the band's focus names. */
export const NOTICE_KEY = 'nexus-notice'

/** The notice, or why the list could not be read. One project shown is named after the head. */
export function StripView(draw: Draw, list: NexusList, notice: StripNotice | null, width: number, isCursor: boolean, scope: string | null, open: () => void) {
  const { Box, Text, Button } = draw
  const head = scope === null ? HEAD : `${HEAD} · ${scopeLabel(scope)}`
  if (!notice) {
    return (
      <Box flexDirection="row" width={width}>
        <Text wrap="truncate-end">
          <Text bold color="claude">
            {head}
          </Text>
          <Text color="error">{`  ${list.failure?.kind}: ${list.failure?.message}`}</Text>
        </Text>
      </Box>
    )
  }
  const look = LOOK[notice.ask]
  // A Button ignores a child Text's truncation, so the row is budgeted here: the project's name goes before the title.
  const room = (shown: string) => width - cells(shown) - 4
  const many = notice.ask === 'reply' ? [`${notice.count} new replies`, `${notice.count} new`] : [`${notice.count} threads need you`, `${notice.count} need you`]
  const shownHead = notice.count === 1 ? (room(head) >= cells(notice.word) + 2 + LEAST_TITLE_CELLS ? head : HEAD) : room(head) >= cells(many[0]!) ? head : HEAD
  const what = notice.count === 1 ? null : (many.find(text => cells(text) <= room(shownHead)) ?? many[1]!)
  const title = Math.max(1, room(shownHead) - cells(notice.word) - 2)
  return (
    <Box flexDirection="row" columnGap={2} width={width}>
      <Text bold color="claude">
        {shownHead}
      </Text>
      <Button key={NOTICE_KEY} plain onPress={open}>
        <Text backgroundColor={isCursor ? 'suggestion' : undefined} color={isCursor ? 'inverseText' : undefined}>
          <Text color={isCursor ? 'inverseText' : look.color}>{`${look.glyph} `}</Text>
          {what ? <Text bold>{what}</Text> : clip(notice.top.title, title)}
          {!what && <Text color={isCursor ? 'inverseText' : look.color}>{`  ${notice.word}`}</Text>}
        </Text>
      </Button>
    </Box>
  )
}
