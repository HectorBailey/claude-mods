import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const PANE = {
  plugin: 'browser-pane',
  component: 'Pane',
  requestId: 'browser',
  props: {
    title: ' ◉ Browser',
    isFocused: true,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const SOCKET = '/run/test/control.sock'

// The engine types tool calls by the MCP tools connected at load, which may not list this plugin's own.
const callTool = ($: Engine, input: Record<string, unknown>) => $.tool.call(input as never)

// Stands in for the helper process: it starts, says where its socket is, and keeps running, while
// every request the module sends it is recorded.
const fakeHelper = (on: On) => {
  const sent: Record<string, unknown>[] = []
  const env: Record<string, string | undefined> = {}

  mock.clock(on)
  mock.store(on)
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: `{"t":"ready","socket":"${SOCKET}"}\n{"t":"cdp","url":"http://127.0.0.1:41235","profile":2}\n` }
    await new Promise(() => {})

    return { code: 0, signal: null }
  })
  on('http.fetch', (_, e) => {
    expect(e.init?.socketPath).toBe(SOCKET)
    sent.push(JSON.parse(e.init?.body ?? '{}') as Record<string, unknown>)

    return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
  })
  on('env.get', (_, e) => ({ value: env[e.name] }))
  on('env.set', (_, e) => {
    env[e.name] = e.value

    return { value: {} }
  })
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.blit', () => ({ value: {} }))
  on('ui.focus', () => ({ value: {} }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__browser-pane__${e.name}` } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  return { sent, env }
}

test('the open tool loads the page in the pane and links are pointed at it', async ($, on) => {
  const { sent, env } = fakeHelper(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const opened = await callTool($, { tool: 'mcp__browser-pane__open', url: 'example.com' })

  expect(opened.text ?? JSON.stringify(opened.result)).toContain('Opened example.com in the browser pane')
  expect(sent).toContainEqual({ op: 'open', url: 'example.com', isNewTab: false })
  expect(env.BROWSER).toMatch(/\/bin\/open-in-pane$/)
  expect(env.CLAUDE_BROWSER_PANE_SOCKET).toBe(SOCKET)
})

test("Claude is pointed at this session's own Chrome, not a fixed port", async ($, on) => {
  fakeHelper(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const opened = await callTool($, { tool: 'mcp__browser-pane__open', url: 'example.com' })
  const text = opened.text ?? JSON.stringify(opened.result)

  expect(text).toContain('http://127.0.0.1:41235')
  expect(text).toContain('--session pane-41235')
})

test('clicks and keys on the page reach Chrome once each, in order', async ($, on) => {
  const { sent } = fakeHelper(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.pointer({ type: 'down', x: 30, y: 13, button: 'left' })
  await ui.pointer({ type: 'up', x: 30, y: 13, button: 'left' })
  await ui.key({ key: 'a' })

  const input = sent.filter(one => one.op === 'mouse' || one.op === 'key')
  expect(input.map(one => `${String(one.op)}:${String(one.type ?? one.key)}`)).toEqual(['mouse:down', 'mouse:up', 'key:a'])
  // The middle of the region is the middle of the page.
  expect(Math.abs(Number(input[0]?.fx) - 0.5)).toBeLessThan(0.05)
  await ui.unmount()
})

test('the pane draws the page, its address bar and the way back to Claude', async ($, on) => {
  fakeHelper(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await ui.find({ type: 'Image', key: 'view' })).toBeDefined()
  expect(await ui.find({ type: 'Client', key: 'page' })).toBeDefined()
  expect(await ui.find({ type: 'Input', key: 'url' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /ask Claude to open a page/ })).toBeDefined()
  await ui.unmount()

  const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await desktop.find({ type: 'Text', text: /only the terminal shows/ })).toBeDefined()
  await desktop.unmount()
})
