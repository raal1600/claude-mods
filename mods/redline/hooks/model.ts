// The timeline's data and the rules that build it: no engine calls here, so
// every function is tested and run on plain values.
import type { Entry, EventKind, Inspected, Now, Rank, SessionEvent } from '../types'

export const MAX_ENTRIES = 80
export const MAX_EVENTS = 150

// Bookkeeping tools that say nothing about the work itself.
const IGNORED =
  /^(ToolSearch|Skill|TodoWrite|TaskCreate|TaskUpdate|TaskList|TaskGet|ListAgents|mcp__ccd_turn__|mcp__ccd_view__|mcp__ccd_session__mark_chapter|mcp__ccd_session__dismiss_task|mcp__visualize__read_me)/

const base = (path: unknown): string | undefined => {
  if (typeof path !== 'string' || path === '') return undefined

  return path.split('/').filter(Boolean).at(-1) ?? path
}

export const short = (text: unknown, n = 60): string | undefined => {
  if (typeof text !== 'string') return undefined
  const one = text.replace(/\s+/g, ' ').trim()
  if (one === '') return undefined

  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

const host = (url: unknown): string | undefined => {
  if (typeof url !== 'string') return undefined
  const m = /^[a-z]+:\/\/([^/?#]+)/i.exec(url)

  return m?.[1] ? m[1].replace(/^www\./, '') : short(url, 40)
}

const TESTS =
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\b(jest|vitest|pytest|mocha|playwright\s+test|rspec|phpunit)\b|\b(cargo|go|swift|deno)\s+test\b|\bplugin\s+test\b/

/** What a tool call is on the timeline; null for bookkeeping to leave out. */
export const classify = (
  tool: string,
  input: Record<string, unknown>,
): { kind: EventKind; text: string } | null => {
  if (IGNORED.test(tool)) return null
  const as = (kind: EventKind, text: string | undefined, fallback: string) => ({
    kind,
    text: text ?? fallback,
  })

  switch (tool) {
    case 'Read':
    case 'NotebookRead':
      return as('read', base(input.file_path ?? input.notebook_path), 'a file')
    case 'Grep':
    case 'Glob':
    case 'LS':
      return as('read', short(input.pattern ?? input.path, 40), 'search')
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return as('edit', base(input.file_path ?? input.notebook_path), 'a file')
    case 'Bash': {
      const command = typeof input.command === 'string' ? input.command : ''
      const text = short(input.description) ?? short(command)
      if (/\bgh\s+pr\s+create\b/.test(command)) return as('pr', text, 'pull request')
      if (/\bgit\s+commit\b/.test(command)) return as('commit', text, 'commit')
      if (TESTS.test(command)) return as('test', text, 'tests')

      return as('run', text, 'command')
    }
    case 'WebFetch':
      return as('web', host(input.url), 'page')
    case 'WebSearch':
      return as('web', short(input.query, 40), 'search')
    case 'Agent':
    case 'Task':
      return as('agent', short(input.description), 'subagent')
    case 'AskUserQuestion':
      return as('ask', undefined, 'asked you a question')
    case 'Artifact':
      return as('publish', base(input.file_path) ?? short(input.action, 20), 'page')
  }

  if (/^mcp__ccd_session__(start_session|hand_off_to_session)$/.test(tool))
    return as('session', short(input.title), 'side session')
  if (/^mcp__(Claude_Browser|claude-in-chrome)__/.test(tool))
    return as('web', host(input.url) ?? tool.split('__').at(-1), 'browser')
  if (tool.startsWith('mcp__')) {
    const parts = tool.split('__')
    const server = parts[1] ?? tool
    // Connector ids are often uuids; the tool's own name reads better then.
    const name = /^[0-9a-f-]{20,}$/i.test(server) ? (parts[2] ?? server) : `${server} ${parts[2] ?? ''}`

    return as('tool', short(name.replace(/^plugin_/, '').replace(/_/g, ' '), 40), 'connector')
  }

  return as('tool', tool, tool)
}

/** A person's message with the machine's wrappers taken off. */
export const plain = (text: string): string =>
  text
    .replace(/<([a-z][\w-]*)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/\[Image:[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const FILLER =
  /^(hey|hi|ok(ay)?|so|yes|yeah|please|can you|could you|i want( you)? to|i need( you)? to|i'd like( you)? to|let's|now)[,.!]?\s+/i

/** A prompt cut to a few words: an entry's name until it earns a title. */
export const labelOf = (text: string): string => {
  const cleaned = plain(text).replace(FILLER, '').replace(FILLER, '')
  const words = cleaned.split(/\s+/).filter(Boolean)
  const label = words.slice(0, 9).join(' ')
  const out = words.length > 9 ? `${label}…` : label

  return out === '' ? 'New request' : out.charAt(0).toUpperCase() + out.slice(1)
}

export const newEntry = (prompt: string, at: number, seed: number): Entry => ({
  id: `${at}-${seed}`,
  at,
  prompt,
  rank: 'pending',
  events: [],
})

export const addEntry = (list: Entry[], prompt: string, at: number): Entry[] =>
  [...list, newEntry(prompt, at, list.length)].slice(-MAX_ENTRIES)

const withLast = (list: Entry[], at: number, change: (last: Entry) => Entry): Entry[] => {
  const all = list.length === 0 ? [newEntry('Session start', at, 0)] : list
  const last = all.at(-1) ?? newEntry('Session start', at, 0)

  return [...all.slice(0, -1), change(last)]
}

/** Appends one event to the latest entry: every call its own row. */
export const addEvent = (list: Entry[], event: SessionEvent): Entry[] =>
  withLast(list, event.at, last => {
    const events = [...last.events, event]
    const over = events.length - MAX_EVENTS

    return over > 0
      ? { ...last, events: events.slice(over), dropped: (last.dropped ?? 0) + over }
      : { ...last, events }
  })

/** Settles the event a tool call opened, wherever it sits. */
export const settleEvent = (
  list: Entry[],
  id: string,
  isError: boolean,
  endedAt?: number,
): Entry[] =>
  list.map(entry =>
    entry.events.some(ev => ev.id === id)
      ? {
          ...entry,
          events: entry.events.map(ev =>
            ev.id === id
              ? {
                  ...ev,
                  status: isError ? 'error' : 'ok',
                  ...(endedAt !== undefined && ev.at > 0 ? { ms: Math.max(0, endedAt - ev.at) } : {}),
                }
              : ev,
          ),
        }
      : entry,
  )

const TANGIBLE: ReadonlySet<EventKind> = new Set(['edit', 'commit', 'pr', 'publish', 'session'])

/** The rank an entry gets with no model to ask: did it change anything? */
export const guessRank = (entry: Entry): Rank =>
  entry.events.some(ev => TANGIBLE.has(ev.kind)) ? 'milestone' : 'step'

export const titleOf = (entry: Entry): string => entry.title ?? labelOf(entry.prompt)

/** Builds the timeline from a transcript, for a session that ran before the mod. */
export const fromMessages = (
  messages: readonly {
    role: string
    text: string
    toolUses: readonly {
      tool_use_id: string
      tool: string
      input: Record<string, unknown>
      isError?: true
    }[]
  }[],
): Entry[] => {
  let list: Entry[] = []
  // An entry's outcome: its wrap-up recap, else the last thing Claude said.
  let hasRecap = false
  const outcome = (summary: string) => {
    const last = list.at(-1)
    if (last) list = [...list.slice(0, -1), { ...last, summary }]
  }
  for (const m of messages) {
    const text = plain(m.text)
    if (m.role === 'user' && text !== '') {
      list = addEntry(list, short(text, 160) ?? text, 0)
      hasRecap = false
      continue
    }
    if (m.role === 'assistant' && text !== '' && !hasRecap) outcome(short(text, 400) ?? text)
    for (const use of m.toolUses) {
      if (use.tool === 'mcp__ccd_turn__wrap_up' && typeof use.input.recap === 'string') {
        outcome(use.input.recap)
        hasRecap = true
      }
      const step = classify(use.tool, use.input)
      if (step)
        list = addEvent(list, {
          id: use.tool_use_id,
          at: 0,
          kind: step.kind,
          text: step.text,
          status: use.isError ? 'error' : 'ok',
          tool: use.tool,
        })
    }
  }

  return list
}

/** Folds one task-list update into what is current. */
export const planned = (n: Now, input: Record<string, unknown>): Now => {
  const items = Array.isArray(input.items)
    ? (input.items as { content?: unknown; status?: unknown }[])
    : undefined
  if (items) {
    const plan = items.map(it => (typeof it.content === 'string' ? it.content : '…'))
    const at = items.findIndex(it => it.status === 'in_progress')
    const firstOpen = items.findIndex(it => it.status !== 'completed')

    return { ...n, plan, current: at >= 0 ? at : firstOpen >= 0 ? firstOpen : plan.length }
  }
  const plan = n.plan ?? []
  if (typeof input.start === 'number') return { ...n, current: input.start - 1 }
  if (input.advance === true) return { ...n, current: Math.min((n.current ?? 0) + 1, plan.length) }

  return n
}

// --- Asking a small model what each entry amounted to -----------------------

export const JUDGE_SYSTEM = [
  'You label entries on a timeline of a working session between a person and an AI coding assistant.',
  'For each numbered entry you get what the person asked, what the assistant did, and how it ended.',
  'Answer with a JSON array only, one object per entry, each carrying the entry number it is for:',
  '[{"n": 1, "title": "...", "milestone": true}]',
  'title: 2 to 5 words saying what was accomplished or settled, past tense, concrete, no filler,',
  'no quotes, no trailing period. Name the thing ("Built sidebar timeline", "Fixed failing clock test").',
  'Judge each entry by its own Asked and Ended lines only, never by its neighbours.',
  'milestone: true only when something tangible was built, changed, fixed, shipped or decided.',
  'false for questions, clarifications, explanations and small exchanges.',
].join(' ')

export const judgePrompt = (entries: readonly Entry[], answer?: string): string =>
  entries
    .map((entry, i) => {
      const counts = new Map<string, number>()
      for (const ev of entry.events) counts.set(ev.kind, (counts.get(ev.kind) ?? 0) + 1)
      const did = [...counts].map(([kind, n]) => `${kind} ×${n}`).join(', ')
      const sample = entry.events
        .slice(-10)
        .map(ev => `${ev.kind} ${ev.text}${ev.status === 'error' ? ' (failed)' : ''}`)
        .join('; ')
      const end = entry.summary ?? (i === entries.length - 1 ? answer : undefined)

      return [
        `Entry ${i + 1}`,
        `Asked: ${short(entry.prompt, 300) ?? ''}`,
        `Did: ${did === '' ? 'nothing with tools' : did}`,
        sample === '' ? '' : `Latest actions: ${sample}`,
        end ? `Ended: ${short(end, 500)}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    })
    .join('\n\n')

export type Verdict = { title: string; isMilestone: boolean }

/**
 * Reads the model's answer, leniently: every JSON object in it that carries a
 * title, placed by its own entry number, else by the order it came in. An
 * entry the answer does not cover gets none.
 */
export const parseVerdicts = (text: string, n: number): (Verdict | undefined)[] => {
  const out: (Verdict | undefined)[] = Array.from({ length: n }, () => undefined)
  let next = 0
  for (const found of text.match(/\{[^{}]*\}/g) ?? []) {
    let row: { n?: unknown; title?: unknown; milestone?: unknown }
    try {
      row = JSON.parse(found) as typeof row
    } catch {
      continue
    }
    const title = short(typeof row.title === 'string' ? row.title.replace(/[."]+$/g, '') : undefined, 48)
    if (!title) continue
    const at = typeof row.n === 'number' && Number.isInteger(row.n) ? row.n - 1 : next
    next = at + 1
    if (at >= 0 && at < n && out[at] === undefined)
      out[at] = { title, isMilestone: row.milestone === true }
  }

  return out
}

export const applyVerdicts = (
  list: Entry[],
  ids: readonly string[],
  verdicts: readonly (Verdict | undefined)[],
): Entry[] =>
  list.map(entry => {
    const i = ids.indexOf(entry.id)
    if (i < 0) return entry
    const v = verdicts[i]

    // With no verdict the entry is ranked by what it changed, and stays
    // untitled so that it is asked about again.
    return v
      ? { ...entry, title: v.title, rank: v.isMilestone ? 'milestone' : 'step', judged: entry.events.length }
      : { ...entry, rank: guessRank(entry) }
  })

// --- Inspecting one event ------------------------------------------------------

const cut = (text: string, n: number): string =>
  text.length > n ? `${text.slice(0, n)}\n… (${text.length - n} more characters)` : text

/** Text a Code element takes: tab and newline its only control characters. */
const clean = (text: string): string =>
  text
    .replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')

const hunk = (before: string, after: string): string => {
  const a = before === '' ? [] : before.split('\n')
  const b = after === '' ? [] : after.split('\n')

  return [
    `@@ -1,${a.length} +1,${b.length} @@`,
    ...a.map(line => `-${line}`),
    ...b.map(line => `+${line}`),
  ].join('\n')
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

/**
 * What an event was given and what it returned, from the transcript's own
 * record of the call; with none (compacted away), what the timeline kept.
 */
export const detailOf = (
  ev: SessionEvent,
  use?: { tool: string; input: Record<string, unknown>; result?: unknown; text?: string },
): Inspected => {
  const known = { id: ev.id, kind: ev.kind, status: ev.status, at: ev.at, ms: ev.ms }
  if (!use)
    return {
      ...known,
      tool: ev.tool ?? ev.kind,
      input: ev.text,
      inputAs: 'text',
      result:
        ev.kind === 'inbox'
          ? ''
          : 'The full record of this call is no longer in the transcript.',
      isFound: false,
    }

  const { input } = use
  const path = str(input.file_path) || str(input.notebook_path) || undefined
  let shown: Pick<Inspected, 'input' | 'inputAs'>
  if (use.tool === 'Bash') {
    shown = { input: str(input.command), inputAs: 'bash' }
  } else if (use.tool === 'Edit') {
    shown = { input: hunk(str(input.old_string), str(input.new_string)), inputAs: 'diff' }
  } else if (use.tool === 'MultiEdit' && Array.isArray(input.edits)) {
    shown = {
      input: (input.edits as { old_string?: unknown; new_string?: unknown }[])
        .map(edit => hunk(str(edit.old_string), str(edit.new_string)))
        .join('\n'),
      inputAs: 'diff',
    }
  } else if (use.tool === 'Write') {
    shown = { input: str(input.content), inputAs: 'text' }
  } else {
    shown = { input: JSON.stringify(input, null, 2) ?? '', inputAs: 'json' }
  }
  const raw =
    use.text ??
    (typeof use.result === 'string'
      ? use.result
      : use.result === undefined
        ? ''
        : (JSON.stringify(use.result, null, 2) ?? ''))
  const result =
    raw !== '' ? raw : ev.status === 'running' ? 'Still running…' : '(nothing was returned)'

  return {
    ...known,
    tool: use.tool,
    path,
    input: cut(clean(shown.input), 6000),
    inputAs: shown.inputAs,
    result: cut(clean(result), 8000),
    isFound: true,
  }
}

export const duration = (ms: number | undefined): string => {
  if (ms === undefined) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`

  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

// --- Words the pane draws --------------------------------------------------------

export const LABEL: Record<EventKind, string> = {
  read: 'Read',
  edit: 'Edit',
  run: 'Run',
  test: 'Test',
  commit: 'Commit',
  pr: 'PR',
  web: 'Web',
  agent: 'Agent',
  session: 'Session',
  ask: 'Ask',
  publish: 'Publish',
  tool: 'Tool',
  inbox: 'Message',
}

export const clock = (at: number): string => {
  if (!at) return ''
  const d = new Date(at)
  const pad = (v: number) => String(v).padStart(2, '0')

  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`

/** An entry in one line: how much was done, what changed, what failed. */
export const metaOf = (entry: Entry): string => {
  const total = entry.events.length + (entry.dropped ?? 0)
  const files = new Set(entry.events.filter(ev => ev.kind === 'edit').map(ev => ev.text)).size
  const failed = entry.events.filter(ev => ev.status === 'error').length
  const parts = [total === 0 ? 'No tools used' : plural(total, 'event')]
  if (files > 0) parts.push(`${plural(files, 'file')} changed`)
  if (failed > 0) parts.push(`${failed} failed`)

  return parts.join(' · ')
}

/** The entry in progress while a turn runs; none while the session waits. */
export const liveOf = (entries: readonly Entry[], now: Now): Entry | undefined =>
  now.state === 'working' ? entries.at(-1) : undefined


/** Entries with no title yet: finished ones, the one in progress left out. */
export const untitled = (entries: readonly Entry[], now: Now): string[] => {
  const live = liveOf(entries, now)

  return entries.filter(entry => entry.title === undefined && entry !== live).map(entry => entry.id)
}

/** Forgets every title, so that all of them are written again. */
export const retitle = (entries: Entry[]): Entry[] =>
  entries.map(({ title: _title, judged: _judged, ...entry }) => ({ ...entry, rank: 'pending' }))
