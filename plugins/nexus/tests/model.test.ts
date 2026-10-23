import { describe, expect, test } from 'claude-code/testing'

import type { NexusRunState, NexusWatch } from '../types'
import { applyEvent, foldReply, isSettled, keepTail, leftOut, matchThread, type WatchEntry, type WatchEvent, parseCommand, parseFailure, parseWatchEvent, tailLines, wrap } from '../hooks/model'

describe('/nexus arguments', () => {
  test('a quoted title after the project, the rest the message', () => {
    expect(parseCommand('new web "Fix login" the form  answers 500')).toEqual({
      verb: 'new',
      project: 'web',
      title: 'Fix login',
      message: 'the form  answers 500',
    })
    expect(parseCommand('new web just a message')).toEqual({ verb: 'new', project: 'web', message: 'just a message' })
    expect(parseCommand('new web').verb).toBe('invalid')
  })

  test('send keeps the message whole; actions take an optional ID', () => {
    expect(parseCommand('send 4f2a  --steer "quoted"\nnext line')).toEqual({ verb: 'send', thread: '4f2a', text: '--steer "quoted"\nnext line' })
    expect(parseCommand('abort')).toEqual({ verb: 'action', action: 'abort' })
    expect(parseCommand('retry-pylon th-4f2a')).toEqual({ verb: 'action', action: 'retry-pylon', thread: 'th-4f2a' })
    expect(parseCommand('')).toEqual({ verb: 'pane' })
    expect(parseCommand('archive a b').verb).toBe('invalid')
    expect(parseCommand('frobnicate').verb).toBe('invalid')
  })

  test('a prefix names the one thread it starts', () => {
    const threads = ['th-4f2a00000001', 'th-4f2b00000002'].map(id => ({
      id,
      title: id,
      project: 'web',
      status: 'active' as const,
      agentTurnRunning: false,
      lastActivityAt: 0,
    }))
    expect(matchThread('4f2a', threads)).toEqual({ id: 'th-4f2a00000001' })
    expect(matchThread('th-4f2b', threads)).toEqual({ id: 'th-4f2b00000002' })
    expect('error' in matchThread('4f2', threads)).toBe(true)
    expect(matchThread('beef', threads)).toEqual({ unknown: true })
    expect('error' in matchThread('fix-it', threads)).toBe(true)
  })
})

const idle: NexusRunState = { status: 'active', run: 'idle', parkedTasks: 0, queued: 0, pylon: 'running', failed: null }
const empty: NexusWatch = { thread: 'th-4f2a00000001', rows: [], state: null, outage: null, ended: null }

/** The watch's own lines for one turn: a question, a tool call and its result, an answer. */
const stream = [
  { type: 'reset', thread: 'th', entries: [{ entry: { id: 1, model: [{ role: 'user', content: 'run the tests' }] }, text: '> run the tests' }] },
  {
    type: 'entry',
    thread: 'th',
    entry: { id: 2, model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'npm  test' } }] }] },
    text: '[tool] bash {"command":"npm test"}',
  },
  { type: 'entry', thread: 'th', entry: { id: 3, model: [{ role: 'toolResult', toolCallId: 'c1', toolName: 'bash', isError: true, content: [] }] }, text: '' },
  { type: 'entry', thread: 'th', entry: { id: 4, model: [{ role: 'system', content: 'x' }] }, text: '' },
  { type: 'entry', thread: 'th', entry: { id: 5, model: [{ role: 'assistant', content: [{ type: 'text', text: 'Two tests fail.' }] }] }, text: 'Two tests fail.' },
  { type: 'state', thread: 'th', ...idle, newField: true },
  { type: 'preview', thread: 'th' },
].map(event => JSON.stringify(event))

describe('watch stream', () => {
  test('folds into rows, a result settling its call, a system entry skipped', () => {
    const events = stream.map(parseWatchEvent)
    expect(events.at(-1)).toBeUndefined()
    const watch = events.reduce((current: NexusWatch, event) => (event ? applyEvent(current, event) : current), empty)
    expect(watch.rows).toEqual([
      { kind: 'user', text: 'run the tests' },
      { kind: 'tool', id: 'c1', name: 'bash', summary: 'npm test', outcome: 'error' },
      { kind: 'assistant', text: 'Two tests fail.' },
    ])
    expect(watch.state).toEqual(idle)
    expect(isSettled(watch.state, watch.rows, false)).toBe(true)
    expect(isSettled({ ...idle, queued: 1 }, watch.rows, false)).toBe(false)
    expect(isSettled(idle, watch.rows.slice(0, 1), false)).toBe(false)
  })

  test('a reply is only text after the last user message', () => {
    const say = (role: 'user' | 'assistant', text: string): WatchEntry => ({ model: [{ role, content: role === 'user' ? text : [{ type: 'text', text }] }], text })
    const reply = (...entries: WatchEntry[]) => {
      const got = foldReply(undefined, { type: 'reset', entries }, 4_000)
      return got && leftOut(got.tail, got.dropped)
    }
    expect(reply(say('user', 'first'), say('assistant', 'old answer'), say('user', 'second'))).toBeUndefined()
    expect(reply(say('user', 'first'), say('assistant', 'old answer'))).toBe('old answer')
    expect(reply(say('user', 'second'), say('assistant', 'Build passed.'), say('assistant', 'Tests passed.'))).toBe('Build passed.\n\nTests passed.')
  })

  test("a reply keeps a turn's first text past the rows kept, its tail cut as keepTail cuts it", () => {
    const tool = (n: number): WatchEvent => ({ type: 'entry', entry: { model: [{ role: 'assistant', content: [{ type: 'toolCall', id: `t${n}`, name: 'bash', arguments: { command: 'ls' } }] }], text: '' } })
    const said = (text: string): WatchEvent => ({ type: 'entry', entry: { model: [{ role: 'assistant', content: [{ type: 'text', text }] }], text } })
    const events: WatchEvent[] = [{ type: 'reset', entries: [{ model: [{ role: 'user', content: 'go' }], text: '> go' }] }, said('Starting'), ...Array.from({ length: 450 }, (_, n) => tool(n)), said('Done')]
    expect(events.reduce(applyEvent, empty).rows.some(row => row.kind === 'assistant' && row.text === 'Starting')).toBe(false)
    const fold = (list: WatchEvent[]) => list.reduce((sofar, event) => foldReply(sofar, event, 4_000), undefined as Parameters<typeof foldReply>[0])
    const got = fold(events)
    expect(got).toEqual({ tail: 'Starting\n\nDone', dropped: 0 })
    const long = [said(`a\n${'x'.repeat(3_000)}`), said(`b\n${'y'.repeat(3_000)}`), said(`c\n${'z'.repeat(2_000)}`)]
    const joined = [`a\n${'x'.repeat(3_000)}`, `b\n${'y'.repeat(3_000)}`, `c\n${'z'.repeat(2_000)}`].join('\n\n')
    const tail = fold([events[0]!, ...long])!
    expect(tail.tail.length).toBe(4_000)
    expect(leftOut(tail.tail, tail.dropped)).toBe(keepTail(joined, 4_000))
  })

  test('a run seen working then idle settles even with the user message last', () => {
    const asked = [{ kind: 'user' as const, text: 'go' }]
    expect(isSettled(idle, asked, false)).toBe(false)
    expect(isSettled(idle, asked, true)).toBe(true)
    expect(isSettled({ ...idle, queued: 1 }, asked, true)).toBe(false)
    expect(isSettled({ ...idle, run: 'working' }, asked, true)).toBe(false)
  })

  test('a failed pylon settles at once', () => {
    const asked = [{ kind: 'user' as const, text: 'go' }]
    expect(isSettled({ ...idle, pylon: 'failed', failed: 'the VM did not boot' }, asked, false)).toBe(true)
    expect(isSettled({ ...idle, run: 'working', failed: 'the VM did not boot' }, asked, false)).toBe(true)
  })

  test('an error event marks an outage until the next state', () => {
    const error = parseWatchEvent('{"type":"error","thread":"th","kind":"unreachable","message":"cannot reach the SOCKS proxy"}')!
    const down = applyEvent(empty, error)
    expect(down.outage).toBe('Nexus is unreachable: cannot reach the SOCKS proxy.')
    expect(applyEvent(down, { type: 'state', state: idle }).outage).toBeNull()
  })

  test('the tail is the last lines, tool runs collapsed', () => {
    const tools = Array.from({ length: 5 }, (_, index) => ({
      kind: 'tool' as const,
      id: `c${index}`,
      name: 'read',
      summary: `src/file${index}.ts`,
      outcome: 'ok' as const,
    }))
    const rows = [{ kind: 'user' as const, text: 'look around' }, ...tools, { kind: 'assistant' as const, text: 'one two three four five six' }]
    const text = tailLines(rows, 12, 20).map(line => line.map(span => span.text).join(''))
    expect(text).toEqual(['› look', '  around', '', '  2 earlier…', '✓ read src/…', '✓ read src/…', '✓ read src/…', '', 'one two', 'three four', 'five six'])
    expect(tailLines(rows, 12, 2).map(line => line.map(span => span.text).join(''))).toEqual(['three four', 'five six'])
    expect(wrap('漢字漢字漢字 ok', 4)).toEqual(['漢字', '漢字', '漢字', 'ok'])
  })

  test('a failed command reads its JSON error line, else its exit code', () => {
    expect(parseFailure(2, '{"error":"cannot reach the SOCKS proxy","kind":"unreachable","status":null}\n')).toEqual({
      kind: 'unreachable',
      message: 'cannot reach the SOCKS proxy',
    })
    expect(parseFailure(4, '')).toEqual({ kind: 'not-found', message: 'the CLI exited with 4' })
  })
})
