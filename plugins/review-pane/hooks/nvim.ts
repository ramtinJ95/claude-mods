import type { AnnotationKind } from '../types'
import type { DiffRow } from './diff'

/** A place Neovim's quickfix list jumps to: the first line of a run of changes in the working file. */
export type Stop = { file: string; line: number; text: string }

/**
 * One stop per run of changed lines, at its first line in the working file; a run that only
 * deletes stops at the line after it. A file with no hunk (binary, mode change) stops at line 1.
 */
export function changeStops(files: readonly string[], rows: readonly DiffRow[]): Stop[] {
  const stops: Stop[] = []
  let file = -1
  let hasStop = true
  let next = 1
  let inRun = false
  const close = () => {
    if (file >= 0 && !hasStop) stops.push({ file: files[file]!, line: 1, text: 'no line changes' })
  }
  for (const row of rows) {
    if (row.kind === 'file') {
      close()
      file = row.file
      hasStop = false
      inRun = false
      continue
    }
    if (row.kind === 'hunk') {
      next = Number(/ \+(\d+)/.exec(row.text)?.[1] ?? 1)
      inRun = false
      continue
    }
    if (row.kind === 'add' || row.kind === 'del') {
      if (!inRun) stops.push({ file: files[file]!, line: Math.max(1, row.newLine ?? next), text: `${row.text[0]} ${row.text.slice(1).trim()}` })
      hasStop = true
      inRun = true
      if (row.newLine !== undefined) next = row.newLine + 1
      continue
    }
    if (row.kind === 'ctx') {
      inRun = false
      next = row.newLine! + 1
    }
  }
  close()
  return stops
}

export const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

/** Runs after the person's config: lazy.nvim resets the runtimepath while it sets up. */
const START = 'lua vim.opt.rtp:append(vim.env.REVIEW_PANE_RTP); require("review_pane").start(vim.env.REVIEW_PANE_DIR)'

/** The script that opens the review, run by whatever splits the terminal or by the person. Paths reach Lua as environment variables, so none is quoted for Vim. */
export function openScript(root: string, dir: string, runtime: string): string {
  return [
    '#!/bin/sh',
    `cd ${shellQuote(root)} || exit 1`,
    `REVIEW_PANE_DIR=${shellQuote(dir)} REVIEW_PANE_RTP=${shellQuote(runtime)} exec nvim --listen ${shellQuote(`${dir}/nvim.sock`)} -c ${shellQuote(START)}`,
    '',
  ].join('\n')
}

/**
 * The `--remote-expr` calling the Lua side's `fn` with `payload` as JSON. Inside a single-quoted
 * Vim string only `'` needs escaping (doubled), and JSON.stringify writes no raw newline.
 */
export function luaCall(fn: 'answer' | 'finished', payload: unknown): string {
  return `luaeval("require'review_pane'.${fn}(_A)", '${JSON.stringify(payload).replaceAll("'", "''")}')`
}

/** An annotation as Neovim sends it to finish: on a file's lines, or with no file on the changes as a whole. */
export type FileNote = { kind: AnnotationKind; file?: string; start?: number; end?: number; lines?: string[]; body: string }

export type AskEvent = {
  type: 'ask'
  id: number
  token: string
  file: string
  start: number
  end: number
  lines: string[]
  context: { start: number; lines: string[] }
  body: string
}

/** What Neovim appends to events.jsonl. */
export type NvimEvent = AskEvent | { type: 'finish'; annotations: FileNote[] } | { type: 'closed'; count: number }

export function parseEvent(line: string): NvimEvent | undefined {
  try {
    const value = JSON.parse(line) as { type?: unknown }
    if (value.type === 'ask' || value.type === 'finish' || value.type === 'closed') return value as NvimEvent
  } catch {
    // An unreadable line is reported by the caller.
  }
  return undefined
}
