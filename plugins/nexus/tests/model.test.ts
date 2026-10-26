import { describe, expect, test } from 'claude-code/testing'

import type { NexusRow, NexusRunState, NexusSession, NexusSessionChanges, NexusThread, NexusWatch } from '../types'
import {
  type WatchEntry,
  type ToolRow,
  type WatchEvent,
  appendEntry,
  applyEvent,
  attachCommand,
  blocks,
  clip,
  clock,
  diffOf,
  exitCode,
  foldReply,
  foldSummary,
  groupThreads,
  herdrError,
  isOlder,
  isSettled,
  isUnread,
  keepTail,
  leftOut,
  matchThread,
  parseClaudeConversation,
  parseCommand,
  parseSent,
  parseStarted,
  parseDetail,
  parseFailure,
  parseHerdrTab,
  parseThreads,
  parseVersion,
  parseWatchEvent,
  previewLook,
  settleSessions,
  shellQuote,
  shownSessions,
  since,
  sentText,
  threadState,
} from '../hooks/model'
import { CONVERSATION, DETAIL, ENTRIES, PATCH, T0, THREADS, WEB_PREVIEW, WORKER_DETAIL, state } from './fake-cli'

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
  lastReplyAt: null,
  seenAt: null,
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
    expect(detail).toMatchObject({ desired: 'running', attach: 'herdr --session nexus-7f3a', conversation: 'agent', worker: null, pylon: { retryRefused: null, observedAt: DETAIL.pylon.observedAt } })
    expect(detail.sessions).toEqual([{ id: 'nexus:1.2', state: 'running', herdrPane: 'nexus:1.2', harness: 'claude-code', harnessSessionId: '9c1e', status: 'working', title: null, message: null }])
    expect(() => parseDetail({ ...DETAIL, desired: undefined })).toThrow('nexus show printed no desired')
    expect(() => parseDetail({ ...DETAIL, attach: undefined })).toThrow('nexus show printed no attach')
  })

  test('rows and details carry the attention and the seen marker of CLI 0.10.0; one without them throws, and an attention this mod does not know asks nothing', () => {
    const [fresh] = parseThreads(THREADS)
    expect(fresh).toMatchObject({ attention: 'working', lastReplyAt: THREADS[0]!.lastReplyAt, seenAt: THREADS[0]!.seenAt })
    expect(parseDetail({ ...DETAIL, attention: 'reply' })).toMatchObject({ attention: 'reply', thread: { lastReplyAt: DETAIL.thread.lastReplyAt, seenAt: DETAIL.thread.seenAt } })
    expect(parseThreads([{ ...THREADS[0], attention: 'pondering' }])[0]!.attention).toBeNull()
    expect(() => parseThreads([{ ...THREADS[0], attention: undefined }])).toThrow('nexus threads printed a thread (th-4f2a00000001) without its attention')
    expect(() => parseThreads([{ ...THREADS[0], seenAt: undefined }])).toThrow('nexus threads printed a thread (th-4f2a00000001) without seenAt')
    expect(() => parseDetail({ ...DETAIL, thread: { ...DETAIL.thread, lastReplyAt: undefined } })).toThrow('nexus show printed a thread (th-4f2a00000001) without lastReplyAt')
    expect(isUnread({ lastReplyAt: 5, seenAt: 4 })).toBe(true)
    expect(isUnread({ lastReplyAt: 5, seenAt: null })).toBe(true)
    expect(isUnread({ lastReplyAt: 5, seenAt: 5 })).toBe(false)
    expect(isUnread({ lastReplyAt: null, seenAt: null })).toBe(false)
    // A start is read only for its ID and title: a CLI before 0.10.0 still starts a thread.
    const { lastReplyAt: _, seenAt: __, ...old } = THREADS[0]!
    expect(parseStarted(old)).toMatchObject({ id: THREADS[0]!.id, lastReplyAt: null, seenAt: null })
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

describe('/nexus session', () => {
  test('quotes anywhere in a word, as a shell reads them: --title="two words" is one title, its quotes gone', () => {
    const id = 'th-4f2a00000001'
    expect(parseCommand(`session open ${id} --title="two words"`)).toEqual({ verb: 'session-open', thread: id, title: 'two words' })
    expect(parseCommand(`session open ${id} --title="login"`)).toEqual({ verb: 'session-open', thread: id, title: 'login' })
    expect(parseCommand(`session open ${id} --title 'two words' --harness=shell`)).toEqual({ verb: 'session-open', thread: id, title: 'two words', harness: 'shell' })
    expect(parseCommand(`session open ${id} --title=it\\'s" a "test`)).toEqual({ verb: 'session-open', thread: id, title: "it's a test" })
    expect(parseCommand(`session open ${id} --title="it's"`)).toEqual({ verb: 'session-open', thread: id, title: "it's" })
    expect(parseCommand(`session open ${id} --title="two words`)).toEqual({ verb: 'invalid', reason: expect.stringMatching(/^\/nexus session has a quote it does not close\./) })
  })

  test('close takes a session by its pane or its ID', () => {
    const id = 'th-4f2a00000001'
    expect(parseCommand(`session close ${id} failed-0123456789ab`)).toEqual({ verb: 'session-close', thread: id, session: 'failed-0123456789ab' })
    expect(parseCommand(`session close ${id}`)).toEqual({ verb: 'session-close', thread: id })
  })
})

describe('paused and failed sessions', () => {
  const PANE = { pylon: 'pylon-th1', herdrPane: 'w1:p1', harness: 'claude-code', harnessSessionId: 'bd2c2d6b', title: 'review', status: 'working' }
  const PAUSED = { ...PANE, id: 'w1:p1', state: 'paused', message: null }
  const FAILED = { pylon: 'pylon-th1', id: 'failed-0123456789ab', herdrPane: null, harness: 'pi', harnessSessionId: '/home/user/.pi/agent/sessions/s.jsonl', title: 'plan', status: 'unknown', state: 'failed', message: 'herdr agent start: the agent did not start.' }
  const sessionsOf = (sessions: unknown[]) => parseDetail({ ...DETAIL, sessions }).sessions

  test('show lists a paused session with the pane it had and a failed one with its message, by the ID session close takes', () => {
    expect(sessionsOf([PAUSED, FAILED])).toEqual([
      { id: 'w1:p1', state: 'paused', herdrPane: 'w1:p1', harness: 'claude-code', harnessSessionId: 'bd2c2d6b', title: 'review', status: 'working', message: null },
      { id: 'failed-0123456789ab', state: 'failed', herdrPane: null, harness: 'pi', harnessSessionId: '/home/user/.pi/agent/sessions/s.jsonl', title: 'plan', status: 'unknown', message: 'herdr agent start: the agent did not start.' },
    ])
  })

  test('a control plane before CLI 0.8.0 sends no state, id or message: the session runs, and its ID is its pane', () => {
    expect(sessionsOf([PANE])).toEqual([{ id: 'w1:p1', state: 'running', herdrPane: 'w1:p1', harness: 'claude-code', harnessSessionId: 'bd2c2d6b', title: 'review', status: 'working', message: null }])
  })

  test('a state the mod does not know, a failed session without its message, a running one without its pane or one without an ID is a contract error', () => {
    expect(() => sessionsOf([{ ...PAUSED, state: 'waking' }])).toThrow('nexus show printed a session (w1:p1) in a state it does not know, "waking", which docs/cli.md requires')
    expect(() => sessionsOf([{ ...FAILED, message: null }])).toThrow('a failed session (failed-0123456789ab) without its message')
    expect(() => sessionsOf([{ ...PANE, id: 'w1:p1', state: 'running', herdrPane: null }])).toThrow('a running session (w1:p1) without its herdrPane')
    expect(() => sessionsOf([{ ...FAILED, id: undefined }])).toThrow('a session without its id')
  })

  test("a close confirmed hides the session by its ID, or by its harness's session ID once a wake moved it to another pane, until the details agree or 30 s pass", () => {
    const [running] = sessionsOf([PANE])
    const moved = sessionsOf([{ ...PANE, herdrPane: 'w2:p1', id: 'w2:p1', state: 'running' }])
    const changes = { opening: [], opened: [], closing: [], closed: { 'w1:p1': { at: T0, harnessSessionId: 'bd2c2d6b' } } }
    expect(shownSessions([running!], changes, T0 + 1_000)).toEqual([])
    expect(shownSessions(moved, changes, T0 + 1_000)).toEqual([])
    expect(shownSessions(moved, changes, T0 + 30_000)).toEqual(moved)
    expect(settleSessions(changes, moved, T0 + 1_000)).toBe(changes)
    expect(settleSessions(changes, [], T0 + 1_000).closed).toEqual({})
  })

  test('an open confirmed shows until the details list it in its pane, or in another pane after a wake as a session of its harness and title with a harness session ID not listed before', () => {
    const claude = (pane: string, harnessSessionId: string | null) => ({ ...PANE, herdrPane: pane, id: pane, state: 'running', harnessSessionId })
    // A, a Claude Code "review" listed when B, another, was opened in w3:p1.
    const [a] = sessionsOf([claude('w1:p1', 'aaaa')])
    const opened: NexusSessionChanges['opened'][number] = { session: { herdrPane: 'w3:p1', harness: 'claude-code', title: 'review' }, at: T0, before: { ids: ['w1:p1'], harnessSessionIds: ['aaaa'] } }
    const changes = { opening: [], opened: [opened], closing: [], closed: {} }
    const ids = (sessions: NexusSession[], with_ = changes) => shownSessions(sessions, with_, T0 + 1_000).map(one => [one.id, one.status])
    expect(ids([a!])).toEqual([['w1:p1', 'working'], ['w3:p1', 'opened']])
    // A wake moves A to w2:p1 before the node reports B: A keeps its harness session ID, so B still shows as opened.
    const movedA = sessionsOf([claude('w2:p1', 'aaaa')])
    expect(ids(movedA)).toEqual([['w2:p1', 'working'], ['w3:p1', 'opened']])
    expect(settleSessions(changes, movedA, T0 + 1_000)).toBe(changes)
    // B reported in another pane with a harness session ID of its own settles it.
    const both = [...movedA, ...sessionsOf([claude('w4:p1', 'bbbb')])]
    expect(ids(both)).toEqual([['w2:p1', 'working'], ['w4:p1', 'working']])
    expect(settleSessions(changes, both, T0 + 1_000).opened).toEqual([])
    // One with no harness session ID could be A, moved, so only its pane tells; the row stays until it times out.
    expect(ids([...movedA, ...sessionsOf([claude('w4:p1', null)])])).toEqual([['w2:p1', 'working'], ['w4:p1', 'working'], ['w3:p1', 'opened']])
    // A new session of another title or harness is not B.
    expect(settleSessions(changes, [...movedA, ...sessionsOf([{ ...claude('w4:p1', 'bbbb'), title: 'other' }])], T0 + 1_000)).toBe(changes)
    expect(settleSessions(changes, [...movedA, ...sessionsOf([{ ...claude('w4:p1', 'bbbb'), harness: 'pi' }])], T0 + 1_000)).toBe(changes)
    // A session listed before without its harness session ID, as Claude Code at its login is, reporting one now is not B.
    const late = sessionsOf([claude('w7:p1', 'eeee')])
    expect(settleSessions({ ...changes, opened: [{ ...opened, before: { ids: ['w1:p1', 'w7:p1'], harnessSessionIds: ['aaaa'] } }] }, late, T0 + 1_000).opened).toHaveLength(1)
    // Without what was listed before, only the pane tells.
    expect(ids(both, { ...changes, opened: [{ ...opened, before: null }] })).toEqual([['w2:p1', 'working'], ['w4:p1', 'working'], ['w3:p1', 'opened']])
  })

  test("stale details listing the pane's earlier session in the open's pane do not settle the open", () => {
    // The earlier "review" in w3:p1 closed, and the open got its pane; details read before the node noticed still list it.
    const opened: NexusSessionChanges['opened'][number] = { session: { herdrPane: 'w3:p1', harness: 'claude-code', title: 'review' }, at: T0, before: { ids: ['w3:p1'], harnessSessionIds: ['old1'] } }
    const changes = { opening: [], opened: [opened], closing: [], closed: {} }
    const stale = sessionsOf([{ ...PANE, herdrPane: 'w3:p1', id: 'w3:p1', state: 'running', harnessSessionId: 'old1' }])
    expect(settleSessions(changes, stale, T0 + 1_000)).toBe(changes)
    expect(shownSessions(stale, changes, T0 + 1_000).map(row => [row.id, row.status])).toEqual([['w3:p1', 'working'], ['w3:p1', 'opened']])
    expect(settleSessions(changes, stale, T0 + 30_000).opened).toEqual([])
    // The open's own session in that pane settles it.
    const fresh = sessionsOf([{ ...PANE, herdrPane: 'w3:p1', id: 'w3:p1', state: 'running', harnessSessionId: 'new1' }])
    expect(settleSessions(changes, fresh, T0 + 1_000).opened).toEqual([])
  })

  test('two opens of one harness and title never settle against one session', () => {
    const before = { ids: [], harnessSessionIds: [] }
    const first = { session: { herdrPane: 'w3:p1', harness: 'claude-code' as const, title: 'review' }, at: T0, before }
    const second = { session: { herdrPane: 'w5:p1', harness: 'claude-code' as const, title: 'review' }, at: T0, before }
    const changes = { opening: [], opened: [first, second], closing: [], closed: {} }
    // A wake moved both before the node reported either, and the details list one of them so far.
    const one = sessionsOf([{ ...PANE, herdrPane: 'w6:p1', id: 'w6:p1', state: 'running', harnessSessionId: 'cccc' }])
    expect(shownSessions(one, changes, T0 + 1_000).map(row => [row.id, row.status])).toEqual([['w6:p1', 'working'], ['w5:p1', 'opened']])
    expect(settleSessions(changes, one, T0 + 1_000).opened).toEqual([second])
    // A session in an open's own pane goes to that open, not to one matched by title.
    const own = sessionsOf([{ ...PANE, herdrPane: 'w5:p1', id: 'w5:p1', state: 'running', harnessSessionId: 'dddd' }])
    expect(settleSessions(changes, own, T0 + 1_000).opened).toEqual([first])
  })

  test('nexus --version reads as numbers, and an older version compares before a newer one', () => {
    expect(parseVersion('nexus 0.6.0\n')).toEqual([0, 6, 0])
    expect(parseVersion('usage')).toBeNull()
    expect(isOlder([0, 7, 9], [0, 8, 0])).toBe(true)
    expect(isOlder([0, 8, 0], [0, 8, 0])).toBe(false)
    expect(isOlder([1, 0, 0], [0, 8, 0])).toBe(false)
  })
})

describe('attaching in a Herdr tab', () => {
  test('the attach command names the configured CLI, quoted for a shell, and plain nexus by default', () => {
    expect(attachCommand('nexus', 'th-4f2a00000001')).toBe('nexus attach th-4f2a00000001')
    expect(attachCommand('/Users/me/My Tools/nexus', 'th-4f2a00000001')).toBe("'/Users/me/My Tools/nexus' attach th-4f2a00000001")
  })

  test('shellQuote leaves a plain word bare and single-quotes anything else, a quote inside closed and escaped', () => {
    expect(shellQuote('nexus')).toBe('nexus')
    expect(shellQuote('/usr/local/bin/nexus')).toBe('/usr/local/bin/nexus')
    expect(shellQuote('th-4f2a00000001')).toBe('th-4f2a00000001')
    expect(shellQuote('/Users/me/My Tools/nexus')).toBe("'/Users/me/My Tools/nexus'")
    expect(shellQuote("/opt/it's/nexus")).toBe("'/opt/it'\\''s/nexus'")
    expect(shellQuote("a b'c")).toBe("'a b'\\''c'")
    expect(shellQuote('$(rm -rf ~); `x`')).toBe("'$(rm -rf ~); `x`'")
    expect(shellQuote('')).toBe("''")
  })

  test("herdr's tab and its errors: the root pane, else null; the error's message, else what it printed, else its exit code", () => {
    expect(parseHerdrTab('{"id":"cli:tab:create","result":{"tab":{"tab_id":"w7:t1"},"root_pane":{"pane_id":"w7:p2"}}}')).toBe('w7:p2')
    expect(parseHerdrTab('{"result":{}}')).toBe(null)
    expect(parseHerdrTab('not json')).toBe(null)
    expect(herdrError(1, '', '{"error":{"code":"workspace_not_found","message":"workspace w9 not found"},"id":"cli:tab:create"}\n')).toBe('workspace w9 not found')
    expect(herdrError(2, '', 'error: unexpected argument --nope\n')).toBe('error: unexpected argument --nope')
    expect(herdrError(1, '', '')).toBe('herdr exited with 1')
  })
})

describe('Claude Code worker threads', () => {
  test("a worker's transcript folds into the rows a watch gives: its tools named as pi's, a result settling its call, the queue apart", () => {
    const reading = parseClaudeConversation(CONVERSATION)
    expect(reading.working).toBe(true)
    expect(reading.queued).toEqual(['also update the docs'])
    expect(reading.rows.map(row => [row.kind, row.kind === 'tool' ? `${row.name} ${row.outcome}` : row.text])).toEqual([
      ['user', '/poteto-mode add a health check'],
      ['assistant', 'Adding `/healthz`.'],
      ['tool', 'edit ok'],
      ['tool', 'bash error'],
    ])
    const edit = reading.rows[2] as ToolRow
    expect(edit.summary).toBe('src/server.ts')
    expect(diffOf(edit)).toMatchObject({ source: "@@ -1,1 +1,2 @@\n-app.listen()\n+app.get('/healthz', ok)\n+app.listen()", added: 2, removed: 1, isNumbered: false })
    expect((reading.rows[3] as ToolRow).output).toBe('FAIL server.test.ts')
    // Claude takes a queued message by its text, or its oldest without one.
    const taken = parseClaudeConversation({ ...CONVERSATION, entries: [...CONVERSATION.entries, { kind: 'queue', at: T0, op: 'enqueue', text: 'then a demo' }, { kind: 'queue', at: T0, op: 'remove', text: 'then a demo' }, { kind: 'queue', at: T0, op: 'dequeue', text: null }] })
    expect(taken.queued).toEqual([])
  })

  test('a prompt from elsewhere, a background task, a notice and a record Nexus does not know show as notices; the entries left out count', () => {
    const reading = parseClaudeConversation({
      kind: 'claude',
      session: null,
      dropped: 12,
      readAt: null,
      working: false,
      entries: [
        { kind: 'prompt', at: 1, text: 'a hook said this', from: 'other' },
        { kind: 'task', at: 2, toolUseId: 'toolu_9', status: 'completed', summary: 'Agent "review" finished', result: 'Looks good.' },
        { kind: 'notice', at: 3, tone: 'error', text: 'API Error: 529 overloaded' },
        { kind: 'record', at: null, type: 'mystery', summary: 'mystery: {"a":1}' },
        { kind: 'turn', at: 4, durationMs: 9_000 },
      ],
    })
    expect(reading.rows).toEqual([
      { kind: 'notice', tone: 'dim', text: 'a hook said this', entry: 12 },
      { kind: 'notice', tone: 'dim', text: 'Background task completed: Agent "review" finished\nLooks good.', entry: 13 },
      { kind: 'notice', tone: 'error', text: 'API Error: 529 overloaded', entry: 14 },
      { kind: 'notice', tone: 'dim', text: 'mystery: {"a":1}', entry: 15 },
    ])
    expect(reading.dropped).toBe(12)
    expect(() => parseClaudeConversation({ entries: [] })).toThrow("nexus conversation printed a Claude worker's conversation, which docs/cli.md requires")
  })

  test('a row keeps its key when the transcript window slides past an entry that drew no row', () => {
    const keys = (json: unknown) => blocks(parseClaudeConversation(json).rows, 0, null).map(block => [block.key, block.kind])
    const entries = [{ kind: 'turn', at: 1, durationMs: 5 }, ...CONVERSATION.entries.slice(0, 2)]
    const before = keys({ ...CONVERSATION, entries, dropped: 2997 })
    const after = keys({ ...CONVERSATION, entries: entries.slice(1), dropped: 2998 })
    expect(before).toEqual([['entry-2998', 'user'], ['entry-2999', 'assistant']])
    expect(after).toEqual(before)
  })

  test("a worker's details say whose conversation it has and how its launch went; a reported session's turn counts as working", () => {
    const detail = parseDetail(WORKER_DETAIL)
    expect(detail).toMatchObject({ conversation: 'claude', worker: { state: 'started', model: 'claude-opus-5-5', message: null }, thread: { agentTurnRunning: true } })
    expect(parseDetail({ ...WORKER_DETAIL, claudeWorker: { model: null, state: 'stalled', message: 'no launch receipt' } }).worker).toEqual({ state: 'stalled', model: null, message: 'no launch receipt' })
    expect(parseDetail({ ...DETAIL, thread: { ...THREADS[0], conversationId: null } }).conversation).toBeNull()
  })

  test("a send says what it did: a harness thread's message queued for its agent, or typed into the worker's session, resumed first or queued behind its turn", () => {
    expect(sentText('th-1', parseSent({ submission: 3 }))).toBe('Sent to th-1.')
    expect(sentText('th-1', parseSent({ claude: { session: 's', outcome: 'sent', resumed: false } }))).toBe('Sent to the Claude Code session of th-1.')
    expect(sentText('th-1', parseSent({ claude: { session: 's', outcome: 'sent', resumed: true } }))).toBe('Sent to the Claude Code session of th-1. Nexus resumed the session first, as no pane ran it.')
    expect(sentText('th-1', parseSent({ claude: { session: 's', outcome: 'queued', resumed: false } }))).toBe('Queued in the Claude Code session of th-1: Claude reads it at its next tool step, or after this turn.')
    expect(() => parseSent({ claude: { session: 's' } })).toThrow('without its outcome')
  })
})
