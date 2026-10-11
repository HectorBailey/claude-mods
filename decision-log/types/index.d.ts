export type Reversibility = 'easy' | 'moderate' | 'hard'

export type Verdict = 'pending' | 'approved' | 'rejected'

export type DecisionTab = 'all' | Verdict

// The most recent verdict change, which the pane offers to undo.
export type VerdictChange = { id: number; from: Verdict; to: Verdict }

export type Decision = {
  id: number
  choice: string
  why: string
  alternatives: string
  impact: string
  reversibility: Reversibility
  isFromSubagent: boolean
  verdict: Verdict
  comment: string
  // Rejected while Claude was idle: it has the feedback but no turn to act on it yet.
  isAwaitingRevisit: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'decision-log': {
      decisions: Decision[]
      isWorking: boolean
      selectedId: number | null
      tab: DecisionTab
      // The decision whose comment box is open; its hotkeys are off meanwhile.
      commentingId: number | null
      lastChange: VerdictChange | null
    }
  }
}
