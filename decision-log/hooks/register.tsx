import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Decision, DecisionTab, Reversibility, Verdict, VerdictChange } from '../types'

import { banner, MASCOT_IDLE_FRAMES, MASCOT_SIZE, MASCOT_WORKING_FRAMES } from './graphics'

const PANE = 'decisions'
const TITLE = ' ◆ Decision log'
const TOOL = 'mcp__decision-log__log_decision'
// Matched by pattern: the engine types tool names by the MCP tools connected at load, which may not list this one.
const TOOL_PATTERN = /^mcp__decision-log__log_decision$/

const decisions = atom({ plugin: 'decision-log', key: 'decisions' } as const, [] as Decision[])
const isWorking = atom({ plugin: 'decision-log', key: 'isWorking' } as const, false)
const selectedId = atom({ plugin: 'decision-log', key: 'selectedId' } as const, null as number | null)
const currentTab = atom({ plugin: 'decision-log', key: 'tab' } as const, 'pending' as DecisionTab)
const lastChange = atom(
  { plugin: 'decision-log', key: 'lastChange' } as const,
  null as VerdictChange | null,
)
const commentingId = atom(
  { plugin: 'decision-log', key: 'commentingId' } as const,
  null as number | null,
)

const INSTRUCTIONS = `# Decision log

The user reviews your judgement calls in a decision log pane, so they can follow the ramifications of the work as it happens. While you work, call ${TOOL} each time you make a choice the user did not spell out and could reasonably have made differently, for example:
- picking between approaches, libraries, data models, file layouts or APIs
- resolving an ambiguity in the request with an assumption
- skipping, deferring, stubbing or working around something
- widening or narrowing the scope of the task
- anything that is costly to reverse later (schema, public interface, deleted data, dependencies)

Log the decision when you make it, not in a batch at the end, and keep working: do not wait for approval. Skip mechanics nobody would question (local variable names, the order you read files in, formatting). A typical task has between zero and five of these.

If a decision log message says the user rejected a decision, stop and deal with it before going further: undo or change what followed from that decision, then log the replacement decision. If they approved one with a comment, take the comment into account.`

const TOOL_DESCRIPTION =
  'Record a judgement call you just made so the user can approve or reject it in their decision log pane. Returns at once; keep working.'

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    choice: {
      type: 'string',
      description: 'What you decided, as one short imperative line ("Store sessions in SQLite").',
    },
    why: { type: 'string', description: 'Why, in a sentence.' },
    alternatives: {
      type: 'string',
      description: 'What else you considered, briefly. Omit when there was no real alternative.',
    },
    impact: {
      type: 'string',
      description:
        'The ramifications: what this affects, what it locks in, what it would cost to change later.',
    },
    reversibility: {
      type: 'string',
      enum: ['easy', 'moderate', 'hard'],
      description: 'How hard it is to undo later.',
    },
  },
  required: ['choice', 'why', 'impact', 'reversibility'],
}

const REVERSIBILITY: Record<Reversibility, { label: string; color: string; level: number }> = {
  easy: { label: 'easy to undo', color: 'success', level: 1 },
  moderate: { label: 'moderate to undo', color: 'warning', level: 2 },
  hard: { label: 'hard to undo', color: 'error', level: 3 },
}

const STATUS: Record<Verdict, { icon: string; color: string; label: string }> = {
  pending: { icon: '●', color: 'warning', label: 'to review' },
  approved: { icon: '✓', color: 'success', label: 'approved' },
  rejected: { icon: '✗', color: 'error', label: 'rejected' },
}

const TABS: readonly { value: DecisionTab; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'pending', label: 'To review' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
]

const asText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

const asReversibility = (value: unknown): Reversibility =>
  value === 'easy' || value === 'hard' ? value : 'moderate'

// What Claude reads when a verdict changes; undefined when there is nothing to tell it.
const feedbackFor = (before: Decision, after: Decision): string | undefined => {
  const name = `D${after.id} ("${after.choice}")`
  const comment = after.comment === '' ? '' : ` Their comment: ${after.comment}`

  if (after.verdict === 'rejected') {
    const opening =
      before.verdict === 'approved'
        ? `the user changed their mind and rejected ${name}, which they had approved.`
        : `the user rejected ${name}.`
    const ask =
      after.comment === ''
        ? ' They left no comment; ask them what they want instead if it is not clear.'
        : comment

    return `Decision log: ${opening}${ask} Revisit it before going further: undo or change what followed from it, then log the replacement decision.`
  }

  if (after.verdict === 'approved') {
    if (before.verdict === 'rejected') {
      return `Decision log: the user changed their mind and approved ${name}, which they had rejected.${comment} If you have not acted on the rejection yet, keep the decision as it was. If you already reworked it, ask them before putting it back.`
    }

    return after.comment === '' ? undefined : `Decision log: the user approved ${name} and commented: ${after.comment}`
  }

  if (before.verdict === 'rejected') {
    return `Decision log: the user withdrew their rejection of ${name} and is reviewing it again. Do not act on that rejection unless they reject it again.`
  }

  // A plain approval was never sent, so taking it back needs no word to Claude.
  return before.comment === ''
    ? undefined
    : `Decision log: the user reopened ${name}, which they had approved with a comment. It is under review again, so hold off on that comment until they decide.`
}

const clip = (text: string, room: number): string =>
  text.length <= room ? text : `${text.slice(0, Math.max(1, room - 1))}…`

const shownIn = (list: readonly Decision[], tab: DecisionTab): readonly Decision[] =>
  tab === 'all' ? list : list.filter(one => one.verdict === tab)

// The stored selection when it is on this tab, else the first decision waiting, else the newest.
const selectedIn = (shown: readonly Decision[], stored: number | null): Decision | undefined =>
  shown.find(one => one.id === stored) ??
  shown.find(one => one.verdict === 'pending') ??
  shown[shown.length - 1]

// Comments typed in the pane, by decision id, until a verdict button takes them.
const drafts = new Map<number, string>()

// The person closed the pane: a new decision updates the status line instead of reopening it.
let isPaneDismissed = false

// Pixel animation: one timer runs while the pane shows something that moves, and stops once
// nothing does. The terminal's last drawing says what that is; the timer repaints between drawings.
const TICK_MS = 100
const TICKS_PER_MASCOT_FRAME = 3
let animation: Timer | undefined
let tick = 0
let mascotFrame = 0
let isMascotShown = false
// The mascot acts out decisions while Claude works and sits blinking otherwise.
let isMascotBusy = false
// What the mascot shows now, so the timer repaints only when a frame differs.
let mascotShowing = ''
let shimmer: { width: number; left: string; right: string } | undefined

const mascotFrames = (): readonly string[] => (isMascotBusy ? MASCOT_WORKING_FRAMES : MASCOT_IDLE_FRAMES)

// The frame a drawing shows now; the timer carries on from it.
const mascotNow = (): string => {
  mascotShowing = mascotFrames()[mascotFrame] ?? ''

  return mascotShowing
}

// Where the light sweeping the title bar is at a tick: in from the left, out past the right.
const glowAt = (at: number, width: number): number => ((at * 1.5) % (width + 24)) - 12

function stopAnimation() {
  animation?.cancel()
  animation = undefined
}

async function repaint($: EngineInterface, key: string, cells: string) {
  try {
    const result = await $.ui.blit({ requestId: PANE, key, cells })

    // Refused: the pane closed or its drawing moved on. The next drawing starts it again.
    if (result.deny !== undefined) {
      stopAnimation()
    }
  } catch {
    stopAnimation()
  }
}

function animate($: EngineInterface) {
  if (animation !== undefined || (!isMascotShown && shimmer === undefined)) {
    return
  }

  animation = $.clock.every(TICK_MS, () => {
    tick += 1

    if (!isMascotShown && shimmer === undefined) {
      stopAnimation()
      return
    }

    if (isMascotShown && tick % TICKS_PER_MASCOT_FRAME === 0) {
      const shown = mascotShowing
      mascotFrame = (mascotFrame + 1) % mascotFrames().length

      if (mascotNow() !== shown) {
        void repaint($, 'mascot', mascotShowing)
      }
    }

    if (shimmer !== undefined) {
      const { width, left, right } = shimmer
      void repaint($, 'banner', banner(width, left, right, glowAt(tick, width)))
    }
  })
}

function showStatus($: EngineInterface, list: readonly Decision[]) {
  const pending = list.filter(one => one.verdict === 'pending').length

  $.ui.status(
    pending === 0
      ? undefined
      : `${pending} decision${pending === 1 ? '' : 's'} to review (/decisions)`,
  )
}

function openPane($: EngineInterface, isFocusing: boolean) {
  return $.ui.open({ id: PANE, title: 'Decisions', ...(isFocusing ? { focus: true } : {}) })
}

async function select($: EngineInterface, id: number) {
  await update($, selectedId, () => id)
  await update($, commentingId, current => (current === id ? current : null))
}

async function moveSelection($: EngineInterface, by: number) {
  const shown = shownIn(await read($, decisions), await read($, currentTab))
  const current = selectedIn(shown, await read($, selectedId))

  if (current === undefined) {
    return
  }

  const index = shown.indexOf(current) + by
  const target = shown[Math.min(shown.length - 1, Math.max(0, index))]

  if (target !== undefined) {
    await select($, target.id)
  }
}

async function startComment($: EngineInterface, id: number) {
  await update($, commentingId, () => id)

  // Best effort: the box is open either way, and moving the ring there only saves a Tab.
  try {
    await $.ui.focus({ requestId: PANE, key: `comment:${id}` })
  } catch (error) {
    $.ui.log(`decision-log: could not focus the comment box: ${String(error)}`, { to: 'debug' })
  }
}

// Every verdict change goes through here: a first verdict, a switch, a reopen, an undo.
async function setVerdict($: EngineInterface, id: number, verdict: Verdict) {
  const isClaudeWorking = await read($, isWorking)
  let before: Decision | undefined
  let after: Decision | undefined

  const list = await update($, decisions, all =>
    all.map(one => {
      if (one.id !== id || one.verdict === verdict) {
        return one
      }

      before = one
      after = {
        ...one,
        verdict,
        comment: verdict === 'pending' ? '' : (drafts.get(id) ?? one.comment).trim(),
        isAwaitingRevisit: verdict === 'rejected' && !isClaudeWorking,
      }

      return after
    }),
  )

  if (before === undefined || after === undefined) {
    return
  }

  await update($, commentingId, () => null)
  await update($, lastChange, () => ({ id, from: before?.verdict ?? 'pending', to: verdict }))
  showStatus($, list)

  if (verdict === 'pending') {
    // Reopened: its old comment comes back to edit, and it waits on the To review tab.
    drafts.set(id, before.comment)
    await update($, currentTab, () => 'pending')
    await update($, selectedId, () => id)
  } else {
    drafts.delete(id)
  }

  if (before.verdict === 'pending') {
    const waiting = list.filter(one => one.verdict === 'pending')
    const nextUp = waiting.find(one => one.id > id) ?? waiting[0]

    if (nextUp !== undefined) {
      await update($, selectedId, () => nextUp.id)
    }
  }

  const text = feedbackFor(before, after)

  if (text !== undefined) {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
  }
}

async function undoLastChange($: EngineInterface) {
  const change = await read($, lastChange)
  const decision = (await read($, decisions)).find(one => one.id === change?.id)

  if (change === null || decision === undefined || decision.verdict !== change.to) {
    return
  }

  await setVerdict($, change.id, change.from)
  await update($, lastChange, () => null)
  await update($, selectedId, () => change.id)
}

async function revisit($: EngineInterface) {
  const ids = (await read($, decisions))
    .filter(one => one.isAwaitingRevisit)
    .map(one => `D${one.id}`)

  if (ids.length === 0) {
    return
  }

  await update($, decisions, all => all.map(one => ({ ...one, isAwaitingRevisit: false })))
  await $.prompt.submit({
    text: `I rejected ${ids.join(', ')} in the decision log. Please revisit ${ids.length === 1 ? 'it' : 'them'} as my comments say.`,
    asUser: true,
  })
}

async function clearReviewed($: EngineInterface) {
  const list = await update($, decisions, all =>
    all.filter(one => one.verdict === 'pending' || one.isAwaitingRevisit),
  )
  showStatus($, list)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'log_decision',
      description: TOOL_DESCRIPTION,
      inputSchema: INPUT_SCHEMA,
      isDeferred: false,
    })
    await $.command.register({
      name: 'decisions',
      description: 'Open the decision log pane; "clear" drops reviewed decisions',
      argumentHint: '[clear]',
      immediate: true,
    })
    showStatus($, await read($, decisions))

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)

    if (!e.tools.includes(TOOL)) {
      return composed
    }

    return {
      sections: [
        ...composed.sections,
        { id: 'decision-log:instructions', text: INSTRUCTIONS, scope: 'session' as const },
      ],
    }
  })

  // Logging a decision only writes to this pane, so it never needs a permission prompt.
  on('tool.check', { tool: TOOL_PATTERN }, () => ({ decision: 'allow' as const }))

  on('tool.call', { tool: TOOL_PATTERN }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const choice = asText(input.choice)

    if (choice === '') {
      return { deny: 'log_decision needs a choice: what you decided, in one line.' }
    }

    let id = 0
    const reversibility = asReversibility(input.reversibility)
    const list = await update($, decisions, all => {
      id = all.reduce((max, one) => Math.max(max, one.id), 0) + 1

      return [
        ...all,
        {
          id,
          choice,
          why: asText(input.why),
          alternatives: asText(input.alternatives),
          impact: asText(input.impact),
          reversibility,
          isFromSubagent: e.agentId !== undefined,
          verdict: 'pending' as const,
          comment: '',
          isAwaitingRevisit: false,
        },
      ]
    })

    showStatus($, list)

    // Bring a new decision into view unless the person is looking at one still waiting.
    const shownId = await read($, selectedId)
    const shownDecision = list.find(one => one.id === shownId)

    if (shownDecision === undefined || shownDecision.verdict !== 'pending') {
      await update($, selectedId, () => id)
    }

    if (reversibility === 'hard') {
      $.ui.toast(`D${id} is hard to undo: ${choice}`, { timeoutMs: 8000 })
    }

    if (!isPaneDismissed) {
      void openPane($, false)
    }

    return {
      result: `Logged as D${id}. The user reviews it in their decision log; carry on without waiting.`,
    }
  })

  on('turn.start', async ($, e, next) => {
    await update($, isWorking, () => true)
    // Claude reads every verdict already appended at the start of this turn.
    await update($, decisions, all =>
      all.some(one => one.isAwaitingRevisit)
        ? all.map(one => ({ ...one, isAwaitingRevisit: false }))
        : all,
    )

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, isWorking, () => false)
    }

    return next(e)
  })

  on('command.run', { command: 'decisions' }, async ($, e) => {
    if (e.args.trim() === 'clear') {
      await clearReviewed($)

      return { text: 'Cleared reviewed decisions.' }
    }

    isPaneDismissed = false
    await openPane($, true)

    return { text: 'Decision log opened.' }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') {
      isPaneDismissed = true
    }

    return next(e)
  })

  // Moving the focus ring onto a table row selects it, so the arrows flick through the details.
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    const id = e.element?.startsWith('row:') === true ? Number(e.element.slice(4)) : NaN

    if (!Number.isNaN(id)) {
      await select($, id)
    }

    return next(e)
  })


  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    const Input = 'Input' in elements ? elements.Input : undefined
    const Raster = 'Raster' in elements ? elements.Raster : undefined
    const list = await read($, decisions)
    const tab = await read($, currentTab)
    const stored = await read($, selectedId)
    const commenting = await read($, commentingId)
    const change = await read($, lastChange)
    const isClaudeWorking = await read($, isWorking)

    if (Raster !== undefined && isMascotBusy !== isClaudeWorking) {
      isMascotBusy = isClaudeWorking
      mascotFrame = 0
    }

    const pending = list.filter(one => one.verdict === 'pending').length
    const approved = list.filter(one => one.verdict === 'approved').length
    const rejected = list.filter(one => one.verdict === 'rejected').length
    const awaitingRevisit = list.filter(one => one.isAwaitingRevisit)
    const counts: Record<DecisionTab, number> = { all: list.length, pending, approved, rejected }
    const shown = shownIn(list, tab)
    const selected = selectedIn(shown, stored)
    const isCommenting = Input !== undefined && selected !== undefined && commenting === selected.id
    // No hotkeys while the comment box is open, so typing never presses a button.
    const hotkey = (key: string) => (isCommenting ? {} : { hotkey: key })
    const width = Math.max(24, e.props.bodyColumns)

    const heading = (title: string) => (
      <Box marginTop={1}>
        <Text bold color="claude">
          {title.toUpperCase()}
        </Text>
        <Text dimColor>{` ${'─'.repeat(Math.max(0, width - title.length - 1))}`}</Text>
      </Box>
    )

    const gauge = (reversibility: Reversibility) => {
      const undo = REVERSIBILITY[reversibility]

      return (
        <Text>
          <Text color={undo.color}>{'●'.repeat(undo.level)}</Text>
          <Text dimColor>{'○'.repeat(3 - undo.level)}</Text>
        </Text>
      )
    }

    const pill = (text: string, color: string) => (
      <Text backgroundColor={color} color="inverseText" bold>
        {` ${text} `}
      </Text>
    )

    const header = () => {
      const right = isClaudeWorking ? '● Claude is working ' : `${list.length} logged `

      if (Raster !== undefined) {
        // While Claude works a light sweeps along the bar, from where the timer has it now.
        const glow = isClaudeWorking ? glowAt(tick, width) : undefined
        shimmer = isClaudeWorking ? { width, left: TITLE, right } : undefined

        return <Raster key="banner" columns={width} rows={1} cells={banner(width, TITLE, right, glow)} />
      }

      return (
        <Box gap={1}>
          <Text bold>
            <Text color="claude">◆</Text> Decision log
          </Text>
          <Text dimColor>· {right.trim()}</Text>
        </Box>
      )
    }

    const progressBar = () => {
      const approvedCells = Math.round((approved / list.length) * width)
      const rejectedCells = Math.min(width - approvedCells, Math.round((rejected / list.length) * width))

      return (
        <Text>
          <Text color="success">{'▔'.repeat(approvedCells)}</Text>
          <Text color="error">{'▔'.repeat(rejectedCells)}</Text>
          <Text dimColor>{'▔'.repeat(width - approvedCells - rejectedCells)}</Text>
        </Text>
      )
    }

    const tabButton = ({ value, label }: { value: DecisionTab; label: string }) => {
      const isActive = value === tab

      return (
        <Button key={`tab:${value}`} plain onPress={() => update($, currentTab, () => value)}>
          {isActive ? (
            pill(`${label} ${counts[value]}`, 'claude')
          ) : (
            <Text color="inactive">{` ${label} ${counts[value]} `}</Text>
          )}
        </Button>
      )
    }

    // The table shows a window of rows around the selection so the detail stays on screen.
    const room = Math.max(4, Math.min(15, e.props.scroll.bodyRows - 26))
    const index = selected === undefined ? 0 : shown.indexOf(selected)
    const start = Math.min(Math.max(0, index - Math.floor(room / 2)), Math.max(0, shown.length - room))
    const rows = shown.slice(start, start + room)
    const below = shown.length - start - rows.length

    const row = (one: Decision) => {
      const isSelected = one.id === selected?.id
      const status = STATUS[one.verdict]
      const undo = REVERSIBILITY[one.reversibility]

      return (
        <Button key={`row:${one.id}`} plain onPress={() => select($, one.id)}>
          <Text color="claude">{isSelected ? '▌' : ' '}</Text>
          <Text color={status.color}>{` ${status.icon} `}</Text>
          <Text bold={isSelected} color={isSelected ? 'claude' : 'inactive'}>
            {`D${one.id}`.padEnd(4)}
          </Text>
          <Text color={undo.color}>{'●'.repeat(undo.level)}</Text>
          <Text dimColor>{'○'.repeat(3 - undo.level)}</Text>
          <Text bold={isSelected} dimColor={!isSelected}>
            {`  ${clip(one.choice, width - 14)}`}
          </Text>
        </Button>
      )
    }

    const field = (icon: string, color: string, label: string, value: string) =>
      value !== '' && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={color} bold>
            {`${icon} ${label}`}
          </Text>
          <Box paddingLeft={2}>
            <Text>{value}</Text>
          </Box>
        </Box>
      )

    const panel = (one: Decision) => {
      const undo = REVERSIBILITY[one.reversibility]
      const status = STATUS[one.verdict]
      const draft = (drafts.get(one.id) ?? '').trim()
      const isPending = one.verdict === 'pending'

      return (
        <Box
          key="detail"
          flexDirection="column"
          borderStyle="round"
          borderColor={undo.color}
          hover={{ borderColor: 'claude' }}
          paddingX={1}
          marginTop={1}
        >
          <Box gap={1}>
            {pill(`D${one.id}`, 'claude')}
            {pill(`${status.icon} ${status.label.toUpperCase()}`, status.color)}
            {gauge(one.reversibility)}
            <Text color={undo.color}>{undo.label}</Text>
            {one.isFromSubagent && <Text dimColor>· subagent</Text>}
          </Box>
          <Box marginTop={1}>
            <Text bold>{one.choice}</Text>
          </Box>
          {field('»', 'suggestion', 'Why', one.why)}
          {field('⇄', 'permission', 'Instead of', one.alternatives)}
          {field('▲', 'warning', 'Ramifications', one.impact)}
          {!isPending && one.comment !== '' && field('↳', 'text', 'Your comment', one.comment)}
          {one.isAwaitingRevisit && (
            <Box marginTop={1}>
              <Text color="warning">↻ waiting for Claude to revisit</Text>
            </Box>
          )}
          {isPending && isCommenting && Input !== undefined && (
            <Box marginTop={1}>
              <Input
                key={`comment:${one.id}`}
                label="✎"
                placeholder="type a comment"
                value={drafts.get(one.id) ?? ''}
                submitLabel="keep"
                onInput={value => {
                  drafts.set(one.id, value)
                }}
                onSubmit={value => {
                  drafts.set(one.id, value)
                  void update($, commentingId, () => null)
                }}
              />
            </Box>
          )}
          {isPending && !isCommenting && draft !== '' && field('✎', 'permission', 'Your comment', draft)}
          {isPending && (
            <Box marginTop={1} gap={2}>
              <Button key="approve" plain {...hotkey('a')} onPress={() => setVerdict($, one.id, 'approved')}>
                {pill('✓ Approve', 'success')}
              </Button>
              <Button key="reject" plain {...hotkey('r')} onPress={() => setVerdict($, one.id, 'rejected')}>
                {pill('✗ Reject', 'error')}
              </Button>
              {Input !== undefined && !isCommenting && (
                <Button key="comment" plain {...hotkey('c')} onPress={() => startComment($, one.id)}>
                  {pill(draft === '' ? '✎ Comment' : '✎ Edit comment', 'permission')}
                </Button>
              )}
            </Box>
          )}
          {!isPending && (
            <Box marginTop={1} gap={2}>
              {one.verdict === 'approved' ? (
                <Button key="reject" plain {...hotkey('r')} onPress={() => setVerdict($, one.id, 'rejected')}>
                  {pill('✗ Reject instead', 'error')}
                </Button>
              ) : (
                <Button key="approve" plain {...hotkey('a')} onPress={() => setVerdict($, one.id, 'approved')}>
                  {pill('✓ Approve instead', 'success')}
                </Button>
              )}
              <Button key="reopen" plain {...hotkey('o')} onPress={() => setVerdict($, one.id, 'pending')}>
                {pill('↺ Reopen', 'permission')}
              </Button>
            </Box>
          )}
        </Box>
      )
    }

    const hero = () => (
      <Box flexDirection="column" alignItems="center">
        {Raster !== undefined && (
          <Raster key="mascot" columns={MASCOT_SIZE.columns} rows={MASCOT_SIZE.rows} cells={mascotNow()} />
        )}
        <Text color={isClaudeWorking ? 'claude' : 'inactive'} bold={isClaudeWorking}>
          {isClaudeWorking ? 'working' : 'idle'}
        </Text>
      </Box>
    )

    const overview = () => {
      const byUndo = (['easy', 'moderate', 'hard'] as const).map(level => ({
        level,
        count: list.filter(one => one.reversibility === level).length,
      }))
      const most = Math.max(1, ...byUndo.map(one => one.count))
      const barRoom = Math.max(4, width - 24)

      return (
        <Box flexDirection="column">
          {heading('Overview')}
          <Box gap={3} marginTop={1}>
            {hero()}
            <Box flexDirection="column" justifyContent="center">
              <Text bold>{pending === 0 ? '✓ All caught up' : `${pending} waiting for review`}</Text>
              <Text dimColor>{`${list.length} decisions this session`}</Text>
              <Box marginTop={1} flexDirection="column">
                <Text>
                  <Text color="success">■</Text> {approved} approved
                </Text>
                <Text>
                  <Text color="error">■</Text> {rejected} rejected
                </Text>
                <Text>
                  <Text color="warning">■</Text> {pending} to review
                </Text>
              </Box>
            </Box>
          </Box>
          {heading('How hard to undo')}
          {byUndo.map(({ level, count }) => (
            <Box key={`undo:${level}`} gap={1}>
              {gauge(level)}
              <Text dimColor>{level.padEnd(9)}</Text>
              <Text color={REVERSIBILITY[level].color}>
                {'█'.repeat(Math.round((count / most) * barRoom)) || '·'}
              </Text>
              <Text dimColor>{String(count)}</Text>
            </Box>
          ))}
          {heading('Recent')}
          {list
            .slice(-5)
            .reverse()
            .map(one => (
              <Button key={`recent:${one.id}`} plain onPress={() => select($, one.id).then(() => update($, currentTab, () => 'all'))}>
                <Text color={STATUS[one.verdict].color}>{`${STATUS[one.verdict].icon} `}</Text>
                <Text color="inactive">{`D${one.id}`.padEnd(4)}</Text>
                <Text dimColor>{` ${clip(one.choice, width - 8)}`}</Text>
              </Button>
            ))}
        </Box>
      )
    }

    const undoable = list.find(one => one.id === change?.id && one.verdict === change.to)
    const undoKey = undoable === undefined ? '' : ' · u undo'
    const keyHelp = isCommenting
      ? 'Enter keeps the comment and turns the hotkeys back on'
      : !e.props.isFocused
        ? 'ctrl+x tab to review from the keyboard'
        : selected !== undefined && selected.verdict !== 'pending'
          ? `n/p next/previous · o reopen · ${selected.verdict === 'approved' ? 'r reject' : 'a approve'} instead${undoKey} · Esc back to the prompt`
          : `n/p next/previous · a approve · r reject · c comment${undoKey} · Esc back to the prompt`

    const undoStrip = (one: Decision) => {
      const verb = { pending: 'Reopened', approved: 'Approved', rejected: 'Rejected' }[one.verdict]

      return (
        <Box gap={1} marginTop={1}>
          <Text color={STATUS[one.verdict].color}>{STATUS[one.verdict].icon}</Text>
          <Text bold>{`${verb} D${one.id}`}</Text>
          <Text dimColor>{clip(one.choice, Math.max(8, width - 30))}</Text>
          <Button key="undo" plain {...hotkey('u')} onPress={() => undoLastChange($)}>
            {pill('↺ Undo', 'permission')}
          </Button>
        </Box>
      )
    }

    const tree = (
      <Box flexDirection="column">
        {header()}
        {list.length === 0 && (
          <Box flexDirection="column" marginTop={Math.max(1, Math.floor((e.props.scroll.bodyRows - 6) / 2))}>
            {hero()}
          </Box>
        )}
        {list.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Box gap={1}>{TABS.map(tabButton)}</Box>
            {progressBar()}
            {undoable !== undefined && undoStrip(undoable)}
          </Box>
        )}
        {awaitingRevisit.length > 0 && !isClaudeWorking && (
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor="warning"
            paddingX={1}
            marginTop={1}
          >
            <Box gap={1}>
              <Text color="warning">↻</Text>
              <Text>
                Claude has your feedback on {awaitingRevisit.map(one => `D${one.id}`).join(', ')} and
                will act on it with your next message.
              </Text>
            </Box>
            <Button key="revisit" plain onPress={() => revisit($)}>
              {pill('↻ Ask Claude to revisit now', 'warning')}
            </Button>
          </Box>
        )}
        {list.length > 0 && shown.length === 0 && tab !== 'pending' && (
          <Box marginTop={1}>
            <Text dimColor>Nothing here yet.</Text>
          </Box>
        )}
        {shown.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>{'     ID  UNDO DECISION'}</Text>
            {start > 0 && <Text dimColor>{`     ↑ ${start} more`}</Text>}
            {rows.map(row)}
            {below > 0 && <Text dimColor>{`     ↓ ${below} more`}</Text>}
            <Box gap={3} marginTop={1}>
              <Button key="prev" plain dimColor {...hotkey('p')} onPress={() => moveSelection($, -1)}>
                ‹ prev
              </Button>
              <Button key="next" plain dimColor {...hotkey('n')} onPress={() => moveSelection($, 1)}>
                next ›
              </Button>
              {approved + rejected > 0 && (
                <Button key="clear-reviewed" plain dimColor onPress={() => clearReviewed($)}>
                  clear reviewed
                </Button>
              )}
            </Box>
          </Box>
        )}
        {selected !== undefined && panel(selected)}
        {list.length > 0 && shown.length === 0 && overview()}
        {list.length > 0 && (
          <Box marginTop={1}>
            <Text dimColor>{keyHelp}</Text>
          </Box>
        )}
      </Box>
    )

    if (Raster !== undefined) {
      isMascotShown = list.length === 0 || shown.length === 0
      animate($)
    }

    return tree
  })
}

