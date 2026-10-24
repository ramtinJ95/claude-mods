import { expect, mock, test, type TestBody } from 'claude-code/testing'

/** The pane over a CLI whose `threads` poll answers after a minute, counting opens, polls and how each poll ended. */
async function pane(...[$, on]: Parameters<TestBody>) {
  const clock = mock.clock(on)
  mock.store(on, { themeNotice: true })
  const seen = { opens: 0, polls: 0, answered: 0, ended: 0 }
  let isOpen = false
  /** Set, a hook beneath the mod's keeps the pane open, as one answering without `next` does. */
  const close = { isRefused: false }
  on('command.register', () => ({ value: { command: 'nexus' } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__nexus__${e.name}` } }))
  on('ui.open', () => {
    seen.opens += 1
    isOpen = true
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => {
    if (!close.isRefused) isOpen = false
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: isOpen ? [{ id: 'nexus', title: 'Nexus', isShown: true, isFocused: false, isPlaced: true }] : [] }))
  on('process.spawn', async function* () {
    seen.polls += 1
    try {
      await clock.sleep(60_000)
      yield { stream: 'stdout' as const, text: '[]' }
      // Reached only when the mod reads on: a killed poll ends at the yield.
      seen.answered += 1
    } finally {
      seen.ended += 1
    }
    return { value: { code: 0, signal: null } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const nexus = (args: string) =>
    $.command.run({ command: 'nexus', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as never)
  return { clock, seen, nexus, close }
}

test('an unfocused pane asks for the keys once more, unless it closed first', async ($, on) => {
  const { clock, seen, nexus } = await pane($, on)
  await nexus('')
  await clock.advance(500)
  expect(seen.opens).toBe(2)
  await nexus('')
  await nexus('close')
  await clock.advance(500)
  expect(seen.opens).toBe(3)
})

test('closing the pane kills its poll in flight', async ($, on) => {
  const { clock, seen, nexus } = await pane($, on)
  await nexus('')
  await nexus('close')
  await clock.advance(61_000)
  expect(seen).toEqual({ opens: 1, polls: 1, answered: 0, ended: 1 })
})

test('a close another hook refuses leaves the poll running', async ($, on) => {
  const { clock, seen, nexus, close } = await pane($, on)
  await nexus('')
  close.isRefused = true
  expect(await nexus('close')).toEqual({ text: 'The Nexus pane stays open: another hook kept it.' })
  await clock.advance(61_000)
  // The poll in flight answered, and the next one began.
  expect(seen).toMatchObject({ polls: 2, answered: 1, ended: 1 })
})
