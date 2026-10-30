// Sends one URL to the browser pane's helper; exits non-zero when the helper cannot take it.

import { request } from 'node:http'

const [url] = process.argv.slice(2)
const socketPath = process.env.CLAUDE_BROWSER_PANE_SOCKET

if (!url || !socketPath) {
  process.exit(2)
}

const call = request({ socketPath, path: '/', method: 'POST', timeout: 15000 }, response => {
  response.resume()
  response.on('end', () => process.exit(response.statusCode === 200 ? 0 : 1))
})

call.on('error', () => process.exit(1))
call.on('timeout', () => call.destroy())
call.end(JSON.stringify({ op: 'open', url, isExternal: true, isNewTab: true }))
