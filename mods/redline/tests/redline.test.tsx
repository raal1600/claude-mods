import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'redline',
  component: 'Pane',
  requestId: 'redline',
  props: {
    title: 'Redline',
    isFocused: false,
    bodyColumns: 44,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

// The one entry's id, read off its row's key.
const entryId = async (ui: { findAll: (q: { type: 'Button' }) => Promise<{ key?: string }[]> }) =>
  (await ui.findAll({ type: 'Button' })).find(b => b.key?.startsWith('open-'))?.key?.slice(5) ?? ''

const labels = async (ui: { findAll: (q: { type: 'Button' }) => Promise<{ text: string }[]> }) =>
  (await ui.findAll({ type: 'Button' })).map(b => b.text)

const USAGE = {
  input_tokens: 1,
  output_tokens: 1,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}

test('a turn becomes a titled milestone whose events open in full', async ($, on) => {
  const time = mock.clock(on, { now: 1_731_400_000_000 })
  const asked: string[] = []
  on('command.register', () => ({ value: { command: 'redline' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  // The transcript's own record of the calls, which the inspector reads; empty
  // until the turn has run.
  let isRecorded = false
  on('session.messages', () => ({
    value: !isRecorded ? [] : [
      {
        role: 'assistant',
        text: '',
        toolUses: [
          {
            tool_use_id: 'u-edit',
            tool: 'Edit',
            input: { file_path: '/a/src/pay.ts', old_string: 'const fee = 1', new_string: 'const fee = 2' },
            text: 'The file /a/src/pay.ts has been updated.',
          },
          {
            tool_use_id: 'u-test',
            tool: 'Bash',
            input: { command: 'npx vitest run', description: 'Run the tests' },
            text: 'FAIL  cart.test.ts > totals\n\u001B[31mexpected 3 to be 4\u001B[0m',
            isError: true,
          },
        ],
      },
    ],
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('model.complete', (_, e) => {
    asked.push(e.prompt)

    return {
      value: {
        isAnswered: true,
        text: '[{"title": "Added Stripe checkout", "milestone": true}]',
        usage: USAGE,
      },
    }
  })
  on('tool.call', async (_, e) => {
    await time.sleep(1500)

    return e.tool === 'Bash' ? { isError: true, result: 'fail' } : { result: {} }
  })
  const call = async (input: Parameters<typeof $.tool.call>[0]) => {
    const ran = $.tool.call(input)
    await time.advance(1500)
    await ran
  }

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await time.advance(300)
  await $.prompt.submit({
    text: 'Can you add Stripe checkout to the cart page',
    wait: false,
    origin: { kind: 'sdk' },
  })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await call({ tool: 'Read', file_path: '/a/src/cart.tsx', tool_use_id: 'u-read' })
  await call({
    tool: 'Edit',
    file_path: '/a/src/pay.ts',
    old_string: 'const fee = 1',
    new_string: 'const fee = 2',
    tool_use_id: 'u-edit',
  })
  await call({
    tool: 'Bash',
    command: 'npx vitest run',
    description: 'Run the tests',
    tool_use_id: 'u-test',
  })

  isRecorded = true

  // Mid-turn, the timeline: one moving dot, the work in hand, and one row
  // for the turn in progress.
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // What moves: the spinner and the light on the bar. Nothing is running, so
  // no row carries the dots.
  const moving = await ui.findAll({ type: 'Svg' })
  expect(moving.map(piece => piece.props.alt)).toEqual(['Working', 'Working'])
  expect(moving.every(piece => String(piece.props.source).includes('<animate'))).toBe(true)
  expect(await ui.find({ type: 'Text', text: /^Working$/ })).toBeTruthy()
  // The latest events lead the screen, newest first, each one a button.
  const id = await entryId(ui)
  expect(await labels(ui)).toEqual([
    'Run the tests — failed',
    'pay.ts',
    'cart.tsx',
    'This turn · all 3 events ›',
  ])

  // A click on it opens the request: its events, newest first.
  await ui.press({ key: `open-${id}` })
  expect(await ui.find({ type: 'Text', text: /^In progress$/ })).toBeTruthy()
  const order = (await ui.findAll({ type: 'Button' })).map(b => b.text)
  expect(order).toEqual(['‹ Timeline', 'Run the tests — failed', 'pay.ts', 'cart.tsx'])

  // A click on an event opens its full record: the command and what came back.
  await ui.press({ key: 'ev-u-test' })
  expect((await ui.findAll({ type: 'Code' })).map(code => code.props.source)).toEqual([
    'npx vitest run',
    'FAIL  cart.test.ts > totals\nexpected 3 to be 4',
  ])
  expect((await ui.find({ type: 'Text', text: /^Failed · / }))?.text).toMatch(
    /^Failed · \d\d:\d\d · 1\.5s$/,
  )
  expect(await ui.find({ key: 'ev-u-test' })).toBeFalsy()

  // Back is one press, and an edit opens as a diff with the file it changed.
  await ui.press({ key: 'back' })
  await ui.press({ key: 'ev-u-edit' })
  const diff = (await ui.findAll({ type: 'Code' }))[0]
  expect(diff?.props.format).toBe('diff')
  expect(diff?.props.source).toBe('@@ -1,1 +1,1 @@\n-const fee = 1\n+const fee = 2')
  expect(await ui.find({ type: 'Text', text: /^\/a\/src\/pay\.ts$/ })).toBeTruthy()

  // A call the transcript no longer holds still says what the timeline kept.
  await ui.press({ key: 'back' })
  await ui.press({ key: 'ev-u-read' })
  expect(await ui.find({ type: 'Text', text: /no longer in the transcript/ })).toBeTruthy()
  await ui.press({ key: 'back' })
  await ui.press({ key: 'back' })

  await $.turn.complete({
    answer: 'Checkout is wired in.',
    durationMs: 1000,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
  })
  await time.advance(100)

  // After it: one line under the model's title, and nothing moves any more.
  expect(asked.length).toBe(1)
  expect(asked[0]).toContain('edit ×1')
  const still = await ui.findAll({ type: 'Svg' })
  expect(still.map(piece => piece.props.alt)).toEqual(['Idle', 'Milestone'])
  expect(still.some(piece => String(piece.props.source).includes('<animate'))).toBe(false)
  expect(await ui.find({ type: 'Text', text: /^Waiting on you$/ })).toBeTruthy()
  expect((await ui.findAll({ type: 'Button' })).map(b => b.text)).toEqual(['Added Stripe checkout'])

  // Opened, it says what was asked, how it ended, and lists its events in order.
  await ui.press({ key: `open-${id}` })
  expect(await ui.find({ type: 'Text', text: /^\d\d:\d\d · 3 events · 1 file changed · 1 failed$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^Can you add Stripe checkout/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^Checkout is wired in\.$/ })).toBeTruthy()
  expect((await ui.findAll({ type: 'Button' })).map(b => b.text)).toEqual([
    '‹ Timeline',
    'cart.tsx',
    'pay.ts',
    'Run the tests — failed',
  ])
  await ui.unmount()

  // The terminal draws the same screens, with a plain dot for the moving one.
  const rows = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await rows.find({ key: 'ev-u-edit' }))?.text).toBe('pay.ts')
  await rows.unmount()
})

test('a session that ran before the mod is rebuilt and named', async ($, on) => {
  const time = mock.clock(on, { now: 1_731_400_000_000 })
  on('command.register', () => ({ value: { command: 'redline' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.messages', () => ({
    value: [
      { role: 'user', text: '<system-reminder>noise</system-reminder>\nwhat does this repo do?', toolUses: [] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'a', tool: 'Read', input: { file_path: '/r/README.md' } }] },
      { role: 'user', text: '', toolUses: [] },
      { role: 'user', text: 'fix the login bug', toolUses: [] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'b', tool: 'Edit', input: { file_path: '/r/login.ts' } }] },
    ],
  }))
  on('model.complete', () => ({
    value: {
      isAnswered: true,
      // Out of order, and fenced: each verdict lands on the entry it numbers.
      text: '```json\n[{"n":2,"title":"Fixed login bug","milestone":true},{"n":1,"title":"Explained the repo","milestone":false}]\n```',
      usage: USAGE,
    },
  }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await time.advance(500)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // Newest first; the fix edited a file, the explanation only read one.
  expect(await labels(ui)).toEqual(['Fixed login bug', 'Explained the repo'])
  // Each row carries its piece of the line: the first from its dot down, the
  // last down to its dot, so the two join into one.
  const marks = (await ui.findAll({ type: 'Svg' })).filter(piece => piece.props.alt !== 'Idle')
  expect(marks.map(piece => piece.props.alt)).toEqual(['Milestone', 'Step'])
  expect(String(marks[0]?.props.source)).toContain('y1="15" x2="6" y2="30"')
  expect(String(marks[1]?.props.source)).toContain('y1="0" x2="6" y2="15"')
  await ui.press({ key: (await ui.findAll({ type: 'Button' }))[0]?.key ?? '' })
  expect(await ui.find({ type: 'Text', text: /^1 event · 1 file changed$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^fix the login bug$/ })).toBeTruthy()
  expect(await labels(ui)).toEqual(['‹ Timeline', 'login.ts'])
  await ui.unmount()
})

test('with no model answer, an entry is ranked by what it changed', async ($, on) => {
  const time = mock.clock(on, { now: 1_731_400_000_000 })
  on('command.register', () => ({ value: { command: 'redline' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.messages', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('model.complete', () => ({
    value: { isAnswered: false, reason: 'empty-reply', usage: USAGE },
  }))
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'Style the cart page', wait: false, origin: { kind: 'sdk' } })
  await $.tool.call({ tool: 'Edit', file_path: '/a/cart.css', old_string: 'a', new_string: 'b' })
  await $.turn.complete({ answer: 'Done.', durationMs: 5, isAborted: false, turnId: 't', reason: 'answer' })
  await time.advance(100)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // Its own words name it, and a changed file makes it a milestone: a dot.
  expect(await labels(ui)).toEqual(['Style the cart page'])
  expect((await ui.findAll({ type: 'Svg' })).map(piece => piece.props.alt)).toContain('Milestone')
  await ui.unmount()
})

test('the task list drives the now block, and the strip reopens the pane', async ($, on) => {
  mock.clock(on, { now: 1_731_400_000_000 })
  const opened: string[] = []
  on('command.register', () => ({ value: { command: 'redline' } }))
  on('ui.open', (_, e) => (opened.push(e.id), { value: { isPlaced: true } }))
  on('session.messages', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({
    tool: 'mcp__ccd_turn__update_plan',
    items: [
      { content: 'Look around', status: 'in_progress' },
      { content: 'Wire the coupon field', status: 'pending' },
    ],
  })
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', advance: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^Wire the coupon field$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^Step 2 of 2$/ })).toBeTruthy()
  // The bar: the first step filled, the second with the light across it.
  const bar = (await ui.findAll({ type: 'Svg' })).find(piece => piece.props.alt === 'Step 2 of 2')
  expect(String(bar?.props.source).match(/<rect/g)?.length).toBe(4)
  expect(String(bar?.props.source)).toContain('<animate attributeName="x"')
  await ui.unmount()

  const before = opened.length
  const strip = await $.ui.mount({
    plugin: 'redline',
    component: 'AbovePrompt',
    surface: 'desktop',
    props: { hasSurvey: false, isCollapsed: false, isWorking: true, maxRows: 4, bodyColumns: 80 },
  } as never)
  expect((await strip.find({ type: 'Text', text: /Redline/ }))?.text).toContain(
    'Now: Wire the coupon field',
  )
  await strip.press({ key: 'open-redline' })
  expect(opened.length).toBe(before + 1)
  await strip.unmount()
})
