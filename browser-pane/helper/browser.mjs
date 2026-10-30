#!/usr/bin/env node
// The browser pane's helper: runs headless Chrome, streams the shown tab as PNG frames and takes
// the pane's clicks, keys and commands over a Unix socket. The hooks module spawns it and reads
// one JSON message per line on stdout. No dependencies beyond Node 22 (global WebSocket).

import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = Number(process.env.BROWSER_PANE_PORT ?? 9333)
const CDP_HTTP = `http://127.0.0.1:${PORT}`
const KEPT_FRAMES = 8
const DOUBLE_CLICK_MS = 400

const runtime = process.env.XDG_RUNTIME_DIR ?? tmpdir()
const workDir = join(runtime, 'claude-browser-pane', String(process.pid))
const socketPath = join(workDir, 'control.sock')
const profileDir = join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'claude-browser-pane', 'profile')

mkdirSync(workDir, { recursive: true })
mkdirSync(profileDir, { recursive: true })

const emit = message => process.stdout.write(`${JSON.stringify(message)}\n`)
const log = (...parts) => process.stderr.write(`${parts.join(' ')}\n`)

// The pane's grid in cells and the terminal's cell size in pixels, which set Chrome's window.
const view = { columns: 80, rows: 24, cellWidth: 10, cellHeight: 20, zoom: 1 }

let chrome = null
let browser = null
let nextId = 1
const pending = new Map()
const sessionListeners = new Map()

const tabs = new Map()
let activeId = null
let activeSession = null
let showing = null
let frameSeq = 0
let lastPress = { at: 0, x: 0, y: 0, count: 0 }
let heldButton = 'none'

// --- Terminal cell size --------------------------------------------------------------------------

// Walks up to the first ancestor holding a pseudo-terminal and asks it for its pixel size.
function detectCellSize() {
  try {
    let pid = process.ppid

    for (let depth = 0; depth < 6 && pid > 1; depth++) {
      let tty = ''

      try {
        tty = readlinkSync(`/proc/${pid}/fd/0`)
      } catch {}

      if (tty.startsWith('/dev/pts/') || tty.startsWith('/dev/tty')) {
        const out = execFileSync(
          'perl',
          ['-e', 'open(my $t, "<", $ARGV[0]) or exit 1; my $w = "\\0" x 8; ioctl($t, 0x5413, $w) or exit 1; print join(" ", unpack("S4", $w))', tty],
          { encoding: 'utf8', timeout: 2000 },
        )
        const [rows, columns, width, height] = out.trim().split(' ').map(Number)

        if (columns > 0 && rows > 0 && width > 0 && height > 0) {
          view.cellWidth = width / columns
          view.cellHeight = height / rows
        }

        return
      }

      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      pid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
    }
  } catch (error) {
    log('cell size: kept the default:', error.message)
  }
}

// The window Chrome draws into, in CSS pixels, and the frame size the pane shows, in device pixels.
function windowSize() {
  const width = Math.max(200, Math.round(view.columns * view.cellWidth))
  const height = Math.max(150, Math.round(view.rows * view.cellHeight))

  return {
    frame: { width, height },
    window: { width: Math.round(width * view.zoom), height: Math.round(height * view.zoom) },
  }
}

// --- Chrome --------------------------------------------------------------------------------------

function findChrome() {
  const candidates = [
    process.env.BROWSER_PANE_CHROME,
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
  ].filter(Boolean)

  for (const name of candidates) {
    try {
      return execFileSync('which', [name], { encoding: 'utf8' }).trim() || name
    } catch {}
  }

  throw new Error('No Chrome or Chromium found; set BROWSER_PANE_CHROME to its path.')
}

async function devtoolsUrl() {
  const response = await fetch(`${CDP_HTTP}/json/version`)

  return (await response.json()).webSocketDebuggerUrl
}

async function ensureChrome() {
  if (browser !== null) {
    return
  }

  let url = await devtoolsUrl().catch(() => null)

  if (url === null) {
    const { window } = windowSize()
    chrome = spawn(
      findChrome(),
      [
        '--headless=new',
        `--remote-debugging-port=${PORT}`,
        '--remote-debugging-address=127.0.0.1',
        `--user-data-dir=${profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--force-device-scale-factor=1',
        `--window-size=${window.width},${window.height}`,
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    )
    chrome.stderr.on('data', () => {})
    chrome.on('exit', () => {
      chrome = null
    })

    for (let tries = 0; tries < 100 && url === null; tries++) {
      await new Promise(resolve => setTimeout(resolve, 100))
      url = await devtoolsUrl().catch(() => null)
    }

    if (url === null) {
      throw new Error('Chrome did not open its DevTools port.')
    }
  }

  await connect(url)
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)

    socket.addEventListener('open', async () => {
      browser = socket
      emit({ t: 'cdp', url: CDP_HTTP })

      try {
        await send('Target.setDiscoverTargets', { discover: true })
        resolve()
      } catch (error) {
        reject(error)
      }
    })
    socket.addEventListener('message', event => onMessage(JSON.parse(String(event.data))))
    socket.addEventListener('close', () => {
      browser = null
      activeSession = null
      activeId = null
      showing = null
      tabs.clear()
      emitTabs()
      emit({ t: 'closed' })
    })
    socket.addEventListener('error', () => reject(new Error('Could not reach Chrome.')))
  })
}

function send(method, params = {}, sessionId) {
  if (browser === null) {
    return Promise.reject(new Error('Chrome is not running.'))
  }

  const id = nextId++
  browser.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))

  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

function onMessage(message) {
  if (message.id !== undefined) {
    const waiter = pending.get(message.id)
    pending.delete(message.id)

    if (message.error) {
      waiter?.reject(new Error(message.error.message))
    } else {
      waiter?.resolve(message.result)
    }

    return
  }

  const { method, params, sessionId } = message

  if (sessionId !== undefined) {
    sessionListeners.get(sessionId)?.(method, params)

    return
  }

  if (method === 'Target.targetCreated' && params.targetInfo.type === 'page') {
    tabs.set(params.targetInfo.targetId, params.targetInfo)
    // A new tab is what someone just opened, the pane's person or Claude: show it.
    void show(params.targetInfo.targetId)
  } else if (method === 'Target.targetInfoChanged' && tabs.has(params.targetInfo.targetId)) {
    tabs.set(params.targetInfo.targetId, params.targetInfo)
    emitTabs()
  } else if (method === 'Target.targetDestroyed' && tabs.has(params.targetId)) {
    tabs.delete(params.targetId)

    if (params.targetId === activeId) {
      activeId = null
      activeSession = null
      const last = [...tabs.keys()].at(-1)

      if (last !== undefined) {
        void show(last)
      }
    }

    emitTabs()
  }
}

function emitTabs() {
  emit({
    t: 'tabs',
    activeId,
    tabs: [...tabs.values()].map(tab => ({ id: tab.targetId, title: tab.title, url: tab.url })),
  })
}

// --- The shown tab -------------------------------------------------------------------------------

// Shows a tab; a second call for the tab already being attached waits on the first.
function show(targetId) {
  if (targetId === activeId && (activeSession !== null || showing?.targetId === targetId)) {
    return showing?.promise ?? Promise.resolve()
  }

  const promise = attach(targetId)
  showing = { targetId, promise }

  return promise
}

async function attach(targetId) {
  const previous = activeSession
  activeId = targetId
  activeSession = null
  emitTabs()

  if (previous !== null) {
    sessionListeners.delete(previous)
    void send('Page.stopScreencast', {}, previous).catch(() => {})
    void send('Target.detachFromTarget', { sessionId: previous }).catch(() => {})
  }

  try {
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })

    if (activeId !== targetId) {
      void send('Target.detachFromTarget', { sessionId }).catch(() => {})

      return
    }

    activeSession = sessionId
    sessionListeners.set(sessionId, (method, params) => onPageEvent(sessionId, method, params))
    await send('Page.enable', {}, sessionId)
    await resize()
  } catch (error) {
    log('show:', error.message)
  }
}

async function resize() {
  if (activeSession === null) {
    return
  }

  const { frame, window } = windowSize()

  try {
    const { windowId } = await send('Browser.getWindowForTarget', { targetId: activeId })
    await send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
    await send('Browser.setWindowBounds', { windowId, bounds: window })
    // Headless Chrome keeps room for browser UI it never draws: grow the window by what the page lost.
    const page = await viewport()
    const extra = { width: window.width - page.width, height: window.height - page.height }

    if (extra.width !== 0 || extra.height !== 0) {
      await send('Browser.setWindowBounds', {
        windowId,
        bounds: { width: window.width + extra.width, height: window.height + extra.height },
      })
    }
  } catch (error) {
    log('resize:', error.message)
  }

  await send('Page.stopScreencast', {}, activeSession).catch(() => {})
  await send(
    'Page.startScreencast',
    { format: 'png', maxWidth: frame.width, maxHeight: frame.height, everyNthFrame: 1 },
    activeSession,
  ).catch(error => log('screencast:', error.message))
}

// Chrome does not always announce a title change, so the tabs are read again once a page loads.
async function refreshTabs() {
  const { targetInfos } = await send('Target.getTargets')

  for (const info of targetInfos) {
    if (tabs.has(info.targetId)) {
      tabs.set(info.targetId, info)
    }
  }

  emitTabs()
}

function onPageEvent(sessionId, method, params) {
  if (method === 'Page.loadEventFired') {
    void refreshTabs().catch(() => {})

    return
  }

  if (method !== 'Page.screencastFrame') {
    return
  }

  void send('Page.screencastFrameAck', { sessionId: params.sessionId }, sessionId).catch(() => {})

  if (sessionId !== activeSession) {
    return
  }

  frameSeq += 1
  const file = join(workDir, `frame-${frameSeq}.png`)
  writeFileSync(file, Buffer.from(params.data, 'base64'))
  rmSync(join(workDir, `frame-${frameSeq - KEPT_FRAMES}.png`), { force: true })
  emit({ t: 'frame', file, seq: frameSeq })
}

// --- Commands ------------------------------------------------------------------------------------

const KEYS = {
  return: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
}

const modifiers = input =>
  (input.alt ? 1 : 0) | (input.ctrl ? 2 : 0) | (input.meta ? 4 : 0) | (input.shift ? 8 : 0)

async function viewport() {
  const { result } = await send(
    'Runtime.evaluate',
    { expression: '[innerWidth, innerHeight]', returnByValue: true },
    activeSession,
  )

  return { width: result.value[0], height: result.value[1] }
}

async function mouse(input) {
  if (activeSession === null) {
    return
  }

  const { width, height } = await viewport()
  const x = Math.round(input.fx * width)
  const y = Math.round(input.fy * height)
  const button = input.button ?? 'none'
  let clickCount = 0
  let type = 'mouseMoved'

  if (input.type === 'down') {
    const now = Date.now()
    const isRepeat = now - lastPress.at < DOUBLE_CLICK_MS && Math.abs(x - lastPress.x) < 6 && Math.abs(y - lastPress.y) < 6
    lastPress = { at: now, x, y, count: isRepeat ? lastPress.count + 1 : 1 }
    clickCount = lastPress.count
    type = 'mousePressed'
    heldButton = button
  } else if (input.type === 'up') {
    clickCount = lastPress.count
    type = 'mouseReleased'
    heldButton = 'none'
  }

  const pressed = type === 'mouseMoved' ? heldButton : button
  const buttons = { none: 0, left: 1, right: 2, middle: 4 }[type === 'mouseReleased' ? 'none' : pressed] ?? 0

  await send(
    'Input.dispatchMouseEvent',
    { type, x, y, button: pressed, buttons, clickCount, modifiers: modifiers(input) },
    activeSession,
  )
}

async function wheel(input) {
  if (activeSession === null) {
    return
  }

  const { width, height } = await viewport()

  await send(
    'Input.dispatchMouseEvent',
    {
      type: 'mouseWheel',
      x: Math.round(input.fx * width),
      y: Math.round(input.fy * height),
      deltaX: 0,
      deltaY: input.deltaY,
      modifiers: modifiers(input),
    },
    activeSession,
  )
}

async function key(input) {
  if (activeSession === null) {
    return
  }

  const named = KEYS[input.key]
  const mods = modifiers(input)

  if (named === undefined && [...input.key].length === 1 && !input.ctrl && !input.meta) {
    await send('Input.insertText', { text: input.key }, activeSession)

    return
  }

  const spec = named ?? {
    key: input.key,
    code: `Key${input.key.toUpperCase()}`,
    keyCode: input.key.toUpperCase().charCodeAt(0),
  }
  const text = mods & 6 ? undefined : spec.text

  await send(
    'Input.dispatchKeyEvent',
    {
      type: text ? 'keyDown' : 'rawKeyDown',
      key: spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.keyCode,
      modifiers: mods,
      ...(text ? { text } : {}),
    },
    activeSession,
  )
  await send(
    'Input.dispatchKeyEvent',
    { type: 'keyUp', key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.keyCode, modifiers: mods },
    activeSession,
  )
}

// An address as typed, given a scheme: http for this machine's own servers, https elsewhere.
const withScheme = url => {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) || /^(about|data|file|chrome|view-source|blob):/i.test(url)) {
    return url
  }

  return /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i.test(url) ? `http://${url}` : `https://${url}`
}

async function open(url, { isNewTab = false } = {}) {
  await ensureChrome()

  if (!isNewTab && activeSession !== null) {
    await send('Page.navigate', { url: withScheme(url) }, activeSession)

    return
  }

  // Reuse a blank tab, so opening a page does not leave an empty one behind.
  const blank = [...tabs.values()].find(tab => tab.url === 'about:blank')

  if (blank !== undefined) {
    await show(blank.targetId)
    await send('Page.navigate', { url: withScheme(url) }, activeSession)

    return
  }

  await send('Target.createTarget', { url: withScheme(url) })
}

async function history(delta) {
  const { currentIndex, entries } = await send('Page.getNavigationHistory', {}, activeSession)
  const entry = entries[currentIndex + delta]

  if (entry !== undefined) {
    await send('Page.navigateToHistoryEntry', { entryId: entry.id }, activeSession)
  }
}

async function command(input) {
  switch (input.op) {
    case 'start':
      await ensureChrome()
      if (activeId === null && tabs.size > 0) await show([...tabs.keys()].at(-1))
      return {}
    case 'open':
      // From outside the pane (the BROWSER opener): the hooks module brings the pane up.
      if (input.isExternal) emit({ t: 'opened', url: input.url })
      await open(input.url, { isNewTab: input.isNewTab === true })
      return {}
    case 'size':
      Object.assign(view, {
        columns: input.columns ?? view.columns,
        rows: input.rows ?? view.rows,
        zoom: input.zoom ?? view.zoom,
      })
      await resize()
      return {}
    case 'mouse':
      await mouse(input)
      return {}
    case 'key':
      await key(input)
      return {}
    case 'wheel':
      await wheel(input)
      return {}
    case 'back':
      await history(-1)
      return {}
    case 'forward':
      await history(1)
      return {}
    case 'reload':
      await send('Page.reload', {}, activeSession)
      return {}
    case 'tab':
      await show(input.id)
      return {}
    case 'close-tab':
      await send('Target.closeTarget', { targetId: input.id })
      return {}
    case 'status':
      return {
        cdp: browser === null ? null : CDP_HTTP,
        activeId,
        tabs: [...tabs.values()].map(tab => ({ id: tab.targetId, title: tab.title, url: tab.url })),
      }
    default:
      throw new Error(`Unknown op: ${input.op}`)
  }
}

// --- Control socket ------------------------------------------------------------------------------

const server = createServer((request, response) => {
  let body = ''
  request.on('data', chunk => (body += chunk))
  request.on('end', async () => {
    try {
      const result = await command(JSON.parse(body || '{}'))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(result))
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: error.message }))
    }
  })
})

function shutdown() {
  server.close()
  chrome?.kill()
  rmSync(workDir, { recursive: true, force: true })
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('SIGHUP', shutdown)

// Spawned by Claude Code: when it goes, so does this, and the Chrome it started.
const parent = process.ppid
setInterval(() => {
  if (process.ppid !== parent) shutdown()
}, 2000).unref()

detectCellSize()

server.listen(socketPath, () => {
  emit({ t: 'ready', socket: socketPath, cell: { width: view.cellWidth, height: view.cellHeight }, port: PORT })
})
