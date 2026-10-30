# browser-pane

A Claude Code mod that puts a real Chrome in a pane beside the chat. Links open there instead of in your desktop browser, and Claude can drive the same browser while you watch.

## What it does

- A **Browser** pane with back, forward and reload, an address bar that also searches (DuckDuckGo), a tab strip and the live page, drawn as a picture in the terminal. Click on the page and type into it as you would in a browser; `Esc` hands the keyboard back.
- **Links open in the pane.** The mod points the session's `BROWSER` at the pane, so links Claude Code opens itself (a published artifact, a sign-in page) land there instead of your desktop browser, as do links from tools that honour `BROWSER` (`gh auth login --web`, Python's `webbrowser`). The **links: pane / links: desktop** button in the status line switches this off, and **↗** opens the shown page in your desktop browser.
- **Claude can drive it.** Claude gets an `open` tool for showing you a page and a `status` tool that reports the tabs. To click, type, read or screenshot, it connects to the same Chrome over the DevTools protocol with [browser-use](https://github.com/browser-use/browser-use) or Playwright, and the pane follows what it does.
- **One Chrome per session.** Each Claude Code session runs its own headless Chrome on a DevTools port Chrome picks, so two sessions can browse at once without stepping on each other, and Claude in each session drives only its own. The status line shows the port.
- **Profiles keep their sign-ins.** Chrome locks a profile to one instance, so each session takes the first free profile from a pool of nine in `~/.local/share/claude-browser-pane/` (`profile`, then `profile-2` and up). A session on its own always gets profile 1; a second session open at the same time gets profile 2, with sign-ins of its own. None of your desktop browser's logins are in any of them. Chrome starts with the first page you open, and stops (freeing its profile) when you close its last tab or the session ends.

## Using it

- `/browser` opens the pane with the address bar ready; `/browser example.com` opens a page in it. Claude opens it too, whenever it shows you a page.
- Click the page (or the pane, then `ctrl+x tab`) to give it the keyboard. With the pane holding the keyboard, outside the address bar:

  | Key | Does |
  | --- | --- |
  | `b` / `f` | back / forward |
  | `r` | reload |
  | `1`-`9` | show that tab |
  | `t` | new tab |
  | `x` | close the shown tab |
  | `o` | open the shown page in your desktop browser |
  | `Esc` | back to the prompt |

  The hotkeys switch off while the address bar has the keyboard, so typing an address never presses a button.
- **−** and **+** in the status line zoom the page out and in; the zoom is kept between sessions.
- The mouse wheel over the page scrolls the page; with the page holding the keyboard, the arrow keys, `PgUp`/`PgDn` and space scroll it too.

## Safety

Anything on your machine that can reach a session's DevTools port on `127.0.0.1` can control that Chrome, Claude included, with no per-site permission prompt (unlike the Claude in Chrome extension). Keep sensitive accounts (banking, admin consoles) out of the pane's profiles.

## Requirements

- A terminal that shows pictures with the kitty graphics protocol: Ghostty or kitty (or iTerm2 3.5+ under fullscreen rendering). Elsewhere the pane shows the page's title in place of the picture.
- Node 22 or newer on your `PATH` (the helper uses its built-in WebSocket; no npm install).
- Google Chrome or Chromium. Set `BROWSER_PANE_CHROME` to its path if it is not on your `PATH` under a usual name.
- Linux for now: the helper reads the terminal's cell size through `/proc`, and link catching falls back to `xdg-open`.

## Install

Type this at the Claude Code prompt:

```
/plugin install browser-pane --marketplace HectorBailey/claude-mods
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session). See the [repository README](../README.md) for updating and requirements.

## Developing

Run Claude Code with the mod loaded straight from this folder; it reloads whenever a hooks file here changes (the helper restarts with the session):

```bash
claude --plugin-dir ./browser-pane
```

Check and test it with:

```bash
claude plugin validate ./browser-pane
claude plugin test ./browser-pane
```

`helper/browser.mjs` is the part that runs Chrome. It can be run on its own: it prints one JSON message per line and takes commands as JSON over the Unix socket its first line names.
