import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const TOOL = 'mcp__decision-log__log_decision'

const PANE = {
  plugin: 'decision-log',
  component: 'Pane',
  requestId: 'decisions',
  props: {
    title: 'Decisions',
    isFocused: true,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const SQLITE = {
  tool: TOOL,
  choice: 'Store sessions in SQLite',
  why: 'No server to run for a single user.',
  alternatives: 'Postgres, JSON files',
  impact: 'Moving to Postgres later needs a data export.',
  reversibility: 'hard',
} as const

const PNPM = {
  tool: TOOL,
  choice: 'Use pnpm for the workspace',
  why: 'Faster installs.',
  impact: 'Contributors need pnpm installed.',
  reversibility: 'easy',
} as const

// The engine types tool calls by the MCP tools connected at load, which may not list this plugin's own.
const logDecision = ($: Engine, input: Record<string, unknown>) => $.tool.call(input as never)

const quietUi = (on: On) => {
  mock.clock(on)
  on('ui.blit', () => ({ value: {} }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
}

test('a logged decision shows in the pane and a rejection reaches Claude', async ($, on) => {
  quietUi(on)
  const session = mock.session(on)

  for (const surface of ['terminal', 'desktop'] as const) {
    const logged = await logDecision($, SQLITE)
    const text = logged.text ?? JSON.stringify(logged.result)
    const id = /Logged as D(\d+)/.exec(text)?.[1] ?? ''
    expect(id).not.toBe('')

    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ key: `row:${id}` })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Store sessions in SQLite' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /hard to undo/ })).toBeDefined()

    await ui.press({ key: 'comment' })
    await ui.input({ key: `comment:${id}`, text: 'We need Postgres for the shared server' })
    await ui.press({ key: 'reject' })

    const rows = session.appended()
    const last = JSON.stringify(rows[rows.length - 1]?.message.content)
    expect(last).toMatch(new RegExp(`rejected D${id}`))
    expect(last).toMatch(/We need Postgres for the shared server/)
    expect(await ui.find({ key: 'reject' })).toBeUndefined()
    await ui.unmount()
  }
})

test('a plain approval sends Claude nothing', async ($, on) => {
  quietUi(on)
  const session = mock.session(on)

  await logDecision($, { ...SQLITE, reversibility: 'easy' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'approve' })

  expect(session.appended()).toHaveLength(0)
  expect(await ui.find({ key: 'revisit' })).toBeUndefined()
  expect((await ui.find({ key: 'tab:approved' }))?.text).toMatch(/Approved 1/)
  // The pane opens on To review, so an approved decision leaves the table.
  expect(await ui.find({ key: 'row:1' })).toBeUndefined()
})

test('feedback given while Claude is idle can wake it, an approval with a comment too', async ($, on) => {
  quietUi(on)
  const session = mock.session(on)
  const submitted: string[] = []
  on('prompt.submit', (_$, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })

  await logDecision($, PNPM)
  await logDecision($, SQLITE)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 'comment' })
  await ui.input({ key: 'comment:1', text: 'Add pnpm to the README setup steps' })
  await ui.press({ key: 'approve' })
  expect(JSON.stringify(session.appended().at(-1)?.message.content)).toMatch(/approved D1 .*Add pnpm/)
  expect(await ui.find({ key: 'revisit' })).toBeDefined()

  await ui.press({ key: 'reject' })
  await ui.press({ key: 'revisit' })
  expect(submitted).toEqual(['In the decision log I rejected D2 and commented on D1. Please act on my feedback.'])
  expect(await ui.find({ key: 'revisit' })).toBeUndefined()
})

test('rows, next and previous flick the detail between decisions', async ($, on) => {
  quietUi(on)
  await logDecision($, SQLITE)
  await logDecision($, PNPM)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: ' D1 ' })).toBeDefined()

  await ui.press({ key: 'next' })
  expect(await ui.find({ type: 'Text', text: ' D2 ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' D1 ' })).toBeUndefined()

  await ui.press({ key: 'row:1' })
  expect(await ui.find({ type: 'Text', text: ' D1 ' })).toBeDefined()

  await ui.press({ key: 'tab:rejected' })
  expect(await ui.find({ type: 'Text', text: /Nothing here yet/ })).toBeDefined()
})

test('the hotkeys switch off while a comment is being typed', async ($, on) => {
  quietUi(on)
  await logDecision($, PNPM)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'approve' }))?.props.hotkey).toBe('a')

  await ui.press({ key: 'comment' })
  expect((await ui.find({ key: 'approve' }))?.props.hotkey).toBeUndefined()
  expect((await ui.find({ key: 'next' }))?.props.hotkey).toBeUndefined()

  await ui.input({ key: 'comment:1', text: 'fine by me' })
  expect((await ui.find({ key: 'approve' }))?.props.hotkey).toBe('a')
  expect(await ui.find({ type: 'Text', text: 'fine by me' })).toBeDefined()
})

test('an empty log shows the critter, idle', async ($, on) => {
  quietUi(on)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'idle' })).toBeDefined()
    await ui.unmount()
  }
})

test('once everything is reviewed the overview shows, with graphics on the terminal', async ($, on) => {
  quietUi(on)
  await logDecision($, SQLITE)
  await logDecision($, PNPM)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    if (surface === 'terminal') {
      await ui.press({ key: 'approve' })
      await ui.press({ key: 'reject' })
    }

    await ui.drawn()
    expect(await ui.find({ type: 'Text', text: '✓ All caught up' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 approved/ })).toBeDefined()
    expect(await ui.find({ key: 'recent:2' })).toBeDefined()

    const rasters = await ui.findAll({ type: 'Raster' })
    expect(rasters.map(one => one.key)).toEqual(surface === 'terminal' ? ['banner', 'mascot'] : [])
    await ui.unmount()
  }
})

test('an accidental approval can be undone, and Claude is told nothing', async ($, on) => {
  quietUi(on)
  const session = mock.session(on)
  await logDecision($, PNPM)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'approve' })
  expect(await ui.find({ key: 'row:1' })).toBeUndefined()
  expect((await ui.find({ key: 'undo' }))?.props.hotkey).toBe('u')

  await ui.press({ key: 'undo' })
  expect(await ui.find({ key: 'row:1' })).toBeDefined()
  expect(await ui.find({ key: 'approve' })).toBeDefined()
  expect(await ui.find({ key: 'undo' })).toBeUndefined()
  expect(session.appended()).toHaveLength(0)
})

test('a reviewed decision opened from the list can be switched or reopened', async ($, on) => {
  quietUi(on)
  const session = mock.session(on)
  const lastRow = () => JSON.stringify(session.appended().at(-1)?.message.content)
  await logDecision($, SQLITE)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'approve' })
  await ui.press({ key: 'tab:approved' })
  await ui.press({ key: 'row:1' })
  await ui.press({ key: 'reject' })
  expect(lastRow()).toMatch(/changed their mind and rejected D1/)

  await ui.press({ key: 'tab:rejected' })
  await ui.press({ key: 'row:1' })
  await ui.press({ key: 'reopen' })
  expect(lastRow()).toMatch(/withdrew their rejection of D1/)
  expect((await ui.find({ key: 'tab:pending' }))?.text).toMatch(/To review 1/)
  expect(await ui.find({ key: 'approve' })).toBeDefined()
})

const watchMascot = (on: On) => {
  const frames: string[] = []
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.blit', ($, e) => {
    if ('cells' in e && e.key === 'mascot') {
      frames.push(e.cells)
    }

    return { value: {} }
  })

  return frames
}

test('while Claude is idle the mascot sits and blinks now and then', async ($, on) => {
  const clock = mock.clock(on)
  const frames = watchMascot(on)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await clock.advance(15000)

  // Only blinks repaint: eyes shut, then open again, a handful of times in 15 seconds.
  expect(frames.length).toBeGreaterThanOrEqual(2)
  expect(frames.length).toBeLessThanOrEqual(8)
  expect(new Set(frames).size).toBe(2)
  await ui.unmount()
})

test('while Claude works the mascot acts out decisions, and stops once off screen', async ($, on) => {
  const clock = mock.clock(on)
  const frames = watchMascot(on)
  on('turn.start', ($2, e) => ({ turnId: e.turnId }))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'idle' })).toBeDefined()
  await $.turn.start({ text: 'work', turnId: 'turn-1' })
  expect(await ui.find({ type: 'Text', text: 'working' })).toBeDefined()
  await clock.advance(6000)
  expect(new Set(frames).size).toBeGreaterThan(5)

  // A decision arrives: the table replaces the mascot, so it stops being repainted.
  await logDecision($, PNPM)
  await clock.advance(300)
  const shown = frames.length
  await clock.advance(3000)
  expect(frames.length).toBe(shown)
  await ui.unmount()
})
