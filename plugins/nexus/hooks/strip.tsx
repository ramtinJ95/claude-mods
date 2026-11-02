// The strip: one row above the prompt with a single notice when Nexus needs the
// person, its most urgent thread named, or how many threads need them. It opens
// that thread, or the list when several do. It draws on the prompt's own background.
import type { BoxProps, ButtonProps, ElementConstructor, TextProps } from 'claude-code'

import type { NexusList } from '../types'
import { type Need, type StripNotice, cells, clip, scopeLabel } from './model'

type Draw = { Box: ElementConstructor<BoxProps>; Text: ElementConstructor<TextProps>; Button: ElementConstructor<ButtonProps> }

const LOOK: Record<Need, { glyph: string; color: string }> = {
  failed: { glyph: '✕', color: 'error' },
  decision: { glyph: '!', color: 'warning' },
  parked: { glyph: '✕', color: 'error' },
  limited: { glyph: '◷', color: 'warning' },
  reply: { glyph: '●', color: 'success' },
  waiting: { glyph: '◇', color: 'warning' },
}

const HEAD = '◆ Nexus'

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
  const look = LOOK[notice.need]
  const what = notice.count === 1 ? null : `${notice.count} threads need you`
  const room = Math.max(8, width - cells(head) - cells(notice.word) - 10)
  return (
    <Box flexDirection="row" columnGap={2} width={width}>
      <Text bold color="claude">
        {head}
      </Text>
      <Button key={NOTICE_KEY} plain onPress={open}>
        <Text backgroundColor={isCursor ? 'suggestion' : undefined} color={isCursor ? 'inverseText' : undefined} wrap="truncate-end">
          <Text color={isCursor ? 'inverseText' : look.color}>{`${look.glyph} `}</Text>
          {what ? <Text bold>{what}</Text> : clip(notice.top.title, room)}
          {!what && <Text color={isCursor ? 'inverseText' : look.color}>{`  ${notice.word}`}</Text>}
        </Text>
      </Button>
    </Box>
  )
}
