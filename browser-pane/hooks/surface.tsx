import type { ClientModule } from 'claude-code'

import type { PageEvent } from '../types'

// Lies over the page's picture and passes the person's clicks and keys to the hooks module.
// It draws nothing, so the picture beneath shows through.

// `columns` and `rows` are the region's size as the pane laid it out; `ack` the last event handled.
type Props = { ack: number; columns: number; rows: number }

// A post replaces one not yet delivered, so every post carries all the events the hooks module
// has not acknowledged yet: a press is never lost behind the move that follows it.
// `instance` tells the hooks module when a new region (a reopened pane) starts counting again.
type State = { instance: string; seq: number; queue: PageEvent[] }

// An event before it is numbered, each kind keeping its own fields.
type Unnumbered<E> = E extends unknown ? Omit<E, 'seq'> : never

const PageInput: ClientModule<Props, State> = (props, surface) => {
  const state = surface.state

  if (state === undefined) {
    const fresh: State = { instance: Math.random().toString(36).slice(2), seq: 0, queue: [] }
    const push = (event: Unnumbered<PageEvent>) => {
      fresh.seq += 1
      const last = fresh.queue.at(-1)
      const next = { ...event, seq: fresh.seq } as PageEvent

      // Moves in a row fold into the latest one.
      if (last?.kind === 'pointer' && last.type === 'move' && next.kind === 'pointer' && next.type === 'move') {
        fresh.queue[fresh.queue.length - 1] = next
      } else {
        fresh.queue.push(next)
      }

      surface.post({ instance: fresh.instance, events: fresh.queue })
    }

    surface.onPointer(event => {
      const columns = surface.columns || props.columns
      const rows = surface.rows || props.rows

      if (event.type === 'enter' || event.type === 'leave' || columns === 0 || rows === 0) {
        return
      }

      push({
        kind: 'pointer',
        type: event.type,
        fx: Math.min(1, Math.max(0, (event.fine?.x ?? event.x + 0.5) / columns)),
        fy: Math.min(1, Math.max(0, (event.fine?.y ?? event.y + 0.5) / rows)),
        ...(event.button ? { button: event.button } : {}),
        ...(event.shift ? { shift: true } : {}),
        ...(event.alt ? { alt: true } : {}),
        ...(event.ctrl ? { ctrl: true } : {}),
      })
    })
    surface.onKey(event => push({ kind: 'key', ...event }))
    surface.setState(fresh)
  } else {
    state.queue = state.queue.filter(event => event.seq > props.ack)
  }

  const { Box } = surface.elements

  return <Box flexGrow={1} />
}

export default PageInput
