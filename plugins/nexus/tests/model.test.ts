import { describe, expect, test } from 'claude-code/testing'

import type { NexusRow, NexusRunState, NexusThread, NexusWatch } from '../types'
import {
  type WatchEntry,
  type WatchEvent,
  appendEntry,
  applyEvent,
  blocks,
  clip,
  clock,
  diffOf,
  exitCode,
  foldReply,
  foldSummary,
  groupThreads,
  isSettled,
  keepTail,
  leftOut,
  matchThread,
  parseCommand,
  parseDetail,
  parseFailure,
  parseThreads,
  parseWatchEvent,
  previewLook,
  since,
  threadState,
} from '../hooks/model'
import { DETAIL, ENTRIES, PATCH, T0, THREADS, WEB_PREVIEW, state } from './fake-cli'

const thread = (over: Partial<NexusThread>): NexusThread => ({
  id: 'th-4f2a00000001',
  title: 'A thread',
  project: 'web',
  status: 'active',
  agentTurnRunning: false,
  createdAt: 0,
  lastHumanActivityAt: 0,
  lastAgentActivityAt: 0,
  lastActivityAt: 0,
  ...over,
})

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
    expect(parseCommand('unpublish 5173')).toEqual({ verb: 'unpublish', port: 5173 })
    expect(parseCommand('unpublish 5173 4f2a')).toEqual({ verb: 'unpublish', port: 5173, thread: '4f2a' })
    expect(parseCommand('unpublish').verb).toBe('invalid')
    expect(parseCommand('unpublish 4f2a 5173').verb).toBe('invalid')
    expect(parseCommand('unpublish 5173 4f2a extra').verb).toBe('invalid')
    expect(parseCommand('strip off')).toEqual({ verb: 'strip', isOn: false })
    expect(parseCommand('strip on')).toEqual({ verb: 'strip', isOn: true })
    expect(parseCommand('strip').verb).toBe('invalid')
  })

  test('a prefix names the one thread it starts', () => {
    const threads = ['th-4f2a00000001', 'th-4f2b00000002'].map(id => thread({ id, title: id }))
    expect(matchThread('4f2a', threads)).toEqual({ id: 'th-4f2a00000001' })
    expect(matchThread('th-4f2b', threads)).toEqual({ id: 'th-4f2b00000002' })
    expect('error' in matchThread('4f2', threads)).toBe(true)
    expect(matchThread('beef', threads)).toEqual({ unknown: true })
    expect('error' in matchThread('fix-it', threads)).toBe(true)
  })
})

const idle: NexusRunState = { status: 'active', run: 'idle', parkedTasks: 0, queued: 0, pylon: 'running', failed: null, ports: [] }
const empty: NexusWatch = { thread: 'th-4f2a00000001', rows: [], dropped: 0, state: null, model: null, outage: null, ended: null }

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
      { kind: 'user', text: 'run the tests', at: null },
      { kind: 'tool', id: 'c1', name: 'bash', summary: 'npm test', outcome: 'error', args: { command: 'npm  test' }, output: '', lines: 0, patch: null },
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
    const asked: NexusRow[] = [{ kind: 'user', text: 'go', at: null }]
    expect(isSettled(idle, asked, false)).toBe(false)
    expect(isSettled(idle, asked, true)).toBe(true)
    expect(isSettled({ ...idle, queued: 1 }, asked, true)).toBe(false)
    expect(isSettled({ ...idle, run: 'working' }, asked, true)).toBe(false)
  })

  test('a failed pylon settles at once', () => {
    const asked: NexusRow[] = [{ kind: 'user', text: 'go', at: null }]
    expect(isSettled({ ...idle, pylon: 'failed', failed: 'the VM did not boot' }, asked, false)).toBe(true)
    expect(isSettled({ ...idle, run: 'working', failed: 'the VM did not boot' }, asked, false)).toBe(true)
  })

  test('an error event marks an outage until the next state', () => {
    const error = parseWatchEvent('{"type":"error","thread":"th","kind":"unreachable","message":"cannot reach the SOCKS proxy"}')!
    const down = applyEvent(empty, error)
    expect(down.outage).toBe('Nexus is unreachable: cannot reach the SOCKS proxy.')
    expect(applyEvent(down, { type: 'state', state: idle }).outage).toBeNull()
  })

  test('a clipped title counts wide characters as two cells', () => {
    expect(clip('漢字漢字', 5)).toBe('漢字…')
    expect(clip('short', 8)).toBe('short')
  })

  test('a failed command reads its JSON error line, else its exit code', () => {
    expect(parseFailure(2, '{"error":"cannot reach the SOCKS proxy","kind":"unreachable","status":null}\n')).toEqual({
      kind: 'unreachable',
      message: 'cannot reach the SOCKS proxy',
    })
    expect(parseFailure(4, '')).toEqual({ kind: 'not-found', message: 'the CLI exited with 4' })
  })
})

describe('the console', () => {
  test('threads carry their pylon and what is wanted of it, and show its desired and attach; a row or show without them throws', () => {
    const [fresh] = parseThreads(THREADS)
    expect(fresh).toMatchObject({ pylon: { node: 'firebat', actualState: 'running', failed: null }, desired: 'running', lastHumanActivityAt: THREADS[0]!.lastHumanActivityAt })
    expect(() => parseThreads([{ ...THREADS[0], desired: undefined }])).toThrow('nexus threads printed a row (th-4f2a00000001) without desired')
    expect(() => parseThreads([{ ...THREADS[0], pylon: null }])).toThrow('without its pylon')
    const detail = parseDetail(DETAIL)
    expect(detail).toMatchObject({ desired: 'running', attach: 'herdr --session nexus-7f3a', hasConversation: true, pylon: { retryRefused: null, observedAt: DETAIL.pylon.observedAt } })
    expect(detail.sessions).toEqual([{ herdrPane: 'nexus:1.2', harness: 'claude-code', harnessSessionId: '9c1e', status: 'working' }])
    expect(() => parseDetail({ ...DETAIL, desired: undefined })).toThrow('nexus show printed no desired')
    expect(() => parseDetail({ ...DETAIL, attach: undefined })).toThrow('nexus show printed no attach')
  })

  test("previews keep the CLI's url and ports their preview; either missing is a contract error, and null ports mean unknown", () => {
    const detail = parseDetail(DETAIL)
    // A control plane older than Preview.failed sends none: not failed.
    expect(detail.previews[0]).toEqual({ service: 'web', httpsPort: 10201, ready: true, failed: null, url: 'https://rj-firebat.example.ts.net:10201/' })
    expect(parseDetail({ ...DETAIL, previews: [{ ...WEB_PREVIEW, ready: false, failed: 'web exited' }] }).previews[0]).toMatchObject({ ready: false, failed: 'web exited' })
    expect(detail.ports).toEqual([
      { port: 3000, service: 'web', preview: detail.previews[0] },
      { port: 5173, service: null, preview: null },
      { port: 9229, service: 'worker', preview: null },
    ])
    expect(parseDetail({ ...DETAIL, ports: null }).ports).toBeNull()
    const { url: _, ...noUrl } = WEB_PREVIEW
    expect(() => parseDetail({ ...DETAIL, previews: [noUrl] })).toThrow('nexus show printed a preview (web) without its url, which docs/cli.md requires')
    expect(() => parseDetail({ ...DETAIL, ports: undefined })).toThrow('nexus show printed no ports')
    expect(() => parseDetail({ ...DETAIL, ports: [{ port: 3000, service: 'web', preview: noUrl }] })).toThrow('without its url')
    const watched = parseWatchEvent(JSON.stringify(state('idle')))
    expect(watched?.type === 'state' && watched.state.ports?.map(one => one.port)).toEqual([3000, 5173, 9229])
    const { ports: __, ...old } = state('idle')
    expect(() => parseWatchEvent(JSON.stringify(old))).toThrow('nexus watch printed no ports')
  })

  test('a thread is as urgent as its worst fact: a failed pylon shows over the agent working', () => {
    expect(threadState({ status: 'active', agentTurnRunning: true }, 'running')).toEqual(['agent working', 'work'])
    expect(threadState({ status: 'active', agentTurnRunning: true }, 'failed')).toEqual(['failed', 'bad'])
    expect(threadState({ status: 'archived', agentTurnRunning: false }, 'paused')).toEqual(['archived', 'muted'])
    expect(threadState({ status: 'idle', agentTurnRunning: false }, 'absent')).toEqual(['not on its node', 'muted'])
  })

  test("a live event carries the queued messages, running tools' output, the partial answer and a retry", () => {
    const event = parseWatchEvent(JSON.stringify({ type: 'live', thread: 'th', queued: ['also add a test', 3], tools: [{ callId: 'b2', output: 'x'.repeat(5_000) }, { output: 'no id' }], partial: 'Running', retry: null, later: 1 }))
    if (event?.type !== 'live') throw new Error('not a live event')
    expect(event.live.queued).toEqual(['also add a test'])
    expect(event.live.tools.map(tool => tool.callId)).toEqual(['b2'])
    expect(event.live.tools[0]!.output.length).toBeLessThan(2_100)
    expect(event.live.partial).toBe('Running')
    // The live event leaves the rows and the settle rule alone, so the model tools stay as pi-nexus has them.
    const done = { ...empty, rows: [{ kind: 'assistant' as const, text: 'done' }] }
    expect(applyEvent(done, event)).toBe(done)
  })

  test('the rows keep what the console draws: arguments, output, the line count, the patch and the model', () => {
    const watch = applyEvent(empty, { type: 'reset', entries: ENTRIES.map(one => ({ model: one.entry.model as never, text: one.text })) })
    expect(watch.model).toBe('claude-opus-5-5')
    const rows = watch.rows
    expect(rows[0]).toMatchObject({ kind: 'user', at: T0 - 72_000 })
    const failed = rows.find(row => row.kind === 'tool' && row.id === 'b1')
    expect(failed).toMatchObject({ outcome: 'error', lines: 4, args: { command: 'npm test -- login' } })
    expect(exitCode(failed?.kind === 'tool' ? failed.output : '')).toBe('1')
    const edit = rows.find(row => row.kind === 'tool' && row.id === 'e1')
    expect(edit?.kind === 'tool' && edit.patch).toBe(PATCH)
    // A result whose call is not in the context still draws, under the result's own tool name.
    const orphan = appendEntry([], { model: [{ role: 'toolResult', toolCallId: 'gone', toolName: 'grep', content: [{ type: 'text', text: 'a\nb' }] }], text: '' })
    expect(orphan).toEqual([{ kind: 'tool', id: 'gone', name: 'grep', summary: '', outcome: 'ok', args: {}, output: 'a\nb', lines: 2, patch: null }])
  })

  test('four tool calls in a row fold into one block, the live run after the rows', () => {
    const watch = applyEvent(empty, { type: 'reset', entries: ENTRIES.map(one => ({ model: one.entry.model as never, text: one.text })) })
    const all = blocks(watch.rows, 0, { queued: ['Also add a test.'], tools: [], partial: 'Running the suite', retry: 'overloaded' })
    expect(all.map(block => block.kind)).toEqual(['user', 'assistant', 'tools', 'assistant', 'tools', 'assistant', 'notice', 'user'])
    const steps = all[4]!
    expect(steps.kind === 'tools' && steps.tools.length).toBe(5)
    expect(foldSummary(steps.kind === 'tools' ? steps.tools : [])).toBe('Read 4 files, ran 1 command')
    // The answer streaming takes the key of the row it becomes once committed.
    expect(all.at(-3)).toEqual({ key: `row-${watch.rows.length}`, isLive: true, kind: 'assistant', text: 'Running the suite' })
    expect(all.at(-1)).toEqual({ key: 'live-queued-0', isLive: true, kind: 'user', text: 'Also add a test.' })
  })

  test('a block keeps its key as the rows kept move past the oldest', () => {
    const said = (n: number): WatchEvent => ({ type: 'entry', entry: { model: [{ role: 'assistant', content: [{ type: 'text', text: `answer ${n}` }] }], text: '' } })
    const long = Array.from({ length: 450 }, (_, n) => said(n)).reduce(applyEvent, empty)
    expect(long.rows).toHaveLength(400)
    expect(long.dropped).toBe(50)
    const last = blocks(long.rows, long.dropped, null).at(-1)
    expect(last).toMatchObject({ key: 'row-449', text: 'answer 449' })
    const longer = applyEvent(long, said(450))
    expect(blocks(longer.rows, longer.dropped, null).find(block => block.key === 'row-449')).toMatchObject({ text: 'answer 449' })
  })

  test("an edit's diff is its result's patch, numbered as the file is; without one it is built from the call and says so", () => {
    const watch = applyEvent(empty, { type: 'reset', entries: ENTRIES.map(one => ({ model: one.entry.model as never, text: one.text })) })
    const edit = watch.rows.find(row => row.kind === 'tool' && row.id === 'e1')
    if (edit?.kind !== 'tool') throw new Error('no edit row')
    expect(diffOf(edit)).toEqual({ source: PATCH.slice(PATCH.indexOf('@@')).replace(/\n$/, ''), added: 1, removed: 1, isNumbered: true, omitted: 0 })
    const bare = diffOf({ ...edit, patch: null })
    expect(bare).toEqual({ source: '@@ -1,1 +1,1 @@\n-const re = /^[^+]+@/\n+const re = /^[^@]+@/', added: 1, removed: 1, isNumbered: false, omitted: 0 })
    expect(diffOf({ ...edit, name: 'write', patch: null, args: { path: 'a.txt', content: 'one\ntwo\n' } })).toEqual({ source: '@@ -0,0 +1,2 @@\n+one\n+two', added: 2, removed: 0, isNumbered: true, omitted: 0 })
    expect(diffOf({ ...edit, name: 'bash', patch: null, args: { command: 'ls' } })).toBeNull()
  })

  test("a patch keeps its last blank context line, and a removed line starting with dashes counts as removed", () => {
    const patch = (body: string) => diffOf({ kind: 'tool', id: 'e', name: 'edit', summary: '', outcome: 'ok', args: {}, output: '', lines: 0, patch: body })
    // The hunk counts three lines on each side; the blank one is a single space.
    expect(patch('--- a\n+++ a\n@@ -1,3 +1,3 @@\n-one\n+two\n three\n \n')?.source).toBe('@@ -1,3 +1,3 @@\n-one\n+two\n three\n ')
    expect(patch('@@ -1,1 +1,1 @@\n--- a rule\n+++ a rule\n')).toMatchObject({ added: 1, removed: 1 })
  })

  test("a diff built from an edit's call keeps whole replacements up to the patch bound and counts the rest", () => {
    const edits = Array.from({ length: 14 }, (_, n) => ({ oldText: `${n}${'o'.repeat(3_999)}`, newText: `${n}${'n'.repeat(3_999)}` }))
    const diff = diffOf({ kind: 'tool', id: 'e', name: 'edit', summary: '', outcome: 'ok', args: { path: 'a.ts', edits }, output: '', lines: 0, patch: null })
    expect(diff?.source.length).toBeLessThanOrEqual(20_000)
    expect(diff?.source.split('\n').filter(line => line.startsWith('@@'))).toHaveLength(2)
    expect(diff).toMatchObject({ added: 2, removed: 2, omitted: 12 })
  })

  test('closed threads fold under the open ones; a filter opens the fold it matches', () => {
    const threads = parseThreads(THREADS)
    const [api, web] = groupThreads(threads, '', {})
    expect(api).toMatchObject({ project: 'api', closed: [], isUnfolded: false })
    expect(web!.open.map(one => one.title)).toEqual(['Fix login form 500s'])
    expect(web!.closed.map(one => one.title)).toEqual(['Old idea'])
    expect(web!.isUnfolded).toBe(false)
    expect(groupThreads(threads, '', { 'closed-web': true })[1]!.isUnfolded).toBe(true)
    const filtered = groupThreads(threads, 'old', {})
    expect(filtered.map(group => group.project)).toEqual(['web'])
    expect(filtered[0]).toMatchObject({ open: [], isUnfolded: true })
  })

  test("times read as the dashboard's: spans, a run's clock, and never", () => {
    expect(since(0, 5_000)).toBe('never')
    expect(since(1_000, 30_000)).toBe('just now')
    expect(since(0 + 1, 5 * 60_000)).toBe('5 min ago')
    expect(clock(72_000)).toBe('1m 12s')
    expect(clock(3 * 3_600_000 + 60_000)).toBe('3h 1m')
  })

  test('a preview links while it can be opened: ready, or paused, which a visit wakes; not while archived or starting', () => {
    const detail = parseDetail(DETAIL)
    const [web, api] = detail.previews
    expect(previewLook(detail, web!)).toMatchObject({ linked: true, label: 'ready' })
    expect(previewLook(detail, api!)).toMatchObject({ linked: false, label: 'starting' })
    expect(previewLook({ ...detail, pylon: { ...detail.pylon, actualState: 'paused' } }, api!)).toMatchObject({ linked: true, hint: 'Opening it wakes the pylon.' })
    expect(previewLook({ ...detail, thread: { ...detail.thread, status: 'archived' } }, web!)).toMatchObject({ linked: false, hint: 'Unarchive the thread to open it.' })
  })
})
