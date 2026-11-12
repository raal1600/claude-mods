import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Entry, Inspected, Now, Route, SessionEvent } from '../types'
import {
  JUDGE_SYSTEM,
  addEntry,
  addEvent,
  applyVerdicts,
  LABEL,
  classify,
  clock,
  detailOf,
  duration,
  fromMessages,
  judgePrompt,
  liveOf,
  metaOf,
  parseVerdicts,
  plain,
  planned,
  plural,
  retitle,
  settleEvent,
  short,
  titleOf,
  untitled,
} from './model'
import { DOTS, IDLE, RAIL_HEIGHT, RAIL_WIDTH, SPINNER, progressBar, railMark } from './motion'

const PANE = 'redline'
const TITLE = 'Redline'

// A grey light enough to sit on a dark or a light ground, for the row under
// the pointer.
const HOVER = '#80808026'

// Titles written before this revision are written again.
const REV = 3

// Change a tag when the stored shape changes: an older value is then read as
// the initial one instead of being misread.
const entries = atom({ plugin: 'redline', key: 'entries' } as const, [] as Entry[], {
  shape: 'entries-2',
})
const now = atom({ plugin: 'redline', key: 'now' } as const, { state: 'idle' } as Now, {
  shape: 'now-2',
})
const route = atom({ plugin: 'redline', key: 'route' } as const, { screen: 'home' } as Route, {
  shape: 'route-1',
})
const rev = atom({ plugin: 'redline', key: 'rev' } as const, 0)

// Prompts a person sent, as opposed to notices and other sessions' messages.
const PERSON = new Set(['composer', 'bridge', 'sdk', 'unclassified', 'channel', 'slack-ping'])
const INBOX = new Set([
  'task-notification',
  'peer',
  'peer-send-message',
  'coordinator',
  'projects-relay',
  'scheduled-trigger',
])

const isToolError = (ran: unknown): boolean => {
  if (typeof ran !== 'object' || ran === null) return false
  const r = ran as { deny?: unknown; isError?: unknown }

  return typeof r.deny === 'string' || r.isError === true
}

type Engine = Pick<EngineInterface, 'model' | 'state'>

/** One event's full record, read from the transcript's own copy of the call. */
const lookup = async (
  $: Pick<EngineInterface, 'session'>,
  ev: SessionEvent,
): Promise<Inspected> => {
  try {
    const messages = await $.session.messages()
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const use = messages[i]?.toolUses.find(one => one.tool_use_id === ev.id)
      if (use) return detailOf(ev, use)
    }
  } catch {
    // A transcript that cannot be read leaves what the timeline kept.
  }

  return detailOf(ev)
}

/**
 * Asks a small model what each entry amounted to: a short title, and whether
 * it was a milestone. With no answer, the entry is ranked by what it changed.
 */
const judge = async ($: Engine, ids: readonly string[], answer?: string): Promise<void> => {
  const picked = (await read($, entries)).filter(entry => ids.includes(entry.id))
  if (picked.length === 0) return
  const order = picked.map(entry => entry.id)
  let text = ''
  try {
    const reply = await $.model.complete({
      model: 'haiku',
      system: JUDGE_SYSTEM,
      prompt: judgePrompt(picked, answer),
      maxTokens: 80 + 60 * picked.length,
    })
    if (reply.isAnswered) text = reply.text
  } catch {
    // A model that cannot be asked leaves the guess below.
  }
  const verdicts = parseVerdicts(text, picked.length)
  await update($, entries, list => applyVerdicts(list, order, verdicts))
}

/** Titles every finished entry that has none, a few to a question. */
const catchUp = async ($: Engine): Promise<void> => {
  const ids = untitled(await read($, entries), await read($, now))
  for (let i = 0; i < ids.length; i += 6) await judge($, ids.slice(i, i + 6))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'redline',
      description: 'Show the timeline of this session',
    })
    if ((await read($, entries)).length === 0) {
      try {
        const past = fromMessages(await $.session.messages())
        if (past.length > 0) await update($, entries, () => past)
      } catch {
        // A transcript that cannot be read leaves the timeline to start fresh.
      }
    }
    if ((await read($, rev)) < REV) {
      await update($, entries, retitle)
      await update($, rev, () => REV)
    }
    // Entries a reload or a failed question left untitled are asked about now:
    // a timer, so that the session's start never waits on a model.
    $.clock.after(200, () => void catchUp($).catch(() => {}))
    void $.ui.open({ id: PANE, title: TITLE })

    return started
  })

  on('command.run', { command: 'redline' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Redline pane opened.' }
  })

  on('prompt.submit', async ($, e, next) => {
    const sent = await next(e)
    if (sent.drop !== undefined || e.isMeta) return sent
    const at = await $.clock.now()
    const kind = e.origin.kind
    const said = plain(sent.text ?? e.text)
    if (e.command) {
      const line = `/${e.command.name}${e.command.args ? ` ${e.command.args}` : ''}`
      await update($, entries, list => addEntry(list, short(line, 160) ?? line, at))
    } else if (PERSON.has(kind) && said !== '') {
      await update($, entries, list => addEntry(list, short(said, 160) ?? said, at))
    } else if (INBOX.has(kind)) {
      await update($, entries, list =>
        addEvent(list, {
          id: `in-${at}`,
          at,
          kind: 'inbox',
          text: short(plain(e.text), 60) ?? 'notification',
          status: 'ok',
        }),
      )
    }

    return sent
  }).catch(($, e, next) => next(e)) // never in the way of a prompt

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      const since = await $.clock.now()
      await update($, now, (n): Now => ({ ...n, state: 'working', since }))
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId) return done
    await update($, now, (n): Now => ({ ...n, state: 'idle' }))
    // With no recap, what Claude said last is the entry's outcome.
    const answer = short(plain(e.answer), 400)
    if (answer)
      await update($, entries, list => {
        const last = list.at(-1)

        return last && !last.summary ? [...list.slice(0, -1), { ...last, summary: answer }] : list
      })
    // After the turn, so the question never holds the answer back.
    $.clock.after(50, () => void catchUp($).catch(() => {}))

    return done
  })

  on('tool.call', async ($, e, next) => {
    // A subagent's own calls are folded into its one event.
    if (e.agentId) return next(e)
    const input = e as unknown as Record<string, unknown>
    const tool = String(e.tool)

    if (tool === 'mcp__ccd_turn__update_plan') {
      await update($, now, n => planned(n, input))

      return next(e)
    }
    if (tool === 'mcp__ccd_turn__wrap_up') {
      const recap = typeof input.recap === 'string' ? input.recap : undefined
      if (recap)
        await update($, entries, list => {
          const last = list.at(-1)

          return last ? [...list.slice(0, -1), { ...last, summary: recap }] : list
        })
      await update($, now, (n): Now => ({ ...n, current: n.plan?.length }))

      return next(e)
    }

    const step = classify(tool, input)
    if (!step) return next(e)
    const at = await $.clock.now()
    const id = e.tool_use_id || `t-${at}`
    await update($, entries, list =>
      addEvent(list, { id, at, kind: step.kind, text: step.text, status: 'running', tool }),
    )
    try {
      const ran = await next(e)
      const endedAt = await $.clock.now()
      await update($, entries, list => settleEvent(list, id, isToolError(ran), endedAt))

      return ran
    } catch (error) {
      await update($, entries, list => settleEvent(list, id, true))
      throw error
    }
  }).catch(($, e, next) => next(e)) // never in the way of a tool call

  // A one-line strip above the message box: what is happening now, and the
  // way back to the pane after it was closed.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, entries)
    const state = await read($, now)
    const plan = state.plan ?? []
    const current = state.current ?? plan.length
    const working = state.state === 'working' || e.props.isWorking
    const latest = list.at(-1)
    const lastMilestone = list.findLast(entry => entry.rank === 'milestone')
    const status = working
      ? `Now: ${plan[current] ?? (latest ? titleOf(latest) : 'working')}`
      : lastMilestone
        ? `Last milestone: ${titleOf(lastMilestone)}`
        : 'Waiting on you'

    return (
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexDirection="row" flexShrink={1}>
          <Text color="claude">● </Text>
          <Text wrap="truncate-end">
            <Text bold>Redline</Text>
            <Text dimColor> · </Text>
            <Text color={working ? 'warning' : undefined}>{status}</Text>
          </Text>
        </Box>
        <Button
          key="open-redline"
          label="Open"
          onPress={() => void $.ui.open({ id: PANE, title: TITLE })}
        />
      </Box>
    )
  })

  // The pane, as a list drills down: the timeline, one line to a request; a
  // click opens that request and its events; a click on an event opens its full
  // record. Each screen has one way back, at its top. It is styled as the app's
  // own sidebar is (plain headings, one clay accent) and it moves only while a
  // turn runs: a spinner, a light across the plan's bar, dots on a running call.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const list = await read($, entries)
    const state = await read($, now)
    const at = await read($, route)
    const live = liveOf(list, state)
    const plan = state.plan ?? []
    const current = state.current ?? plan.length
    const { Box, Button, Code, Text } = $.ui.resolve(e)
    const Svg = e.surface !== 'terminal' ? $.ui.resolve(e).Svg : undefined
    const columns = e.props.bodyColumns
    // A title longer than the row pushes what follows it off the pane.
    const fit = Math.max(16, Math.min(48, columns - 8))
    // The pane is measured in character cells; a drawing wants pixels.
    const barWidth = Math.max(120, Math.round(columns * 8.2) - 36)

    const go = (to: Route) => () => update($, route, () => to)
    const openEvent = (entry: Entry, ev: SessionEvent) => async () => {
      const detail = await lookup($, ev)
      await update($, route, (): Route => ({ screen: 'event', entry: entry.id, detail }))
    }

    const heading = (label: string) => (
      <Text size="footnote" dimColor>
        {label}
      </Text>
    )
    const back = (label: string, to: Route) => (
      <Box flexDirection="row">
        <Button key="back" plain dimColor label={`‹ ${label}`} onPress={go(to)} />
      </Box>
    )
    const spinner = (isOn: boolean) =>
      Svg ? (
        <Svg source={isOn ? SPINNER : IDLE} alt={isOn ? 'Working' : 'Idle'} width={16} height={16} />
      ) : (
        <Text color={isOn ? 'claude' : undefined} dimColor={!isOn}>
          {isOn ? '●' : '○'}
        </Text>
      )

    // One event on a line: what kind, then what it was about, which is the
    // button; a call still running carries the moving dots.
    const eventRow = (entry: Entry, ev: SessionEvent) => {
      const failed = ev.status === 'error'
      const running = ev.status === 'running'

      return (
        <Box
          key={`row-${ev.id}`}
          flexDirection="row"
          alignItems="center"
          paddingX="sm"
          hover={{ backgroundColor: HOVER }}
        >
          <Box width={7} flexShrink={0}>
            <Text size="footnote" color={failed ? 'error' : undefined} dimColor={!failed}>
              {LABEL[ev.kind]}
            </Text>
          </Box>
          <Box flexGrow={1} flexShrink={1}>
            <Button
              key={`ev-${ev.id}`}
              plain
              label={short(`${ev.text}${failed ? ' — failed' : ''}`, fit - 6) ?? ev.text}
              onPress={openEvent(entry, ev)}
            />
          </Box>
          {running && Svg ? <Svg source={DOTS} alt="Running" width={22} height={8} /> : null}
          {running && !Svg ? <Text color="claude">…</Text> : null}
        </Box>
      )
    }

    // --- One event's full record ---------------------------------------------
    const shownEntry = at.screen === 'home' ? undefined : list.find(en => en.id === at.entry)
    if (at.screen === 'event' && shownEntry) {
      const d = at.detail
      const status = d.status === 'error' ? 'Failed' : d.status === 'running' ? 'Running' : 'Done'
      const facts = [status, clock(d.at), duration(d.ms)].filter(part => part !== '').join(' · ')
      const inputHeading =
        d.inputAs === 'diff' ? 'Change' : d.inputAs === 'bash' ? 'Command' : d.isFound ? 'Input' : 'Event'

      return (
        <Box flexDirection="column" gap="md">
          {back(short(titleOf(shownEntry), fit) ?? 'Back', { screen: 'entry', entry: shownEntry.id })}
          <Box flexDirection="column" gap="xs" paddingX="sm">
            {heading(LABEL[d.kind])}
            <Text size="heading" weight="semibold" wrap="wrap">
              {shownEntry.events.find(ev => ev.id === d.id)?.text ?? d.tool}
            </Text>
            <Text size="footnote" color={d.status === 'error' ? 'error' : undefined} dimColor={d.status !== 'error'} tabular>
              {facts}
            </Text>
            {d.path ? (
              <Text size="caption" mono dimColor wrap="wrap">
                {d.path}
              </Text>
            ) : null}
          </Box>
          {d.input !== '' ? (
            <Box flexDirection="column" gap="xs" paddingX="sm">
              {heading(inputHeading)}
              {d.inputAs === 'diff' ? (
                <Code source={d.input} format="diff" path={d.path} />
              ) : d.inputAs === 'bash' ? (
                <Code source={d.input} language="bash" />
              ) : d.inputAs === 'json' ? (
                <Code source={d.input} language="json" />
              ) : d.isFound ? (
                <Code source={d.input} path={d.path} />
              ) : (
                <Text size="footnote" wrap="wrap">
                  {d.input}
                </Text>
              )}
            </Box>
          ) : null}
          {d.result !== '' ? (
            <Box flexDirection="column" gap="xs" paddingX="sm">
              {heading('Result')}
              {d.isFound ? (
                <Code source={d.result} />
              ) : (
                <Text size="footnote" dimColor wrap="wrap">
                  {d.result}
                </Text>
              )}
            </Box>
          ) : null}
        </Box>
      )
    }

    // --- One request and its events -------------------------------------------
    if (at.screen === 'entry' && shownEntry) {
      const entry = shownEntry
      const isLive = entry === live
      // In progress, the newest event leads; finished, they read in order.
      const rows = isLive ? [...entry.events].reverse() : entry.events
      const facts = [clock(entry.at), metaOf(entry)].filter(part => part !== '').join(' · ')

      return (
        <Box flexDirection="column" gap="md">
          {back('Timeline', { screen: 'home' })}
          <Box flexDirection="column" gap="xs" paddingX="sm">
            {isLive ? (
              <Box flexDirection="row" alignItems="center" columnGap="sm">
                {spinner(true)}
                <Text color="claude">In progress</Text>
              </Box>
            ) : null}
            <Text size="heading" weight="semibold" wrap="wrap">
              {titleOf(entry)}
            </Text>
            <Text size="footnote" dimColor tabular>
              {facts}
            </Text>
            {isLive && Svg ? (
              <Svg
                source={progressBar(barWidth, plan.length, current)}
                alt="Progress through the plan"
                width={barWidth}
                height={4}
              />
            ) : null}
          </Box>
          {entry.title ? (
            <Box flexDirection="column" gap="xs" paddingX="sm">
              {heading('You asked')}
              <Text wrap="wrap">{entry.prompt}</Text>
            </Box>
          ) : null}
          {entry.summary ? (
            <Box flexDirection="column" gap="xs" paddingX="sm">
              {heading('Outcome')}
              <Text wrap="wrap">{entry.summary}</Text>
            </Box>
          ) : null}
          {rows.length > 0 ? (
            <Box flexDirection="column" gap="xs">
              <Box paddingX="sm">{heading('Events')}</Box>
              <Box flexDirection="column">{rows.map(ev => eventRow(entry, ev))}</Box>
              {entry.dropped ? (
                <Box paddingX="sm">
                  <Text size="caption" dimColor>
                    {plural(entry.dropped, 'earlier event')} not kept
                  </Text>
                </Box>
              ) : null}
            </Box>
          ) : null}
        </Box>
      )
    }

    // --- The timeline ------------------------------------------------------------
    const history = (live ? list.slice(0, -1) : [...list]).reverse()
    const working = live !== undefined || state.state === 'working'
    const headline = working
      ? (plan[current] ?? (live ? titleOf(live) : 'Working…'))
      : current < plan.length
        ? `Paused at: ${plan[current] ?? ''}`
        : ''
    const progress =
      plan.length > 0 ? `Step ${Math.min(current + 1, plan.length)} of ${plan.length}` : ''
    const latest = live ? [...live.events].reverse().slice(0, 3) : []

    return (
      <Box
        flexDirection="column"
        gap="md"
        width={e.surface === 'terminal' ? Math.max(20, columns) : undefined}
      >
        <Box flexDirection="column" gap="xs">
          <Box flexDirection="row" alignItems="center" justifyContent="space-between" paddingX="sm">
            <Box flexDirection="row" alignItems="center" columnGap="sm">
              {spinner(working)}
              <Text color={working ? 'claude' : undefined} dimColor={!working}>
                {working ? 'Working' : 'Waiting on you'}
              </Text>
            </Box>
            {working && progress !== '' ? (
              <Text size="footnote" dimColor tabular>
                {progress}
              </Text>
            ) : null}
          </Box>
          {headline !== '' ? (
            <Box paddingX="sm">
              <Text size="heading" weight="semibold" wrap="wrap">
                {headline}
              </Text>
            </Box>
          ) : null}
          {working && Svg ? (
            <Box paddingX="sm" paddingY="xs">
              <Svg
                source={progressBar(barWidth, plan.length, current)}
                alt={progress === '' ? 'Working' : progress}
                width={barWidth}
                height={4}
              />
            </Box>
          ) : null}
          {live ? (
            <Box flexDirection="column">
              {latest.map(ev => eventRow(live, ev))}
              <Box flexDirection="row" paddingX="sm" hover={{ backgroundColor: HOVER }} key={`entry-${live.id}`}>
                <Button
                  key={`open-${live.id}`}
                  plain
                  dimColor
                  label={
                    live.events.length === 0
                      ? 'This turn · no events yet'
                      : `This turn · all ${plural(live.events.length, 'event')} ›`
                  }
                  onPress={go({ screen: 'entry', entry: live.id })}
                />
              </Box>
            </Box>
          ) : null}
        </Box>
        <Box flexDirection="column" gap="xs">
          <Box paddingX="sm">
            <Text>Timeline</Text>
          </Box>
          <Box flexDirection="column">
            {history.length === 0 ? (
              <Box paddingX="sm">
                <Text size="footnote" dimColor wrap="wrap">
                  Finished requests appear here, newest first.
                </Text>
              </Box>
            ) : null}
            {history.map((entry, i) => {
              const isMilestone = entry.rank === 'milestone'
              const mark = railMark(isMilestone, i === 0, i === history.length - 1)

              return (
                <Box
                  key={`entry-${entry.id}`}
                  flexDirection="row"
                  alignItems="center"
                  paddingX="sm"
                  hover={{ backgroundColor: HOVER }}
                >
                  <Box width={2} flexShrink={0} flexDirection="row" alignItems="center">
                    {Svg ? (
                      <Svg
                        source={mark}
                        alt={isMilestone ? 'Milestone' : 'Step'}
                        width={RAIL_WIDTH}
                        height={RAIL_HEIGHT}
                      />
                    ) : (
                      <Text color={isMilestone ? 'claude' : undefined} dimColor={!isMilestone}>
                        {isMilestone ? '●' : '·'}
                      </Text>
                    )}
                  </Box>
                  <Box flexGrow={1} flexShrink={1}>
                    <Button
                      key={`open-${entry.id}`}
                      plain
                      dimColor={!isMilestone}
                      label={short(titleOf(entry), fit) ?? titleOf(entry)}
                      onPress={go({ screen: 'entry', entry: entry.id })}
                    />
                  </Box>
                  <Text size="caption" dimColor tabular>
                    {clock(entry.at)}
                  </Text>
                </Box>
              )
            })}
          </Box>
        </Box>
      </Box>
    )
  })
}
