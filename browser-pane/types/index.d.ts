export type BrowserTab = { id: string; title: string; url: string }

// What the page's input region posts: a click or key, numbered so none is handled twice.
export type PageEvent =
  | { seq: number; kind: 'pointer'; type: string; fx: number; fy: number; button?: string; shift?: true; alt?: true; ctrl?: true }
  | { seq: number; kind: 'key'; key: string; ctrl?: true; shift?: true; meta?: true }

// Where the browser stands: helper up with no Chrome yet, helper launching, Chrome serving the
// pane, or the helper exited with a problem.
export type HelperPhase = 'stopped' | 'starting' | 'running' | 'failed'

declare module 'claude-code' {
  interface PluginState {
    'browser-pane': {
      tabs: BrowserTab[]
      activeId: string | null
      phase: HelperPhase
      // This session's Chrome: its DevTools address and which profile of the pool it runs on.
      cdp: string | null
      profile: number | null
      // The helper's last words when it failed; empty otherwise.
      problem: string
      // The page's zoom as a browser shows it: 1.25 draws text a quarter larger.
      zoom: number
      isCatchingLinks: boolean
      // BROWSER as it was before this mod set it, so turning link catching off restores it.
      nativeBrowser: string | null
      // The pane element holding the keyboard; its hotkeys are off while the URL field has it.
      focused: string | null
    }
  }
}
