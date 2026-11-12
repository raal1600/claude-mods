export type EventKind =
  | 'read'
  | 'edit'
  | 'run'
  | 'test'
  | 'commit'
  | 'pr'
  | 'web'
  | 'agent'
  | 'session'
  | 'ask'
  | 'publish'
  | 'tool'
  | 'inbox'

export type EventStatus = 'running' | 'ok' | 'error'

/** One thing Claude did: every tool call is its own event, none merged. */
export type SessionEvent = {
  /** The tool call's id, so a result settles its own event. */
  id: string
  /** Milliseconds since the epoch; 0 when rebuilt from history. */
  at: number
  kind: EventKind
  text: string
  status: EventStatus
  /** The tool that ran, by its own name. */
  tool?: string
  /** How long the call took, in milliseconds. */
  ms?: number
}

/** One event opened for inspection: what went in and what came back. */
export type Inspected = {
  id: string
  tool: string
  kind: EventKind
  status: EventStatus
  at: number
  ms?: number
  /** The file the call was about, when it names one. */
  path?: string
  /** What the call was given, ready to draw. */
  input: string
  /** How `input` reads: a shell command, a diff, JSON, or plain text. */
  inputAs: 'bash' | 'diff' | 'json' | 'text'
  /** What came back, as the model read it. */
  result: string
  /** False when the transcript no longer holds the call. */
  isFound: boolean
}

/**
 * `milestone`: something tangible was built, changed, fixed or decided.
 * `step`: a question, a clarification, a small exchange.
 * `pending`: not judged yet.
 */
export type Rank = 'milestone' | 'step' | 'pending'

/** One of the person's requests and everything done for it. */
export type Entry = {
  id: string
  at: number
  /** The person's words, shortened. */
  prompt: string
  /** What was achieved, in a few words, written once the work ended. */
  title?: string
  rank: Rank
  events: SessionEvent[]
  /** Events dropped from the front once an entry holds too many. */
  dropped?: number
  /** The wrap-up recap Claude gave when the work ended. */
  summary?: string
  /** How many events the entry held when it was last judged. */
  judged?: number
}

/** What the session is doing right now. */
export type Now = {
  state: 'working' | 'idle'
  /** When the running turn started. */
  since?: number
  /** Claude's task list for the current work, when it keeps one. */
  plan?: string[]
  /** Index into `plan` of the step in progress; past the end when all done. */
  current?: number
}

/**
 * The pane's screens, as an iOS list drills down: the timeline, one request
 * and its events, one event's full record.
 */
export type Route =
  | { screen: 'home' }
  | { screen: 'entry'; entry: string }
  | { screen: 'event'; entry: string; detail: Inspected }

declare module 'claude-code' {
  interface PluginState {
    redline: {
      entries: Shaped<Entry[]>
      now: Shaped<Now>
      /** Which screen the pane shows. */
      route: Shaped<Route>
      /** Bumped when stored titles must be written again. */
      rev: number
    }
  }
}
