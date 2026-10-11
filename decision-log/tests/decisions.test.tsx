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
  expect((await ui.find({ key: 'tab:approved' }))?.text).toMatch(/Approved 1/)
  // The pane opens on To review, so an approved decision leaves the table.
  expect(await ui.find({ key: 'row:1' })).toBeUndefined()
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

test('an empty log draws its placeholder card', async $ => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'No decisions yet' })).toBeDefined()
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
