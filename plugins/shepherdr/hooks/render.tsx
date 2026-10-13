// How the `agents` tool's calls, results and pushed reports look to the
// person. The model keeps reading the same JSON and agent_report text; these
// rows only draw it. Each takes the surface's element table from the hook.
import type { BoxProps, ElementConstructor, MarkdownProps, TextProps } from 'claude-code'

export type Draw = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Markdown: ElementConstructor<MarkdownProps>
}

type Input = Record<string, unknown>

const str = (value: unknown) => (typeof value === 'string' ? value : undefined)

function firstLine(text: string, max = 80): string {
  const line = text.trim().split('\n')[0] ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** `target` on `machine`, as the call names them. */
function where(input: Input): string {
  const machine = str(input['machine'])
  return `${str(input['target']) ?? ''}${machine ? ` on ${machine.slice(0, 8)}` : ''}`
}

/** One line saying what the call does. */
export function callSummary(input: Input): string {
  const action = str(input['action']) ?? 'help'
  switch (action) {
    case 'help':
      return input['commands'] ? `commands ${where(input)}` : 'help'
    case 'list': {
      const filters = [str(input['machine']), str(input['status']), str(input['query'])].filter(Boolean)
      return filters.length ? `list ${filters.join(' ')}` : 'list'
    }
    case 'spawn': {
      const machine = str(input['machine'])
      return `spawn ${str(input['agent_type'])} "${str(input['label'])}"${machine ? ` on ${machine.slice(0, 8)}` : ''}: ${firstLine(str(input['message']) ?? '', 60)}`
    }
    case 'assign':
    case 'send':
      return `${action} ${where(input)}: ${firstLine(str(input['message']) ?? '', 60)}`
    case 'answer': {
      const answers = Array.isArray(input['answers']) ? (input['answers'] as Input[]) : []
      const picked = answers
        .map(answer => [...((answer['selections'] as string[] | undefined) ?? []), str(answer['other'])].filter(Boolean).join(', '))
        .join(' / ')
      return `answer ${where(input)}: ${picked || '(custom)'}`
    }
    default:
      return `${action} ${where(input)}`
  }
}

export function CallRow({ Box, Text }: Draw, input: Input, state: { isRunning: boolean; isErrored: boolean }) {
  const blocking = input['blocking'] !== false && ['spawn', 'assign', 'answer'].includes(str(input['action']) ?? '')
  return (
    <Box>
      <Text bold color="claude">shepherdr </Text>
      <Text>{callSummary(input)}</Text>
      {state.isRunning && <Text dimColor>{blocking ? '  waiting for the worker…' : '  …'}</Text>}
    </Box>
  )
}

type Report = { status: string; target: string; name?: string; machine?: string; body: string }

// Attributes are quoted and escaped (fleet.ts reportText), so a quoted value
// may hold anything but a quote.
const REPORT = /<agent_report((?:\s+[a-z_]+="[^"]*")*)>\n?([\s\S]*?)\n?<\/agent_report>/g

const unescape = (value: string) =>
  value.replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')

/** The agent_report blocks a text holds, in order. */
export function parseReports(text: string): Report[] {
  return [...text.matchAll(REPORT)].map(([, attributes = '', body = '']) => {
    const value = (name: string) => {
      const found = attributes.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1]
      return found === undefined ? undefined : unescape(found)
    }
    return {
      status: value('status') ?? 'done',
      target: value('target') ?? '',
      ...(value('name') ? { name: value('name') } : {}),
      ...(value('machine') ? { machine: value('machine') } : {}),
      body: body.replaceAll('<\\/agent_report>', '</agent_report>'),
    }
  })
}

const STATUS_COLOR: Record<string, string> = {
  done: 'success',
  failed: 'error',
  question: 'warning',
  blocked: 'warning',
  interrupted: 'warning',
  closed: 'subtle',
}

type Prompt = { title: string; body?: string; multiple: boolean; choices: { label: string; description?: string }[] }

/** An Ask's prompts with everything needed to choose: body, choices and their descriptions. */
function prompts({ Box, Text }: Draw, list: readonly Prompt[], askId?: string) {
  return (
    <Box flexDirection="column">
      {list.map(prompt => (
        <Box flexDirection="column">
          <Text>
            <Text bold>{prompt.title}</Text>
            {prompt.multiple && <Text dimColor> (several)</Text>}
          </Text>
          {prompt.body && <Text>{prompt.body}</Text>}
          {prompt.choices.map(choice => (
            <Text>
              {`  · ${choice.label}`}
              {choice.description && <Text dimColor>{`  ${choice.description}`}</Text>}
            </Text>
          ))}
        </Box>
      ))}
      {askId && <Text dimColor>{`ask_id ${askId}`}</Text>}
    </Box>
  )
}

/** A question's body is its JSON line and a hint. */
function questionBody(draw: Draw, body: string) {
  const [json = '', ...hint] = body.split('\n').filter(line => !line.startsWith('Task: '))
  try {
    const ask = JSON.parse(json) as { ask_id?: string; prompts?: Prompt[]; question?: string }
    return (
      <draw.Box flexDirection="column">
        {ask.question && <draw.Text>{ask.question}</draw.Text>}
        {prompts(draw, ask.prompts ?? [], ask.ask_id)}
        <draw.Text dimColor>{hint.join(' ')}</draw.Text>
      </draw.Box>
    )
  } catch {
    return <draw.Text>{body}</draw.Text>
  }
}

export function ReportRows(draw: Draw, reports: readonly Report[]) {
  const { Box, Text, Markdown } = draw
  return (
    <Box flexDirection="column">
      {reports.map(report => {
        const lines = report.body.split('\n')
        const task = lines.find(line => line.startsWith('Task: '))
        const rest = lines.filter(line => line !== task).join('\n').trim()
        return (
          <Box flexDirection="column" marginBottom={reports.length > 1 ? 1 : 0}>
            <Text>
              <Text bold color={STATUS_COLOR[report.status] ?? 'text'}>{report.status}</Text>
              <Text>{`  ${report.name ?? report.target}`}</Text>
              <Text dimColor>{`  ${report.target}${report.machine ? ` on ${report.machine.slice(0, 8)}` : ''}`}</Text>
            </Text>
            {task && <Text dimColor>{firstLine(task, 120)}</Text>}
            {report.status === 'question' ? questionBody(draw, rest) : rest ? <Markdown text={rest} /> : null}
          </Box>
        )
      })}
    </Box>
  )
}

/** Reports the mod pushed into the session as a prompt of their own. */
export function PushedReports(draw: Draw, reports: readonly Report[]) {
  const { Box, Text } = draw
  return (
    <Box flexDirection="column">
      <Text bold color="claude">shepherdr report</Text>
      {ReportRows(draw, reports)}
    </Box>
  )
}

type Agent = { target: string; name?: string; kind: string; status: string; cwd?: string; machine?: string; machine_name?: string; watched?: boolean }

/** A result the call's own JSON line describes; undefined draws the engine's row. */
export function ResultRow(draw: Draw, output: string) {
  const { Box, Text } = draw
  const reports = parseReports(output)
  const head = output.split('\n')[0] ?? ''
  let value: Input | undefined
  try {
    value = head.startsWith('{') ? (JSON.parse(head) as Input) : undefined
  } catch {
    value = undefined
  }
  if (reports.length && !value) return ReportRows(draw, reports)
  if (!value) return undefined
  const line = (text: string) => <Text dimColor>{text}</Text>
  // An answer's status, then the worker's settlement when it waited for one.
  if ('ask_id' in value)
    return (
      <Box flexDirection="column">
        {line(`answer ${String(value['status'])}${value['input_sent'] === false ? ' (already recorded; nothing sent)' : ''}`)}
        {reports.length > 0 && ReportRows(draw, reports)}
      </Box>
    )
  if (Array.isArray(value['agents'])) {
    const agents = value['agents'] as Agent[]
    const unavailable = (value['unavailable'] as { machine_name?: string; machine?: string; error: string }[] | undefined) ?? []
    return (
      <Box flexDirection="column">
        {agents.length === 0 && line('no agents')}
        {agents.map(agent => (
          <Text>
            <Text color={agent.status === 'working' ? 'claude' : agent.status === 'blocked' ? 'warning' : 'text'}>{agent.status.padEnd(8)}</Text>
            <Text>{` ${agent.name ?? agent.target}`}</Text>
            <Text dimColor>{` ${agent.target} ${agent.kind}${agent.machine ? ` on ${agent.machine_name ?? ''} (${agent.machine})` : ''}${agent.watched ? ' · watched' : ''}${agent.cwd ? `  ${agent.cwd}` : ''}`}</Text>
          </Text>
        ))}
        {unavailable.map(entry => (
          <Text color="error">{`${entry.machine_name ?? entry.machine ?? 'this machine'}: ${entry.error}`}</Text>
        ))}
      </Box>
    )
  }
  if (Array.isArray(value['commands']))
    return line((value['commands'] as { name: string }[]).map(command => `/${command.name}`).join('  '))
  // Help is reference text: the default row keeps all of it.
  if (Array.isArray(value['profiles'])) return undefined
  if ('watching' in value) return line(`${value['watching'] ? 'watching' : 'stopped watching'} ${String(value['target'])}`)
  if ('commandSubmitted' in value) return line(`command sent to ${String(value['target'])} (${String(value['delivery'])})`)
  if ('delivery' in value)
    return line(
      `${value['status'] === 'working' ? 'working in the background' : 'delivered'} · ${String(value['name'] ?? value['target'])} ${String(value['target'])} (${String(value['delivery'])})`,
    )
  if ('reply' in value || 'text' in value || 'ask' in value) {
    const agent = value['agent'] as Agent | undefined
    const ask = value['ask'] as { toolCallId: string; prompts: Prompt[] } | undefined
    return (
      <Box flexDirection="column">
        {line(`${agent?.name ?? agent?.target ?? ''} ${agent?.status ?? ''}`)}
        {typeof value['reply'] === 'string' && <draw.Markdown text={value['reply']} />}
        {typeof value['text'] === 'string' && <Text>{value['text']}</Text>}
        {ask && <Text color="warning">pending question</Text>}
        {ask && prompts(draw, ask.prompts, ask.toolCallId)}
      </Box>
    )
  }
  return undefined
}
