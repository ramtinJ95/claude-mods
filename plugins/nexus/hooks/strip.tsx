// The strip: one row above the prompt with a chip per live thread that wants a
// look, most urgent first, so Nexus never needs opening to know what it is doing.
// A chip opens its thread in the pane. It draws on the prompt's own background.
import type { BoxProps, ButtonProps, ElementConstructor, TextProps } from 'claude-code'

import type { NexusList } from '../types'
import { type Chip, cells, clip, scopeLabel } from './model'

type Draw = { Box: ElementConstructor<BoxProps>; Text: ElementConstructor<TextProps>; Button: ElementConstructor<ButtonProps> }

const LOOK: Record<Chip['kind'], { glyph: string; color: string }> = {
  failed: { glyph: '✕', color: 'error' },
  parked: { glyph: '✕', color: 'error' },
  reply: { glyph: '●', color: 'success' },
  working: { glyph: '◉', color: 'planMode' },
  waiting: { glyph: '◇', color: 'warning' },
}

const HEAD = '◆ Nexus'
/** The most a chip's title takes, so three chips fit beside one another in a narrow column. */
const TITLE_CELLS = 24

/** The least a chip's title takes: the first chip shortens its title to this to fit beside a project's name. */
const LEAST_TITLE_CELLS = 8

const chipText = (chip: Chip, title: number) => ` ${LOOK[chip.kind].glyph} ${clip(chip.thread.title, title)}  ${chip.note} `

/**
 * The chips that fit in `width` on one row, the rest counted as `+N`, or why the list could not be read. One project
 * shown is named after the head.
 */
export function StripView(draw: Draw, list: NexusList, chips: readonly Chip[], width: number, cursor: string | null, scope: string | null, open: (id: string) => void) {
  const { Box, Text, Button } = draw
  const head = scope === null ? HEAD : `${HEAD} · ${scopeLabel(scope)}`
  if (list.failure && !list.threads) {
    return (
      <Box flexDirection="row" width={width}>
        <Text wrap="truncate-end">
          <Text bold color="claude">
            {head}
          </Text>
          <Text color="error">{`  ${list.failure.kind}: ${list.failure.message}`}</Text>
        </Text>
      </Box>
    )
  }
  const room = width - cells(head) - 6
  const shown: { chip: Chip; title: number }[] = []
  let used = 0
  for (const chip of chips) {
    const over = used + cells(chipText(chip, TITLE_CELLS)) + 1 - room
    const title = cells(clip(chip.thread.title, TITLE_CELLS)) - Math.max(0, over)
    if (over > 0 && (shown.length > 0 || title < LEAST_TITLE_CELLS)) break
    shown.push({ chip, title })
    used += cells(chipText(chip, title)) + 1
  }
  const more = chips.length - shown.length
  return (
    <Box flexDirection="row" columnGap={1} width={width}>
      <Text bold color="claude">
        {head}
      </Text>
      {shown.map(({ chip, title }) => {
        const isCursor = cursor === chip.thread.id
        return (
          <Button key={chip.thread.id} plain onPress={() => open(chip.thread.id)}>
            <Text backgroundColor={isCursor ? 'suggestion' : undefined} color={isCursor ? 'inverseText' : undefined}>
              <Text color={isCursor ? 'inverseText' : LOOK[chip.kind].color}>{` ${LOOK[chip.kind].glyph} `}</Text>
              {clip(chip.thread.title, title)}
              <Text color={isCursor ? 'inverseText' : chip.kind === 'working' ? 'subtle' : LOOK[chip.kind].color}>{`  ${chip.note} `}</Text>
            </Text>
          </Button>
        )
      })}
      {more > 0 && <Text color="subtle">{`+${more}`}</Text>}
    </Box>
  )
}
