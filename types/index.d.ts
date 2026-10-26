// What one pinned item is, and what the pane keeps in the session.

export type Kind = 'decide' | 'do' | 'know'

// open: waiting on the person
// sent: the person answered; the message is in the session, no request has carried it yet
// seen: a model request carried it; Claude has it but has not resolved it
// done: the model resolved it, or it sat seen for several turns
export type Status = 'open' | 'sent' | 'seen' | 'done'

// `at`: when the note was handed over; `to`: the helper agent that got it
// (absent: the main conversation).
export type Note = { text: string; at: number; status: 'sent' | 'seen'; to?: string }

export type Item = {
  id: string
  n: number
  kind: Kind
  title: string
  detail: string
  options: string[]
  from: string
  agentId?: string
  status: Status
  createdAt: number
  answer: string
  notes: Note[]
  // Left from the old expand/collapse pane; no longer read or written.
  isExpanded?: boolean
  // When the answer was handed over, and the helper agent that got it.
  sentAt?: number
  sentTo?: string
  // A "chat about this" no model request has carried yet.
  chatAt?: number
  seenTurn?: string
  // Left from the turn-count archive; no longer read or written.
  seenAge?: number
}

// icon: the mascot alone. list: a row per item. card: one item in full.
export type View = 'icon' | 'list' | 'card'

export type PaneSettings = {
  view: View
  focus: boolean
  catch: boolean
  showDone: boolean
}

export type Live = {
  isTurnRunning: boolean
  turnId: string
  pinsThisTurn: number
  lastPinAt: number
  tick: number
}

declare module 'claude-code' {
  interface PluginState {
    'needs-you': {
      items: Shaped<Item[]>
      settings: Shaped<PaneSettings>
      live: Live
      interim: string[]
      // The id of the item the card view shows.
      cursor: string
    }
  }
}
