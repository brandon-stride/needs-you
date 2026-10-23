// Pure helpers for the Needs-you pane: items, the messages that go back into
// the session, the reply catcher, and the little avatar. No engine in here, so
// every function is testable on its own.

import type { Item, Kind, PaneSettings } from '../types'

export const KINDS: readonly Kind[] = ['decide', 'do', 'know']

export const TOOL_PIN = 'mcp__needs-you__pin'
export const TOOL_RESOLVE = 'mcp__needs-you__resolve'
export const TOOL_UPDATE = 'mcp__needs-you__update'
export const TOOL_LIST = 'mcp__needs-you__list'

export const DEFAULT_SETTINGS: PaneSettings = { view: 'list', focus: true, catch: true, showDone: false }

export type Pin = { title: string; detail: string; kind: Kind; options: string[] }

// What the model sent to the pin tool, checked field by field: a plugin tool's
// input arrives untyped.
export function parsePin(args: Record<string, unknown>): { ok: true; pin: Pin } | { ok: false; why: string } {
  const title = oneLine(String(args.title ?? '')).slice(0, 140)
  if (!title) return { ok: false, why: 'title is required: one plain line saying what you need from the person' }
  const kind = KINDS.includes(args.kind as Kind) ? (args.kind as Kind) : 'know'
  const detail = String(args.detail ?? '').trim().slice(0, 600)
  const options = Array.isArray(args.options)
    ? args.options.map(o => oneLine(String(o)).slice(0, 60)).filter(Boolean).slice(0, 4)
    : []
  if (kind === 'decide' && options.length < 2) {
    return { ok: false, why: 'a decision needs 2 to 4 options, your recommendation first' }
  }
  return { ok: true, pin: { title, detail, kind, options: kind === 'decide' ? options : [] } }
}

export function newItem(items: readonly Item[], pin: Pin, from: string, now: number, agentId?: string): Item {
  const n = items.reduce((m, i) => Math.max(m, i.n), 0) + 1
  const item: Item = {
    id: `n${n}-${now.toString(36)}`,
    n,
    kind: pin.kind,
    title: pin.title,
    detail: pin.detail,
    options: pin.options,
    from,
    status: 'open',
    createdAt: now,
    answer: '',
    notes: [],
  }
  if (agentId) item.agentId = agentId
  return item
}

export function findByN(items: readonly Item[], n: number): Item | undefined {
  return items.find(i => i.n === n)
}

export function openItems(items: readonly Item[]): Item[] {
  return items.filter(i => i.status !== 'done')
}

export function doneItems(items: readonly Item[]): Item[] {
  return items.filter(i => i.status === 'done')
}

// A sent answer, note or chat request becomes seen once a model request has
// carried it: a request of the loop it went to (`agentId`, absent for main)
// that started at or after it was handed over. Ids in `holding` are still
// being handed over, so no request has them for sure yet.
export function markSeen(
  items: readonly Item[],
  turnId: string,
  stepAt: number,
  agentId?: string,
  holding: ReadonlySet<string> = new Set(),
): Item[] {
  const carried = (at: number | undefined, to: string | undefined) => to === agentId && (at ?? 0) <= stepAt
  return items.map(i => {
    if (holding.has(i.id)) return i
    let next = i
    const notes = i.notes.map(n => (n.status === 'sent' && carried(n.at, n.to) ? { ...n, status: 'seen' as const } : n))
    if (notes.some((n, k) => n !== i.notes[k])) next = { ...next, notes }
    if (i.chatAt !== undefined && agentId === undefined && i.chatAt <= stepAt) {
      next = { ...next }
      delete next.chatAt
    }
    if (i.status === 'sent' && carried(i.sentAt, i.sentTo)) next = { ...next, status: 'seen', seenTurn: turnId, seenAge: 0 }
    return next
  })
}

// How many main turns a seen item stays in the open list unresolved.
export const ARCHIVE_TURNS = 6

// A seen item stays as one dim line ("Claude has it") until the model resolves
// it. One left unresolved leaves after ARCHIVE_TURNS main turns; a quiet one
// (an ack, the person's own reminder) after the turn that carried it. Nothing
// leaves while a note or chat request on it is still on its way.
export function archiveSeen(items: readonly Item[], endedTurn: string): Item[] {
  return items.map(i => {
    if (i.status !== 'seen' || i.seenTurn === endedTurn) return i
    if (i.chatAt !== undefined || i.notes.some(n => n.status === 'sent')) return i
    const age = (i.seenAge ?? 0) + 1
    const limit = isQuietItem(i) ? 1 : ARCHIVE_TURNS
    return age >= limit ? { ...i, status: 'done', seenAge: age } : { ...i, seenAge: age }
  })
}

export type Answer =
  | { kind: 'check' }
  | { kind: 'option'; text: string }
  | { kind: 'note'; text: string }
  | { kind: 'chat' }

// An item whose tick needs nothing from the model: a 'know' the person read,
// or a reminder the person pinned for themselves (`/needs-you add`).
export function isQuietItem(item: Item): boolean {
  return item.from === 'you' || item.kind === 'know'
}

// An answer that is appended quietly and never starts a turn.
export function isQuiet(item: Item, answer: Answer): boolean {
  if (answer.kind === 'chat') return false
  if (item.from === 'you') return true
  return item.kind === 'know' && answer.kind === 'check'
}

// A tick on a decision is "go with your recommendation": the first option.
export function normalize(item: Item, answer: Answer): Answer {
  if (answer.kind === 'check' && item.kind === 'decide' && item.options[0]) return { kind: 'option', text: item.options[0] }
  return answer
}

// What the main conversation still has to read: answers handed to it that no
// request carried and that ask for a reply. A key of them, '' for none.
export function pendingKey(items: readonly Item[]): string {
  const keys: string[] = []
  for (const i of items) {
    if (i.status === 'done') continue
    if (i.status === 'sent' && !i.sentTo && !isQuietItem(i)) keys.push(`${i.id}@${i.sentAt ?? 0}`)
    if (i.from !== 'you') for (const n of i.notes) if (n.status === 'sent' && !n.to) keys.push(`${i.id}:${n.at}`)
    if (i.chatAt !== undefined) keys.push(`${i.id}~${i.chatAt}`)
  }
  return keys.join(',')
}

// The hidden message the model reads when the person acts in the pane while a
// turn runs (or, for a quiet one, at the next turn). The person never sees it.
export function messageFor(item: Item, answer: Answer): string {
  const head = `[needs-you] #${item.n} "${item.title}"`
  const tail = `Act on this, then call ${TOOL_RESOLVE} with n=${item.n}. Do not ask about it again in prose.`
  const quiet = 'No reply needed; it leaves the pane by itself.'
  if (item.from === 'you' && answer.kind !== 'chat') {
    const what = answer.kind === 'note' ? `the person added a note to their own reminder: "${answer.text}"` : 'the person ticked off their own reminder'
    return `${head}: ${what}. ${quiet}`
  }
  switch (answer.kind) {
    case 'check':
      return item.kind === 'know'
        ? `${head}: the person has read this. ${quiet}`
        : `${head}: the person has done this. ${tail}`
    case 'option': {
      const rec = item.options[0] === answer.text ? ' (your recommendation)' : ''
      return `${head}: the person chose "${answer.text}"${rec}. ${tail}`
    }
    case 'note':
      return `${head}: the person added a note: "${answer.text}". Take it into account. If it changes the question, call ${TOOL_UPDATE} with n=${item.n}; call ${TOOL_RESOLVE} only once the item is settled.`
    case 'chat':
      return `${head}: the person wants to talk this one through. In your next reply, bring it up in plain words (what it is, why it matters, what you recommend), ask what they want, and wait. Leave the item open until it is settled.`
  }
}

// The same answer as the person's own words, for a prompt that starts a turn:
// the person sees it in the transcript, so it reads as them speaking. What to
// do with it is in the system prompt section.
export function personMessageFor(item: Item, answer: Answer): string {
  const head = `[needs-you] #${item.n} "${item.title}"`
  switch (answer.kind) {
    case 'check':
      return item.kind === 'know' ? `${head}: got it.` : `${head}: done.`
    case 'option':
      return item.options[0] === answer.text
        ? `${head}: go with your recommendation, "${answer.text}".`
        : `${head}: I choose "${answer.text}".`
    case 'note':
      return `${head}: a note from me: "${answer.text}"`
    case 'chat':
      return `${head}: can we talk this one through? What is it, why does it matter, and what do you recommend?`
  }
}

// The main conversation's copy of an answer that went to a helper agent.
export function fyiFor(item: Item, answer: Answer): string {
  const what = answer.kind === 'note' ? `added a note: "${answer.text}"` : answer.kind === 'option' ? `chose "${answer.text}"` : 'ticked it'
  return `[needs-you] FYI: #${item.n} "${item.title}" was asked by ${item.from || 'a helper agent'}. The person ${what}; it went to that agent. No action needed from you.`
}

// The prompt that starts a turn when answers reached the conversation after its
// last request: the rows are in the conversation; nothing has read them.
export const WAKE_TEXT =
  '[needs-you] The person answered in the Needs-you pane while you were finishing your last reply. Read the [needs-you] messages just above and act on them.'

// The hidden row after the reply catcher pinned asks from the last reply.
export function caughtNote(pinned: readonly Item[]): string {
  const list = pinned.map(i => `#${i.n} "${i.title}"`).join(', ')
  return `[needs-you] From your last reply, the pane pinned ${list} for the person. They are open items now: call ${TOOL_RESOLVE} on each once handled, and do not ask them again in prose.`
}

export function pinReply(item: Item, isPlaced = true): string {
  const base = `Pinned #${item.n} (${item.kind}): "${item.title}".`
  const close = `Call ${TOOL_RESOLVE} n=${item.n} once it is handled.`
  return isPlaced
    ? `${base} The person sees it in the Needs-you pane; in your reply, at most one short line pointing at #${item.n}. ${close}`
    : `${base} The Needs-you pane is not showing on the person's screen, so also ask it in one plain line in your reply and say they can type /needs-you to open the pane. ${close}`
}

export function listReply(items: readonly Item[]): string {
  const open = openItems(items)
  if (open.length === 0) return 'Nothing is pinned.'
  return open
    .map(i => {
      const state = i.status === 'open' ? 'waiting' : i.status
      const ans = i.answer ? ` answer: "${i.answer}"` : ''
      const notes = i.notes.length ? ` notes: ${i.notes.map(n => `"${n.text}"`).join('; ')}` : ''
      return `#${i.n} [${i.kind}, ${state}] ${i.title}${ans}${notes}`
    })
    .join('\n')
}

// ---- the reply catcher: asks that never got pinned -----------------------

const CUE = /\?\s*$|\?\n|let me know|your call|up to you|do you want|would you like|should i\b|want me to|need you to|you(?:'ll| will) need to|please (?:confirm|check|send|add|create|mint|set)|which (?:one|option|do you)|heads.?up|fyi\b|note that you|before i (?:can|continue)|waiting on you|blocked on/i

export function hasCue(answer: string): boolean {
  return answer.length > 20 && CUE.test(answer)
}

export const CATCH_SYSTEM = `You read the last reply of a coding assistant and pull out only the things the PERSON must now decide, do outside the chat, or know because it blocks or changes the work. Ignore things the assistant itself will do next, status updates, summaries, and rhetorical questions. Answer with a JSON array and nothing else. Each element: {"kind":"decide"|"do"|"know","title":"one plain line, no code names or jargon, under 100 characters","detail":"one or two plain sentences, may be empty","options":["only for decide: 2-4 short options, recommendation first"]}. Empty array when nothing needs the person.`

export function catchPrompt(answer: string): string {
  return `The reply:\n\n${answer.slice(0, 6000)}`
}

export function parseCaught(text: string): Pin[] {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  let raw: unknown
  try {
    raw = JSON.parse(text.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const pins: Pin[] = []
  for (const row of raw.slice(0, 4)) {
    if (!row || typeof row !== 'object') continue
    const parsed = parsePin(row as Record<string, unknown>)
    if (parsed.ok) pins.push(parsed.pin)
  }
  return pins
}

// ---- text helpers --------------------------------------------------------

export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function firstLine(text: string, max: number): string {
  const line = text.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? ''
  const plain = line.replace(/^#+\s*/, '').replace(/[*_`]/g, '')
  return plain.length > max ? `${plain.slice(0, Math.max(1, max - 1))}…` : plain
}

// A label cut to `max` columns with an ellipsis.
export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text
}

export function parseCommand(args: string): { verb: string; rest: string } {
  const trimmed = args.trim()
  const space = trimmed.indexOf(' ')
  if (space < 0) return { verb: trimmed.toLowerCase(), rest: '' }
  return { verb: trimmed.slice(0, space).toLowerCase(), rest: trimmed.slice(space + 1).trim() }
}

// How tall the pane wants to be while it sits inline above the prompt.
export function wantedRows(items: readonly Item[], settings: PaneSettings): number {
  if (settings.view === 'icon') return 3
  const open = openItems(items)
  let rows = 2
  for (const i of open) {
    // An answered item is one line; an open one is a full card: title, detail,
    // a line of chips, its notes, the note field, and a gap.
    if (i.status !== 'open') {
      rows += 2
      continue
    }
    rows += 4 + Math.ceil(i.title.length / 36) + Math.ceil(i.detail.length / 40) + i.notes.length
  }
  if (doneItems(items).length) rows += 1 + (settings.showDone ? doneItems(items).length : 0)
  return Math.min(40, Math.max(3, rows))
}

// ---- the avatar ----------------------------------------------------------
// The Claude mascot in block characters: a boxy orange body, two eyes, stub
// arms, three feet. It wears a random hat, holds a random thing, dances on the
// tick while something is open, and throws the odd emote. Every line is padded
// to AVATAR_WIDTH so the pane never jitters as frames change.

export const AVATAR_WIDTH = 15

// Each hat is 10 columns wide, sitting over the body (columns 1 to 8).
const HATS = [
  '  ▟██████▙',  // beanie
  ' ▂▟████▙▂ ',  // top hat
  '  ▙▟▙▟▙▟  ',  // crown
  '    ◢◣    ',  // party cone
  ' ▂▂████▂▂ ',  // cowboy
  '  ▟▀▀▀▀▙  ',  // chef
  '  ╭────╮  ',  // halo
  '  ─◉──    ',  // propeller
  '  ▞▀▀▀▀▚  ',  // bucket
  '  ▁▁▁▁▁▁  ',  // flat cap
]
// Things it holds: emoji that every terminal draws two columns wide.
const THINGS = ['🔧', '🔑', '☕', '📎', '🧭', '🪄', '🎸', '🍕', '🎈', '🔦', '🎺', '🍩', '📣', '🥁', '🎯', '🪁', '🧃', '🛸']
// Emotes beside the hat; '' is "none this time".
const EMOTES = ['♪', '♫', '!', '?', '♥', '…', '✦', '~', '', '', '', '']
const EMOTE_SLEEP = ['z', 'zz', 'zzz']

export type AvatarState = { open: number; isFresh: boolean; tick: number; seed: number }

function hash(n: number): number {
  let x = (n ^ 0x9e3779b9) >>> 0
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0
  return (x ^ (x >>> 16)) >>> 0
}

function pick<T>(list: readonly T[], n: number): T {
  return list[hash(n) % list.length] as T
}

function pad(line: string): string {
  const w = cellWidth(line)
  return w >= AVATAR_WIDTH ? line : line + ' '.repeat(AVATAR_WIDTH - w)
}

// Columns a string takes: emoji count two, everything here else one.
function cellWidth(s: string): number {
  let w = 0
  for (const ch of s) w += (ch.codePointAt(0) ?? 0) > 0xffff || ch === '☕' ? 2 : 1
  return w
}

// What the mascot is doing this tick.
export function avatarMood(s: AvatarState): 'asleep' | 'surprised' | 'dancing' {
  return s.open === 0 ? 'asleep' : s.isFresh ? 'surprised' : 'dancing'
}

// The face line's fixed width: ASCII only, so every terminal and font agrees
// (‿ • ⊙ draw one or two columns depending on the font).
export const AVATAR_LINE_WIDTH = 9

// One line, for the mobile list and tight widths: the face only, padded so the
// text after it never shifts between frames.
export function avatarLine(s: AvatarState): string {
  const mood = avatarMood(s)
  const face =
    mood === 'asleep' ? `[-_-] ${pick(EMOTE_SLEEP, Math.floor(s.tick / 2))}` :
    mood === 'surprised' ? (s.tick % 2 ? '[O_O]!' : '[O_O]') :
    s.tick % 7 === 0 ? '[^_-]' : '[^_^]'
  return face.padEnd(AVATAR_LINE_WIDTH, ' ')
}

// Five lines: hat (+ emote), then the body in four rows. The hat changes every
// ~40 ticks, the held thing every ~25, the emote every 4; all seeded so two
// draws of the same tick agree.
export function avatarBlock(s: AvatarState): string[] {
  const mood = avatarMood(s)
  const hat = pick(HATS, s.seed + Math.floor(s.tick / 40))
  const thing = pick(THINGS, s.seed * 3 + 1 + Math.floor(s.tick / 25))
  const emote = mood === 'asleep'
    ? pick(EMOTE_SLEEP, Math.floor(s.tick / 2))
    : mood === 'surprised'
      ? (s.tick % 2 ? '!!' : '! ')
      : pick(EMOTES, s.seed + Math.floor(s.tick / 4))

  const blink = mood === 'asleep' || (mood === 'dancing' && s.tick % 9 === 0)
  const wide = mood === 'surprised'
  const eyes = blink ? '██▄██▄██' : wide ? '█▌ ▌▐ ▐█' : '██ ██ ██'

  // Arm pose cycles mid, up, mid, down while dancing; up while surprised; down asleep.
  const pose = mood === 'dancing' ? (['mid', 'up', 'mid', 'down'] as const)[s.tick % 4] : mood === 'surprised' ? 'up' : 'down'
  const shift = mood === 'dancing' && s.tick % 2 === 1 ? ' ' : ''
  const feet = mood === 'dancing' ? (s.tick % 4 < 2 ? '▀▀ ▀▀ ▀▀' : '▀▀  ▀▀ ▀') : '▀▀ ▀▀ ▀▀'

  const row0 = pose === 'up' ? '▝▄██████▄▘' : ' ▄██████▄ '
  const row1 = pose === 'mid' ? `▐${eyes}▌` : ` ${eyes} `
  const row2 = pose === 'down' ? '▗████████▖' : ' ████████ '
  const row3 = ` ${feet} `

  // The held thing rides on the arm row that has the arm.
  const holdRow = pose === 'up' ? 0 : pose === 'mid' ? 1 : 2
  const rows = [row0, row1, row2, row3].map((r, k) => (k === holdRow ? `${shift}${r}${thing}` : `${shift}${r}`))
  const hatLine = `${shift}${hat} ${emote}`
  return [pad(hatLine), ...rows.map(pad)]
}
