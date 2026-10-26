// A fake Nexus CLI for the pane's tests: the test's process hooks answer each
// command from fixtures, and the engine's other calls the pane makes.
import { mock, type TestBody } from 'claude-code/testing'

import { fieldOf } from '../hooks/keys'

type Body = Parameters<TestBody>

export const ID = 'th-4f2a00000001'
export const T0 = 1_000_000_000_000
const MIN = 60_000

export const THREAD = {
  id: ID,
  title: 'Fix login form 500s',
  project: 'web',
  status: 'active',
  agentTurnRunning: true,
  createdAt: T0 - 12 * MIN,
  lastHumanActivityAt: T0 - 2 * MIN,
  lastAgentActivityAt: T0,
  lastReplyAt: T0 - 60_000,
  seenAt: T0 - 60_000,
  pylonId: 'pylon-7f3a',
  conversationId: '7',
  pylon: { node: 'firebat', actualState: 'running', failed: null },
  desired: 'running',
  attention: 'working',
}

export const THREADS = [
  THREAD,
  { ...THREAD, id: 'th-9b0000000002', title: 'Old idea', status: 'archived', agentTurnRunning: false, createdAt: T0 - 90 * MIN, pylon: { node: 'firebat', actualState: 'paused', failed: null }, desired: 'paused', attention: null },
  { id: 'th-7c0000000003', title: 'API docs', project: 'api', status: 'idle', agentTurnRunning: false, createdAt: T0 - 3 * 60 * MIN, lastHumanActivityAt: T0 - 3 * 60 * MIN, lastAgentActivityAt: T0 - 3 * 60 * MIN, lastReplyAt: T0 - 3 * 60 * MIN, seenAt: T0 - 3 * 60 * MIN, pylonId: 'p3', conversationId: '9', pylon: { node: 'testbench', actualState: 'paused', failed: null }, desired: 'paused', attention: null },
]

export const WEB_PREVIEW = { pylon: 'pylon-7f3a', service: 'web', httpsPort: 10201, ready: true, url: 'https://rj-firebat.example.ts.net:10201/' }
const API_PREVIEW = { pylon: 'pylon-7f3a', service: 'api', httpsPort: 10202, ready: false, url: 'https://rj-firebat.example.ts.net:10202/' }
/** A declared service with its preview, an ad hoc server with none yet, and a service declared without one. */
export const PORTS = [
  { port: 3000, service: 'web', preview: WEB_PREVIEW },
  { port: 5173, service: null, preview: null },
  { port: 9229, service: 'worker', preview: null },
]
/** What `nexus preview <thread> 5173 --wait` prints once the node serves it. */
export const OPENED = { pylon: 'pylon-7f3a', service: 'port-5173', httpsPort: 10203, ready: true, url: 'https://rj-firebat.example.ts.net:10203/' }

export const DETAIL = {
  thread: THREAD,
  attention: 'working',
  seenAt: THREAD.seenAt,
  lastReplyAt: THREAD.lastReplyAt,
  pylon: { id: 'pylon-7f3a', node: 'firebat', actualState: 'running', failed: null, observedAt: new Date(T0 - 12_000).toISOString(), retryRefused: null },
  sessions: [{ herdrPane: 'nexus:1.2', harness: 'claude-code', harnessSessionId: '9c1e', status: 'working', pylon: 'pylon-7f3a' }],
  previews: [WEB_PREVIEW, API_PREVIEW],
  ports: PORTS,
  outputs: [
    { thread: ID, kind: 'branch', ref: 'fix/login-plus' },
    { thread: ID, kind: 'preview', ref: 'web' },
  ],
  agent: { parkedTasks: 0 },
  desired: 'running',
  attach: 'herdr --session nexus-7f3a',
}

/** The details once 5173 is published: a linked port's preview, which `unpreview` can close. */
export const PUBLISHED = { ...DETAIL, previews: [...DETAIL.previews, OPENED], ports: PORTS.map(one => (one.port === 5173 ? { ...one, preview: OPENED } : one)) }

export const NODES = [
  { name: 'firebat', tailnetHost: 'rj-firebat.example.ts.net', tailnetNodeId: 'n1', state: 'online', capacity: null, observedAt: null },
  { name: 'testbench', tailnetHost: 'testbench.example.ts.net', tailnetNodeId: 'n2', state: 'offline', capacity: null, observedAt: null },
]

export const PROJECTS = [
  { id: 'web', repoUrl: 'git@github.com:me/web.git', defaultBranch: 'main', defaultNode: 'firebat' },
  { id: 'api', repoUrl: 'git@github.com:me/api.git', defaultBranch: 'trunk', defaultNode: 'testbench' },
]

const user = (id: number, text: string, timestamp: number) => ({ entry: { id, model: [{ role: 'user', content: text, timestamp }] }, text: `> ${text}` })
const assistant = (id: number, content: unknown[]) => ({ entry: { id, model: [{ role: 'assistant', model: 'claude-opus-5-5', content }] }, text: '' })
const call = (id: string, name: string, args: unknown) => ({ type: 'toolCall', id, name, arguments: args })
const said = (text: string) => ({ type: 'text', text })
const result = (id: number, callId: string, name: string, text: string, isError = false, details?: unknown) => ({
  entry: { id, model: [{ role: 'toolResult', toolCallId: callId, toolName: name, content: [{ type: 'text', text }], isError, ...(details ? { details } : {}) }] },
  text: '',
})

export const PATCH = [
  'Index: src/auth/email.ts',
  '===================================================================',
  '--- src/auth/email.ts',
  '+++ src/auth/email.ts',
  '@@ -11,3 +11,3 @@',
  " import { parse } from './parse'",
  '-const re = /^[^+]+@/',
  '+const re = /^[^@]+@/',
  ' export { re }',
  '',
].join('\n')

/** A turn with prose, a failed command, an edit with its patch, four reads that fold and a command still running. */
export const ENTRIES = [
  user(1, 'The login form answers 500 when the email has a plus sign. Fix it.', T0 - 72_000),
  assistant(2, [said("I'll reproduce it **first**."), call('b1', 'bash', { command: 'npm test -- login', timeout: 120 })]),
  result(3, 'b1', 'bash', 'FAIL src/login.test.ts\n  ✕ accepts plus addressing\n\nCommand exited with code 1', true),
  assistant(4, [call('e1', 'edit', { path: 'src/auth/email.ts', edits: [{ oldText: 'const re = /^[^+]+@/', newText: 'const re = /^[^@]+@/' }] })]),
  result(5, 'e1', 'edit', 'Successfully replaced 1 block in src/auth/email.ts.', false, { diff: '', patch: PATCH, firstChangedLine: 12 }),
  assistant(6, [said('Fixed: the regex rejected plus addressing.'), ...['a', 'b', 'c', 'd'].map(name => call(`r-${name}`, 'read', { path: `src/${name}.ts` }))]),
  ...['a', 'b', 'c', 'd'].map((name, index) => result(7 + index, `r-${name}`, 'read', 'line\n'.repeat(10 + index))),
  // pi's call IDs hold a `|`, as the real ones do.
  assistant(11, [call('call_b2|fc_9', 'bash', { command: 'npm test' })]),
]

export const state = (run: string, extra: Record<string, unknown> = {}) => ({ type: 'state', thread: ID, status: 'active', run, parkedTasks: 0, queued: 0, pylon: 'running', failed: null, ports: PORTS, ...extra })
export const live = (extra: Record<string, unknown> = {}) => ({ type: 'live', thread: ID, queued: [], tools: [], partial: null, retry: null, ...extra })

/** A Claude Code worker thread (CLI 0.17.0): no harness conversation, its turn a reported session's. */
export const WORKER = { ...THREAD, id: 'th-c1a0de000009', title: 'Add a health check', conversationId: null, agentTurnRunning: false, sessionTurnRunning: true }
export const WORKER_DETAIL = { ...DETAIL, thread: WORKER, agent: null, claudeWorker: { model: 'claude-opus-5-5', state: 'started' } }

/** What `nexus conversation` prints for the worker: a prompt, an answer, an edit, a failed command, a message queued behind the turn. */
export const CONVERSATION = {
  kind: 'claude',
  session: '5e55-10n',
  entries: [
    { kind: 'prompt', at: T0 - 90_000, text: '/poteto-mode add a health check', from: 'command' },
    { kind: 'reply', at: T0 - 80_000, text: 'Adding `/healthz`.' },
    { kind: 'tool', at: T0 - 70_000, id: 'toolu_1', name: 'Edit', input: { file_path: 'src/server.ts', old_string: 'app.listen()', new_string: "app.get('/healthz', ok)\napp.listen()" } },
    { kind: 'result', at: T0 - 69_000, toolUseId: 'toolu_1', output: 'The file src/server.ts has been updated.', isError: false },
    { kind: 'tool', at: T0 - 60_000, id: 'toolu_2', name: 'Bash', input: { command: 'npm test', description: 'Run the tests' } },
    { kind: 'result', at: T0 - 50_000, toolUseId: 'toolu_2', output: 'FAIL server.test.ts', isError: true },
    { kind: 'queue', at: T0 - 40_000, op: 'enqueue', text: 'also update the docs' },
    { kind: 'sparkle', at: T0 - 30_000, text: 'a kind from a newer CLI' },
  ],
  dropped: 0,
  readAt: T0,
  working: true,
}

/** `changes --json` since the pylon booted: a nested folder, a rename, a deletion, a binary file and a file at the root. */
export const CHANGES = {
  base: { kind: 'start', commit: 'a1b2c3d' },
  files: [
    { path: 'src/auth/login.ts', oldPath: null, status: 'modified', additions: 12, deletions: 3 },
    { path: 'src/auth/session.ts', oldPath: 'src/auth/old-session.ts', status: 'renamed', additions: 2, deletions: 2 },
    { path: 'src/ui/logo.png', oldPath: null, status: 'added', additions: null, deletions: null },
    { path: 'src/ui/Form.tsx', oldPath: null, status: 'deleted', additions: 0, deletions: 40 },
    { path: 'README.md', oldPath: null, status: 'modified', additions: 1, deletions: 0 },
  ],
  truncated: false,
}

/** `diff --json` of src/auth/login.ts: two hunks, the second further down the file. */
export const DIFF = {
  base: { kind: 'start', commit: 'a1b2c3d' },
  diff: [
    'diff --git a/src/auth/login.ts b/src/auth/login.ts',
    'index 3f2a1b0..9c8d7e6 100644',
    '--- a/src/auth/login.ts',
    '+++ b/src/auth/login.ts',
    '@@ -10,4 +10,5 @@ export async function login(form: FormData) {',
    "   const email = form.get('email')",
    '-  const user = await db.find(email)',
    '+  const user = await db.users.find(email)',
    "+  if (!user) throw new HttpError(401, 'unknown user')",
    '   return session(user)',
    ' }',
    '@@ -40,2 +41,2 @@ function session(user: User) {',
    '-  return sign(user.id)',
    '+  return sign(user.id, { ttl: HOUR })',
    ' }',
    '',
  ].join('\n'),
  truncated: false,
}

export type Fake = {
  /** Every `$.process.run` argv, the CLI's name dropped. */
  runs: string[][]
  /** Every `$.process.spawn` argv, the CLI's name dropped. */
  spawns: string[][]
  threads: unknown[]
  /** What `projects` lists; `project add` adds to it, as the control plane does. */
  projects: unknown[]
  detail: unknown
  /** What `changes` answers; `--uncommitted` and `--turn` get the same files against HEAD or the latest turn. */
  changes: unknown
  /** What `diff` answers, for any file. */
  diff: unknown
  /** What `conversation` answers: a Claude Code worker's transcript. */
  conversation: unknown
  /** What `send` answers. */
  sent: unknown
  /** Whether the Herdr tab of an attach still runs it, as `herdr pane process-info` reports. */
  attaching: boolean
  /** The watch's lines in order; a `{ delay }` holds the stream that long on the test's clock first. */
  watch: unknown[]
  /** A verb whose answer comes that many milliseconds late on the test's clock. */
  slow: Record<string, number>
  /** A verb that fails: its exit code and stderr. */
  fail: Record<string, { exitCode: number; error: string }>
  /** What a verb prints in place of its usual answer, as a CLI that disagrees with docs/cli.md would. */
  printed: Record<string, unknown>
  /** Whether `preview` and `unpreview` change what `show` lists, as the control plane does; false as if another client undid each at once. */
  publishes: boolean
  /** The answer AskUserQuestion gives. */
  answer: string
  asked: string[]
  /** Each ask's answers, in the order the dialog lists them. */
  offered: string[][]
  copied: string[]
  /** Every `$.ui.toast` text. */
  toasts: string[]
  opens: number
  isOpen: boolean
  /** What `$.store` holds, from the session's start on: the theme tip is taken as said unless a test says otherwise. */
  store: Record<string, unknown>
  /** The pane `session open` answers with. */
  nextPane: string
  /** What `nexus --version` prints after `nexus `. */
  version: string
  /** Every herdr argv, `herdr` dropped. */
  herdr: string[][]
  /** A herdr command, by its two words, that fails with this message. */
  herdrFail: Record<string, string>
  /** The environment the mod reads: Herdr's variables when a test runs it inside Herdr. */
  env: Record<string, string>
  /** Runs before each `$.store.set` lands, to hold one while the test does something else. */
  saving?: (key: string, value: unknown) => Promise<void>
}

/**
 * `project add`'s arguments as node:util's parseArgs reads them for the CLI (strict, positionals allowed): `--name=value`
 * or `--name value` is an option, anything after `--` a positional; or the error the CLI prints.
 */
function parseProjectAdd(args: readonly string[]): { values: Record<string, string>; positionals: string[] } | string {
  const values: Record<string, string> = {}
  const positionals: string[] = []
  for (let at = 0; at < args.length; at++) {
    const arg = args[at]!
    if (arg === '--') {
      positionals.push(...args.slice(at + 1))
      break
    }
    if (!arg.startsWith('--')) {
      positionals.push(arg)
      continue
    }
    const [name, inline] = arg.slice(2).split(/=(.*)/s)
    if (name === 'json') continue
    if (name !== 'node' && name !== 'branch') return `Unknown option '--${name}'`
    const value = inline ?? args[++at]
    if (value === undefined) return `Option '--${name} <value>' argument missing`
    values[name] = value
  }
  return positionals.length === 2 ? { values, positionals } : `project add takes 2 arguments, got ${positionals.length}`
}

export function fake(change: Partial<Fake> = {}): Fake {
  // A copy, as the mod writes the store a test reads: a fixture shared by tests would carry one's writes into the next.
  const store = structuredClone(change.store ?? { themeNotice: true })
  return { runs: [], spawns: [], threads: THREADS, projects: PROJECTS, detail: DETAIL, changes: CHANGES, diff: DIFF, conversation: CONVERSATION, sent: { submission: 3 }, attaching: false, watch: [{ type: 'reset', thread: ID, entries: ENTRIES }, state('working'), live()], slow: {}, fail: {}, printed: {}, publishes: true, answer: 'Keep', asked: [], offered: [], copied: [], toasts: [], opens: 0, isOpen: false, nextPane: 'nexus:2.1', version: '0.17.0', herdr: [], herdrFail: {}, env: {}, ...change, store }
}

/** `detail` with the linked preview of `port` published, or gone when `preview` is null. */
function withPreview(detail: unknown, port: number, preview: typeof OPENED | null) {
  const shown = detail as typeof DETAIL
  const service = `port-${port}`
  return {
    ...shown,
    previews: [...shown.previews.filter(one => one.service !== service), ...(preview ? [preview] : [])],
    ports: shown.ports?.map(one => (one.port === port ? { ...one, preview } : one)) ?? null,
  }
}

/**
 * `thread` as the control plane leaves it once `seen` marks its latest reply, or with `upTo` (`--last-reply-at`) no reply
 * after that one and never lower than it was: its attention what follows `reply` once nothing is left unread.
 */
function markedSeen<T>(thread: T, upTo: number | null): T {
  const one = thread as typeof THREAD
  const seenAt = upTo === null ? one.lastReplyAt : Math.max(one.seenAt ?? upTo, Math.min(upTo, one.lastReplyAt ?? upTo))
  const isRead = seenAt === one.lastReplyAt
  return { ...one, seenAt, attention: one.attention === 'reply' && isRead ? (one.agentTurnRunning ? 'working' : null) : one.attention } as T
}

const reply = (json: unknown) => ({ value: { exitCode: 0, stdout: JSON.stringify(json), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

/** Boots the mod over `cli`: its session, the engine's answers, and a clock that starts at T0 and moves only when told. */
export async function boot(...[$, on, cli]: [...Body, Fake]) {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, cli.env)
  // The store as the mod leaves it, which a test reads back.
  on('store.get', (_, e) => ({ value: cli.store[e.key] }))
  on('store.set', async (_, e) => {
    await cli.saving?.(e.key, e.value)
    cli.store[e.key] = e.value
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    delete cli.store[e.key]
    return { value: undefined }
  })
  const answers: Record<string, () => unknown> = {
    nodes: () => NODES,
    projects: () => cli.projects,
    threads: () => cli.threads,
    show: () => cli.detail,
    wake: () => null,
    seen: () => null,
    send: () => cli.sent,
    abort: () => null,
    retry: () => null,
    'retry-pylon': () => null,
    archive: () => ({ ...THREAD, status: 'archived' }),
    unarchive: () => THREAD,
    delete: () => ({ ...THREAD, status: 'deleted' }),
    start: () => ({ ...THREAD, id: 'th-123456789abc', title: 'New one', agentTurnRunning: false }),
    preview: () => OPENED,
    unpreview: () => null,
    changes: () => cli.changes,
    diff: () => cli.diff,
    conversation: () => cli.conversation,
  }
  on('process.run', async (_, e) => {
    const argv = e.argv.slice(1)
    if (e.argv[0] === 'herdr') {
      // herdr prints its answer as JSON on stdout, and an error as JSON on stderr.
      cli.herdr.push(argv)
      const error = cli.herdrFail[`${argv[0]} ${argv[1]}`]
      if (error) return { value: { exitCode: 1, stdout: '', stderr: `${JSON.stringify({ error: { code: 'failed', message: error }, id: 'cli:request' })}\n`, isStdoutTruncated: false, isStderrTruncated: false } }
      if (argv[1] === 'process-info') return reply({ id: 'cli:pane:process_info', result: { process_info: { foreground_process_group_id: cli.attaching ? 41 : 40, shell_pid: 40 } } })
      return reply(argv[0] === 'tab' ? { id: 'cli:tab:create', result: { tab: { tab_id: 'w9:t3' }, root_pane: { pane_id: 'w9:p7' } } } : { id: 'cli:pane:run', result: { type: 'ok' } })
    }
    cli.runs.push(argv)
    if (argv[0] === '--version') return { value: { exitCode: 0, stdout: `nexus ${cli.version}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    // `session open` and `session close` are slowed or failed by both words.
    const verb = argv[0] === 'session' ? `session ${argv[1]}` : argv[0]!
    const late = cli.slow[verb]
    // The engine kills a run that outlasts its timeout, and the call rejects.
    const timeout = e.init?.timeoutMs ?? 30_000
    if (late && late > timeout) {
      await clock.sleep(timeout)
      throw new Error(`timed out after ${timeout} ms`)
    }
    if (late) await clock.sleep(late)
    const failure = cli.fail[verb]
    if (failure) return { value: { exitCode: failure.exitCode, stdout: '', stderr: `${JSON.stringify({ error: failure.error, kind: 'failed', status: 500 })}\n`, isStdoutTruncated: false, isStderrTruncated: false } }
    if (argv[0] === 'seen') {
      // `nexus seen --json <thread> [--last-reply-at=<ms>]`.
      const id = argv.find(arg => arg.startsWith('th-'))
      const flag = argv.find(arg => arg.startsWith('--last-reply-at='))
      const upTo = flag === undefined ? null : Number(flag.slice('--last-reply-at='.length))
      cli.threads = cli.threads.map(one => ((one as typeof THREAD).id === id ? markedSeen(one, upTo) : one))
      const detail = cli.detail as typeof DETAIL
      if (detail.thread.id === id) cli.detail = { ...markedSeen(detail, upTo), thread: markedSeen(detail.thread, upTo) }
    }
    if (argv[0] === 'project') {
      // `nexus project add`, read as the CLI's strict parseArgs reads it, its project built from its arguments.
      const added = parseProjectAdd(argv.slice(2))
      if (typeof added === 'string') return { value: { exitCode: 64, stdout: '', stderr: `${JSON.stringify({ error: added, kind: 'invalid', status: null })}\n`, isStdoutTruncated: false, isStderrTruncated: false } }
      const { values, positionals: [id, repoUrl] } = added
      const project = { id, repoUrl, defaultBranch: values.branch ?? 'main', defaultNode: values.node, resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null }
      cli.projects = [...cli.projects, project]
      return reply(project)
    }
    if (verb === 'session open') {
      // `nexus session open --json [--harness=…] [--title=…] -- <thread>`: the title is the harness's name unless given.
      const flag = (name: string) => argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
      const harness = flag('harness') ?? 'claude-code'
      return reply({ herdrPane: cli.nextPane, harness, title: flag('title') ?? harness })
    }
    return reply(answers[argv[0]!]?.() ?? null)
  })
  on('process.spawn', async function* (_, e) {
    const argv = e.argv.slice(1)
    cli.spawns.push(argv)
    if (argv[0] === 'watch') {
      for (const event of cli.watch) {
        if (typeof event === 'object' && event !== null && 'delay' in event) await clock.sleep(event.delay as number)
        else yield { stream: 'stdout' as const, text: `${JSON.stringify(event)}\n` }
      }
      // A live watch holds until it is stopped.
      await clock.sleep(10 * 60 * MIN)
    } else {
      const late = cli.slow[argv[0]!]
      if (late) await clock.sleep(late)
      const failure = cli.fail[argv[0]!]
      if (failure) {
        yield { stream: 'stderr' as const, text: `${JSON.stringify({ error: failure.error, kind: 'failed', status: 500 })}\n` }
        return { value: { code: failure.exitCode, signal: null } }
      }
      if (argv[0] === 'project' && !('project' in cli.printed)) {
        const added = parseProjectAdd(argv.slice(2))
        if (typeof added === 'string') throw new Error(added)
        const { values, positionals: [id, repoUrl] } = added
        const project = { id, repoUrl, defaultBranch: values.branch ?? 'main', defaultNode: values.node, resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null }
        cli.projects = [...cli.projects, project]
        yield { stream: 'stdout' as const, text: JSON.stringify(project) }
        return { value: { code: 0, signal: null } }
      }
      if (cli.publishes && (argv[0] === 'preview' || argv[0] === 'unpreview')) {
        cli.detail = withPreview(cli.detail, Number(argv[3]), argv[0] === 'preview' ? OPENED : null)
      }
      // `--uncommitted` compares with HEAD instead of the commit the pylon booted on, and `--turn` with the latest turn's snapshot.
      const base = argv.includes('--uncommitted') ? { kind: 'head', commit: 'f00d123' } : argv.includes('--turn') ? { kind: 'turn', commit: '7e1f00d' } : null
      if ((argv[0] === 'changes' || argv[0] === 'diff') && base && !(argv[0] in cli.printed)) {
        const answer = answers[argv[0]]!() as { base: unknown }
        yield { stream: 'stdout' as const, text: JSON.stringify({ ...answer, base }) }
        return { value: { code: 0, signal: null } }
      }
      yield { stream: 'stdout' as const, text: JSON.stringify(argv[0]! in cli.printed ? cli.printed[argv[0]!] : (answers[argv[0]!]?.() ?? null)) }
    }
    return { value: { code: 0, signal: null } }
  })
  on('command.register', () => ({ value: { command: 'nexus' } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__nexus__${e.name}` } }))
  on('ui.open', () => {
    cli.opens += 1
    cli.isOpen = true
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => {
    cli.isOpen = false
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: cli.isOpen ? [{ id: 'nexus', title: 'Nexus', isShown: true, isFocused: true, isPlaced: true }] : [] }))
  on('ui.toast', (_, e) => {
    cli.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.copy', (_, e) => {
    cli.copied.push(e.text)
    return { value: { isCopied: true } } as never
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    const questions = (e as unknown as { questions: { question: string; options: { label: string }[] }[] }).questions
    cli.asked.push(questions[0]!.question)
    cli.offered.push(questions[0]!.options.map(option => option.label))
    return { result: { questions, answers: { [questions[0]!.question]: cli.answer } } } as never
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const nexus = async (args: string) => {
    const done = await $.command.run({ command: 'nexus', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } } as never)
    // The pane's watch writes what it read within 100 ms.
    await clock.advance(100)
    return done
  }
  const mount = (columns = 100, rows = 60) =>
    $.ui.mount({
      plugin: 'nexus',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'nexus',
      props: { title: 'Nexus', isFocused: true, bodyColumns: columns, placement: 'dock', scroll: { offset: 0, bodyRows: rows }, view: {} },
    })
  const strip = (columns = 120) =>
    $.ui.mount({ plugin: 'nexus', surface: 'terminal', component: 'AbovePrompt', requestId: 'above-prompt', props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: columns, scroll: { offset: 0, bodyRows: 20 }, view: {} } } as never)
  return { clock, nexus, mount, strip }
}

type Ui = Awaited<ReturnType<Awaited<ReturnType<typeof boot>>['mount']>>

/** The key the field `name` is drawn under now (`fieldKey`), or `name` itself when it is not drawn. */
export const field = async (ui: Ui, name: string) => (await ui.findAll({ type: 'Input' })).find(one => one.key !== undefined && fieldOf(one.key) === name)?.key ?? name

/**
 * What the fields of a mounted pane show, as 2.1.310's field store keeps it (read from its renderer): the typing, by
 * key, until a drawing gives that key a `value` other than the one this mount last drew, then that `value`; Enter empties
 * the field it submits once its hooks answer, unless it was typed in since, and the pane's answer at once. The kit
 * draws no fields, so this reads each drawing the test takes as the engine reads every drawing. A pane closed loses its
 * store, so a pane opened again is a new mount with a new `typing`.
 */
export function typing(ui: Ui) {
  const typed = new Map<string, string>()
  const drawn = new Map<string, unknown>()
  const read = async () => {
    const inputs = await ui.findAll({ type: 'Input' })
    for (const one of inputs) {
      if (drawn.has(one.key!) && drawn.get(one.key!) !== one.props.value) typed.delete(one.key!)
      drawn.set(one.key!, one.props.value)
    }
    return inputs
  }
  return {
    /** Types `text` over the field `name`, as the person editing it does. */
    async type(name: string, text: string) {
      await read()
      const key = await field(ui, name)
      typed.set(key, text)
      await ui.input({ key, text, kind: 'change' })
    },
    /**
     * Enter in the field `name`: the engine delivers its text and empties the field once the submit's hooks answer,
     * which the pane's do at once, as they start their work without waiting for it. The kit's `ui.input` waits for that
     * work, so the field is emptied as the submit is sent. `typing` is text whose changes have not landed yet; `during`
     * types into the emptied field while the submit's work runs.
     */
    async submit(name: string, options: { typing?: string; during?: () => Promise<void> } = {}) {
      await read()
      const key = await field(ui, name)
      if (options.typing !== undefined) typed.set(key, options.typing)
      const text = typed.get(key) ?? ((await ui.find({ type: 'Input', key }))?.props.value as string | undefined) ?? ''
      const submitted = ui.input({ key, text, kind: 'submit' })
      typed.set(key, '')
      await options.during?.()
      await submitted
    },
    /** Types `text` over the field `key` as it is drawn now, its change still on its way to the mod. */
    async typeInto(key: string, text: string) {
      typed.set(key, text)
      await ui.input({ key, text, kind: 'change' })
    },
    /** What the field `name` shows, or undefined when it is not drawn. */
    async shows(name: string) {
      const one = (await read()).find(input => fieldOf(input.key!) === name)
      return one && (typed.get(one.key!) ?? (one.props.value as string | undefined) ?? '')
    },
  }
}

/**
 * Every theme key Claude Code names: a colour outside them would not follow the person's theme. Two more are the
 * dock's paint: the bash message's background, ANSI black under dark-ansi, under the body, and the user message's
 * band under the title bar, both keys every theme holds.
 */
export const THEME_KEYS = new Set([
  'text', 'inverseText', 'inactive', 'subtle', 'suggestion', 'remember', 'success', 'error', 'warning', 'merged', 'claude', 'permission',
  'planMode', 'autoAccept', 'promptBorder', 'bashBorder', 'ide', 'diffAdded', 'diffRemoved', 'diffAddedDimmed', 'diffRemovedDimmed', 'diffAddedWord', 'diffRemovedWord',
  'bashMessageBackgroundColor', 'userMessageBackground',
])
