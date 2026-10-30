import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BrowserTab, HelperPhase, PageEvent } from '../types'

const PANE = 'browser'
const TITLE = ' ◉ Browser'
const OPEN_TOOL = 'mcp__browser-pane__open'
// Matched by pattern: the engine types tool names by the MCP tools connected at load, which may not list these.
const OPEN_PATTERN = /^mcp__browser-pane__open$/
const STATUS_PATTERN = /^mcp__browser-pane__status$/
// Shown until the first frame arrives: one dark pixel stretched over the page's box.
const BLANK = { rgba: 'ICAk/w==', width: 1, height: 1 }
const ZOOMS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 2]
// Rows the pane spends around the page: the toolbar, the tab strip and the status line.
const FRAME_ROWS = 3
// The page's first row in the pane's body, under the toolbar and the tab strip.
const PAGE_TOP = 2
// How far one wheel tick scrolls the page, in CSS pixels.
const WHEEL_PIXELS = 80

const tabs = atom({ plugin: 'browser-pane', key: 'tabs' } as const, [] as BrowserTab[])
const activeId = atom({ plugin: 'browser-pane', key: 'activeId' } as const, null as string | null)
const phase = atom({ plugin: 'browser-pane', key: 'phase' } as const, 'starting' as HelperPhase)
const cdp = atom({ plugin: 'browser-pane', key: 'cdp' } as const, null as string | null)
const profile = atom({ plugin: 'browser-pane', key: 'profile' } as const, null as number | null)
const problem = atom({ plugin: 'browser-pane', key: 'problem' } as const, '')
const zoom = atom({ plugin: 'browser-pane', key: 'zoom' } as const, 1)
const isCatchingLinks = atom({ plugin: 'browser-pane', key: 'isCatchingLinks' } as const, true)
const nativeBrowser = atom({ plugin: 'browser-pane', key: 'nativeBrowser' } as const, null as string | null)
const focused = atom({ plugin: 'browser-pane', key: 'focused' } as const, null as string | null)

const INSTRUCTIONS = `# Browser pane

The user has a Chrome browser pane beside this chat. Whenever you want to show them a web page (a site, a local dev server, a published artifact), open it with ${OPEN_TOOL} instead of their desktop browser.

To click, type, read or screenshot pages yourself, drive that same Chrome over the DevTools protocol; the pane shows what you do. Each session has a Chrome of its own on a port of its own: call mcp__browser-pane__status (or ${OPEN_TOOL}), which starts it and gives its address and the browser-use commands for it. Use only that address, never another session's. Playwright's \`chromium.connectOverCDP(<address>)\` works too. The browser keeps its own profile, so the user may need to sign in to a site there once.`

const OPEN_DESCRIPTION =
  "Open a web page in the user's browser pane, a Chrome shown beside the chat. Use it instead of the user's desktop browser whenever you want to show them a page. Returns once the page starts loading."

const STATUS_DESCRIPTION =
  "Start the browser pane's Chrome if it is not running, and report its tabs and DevTools (CDP) address for driving it with browser-use or Playwright."

const OPEN_SCHEMA = {
  type: 'object',
  properties: {
    url: { type: 'string', description: 'The address to open; https:// is added when no scheme is given.' },
    newTab: { type: 'boolean', description: 'Open it in a new tab instead of the one shown.' },
  },
  required: ['url'],
}

type Helper = { socket: string }

type HelperMessage =
  | { t: 'ready'; socket: string }
  | { t: 'cdp'; url: string; profile: number }
  | { t: 'tabs'; activeId: string | null; tabs: BrowserTab[] }
  | { t: 'frame'; file: string; seq: number }
  | { t: 'opened'; url: string }
  | { t: 'closed' }

let helper: Promise<Helper> | null = null
let latestFrame: string | null = null
// The size last sent to the helper, so a redraw at the same size sends nothing.
let sentSize = ''
// The page region's events already passed on, per region instance.
let regionInstance = ''
let handledSeq = 0
// The page region's size as last drawn, which its props carry with the acknowledgement.
let region = { columns: 0, rows: 0 }

const parseLine = (line: string): HelperMessage | undefined => {
  try {
    const message = JSON.parse(line) as HelperMessage

    return typeof message === 'object' && message !== null && 't' in message ? message : undefined
  } catch {
    return undefined
  }
}

const clip = (text: string, room: number): string =>
  text.length <= room ? text : `${text.slice(0, Math.max(1, room - 1))}…`

// What the URL field's text means: an address as typed, or a search.
const addressFor = (typed: string): string =>
  /^[a-z][a-z0-9+.-]*:\/\//i.test(typed) || /^(localhost|[\w-]+(\.[\w-]+)+)(:\d+)?(\/|$)/i.test(typed)
    ? typed
    : `https://duckduckgo.com/?q=${encodeURIComponent(typed)}`

const shortUrl = (url: string): string => url.replace(/^https?:\/\//, '').replace(/\/$/, '')

const portOf = (address: string): string => /:(\d+)$/.exec(address)?.[1] ?? ''

// How Claude reaches this session's Chrome with browser-use: a browser-use session named after the
// port, so two Claude sessions never share one.
const driveHint = (address: string): string =>
  `DevTools (CDP) address: ${address}. With browser-use, start with \`browser-use --session pane-${portOf(address)} --cdp-url ${address} state\`, then leave out --cdp-url (\`browser-use --session pane-${portOf(address)} click 4\`).`

function startHelper($: EngineInterface): Promise<Helper> {
  helper ??= new Promise<Helper>((resolve, reject) => {
    void runHelper($, resolve, reject)
  })

  return helper
}

// The helper's life: reads its messages until it exits, then marks the browser failed.
async function runHelper(
  $: EngineInterface,
  resolve: (ready: Helper) => void,
  reject: (error: Error) => void,
) {
  await update($, phase, () => 'starting')
  await update($, problem, () => '')

  let buffer = ''
  let lastWords = ''
  let isReady = false

  try {
    const child = $.process.spawn({ argv: ['node', `${$.plugin.root}/helper/browser.mjs`] })

    for await (const chunk of child) {
      if (chunk.stream === 'stderr') {
        lastWords = (lastWords + chunk.text).slice(-1000)
        $.ui.log(`browser-pane helper: ${chunk.text.trimEnd()}`, { to: 'debug' })
        continue
      }

      buffer += chunk.text
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      // Only the newest frame of a burst is worth drawing.
      let frame: string | undefined

      for (const line of lines) {
        const message = parseLine(line)

        if (message?.t === 'frame') {
          frame = message.file
        } else if (message?.t === 'ready') {
          isReady = true
          sentSize = ''
          await catchLinks($, message.socket)
          await update($, phase, () => 'stopped')
          resolve({ socket: message.socket })
        } else if (message !== undefined) {
          await onHelperMessage($, message)
        }
      }

      if (frame !== undefined) {
        latestFrame = frame
        void $.ui.blit({ requestId: PANE, key: 'view', source: { file: frame, format: 'png' } })
      }
    }
  } catch (error) {
    lastWords = error instanceof Error ? error.message : String(error)
  }

  helper = null
  latestFrame = null

  if (!isReady) {
    reject(new Error(`The browser helper did not start: ${lastWords.trim() || 'no output'}`))
  }

  try {
    await releaseLinks($)
    await update($, tabs, () => [])
    await update($, activeId, () => null)
    await update($, cdp, () => null)
    await update($, phase, () => 'failed')
    await update($, problem, () => lastWords.trim().split('\n').at(-1) || 'The browser helper stopped.')
  } catch {
    // The module is unloading (a reload or the session's end), which is what ended the helper.
  }
}

async function onHelperMessage($: EngineInterface, message: HelperMessage) {
  if (message.t === 'cdp') {
    await update($, cdp, () => message.url)
    await update($, profile, () => message.profile)
    await update($, phase, () => 'running')
  } else if (message.t === 'tabs') {
    await update($, tabs, () => message.tabs)
    await update($, activeId, () => message.activeId)
  } else if (message.t === 'opened') {
    // A link from outside the pane (Claude Code's own opener): bring the pane up to show it.
    void openPane($, false)
  } else if (message.t === 'closed') {
    latestFrame = null
    await update($, cdp, () => null)
    await update($, phase, () => 'stopped')
  }
}

async function call($: EngineInterface, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { socket } = await startHelper($)
  const response = await $.http.fetch('http://browser-pane/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    socketPath: socket,
  })
  const answer = JSON.parse(response.text || '{}') as Record<string, unknown>

  if (!response.ok) {
    throw new Error(typeof answer.error === 'string' ? answer.error : `The helper answered ${response.status}.`)
  }

  return answer
}

function act($: EngineInterface, body: Record<string, unknown>) {
  void call($, body).catch(error => $.ui.toast(`Browser: ${error instanceof Error ? error.message : String(error)}`))
}

// Points Claude Code's link opener (and every process it starts) at the pane.
async function catchLinks($: EngineInterface, socket: string) {
  await $.env.set('CLAUDE_BROWSER_PANE_SOCKET', socket)

  if (!(await read($, isCatchingLinks))) {
    return
  }

  const opener = `${$.plugin.root}/bin/open-in-pane`
  const current = await $.env.get('BROWSER')

  if (current !== opener) {
    await update($, nativeBrowser, () => current ?? null)
  }

  await $.env.set('BROWSER', opener)
}

async function releaseLinks($: EngineInterface) {
  if ((await $.env.get('BROWSER')) === `${$.plugin.root}/bin/open-in-pane`) {
    await $.env.set('BROWSER', (await read($, nativeBrowser)) ?? undefined)
  }
}

async function toggleLinks($: EngineInterface) {
  const isOn = await update($, isCatchingLinks, value => !value)
  await $.store.set('isCatchingLinks', isOn)

  if (isOn && helper !== null) {
    await catchLinks($, (await helper).socket)
  } else {
    await releaseLinks($)
  }

  $.ui.toast(isOn ? 'Links now open in the browser pane.' : 'Links now open in your desktop browser.')
}

async function stepZoom($: EngineInterface, step: number) {
  const next = await update($, zoom, value => {
    const at = ZOOMS.findIndex(one => one >= value)

    return ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, (at === -1 ? ZOOMS.length - 1 : at) + step))] ?? value
  })
  await $.store.set('zoom', next)
}

function openPane($: EngineInterface, isFocusing: boolean) {
  return $.ui.open({ id: PANE, title: TITLE, ...(isFocusing ? { focus: true } : {}) })
}

async function go($: EngineInterface, typed: string, isNewTab = false) {
  const text = typed.trim()

  if (text === '') {
    return
  }

  await call($, { op: 'open', url: addressFor(text), isNewTab })
}

async function openOutside($: EngineInterface, url: string | undefined) {
  if (url === undefined || url === 'about:blank') {
    return
  }

  const native = await read($, nativeBrowser)
  // Without BROWSER, so a generic xdg-open does not send the link back to the pane.
  await $.process.run(native === null ? ['env', '-u', 'BROWSER', 'xdg-open', url] : [native, url])
}

// Tells the helper the page's box whenever the pane's size or the zoom changes. Only a running
// helper is told: the next one is told by the redraw its start causes.
function syncSize(columns: number, rows: number, pageZoom: number, $: EngineInterface) {
  const size = `${columns}x${rows}@${pageZoom}`

  if (size === sentSize || helper === null) {
    return
  }

  sentSize = size
  void helper
    .then(({ socket }) =>
      $.http.fetch('http://browser-pane/', {
        method: 'POST',
        body: JSON.stringify({ op: 'size', columns, rows, zoom: 1 / pageZoom }),
        socketPath: socket,
      }),
    )
    .catch(() => {
      sentSize = ''
    })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'open',
      description: OPEN_DESCRIPTION,
      inputSchema: OPEN_SCHEMA,
      isDeferred: false,
    })
    await $.tool.register({
      name: 'status',
      description: STATUS_DESCRIPTION,
      inputSchema: { type: 'object', properties: {} },
    })
    await $.command.register({
      name: 'browser',
      description: 'Open the browser pane; give a URL to load it there',
      argumentHint: '[url]',
      immediate: true,
    })

    const storedZoom = await $.store.get('zoom')
    const storedCatching = await $.store.get('isCatchingLinks')

    if (typeof storedZoom === 'number') {
      await update($, zoom, () => storedZoom)
    }

    if (typeof storedCatching === 'boolean') {
      await update($, isCatchingLinks, () => storedCatching)
    }

    // The helper is small and Chrome only starts with the first page, so it runs from the start:
    // links Claude Code opens reach the pane even before the person has opened it.
    void startHelper($).catch(() => {})

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)

    if (!e.tools.includes(OPEN_TOOL)) {
      return composed
    }

    return {
      sections: [
        ...composed.sections,
        { id: 'browser-pane:instructions', text: INSTRUCTIONS, scope: 'session' as const },
      ],
    }
  })

  // Both tools act only on the pane's own browser, so neither needs a permission prompt.
  on('tool.check', { tool: OPEN_PATTERN }, () => ({ decision: 'allow' as const }))
  on('tool.check', { tool: STATUS_PATTERN }, () => ({ decision: 'allow' as const }))

  on('tool.call', { tool: OPEN_PATTERN }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const url = typeof input.url === 'string' ? input.url.trim() : ''

    if (url === '') {
      return { deny: 'open needs a url.' }
    }

    try {
      await call($, { op: 'open', url, isNewTab: input.newTab === true })
    } catch (error) {
      return { deny: `The browser pane could not open it: ${error instanceof Error ? error.message : String(error)}` }
    }

    const { isPlaced } = await openPane($, false)
    const address = await read($, cdp)
    const opened = isPlaced
      ? `Opened ${url} in the browser pane.`
      : `Loaded ${url} in the browser pane, which is waiting for room on screen; the user can show it with /browser.`

    return { result: address === null ? opened : `${opened} ${driveHint(address)}` }
  })

  on('tool.call', { tool: STATUS_PATTERN }, async $ => {
    try {
      await call($, { op: 'start' })
      const status = await call($, { op: 'status' })
      const list = (status.tabs ?? []) as BrowserTab[]
      const lines = list.map(
        tab => `${tab.id === status.activeId ? '* ' : '  '}${tab.title || '(untitled)'} - ${tab.url}`,
      )

      const address = typeof status.cdp === 'string' ? status.cdp : ''

      return {
        result: [
          `This session's Chrome is running on browser profile ${String(status.profile)}. ${driveHint(address)}`,
          lines.length === 0 ? 'No tabs are open.' : `Tabs (* is the one the pane shows):\n${lines.join('\n')}`,
        ].join('\n'),
      }
    } catch (error) {
      return { deny: `The browser pane's Chrome is not available: ${error instanceof Error ? error.message : String(error)}` }
    }
  })

  on('command.run', { command: 'browser' }, async ($, e) => {
    const typed = e.args.trim()
    await openPane($, true)

    try {
      if (typed !== '') {
        await go($, typed)

        return { text: `Opened ${typed} in the browser pane.` }
      }

      await call($, { op: 'start' })
    } catch (error) {
      return { text: `The browser pane could not start Chrome: ${error instanceof Error ? error.message : String(error)}` }
    }

    if ((await read($, tabs)).length === 0) {
      await call($, { op: 'open', url: 'about:blank' }).catch(() => {})
    }

    void $.ui.focus({ requestId: PANE, key: 'url' }).catch(() => {})

    return { text: 'Browser pane opened.' }
  })

  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    await update($, focused, () => e.element ?? null)

    return next(e)
  })

  // The page region's clicks and keys, passed to Chrome in order.
  on('ui.message', { requestId: PANE }, async ($, e) => {
    const data = e.data as { instance?: string; events?: PageEvent[] }

    if (data.instance !== regionInstance) {
      regionInstance = data.instance ?? ''
      handledSeq = 0
    }

    for (const event of data.events ?? []) {
      if (event.seq <= handledSeq) {
        continue
      }

      handledSeq = event.seq
      const { seq, kind, ...rest } = event
      await call($, { op: kind === 'pointer' ? 'mouse' : 'key', ...rest }).catch(() => {})
    }

    return { props: { ack: handledSeq, ...region } }
  })

  // The page region reports clicks and keys but not the wheel, which scrolls the pane's body instead:
  // a tick over the page scrolls the page, and the pane stays put.
  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const at = e.pointer
    const row = at === undefined ? -1 : at.row - PAGE_TOP
    const isOverPage =
      at !== undefined && row >= 0 && row < region.rows && at.column >= 0 && at.column < region.columns

    if (e.origin.kind !== 'person' || !isOverPage || helper === null) {
      return next(e)
    }

    act($, {
      op: 'wheel',
      fx: (at.column + 0.5) / region.columns,
      fy: (row + 0.5) / region.rows,
      deltaY: e.by * WHEEL_PIXELS,
    })

    return { deny: 'The wheel scrolled the page.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface !== 'terminal') {
      const { Text } = $.ui.resolve(e)

      return <Text dimColor>The browser pane draws pages as pictures, which only the terminal shows.</Text>
    }

    const { Box, Button, Client, Image, Input, Text } = $.ui.resolve(e)
    const list = await read($, tabs)
    const shownId = await read($, activeId)
    const state = await read($, phase)
    const why = await read($, problem)
    const address = await read($, cdp)
    const profileNumber = await read($, profile)
    const pageZoom = await read($, zoom)
    const isCatching = await read($, isCatchingLinks)
    const holder = await read($, focused)
    const width = Math.max(30, e.props.bodyColumns)
    const pageRows = Math.max(6, e.props.scroll.bodyRows - FRAME_ROWS)
    const shown = list.find(tab => tab.id === shownId)
    // No hotkeys while the URL field has the keys, so typing an address never presses a button.
    const hotkey = (key: string) => (holder === 'url' ? {} : { hotkey: key })

    syncSize(width, pageRows, pageZoom, $)
    region = { columns: width, rows: pageRows }

    const tabRoom = Math.max(6, Math.floor((width - 12) / Math.max(1, list.length)) - 4)
    const status: Record<HelperPhase, { color: string; text: string }> = {
      starting: { color: 'warning', text: 'starting…' },
      stopped: { color: 'inactive', text: 'Chrome starts with the first page' },
      running: {
        color: 'success',
        text: `Chrome · profile ${profileNumber ?? '?'} · Claude drives it at :${address === null ? '?' : portOf(address)}`,
      },
      failed: { color: 'error', text: why || 'The browser stopped.' },
    }
    const empty =
      state === 'failed'
        ? why
        : list.length === 0
          ? 'Type an address above, or ask Claude to open a page.'
          : undefined

    return (
      <Box flexDirection="column" width={width}>
        <Box flexDirection="row" gap={1}>
          <Button key="back" plain {...hotkey('b')} onPress={() => act($, { op: 'back' })}>
            ◀
          </Button>
          <Button key="forward" plain {...hotkey('f')} onPress={() => act($, { op: 'forward' })}>
            ▶
          </Button>
          <Button key="reload" plain {...hotkey('r')} onPress={() => act($, { op: 'reload' })}>
            ⟳
          </Button>
          <Box flexGrow={1}>
            <Input
              key="url"
              value={shown === undefined || shown.url === 'about:blank' ? '' : shown.url}
              placeholder="Search or type an address"
              submitLabel="go"
              onSubmit={value => void go($, value).catch(error => $.ui.toast(`Browser: ${String(error)}`))}
            />
          </Box>
          <Button key="outside" plain dimColor {...hotkey('o')} onPress={() => void openOutside($, shown?.url)}>
            ↗
          </Button>
        </Box>
        <Box flexDirection="row" gap={1} overflow="hidden">
          {list.map((tab, index) => {
            const isShown = tab.id === shownId

            return (
              <Button
                key={`tab:${tab.id}`}
                plain
                {...(index < 9 ? hotkey(String(index + 1)) : {})}
                onPress={() => act($, { op: 'tab', id: tab.id })}
              >
                <Text color={isShown ? 'claude' : undefined} bold={isShown} dimColor={!isShown}>
                  {clip(tab.title || shortUrl(tab.url) || 'New tab', tabRoom)}
                </Text>
              </Button>
            )
          })}
          <Button key="new-tab" plain dimColor {...hotkey('t')} onPress={() => act($, { op: 'open', url: 'about:blank', isNewTab: true })}>
            +
          </Button>
          {shown !== undefined && (
            <Button key="close-tab" plain dimColor {...hotkey('x')} onPress={() => act($, { op: 'close-tab', id: shown.id })}>
              ✕
            </Button>
          )}
        </Box>
        <Box width={width} height={pageRows}>
          <Image
            key="view"
            source={latestFrame === null || list.length === 0 ? BLANK : { file: latestFrame, format: 'png' }}
            columns={width}
            rows={pageRows}
            alt={shown?.title || 'The page'}
          />
          <Box position="absolute" top={0} left={0}>
            <Client key="page" module="./surface.tsx" props={{ ack: handledSeq, ...region }} width={width} height={pageRows} />
          </Box>
          {empty !== undefined && (
            <Box position="absolute" top={Math.floor(pageRows / 2)} left={0} width={width} justifyContent="center">
              <Text color={state === 'failed' ? 'error' : undefined} dimColor={state !== 'failed'}>
                {clip(empty, width - 2)}
              </Text>
            </Box>
          )}
        </Box>
        <Box flexDirection="row" justifyContent="space-between">
          <Text>
            <Text color={status[state].color}>● </Text>
            <Text dimColor>{clip(status[state].text, Math.max(10, width - 28))}</Text>
          </Text>
          <Box flexDirection="row" gap={1}>
            <Button key="links" plain dimColor onPress={() => void toggleLinks($)}>
              {isCatching ? 'links: pane' : 'links: desktop'}
            </Button>
            <Button key="zoom-out" plain onPress={() => void stepZoom($, -1)}>
              −
            </Button>
            <Text dimColor>{`${Math.round(pageZoom * 100)}%`}</Text>
            <Button key="zoom-in" plain onPress={() => void stepZoom($, 1)}>
              +
            </Button>
          </Box>
        </Box>
      </Box>
    )
  })
}
