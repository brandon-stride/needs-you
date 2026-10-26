import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import { RASTER_COLS, RASTER_ROWS, draw, frameAt, frameKey, toRaster, toRgba } from './clawd'
import type { Reaction } from './clawd'

import type { Item, Kind, Live, Note, PaneSettings } from '../types'
import {
  CATCH_SYSTEM,
  DEFAULT_SETTINGS,
  LIMITS,
  TOOL_LIST,
  TOOL_PIN,
  TOOL_RESOLVE,
  TOOL_UPDATE,
  WAKE_TEXT,
  archiveSeen,
  avatarLine,
  catchPrompt,
  caughtNote,
  doneItems,
  droppedNote,
  findByN,
  findSameAsk,
  firstLine,
  fyiFor,
  hasCue,
  isQuiet,
  listReply,
  markSeen,
  messageFor,
  newItem,
  nextWaiting,
  normalize,
  oneLine,
  openItems,
  openReminder,
  parseCaught,
  parseCommand,
  parsePin,
  pendingKey,
  personMessageFor,
  pinReply,
  wantedRows,
} from './items'
import type { Answer, Pin } from './items'

const PANE = 'needs-you'

// Obsidian: the pane sits a hair above the terminal's near-black (#08090a), each
// item a card a step above that, with one colour per kind on its edge.
const INK = {
  pane: '#0d0f12',
  card: '#14171c',
  cardOpen: '#1a1e25',
  body: '#b4bac4',
  mute: '#5c636e',
  chip: '#262b33',
  chipText: '#d7dbe2',
  decide: '#E6B84A',
  do: '#D97757',
  know: '#6FA8DC',
} as const
// Ask for a wide dock: the engine caps it at 45% of the terminal.
const COLUMNS = 90
const FRESH_MS = 12_000
const TICK_MS = 250
const REACT_MS = 2_500
// The picture's box in the pane: 10 columns by 5 rows is about square.
const PIC_COLS = 10
const PIC_ROWS = 5
const PIC_SCALE = 3
// A second "chat about this" on the same item within this long is ignored.
const CHAT_MS = 15_000
// The store keeps other sessions' lists this long, and this many of them.
const STORE_SHAPE = 'items-2'
const KEEP_MS = 14 * 24 * 60 * 60 * 1000
const KEEP_SESSIONS = 30
// The folded-narration ids kept across turns.
const INTERIM_CAP = 500

type $T = EngineInterface

// Bump a tag when its value's fields change: old values are then declined.
const items = atom({ plugin: 'needs-you', key: 'items' } as const, [] as Item[], { shape: 'items-1' })
const settings = atom({ plugin: 'needs-you', key: 'settings' } as const, { ...DEFAULT_SETTINGS } as PaneSettings, { shape: 'settings-2' })
// Where settings are stored across sessions: a new key when their meaning
// changes (the card view became the default), so an old choice does not stick.
const SETTINGS_KEY = 'settings-2'
const live = atom({ plugin: 'needs-you', key: 'live' } as const, {
  isTurnRunning: false,
  turnId: '',
  pinsThisTurn: 0,
  lastPinAt: 0,
  tick: 0,
} as Live)
// Assistant blocks of past turns that came before each turn's last tool call:
// the working narration, folded to one line once its turn is over.
const interim = atom({ plugin: 'needs-you', key: 'interim' } as const, [] as string[])
const cursor = atom({ plugin: 'needs-you', key: 'cursor' } as const, '')

// Per-load bookkeeping; a reload starts it over, the state above stays.
const local = {
  sessionId: '',
  paneIsPlaced: false,
  drafts: {} as Record<string, string>,
  // Assistant blocks first drawn during the running main turn, in order, and
  // every block drawn before it began (a re-draw of an old one is not new).
  assistantIds: [] as string[],
  knownIds: new Set<string>(),
  cutIndex: 0,
  isTurnRunning: false,
  // Items whose answer is being handled right now (a second press is ignored),
  // and those whose row is mid-append, so no request counts as carrying it yet.
  inFlight: new Set<string>(),
  holding: new Set<string>(),
  chatAt: {} as Record<string, number>,
  // The pending answers the last wake-up prompt was for.
  wokeFor: '',
  storeWarned: false,
  // The mascot: pictures while the terminal draws them, half-block cells once
  // a blit says it cannot; the last frame blitted, so a beat with no change
  // sends nothing; the reaction to the person's last press, for a moment.
  pictures: true,
  frameKey: '',
  reaction: undefined as { kind: Reaction; until: number } | undefined,
  // Unanswered items while the pane is off screen: what the hint line shows.
  offScreen: 0,
}

const SECTION = {
  id: 'needs-you:pane',
  scope: 'session',
  text: [
    '# The Needs-you pane',
    `The person reads a side pane, not your transcript, for anything that needs them. Whenever you need the person to DECIDE something, DO something outside this chat (mint a key, click approve, pay, reply to someone), or KNOW something that blocks or changes the work, call ${TOOL_PIN} at that moment, not at the end of a long reply. One item per call. Plain words a stranger would follow: no code names, paths or jargon unless they must act on them; what and why, one line each. A decision lists 2 to 4 options of a few words each, your recommendation first. The pane is narrow: a title under ${LIMITS.title} characters, a detail under ${LIMITS.detail}; a longer write-up goes in a file or page the detail points to. Several decisions are several pins, one each.`,
    `A message containing [needs-you] is the person answering an item from the pane: act on it and call ${TOOL_RESOLVE} with that number once handled. A note on an item is added context: take it into account, and resolve only once the item is settled. One that says no reply is needed needs none. When the person answers or settles an open item in chat instead, call ${TOOL_RESOLVE} for it in that turn. If the question of an open item changes, call ${TOOL_UPDATE}; do not pin it again. Never repeat an open item's question in prose; say "waiting on #3 in the pane" and move on. ${TOOL_LIST} shows what is open. Subagents pin too; the pane shows who asked.`,
  ].join('\n\n'),
} as const

export const register: Register = on => {
  let timer: Timer | undefined

  // Registered first, so it runs for every tool, the pane's own included (the
  // pane's tool hooks below answer without calling next). A tool call ends the
  // narration of the turn so far: blocks drawn before it fold once it is over.
  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined) local.cutIndex = local.assistantIds.length
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    local.sessionId = await $.session.id()
    await restore($, false)
    $.clock.after(0, () => {
      void pruneStore($).catch(() => undefined)
    })
    await Promise.all([
      $.tool.register({
        name: 'pin',
        description:
          'Pin something the person must decide, do outside this chat, or know. It shows in their Needs-you pane; they answer there. Plain words, one item per call.',
        isDeferred: false,
        inputSchema: {
          type: 'object',
          properties: {
            kind: {
              type: 'string',
              enum: ['decide', 'do', 'know'],
              description: 'decide: they pick. do: they act outside this chat. know: it blocks or changes the work.',
            },
            title: { type: 'string', maxLength: LIMITS.title, description: `One plain line, under ${LIMITS.title} characters, no jargon.` },
            detail: {
              type: 'string',
              maxLength: LIMITS.detail,
              description: `One or two plain sentences, under ${LIMITS.detail} characters: why, and what happens either way. Optional.`,
            },
            options: {
              type: 'array',
              items: { type: 'string', maxLength: LIMITS.option },
              description: `decide only: 2 to 4 options of a few words each (under ${LIMITS.option} characters), your recommendation first.`,
            },
            distinct: {
              type: 'boolean',
              description: 'Only after a pin was refused as a repeat: true when this really is a different ask from the waiting one.',
            },
          },
          required: ['kind', 'title'],
        },
      }),
      $.tool.register({
        name: 'resolve',
        description: "Mark a Needs-you item handled, by its number. Call it once you have acted on the person's answer.",
        isDeferred: false,
        inputSchema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
      }),
      $.tool.register({
        name: 'update',
        description: 'Change the title, detail or options of an open Needs-you item, by its number. Use it when the question changes instead of pinning it again.',
        isDeferred: false,
        inputSchema: {
          type: 'object',
          properties: {
            n: { type: 'number' },
            title: { type: 'string' },
            detail: { type: 'string' },
            options: { type: 'array', items: { type: 'string' } },
          },
          required: ['n'],
        },
      }),
      $.tool.register({
        name: 'list',
        description: 'List the open Needs-you items and what the person has answered so far.',
        isDeferred: false,
        inputSchema: { type: 'object' },
      }),
      $.command.register({
        name: 'needs-you',
        description: 'Needs-you pane: open it, focus on|off, add <text>, clear, catch on|off',
        argumentHint: '[focus on|off] [add <text>] [clear] [catch on|off]',
        immediate: true,
      }),
    ])
    // Open at startup (a new session, or a reload) only when restored items are
    // waiting; otherwise the first pin or /needs-you opens it.
    if (openItems(await read($, items)).length > 0) {
      const opened = await $.ui.open(await openArgs($))
      local.paneIsPlaced = opened.isPlaced
    } else {
      local.paneIsPlaced = (await $.ui.panes()).some(p => p.id === PANE)
    }
    timer?.cancel()
    timer = $.clock.every(TICK_MS, () => {
      void tick($).catch(() => undefined)
    })
    return next(e)
  })

  // The person's close (the mark, Esc, or the ✕ chip) sticks until the next pin.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      local.paneIsPlaced = false
      await signal($)
    }
    return next(e)
  })

  // A /clear ends the conversation, not the session: the list empties and the
  // tick keeps running (no session.start follows). The next turn.start picks up
  // the new session id.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, items, () => [])
      await update($, interim, () => [])
      local.assistantIds = []
      local.knownIds.clear()
      local.wokeFor = ''
    } else {
      timer?.cancel()
      timer = undefined
    }
    return next(e)
  })

  // ---- the model's side: pin, resolve, update, list ------------------------

  on('tool.call', { tool: TOOL_PIN }, async ($, e) => {
    const parsed = parsePin(e as Record<string, unknown>)
    if (!parsed.ok) return { result: `Not pinned: ${parsed.why}.` }
    const twin = (e as Record<string, unknown>).distinct === true ? undefined : findSameAsk(await read($, items), parsed.pin.title)
    if (twin) {
      return {
        result: `Not pinned: #${twin.n} is still waiting and asks nearly the same (${JSON.stringify(twin.title)}). If the question changed, call ${TOOL_UPDATE} with n=${twin.n}. If #${twin.n} is settled, call ${TOOL_RESOLVE} on it first. If this is a different ask (another person, project or number), pin again with distinct: true.`,
      }
    }
    const { item, isPlaced } = await pin($, parsed.pin, { agentId: e.agentId })
    return { result: pinReply(item, isPlaced) }
  }).catch(() => ({ result: 'Not pinned: the Needs-you pane failed. Ask the person in one plain line instead.' }))

  on('tool.call', { tool: TOOL_RESOLVE }, async ($, e) => {
    const n = Number((e as Record<string, unknown>).n)
    const list = await read($, items)
    const item = findByN(list, n)
    if (!item) return { result: `No item #${n}.` }
    await setItems($, cur => cur.map(i => (i.n === n ? { ...i, status: 'done' as const } : i)))
    return { result: `#${n} resolved.` }
  }).catch(() => ({ result: 'The Needs-you pane failed to resolve that item; carry on.' }))

  on('tool.call', { tool: TOOL_UPDATE }, async ($, e) => {
    const args = e as Record<string, unknown>
    const n = Number(args.n)
    const list = await read($, items)
    const item = findByN(list, n)
    if (!item || item.status === 'done') return { result: `No open item #${n}.` }
    const parsed = parsePin({
      kind: item.kind,
      title: args.title ?? item.title,
      detail: args.detail ?? item.detail,
      options: args.options ?? item.options,
    })
    if (!parsed.ok) return { result: `Not changed: ${parsed.why}.` }
    await setItems($, cur => cur.map(i => (i.n === n ? { ...i, ...parsed.pin } : i)))
    return { result: `#${n} updated.` }
  }).catch(() => ({ result: 'The Needs-you pane failed to update that item; carry on.' }))

  on('tool.call', { tool: TOOL_LIST }, async $ => ({ result: listReply(await read($, items)) })).catch(() => ({
    result: 'The Needs-you pane is not answering.',
  }))

  // The person's typed message, while items wait: the model is reminded of them,
  // so an answer given in chat closes the item. Never in the way of the prompt.
  on('prompt.submit', async ($, e, next) => {
    const kind = e.origin.kind
    if (e.command || e.isMeta || (kind !== 'composer' && kind !== 'bridge') || e.text.trimStart().startsWith('[needs-you]')) return next(e)
    let reminder = ''
    try {
      // After a /clear or resume the list in memory is the old conversation's
      // until turn.start restores the new one's: say nothing then.
      if ((await $.session.id()) !== local.sessionId) return next(e)
      const waiting = (await read($, items)).filter(i => i.status === 'open' && i.from !== 'you')
      if (waiting.length) reminder = openReminder(waiting)
    } catch {
      reminder = ''
    }
    return next(reminder ? { ...e, context: [...(e.context ?? []), reminder] } : e)
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    return { sections: [...r.sections, SECTION] }
  })

  // ---- the turn: what is running, what has been read -----------------------

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      // A /clear or an in-process resume changes the session without a
      // session.start: follow it, so the list is that session's.
      const sid = await $.session.id()
      if (sid !== local.sessionId) {
        local.sessionId = sid
        await restore($, true)
      }
      for (const id of local.assistantIds) local.knownIds.add(id)
      local.assistantIds = []
      local.cutIndex = 0
      local.isTurnRunning = true
      await update($, live, l => ({ ...l, isTurnRunning: true, turnId: e.turnId, pinsThisTurn: 0 }))
    }
    return next(e)
  })

  // Every model request carries what was handed to its loop before it started.
  on('turn.step', async function* ($, e, next) {
    const at = await $.clock.now()
    const list = await read($, items)
    const seen = markSeen(list, e.turnId, at, e.agentId, local.holding)
    if (seen.some((i, k) => i !== list[k])) await setItems($, cur => markSeen(cur, e.turnId, at, e.agentId, local.holding))
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined) {
      await rescueFromAgent($, e.agentId)
      return r
    }
    const l = await read($, live)
    local.isTurnRunning = false
    await update($, live, x => ({ ...x, isTurnRunning: false }))
    const fold = local.assistantIds.slice(0, local.cutIndex)
    for (const id of local.assistantIds) local.knownIds.add(id)
    local.assistantIds = []
    local.cutIndex = 0
    if (fold.length) await update($, interim, prev => [...prev, ...fold.filter(id => !prev.includes(id))].slice(-INTERIM_CAP))
    // Only after a turn that answered: a request that failed or was stopped may
    // not have been read, so its items stay.
    if (e.reason === 'answer') {
      const list = await read($, items)
      const kept = archiveSeen(list)
      if (kept.some((i, k) => i !== list[k])) await setItems($, cur => archiveSeen(cur))
    }
    const s = await read($, settings)
    if (s.catch && e.reason === 'answer' && l.pinsThisTurn === 0 && hasCue(e.answer)) {
      const answer = e.answer
      const turnId = e.turnId
      $.clock.after(0, () => {
        void catchFromReply($, answer, turnId).catch(() => undefined)
      })
    }
    // An answer that reached the conversation during the turn's last request
    // is read by nothing until the next turn: start one. Only after a turn that
    // answered: not after the person stopped it, nor after an error.
    if (e.reason === 'answer') {
      $.clock.after(0, () => {
        void wakeIfStranded($).catch(() => undefined)
      })
    }
    return r
  })

  // ---- the person's side: the slash command -------------------------------

  on('command.run', { command: 'needs-you' }, async ($, e) => {
    const { verb, rest } = parseCommand(e.args)
    const s = await read($, settings)
    if (verb === 'focus') {
      const focus = rest === 'off' ? false : rest === 'on' ? true : !s.focus
      await setSettings($, { focus })
      $.ui.invalidate('ui.render')
      return {
        text: focus
          ? 'Focus on: tool rows and working notes are hidden (ctrl+o still shows all).'
          : 'Focus off: the full transcript is back.',
      }
    }
    if (verb === 'catch') {
      const isOn = rest !== 'off'
      await setSettings($, { catch: isOn })
      return { text: isOn ? 'Reply catcher on: asks that were not pinned get pinned after each reply.' : 'Reply catcher off.' }
    }
    if (verb === 'add' && rest) {
      const { item } = await pin($, { kind: 'do', title: oneLine(rest).slice(0, 140), detail: '', options: [] }, { from: 'you', isCounted: false })
      return { text: `Pinned #${item.n}: ${item.title}` }
    }
    if (verb === 'clear') {
      const dropped = (await read($, items)).filter(i => i.status === 'open' && i.from !== 'you')
      await setItems($, cur => cur.map(i => (i.status === 'done' ? i : { ...i, status: 'done' as const })))
      if (dropped.length) await appendRow($, droppedNote(dropped))
      return { text: 'Needs-you pane cleared.' }
    }
    if (verb === 'list' || verb === 'card') {
      await setSettings($, { view: verb })
    }
    const opened = await $.ui.open({ ...(await openArgs($)), focus: true })
    local.paneIsPlaced = opened.isPlaced
    const open = openItems(await read($, items)).length
    return {
      text: opened.isPlaced
        ? `Needs-you pane open: ${open} item${open === 1 ? '' : 's'} waiting. Focus mode is ${s.focus ? 'on' : 'off'}.`
        : `The pane could not be drawn here (${opened.reason}).`,
    }
  })

  // ---- focus mode: a quiet transcript -------------------------------------
  // The terminal alone: ctrl+o (isExpanded) shows what is hidden there. Other
  // surfaces have no such key, so their transcript stays whole.

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const s = await read($, settings)
    if (!s.focus || e.props.isExpanded === true || e.props.isErrored || e.props.isInterrupted) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box display="none" />
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const s = await read($, settings)
    if (!s.focus || e.props.isExpanded === true || e.props.isErrored) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box display="none" />
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const s = await read($, settings)
    if (!s.focus || e.props.isExpanded) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box display="none" />
  })

  // While items wait and the pane is off screen, a few dim characters at the
  // end of the hint line under the prompt (`? for shortcuts`) say so: no row of
  // their own, nothing pinned.
  on('ui.render', { component: 'PromptHint' }, async (_$, e, next) => {
    if (!local.offScreen) return next(e)
    const tail = `${e.props.tail ?? ''}  ● ${local.offScreen} needs you`
    return next({ ...e, props: { ...e.props, tail } })
  })

  on('ui.render', { component: 'ToolProgress' }, async ($, e, next) => {
    const s = await read($, settings)
    return s.focus ? next({ ...e, props: { ...e.props, hint: '' } }) : next(e)
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    // Only a block first drawn while the main turn runs is that turn's; a
    // re-draw of an older one (scroll, resize, invalidate) is not.
    const id = e.requestId
    if (!local.knownIds.has(id) && !local.assistantIds.includes(id)) {
      if (local.isTurnRunning) local.assistantIds.push(id)
      else local.knownIds.add(id)
    }
    if (e.surface !== 'terminal') return next(e)
    const s = await read($, settings)
    const folded = await read($, interim)
    if (!s.focus || !folded.includes(id)) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const width = Math.max(20, (e.viewport?.columns ?? 80) - 6)
    return (
      <Box paddingLeft={2}>
        <Text dimColor wrap="truncate">
          · {firstLine(e.props.text, width)}
        </Text>
      </Box>
    )
  })

  // ---- the pane -----------------------------------------------------------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (!local.paneIsPlaced) {
      local.paneIsPlaced = true
      await signal($)
    }
    const [list, s, l] = await Promise.all([read($, items), read($, settings), read($, live)])
    const now = await $.clock.now()
    const open = openItems(list)
    const done = doneItems(list)
    // Only an unanswered item waits on the person; a sent or seen one is Claude's.
    const waiting = open.filter(i => i.status === 'open').length
    const width = Math.max(24, e.props.bodyColumns)
    const face = { open: open.length, isFresh: now - l.lastPinAt < FRESH_MS, tick: Math.floor(now / 900), seed: open.length * 7 + done.length }
    const frame = frameAt(await scene($))
    local.frameKey = frameKey(frame)
    const grid = draw(frame)
    const tone = open.length ? 'claude' : 'inactive'

    if (e.surface === 'mobile') {
      const { Box, Text, Button } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          <Text color={tone}>
            {avatarLine(face)} Needs you · {open.length} open
          </Text>
          {open.map(i => {
            // Answered: a non-pressable [~] and where the answer is. Open: a
            // decision shows its options, the first being the recommendation;
            // anything else a box to tick.
            const isOpen = i.status === 'open'
            const state = i.status === 'sent' ? ' · sending' : i.status === 'seen' ? ' · Claude has it' : ''
            return (
              <Box key={`row:${i.id}`} flexDirection="column">
                <Box flexDirection="row" gap={1}>
                  {!isOpen ? (
                    <Text dimColor>[~]</Text>
                  ) : i.options.length === 0 ? (
                    <Button key={`d:${i.id}`} plain label="[ ]" onPress={() => void answer($, i.id, { kind: 'check' })} />
                  ) : null}
                  <Text dimColor={!isOpen}>
                    {i.n} {i.title}
                    {state}
                  </Text>
                </Box>
                {isOpen && i.options.length > 0 && (
                  <Box flexDirection="row" flexWrap="wrap" gap={1} paddingLeft={2}>
                    {i.options.map((o, k) => (
                      <Button
                        key={`o:${i.id}:${k}`}
                        plain
                        label={k === 0 ? `★ ${o}` : o}
                        onPress={() => void answer($, i.id, { kind: 'option', text: o })}
                      />
                    ))}
                  </Box>
                )}
              </Box>
            )
          })}
        </Box>
      )
    }

    const ui = $.ui.resolve(e)
    const { Box, Text, Button, Input } = ui
    // The terminal draws Clawd as a picture (kitty graphics), or as half-block
    // cells once a blit says pictures cannot be drawn; other surfaces get the face.
    const mascot =
      'Image' in ui && local.pictures ? (
        <ui.Image key="clawd" source={toRgba(grid, PIC_SCALE)} columns={PIC_COLS} rows={PIC_ROWS} alt="Claude" />
      ) : 'Raster' in ui ? (
        <ui.Raster key="clawd" columns={RASTER_COLS} rows={RASTER_ROWS} cells={toRaster(grid)} />
      ) : (
        <Text color={tone}>{avatarLine(face)}</Text>
      )
    const bodyRows = e.props.scroll.bodyRows
    // A chip: a compact button drawn as a filled label, one space of padding,
    // instead of the engine's wide `[ label ]`. The focus and the pointer invert it.
    // No hotkeys: the engine prefixes a plain button with `a:` for one, which clutters the chip.
    // `wrap`: a long label (an option) wraps inside its box instead of running off.
    const chip = (key: string, text: string, onPress: () => void, o: { hue?: string; dim?: boolean; wrap?: boolean } = {}) => (
      <Button key={key} plain {...(o.dim ? { dimColor: true } : {})} onPress={onPress}>
        <Text backgroundColor={o.hue ?? INK.chip} color={o.hue ? INK.pane : INK.chipText} bold={Boolean(o.hue)} {...(o.wrap ? { wrap: 'wrap' as const } : {})}>
          {` ${text} `}
        </Text>
      </Button>
    )

    if (s.view === 'icon') {
      return (
        <Box flexDirection="column" alignItems="flex-start" backgroundColor={INK.pane} width={width} minHeight={bodyRows} paddingX={1}>
          {mascot}
          <Box flexDirection="row" gap={1}>
            <Text bold color={open.length ? INK.decide : INK.mute}>
              {waiting ? `${waiting} waiting` : 'all clear'}
            </Text>
            {chip('view', '▸ open', () => void setSettings($, { view: 'card' }))}
          </Box>
        </Box>
      )
    }

    const kindWord = (k: Kind) => (k === 'decide' ? 'you decide' : k === 'do' ? 'you do' : 'for you to know')
    const at = await read($, cursor)
    const shown = s.view === 'card' ? shownItem(list, at) : undefined
    const position = shown ? open.indexOf(shown) + 1 : 0
    const status = waiting ? `${waiting} waiting on you` : open.length ? 'with Claude' : 'nothing waiting'
    const canStep = shown !== undefined && open.length > 1

    // The top row: what is waiting, then the controls. Under 48 columns the
    // count alone, so it keeps one row.
    const header = (
      <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
        <Box flexDirection="row" gap={1} flexShrink={1}>
          <Text bold color={INK.do}>
            Needs you
          </Text>
          <Text dimColor>{width >= 48 ? status : waiting ? String(waiting) : ''}</Text>
        </Box>
        <Box flexDirection="row" gap={1} flexShrink={0}>
          {canStep ? chip('prev', '‹', () => void step($, -1)) : null}
          {canStep ? <Text dimColor>{`${position}/${open.length}`}</Text> : null}
          {canStep ? chip('next', '›', () => void step($, 1)) : null}
          {shown ? chip('list', '≡', () => void setSettings($, { view: 'list' })) : null}
          {chip('min', '─', () => void setSettings($, { view: 'icon' }))}
          {chip('close', '✕', () => void closePane($))}
        </Box>
      </Box>
    )

    const doneBlock =
      done.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {/* A link-like toggle, not a chip: a filled chip keeps the engine's
              focus inversion after the press and reads as "selected". */}
          <Button key="done" plain dimColor onPress={() => void setSettings($, { showDone: !s.showDone })}>
            {s.showDone ? `▴ hide ${done.length} done` : `▾ show ${done.length} done`}
          </Button>
          {s.showDone ? (
            <Box flexDirection="column">
              {done.slice(-12).map(i => (
                <Text key={`done:${i.id}`} dimColor strikethrough wrap="truncate-end">
                  {String(i.n)} {i.title}
                </Text>
              ))}
            </Box>
          ) : null}
        </Box>
      ) : null

    // The card: one item in full, every word of it, with the ways to answer.
    // The pane is a narrow column, so it shows one thing at a time and steps.
    if (shown) {
      const i = shown
      const isOpen = i.status === 'open'
      const hue = isOpen ? kindHue(i.kind) : INK.mute
      // Inside the card: pane padding (2), the colour bar (1), card padding (2).
      const inner = Math.max(16, width - 5)
      const tick = i.kind === 'do' ? 'done' : 'got it'
      const fromAgent = i.from && i.from !== 'you' && i.from !== 'Claude' ? i.from : ''
      return (
        <Box flexDirection="column" backgroundColor={INK.pane} width={width} minHeight={bodyRows} paddingX={1}>
          {header}
          <Box key={`card:${i.id}`} flexDirection="row">
            <Box width={1} flexShrink={0} backgroundColor={hue} />
            <Box flexDirection="column" flexGrow={1} backgroundColor={INK.card} paddingX={1} paddingY={1}>
              <Box flexDirection="row" gap={1}>
                <Text backgroundColor={hue} color={INK.pane} bold>
                  {` ${i.n} `}
                </Text>
                <Text color={hue} bold>
                  {kindWord(i.kind)}
                </Text>
                {fromAgent ? <Text dimColor wrap="truncate-end">{`from ${fromAgent}`}</Text> : null}
              </Box>
              <Box width={inner} marginTop={1}>
                <Text bold wrap="wrap">
                  {i.title}
                </Text>
              </Box>
              {i.detail !== '' && (
                <Box width={inner} marginTop={1}>
                  <Text color={INK.body} wrap="wrap">
                    {i.detail}
                  </Text>
                </Box>
              )}
              {isOpen ? (
                <Box flexDirection="column" marginTop={1} width={inner} rowGap={1}>
                  {/* One option to a row, whole: the recommendation first and filled. */}
                  {i.options.length > 0
                    ? i.options.map((o, k) => (
                        <Box key={`ob:${i.id}:${k}`} width={inner}>
                          {chip(`o:${i.id}:${k}`, k === 0 ? `★ ${o}` : `  ${o}`, () => void answer($, i.id, { kind: 'option', text: o }), {
                            ...(k === 0 ? { hue } : {}),
                            wrap: true,
                          })}
                        </Box>
                      ))
                    : chip(`d:${i.id}`, `✓ ${tick}`, () => void answer($, i.id, { kind: 'check' }), { hue })}
                  <Box flexDirection="row" flexWrap="wrap" gap={1}>
                    {chip(`c:${i.id}`, '💬 talk it over', () => void answer($, i.id, { kind: 'chat' }))}
                    {chip(`x:${i.id}`, '✕ not needed', () => void dismiss($, i.id), { dim: true })}
                  </Box>
                </Box>
              ) : (
                <Box width={inner} marginTop={1}>
                  <Text dimColor wrap="wrap">
                    {i.answer ? `→ ${i.answer}   ` : ''}
                    {i.status === 'sent' ? '… sending' : '✓ Claude has it'}
                  </Text>
                </Box>
              )}
              {i.notes.map((n, k) => (
                <Box key={`note:${i.id}:${k}`} width={inner}>
                  <Text dimColor wrap="wrap">
                    {n.status === 'seen' ? '✓' : '…'} {n.text}
                  </Text>
                </Box>
              ))}
              {isOpen ? (
                <Box flexDirection="row" width={inner} marginTop={1}>
                  <Input
                    key={`n:${i.id}`}
                    placeholder="✎ add a note"
                    submitLabel=" "
                    rows={2}
                    value={local.drafts[i.id] ?? ''}
                    onInput={v => {
                      local.drafts[i.id] = v
                    }}
                    onSubmit={v => void answer($, i.id, { kind: 'note', text: v })}
                  />
                </Box>
              ) : null}
            </Box>
          </Box>
        </Box>
      )
    }

    // The list: a row per item, its title whole; a row opens its card.
    return (
      <Box flexDirection="column" backgroundColor={INK.pane} width={width} minHeight={bodyRows} paddingX={1}>
        {header}

        {open.length === 0 && (
          <Box flexDirection="column" paddingX={1}>
            <Text dimColor>Claude pins what it needs from you here.</Text>
            <Text dimColor>Try: /needs-you add something</Text>
          </Box>
        )}

        {open.map(i => {
          const isOpen = i.status === 'open'
          const hue = isOpen ? kindHue(i.kind) : INK.mute
          const state = i.status === 'sent' ? '… sending' : '✓ Claude has it'
          const meta = isOpen ? kindWord(i.kind) : `${i.answer ? `→ ${i.answer}   ` : ''}${state}`
          return (
            <Box key={`row:${i.id}`} flexDirection="row" marginBottom={1} hover={{ backgroundColor: INK.cardOpen }}>
              <Box width={1} flexShrink={0} backgroundColor={hue} />
              <Box flexDirection="column" flexGrow={1} paddingX={1} width={width - 3}>
                <Button key={`open:${i.id}`} plain onPress={() => void show($, i.id)}>
                  <Text bold={isOpen} dimColor={!isOpen} wrap="wrap">
                    {`${i.n}  ${i.title}`}
                  </Text>
                </Button>
                <Text color={isOpen ? hue : undefined} dimColor={!isOpen} wrap="wrap">
                  {meta}
                </Text>
              </Box>
            </Box>
          )
        })}

        {doneBlock}
      </Box>
    )
  })
}

// ---- helpers that touch the engine ----------------------------------------

// What the store keeps per session: the list's not-done items under a shape
// tag, and when it was written. A value of another shape is declined.
type Stored = { shape: string; at: number; items: Item[] }

function asStored(raw: unknown): Stored | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const v = raw as Partial<Stored>
  return v.shape === STORE_SHAPE && Array.isArray(v.items) && typeof v.at === 'number' ? (v as Stored) : undefined
}

// The session's stored list. On a change of session (`isNewSession`) the list
// becomes that session's, empty when it has none; at a (re)load a stored list
// replaces the one in memory only when there is one.
async function restore($: $T, isNewSession: boolean) {
  const stored = asStored(await $.store.get(`items:${local.sessionId}`).catch(() => undefined))
  if (stored && stored.items.length) await update($, items, () => stored.items)
  else if (isNewSession) await update($, items, () => [])
  if (isNewSession) {
    await update($, interim, () => [])
    local.wokeFor = ''
  }
  const s = (await $.store.get(SETTINGS_KEY).catch(() => undefined)) as Partial<PaneSettings> | undefined
  if (s && typeof s === 'object') await update($, settings, cur => ({ ...cur, ...s }))
  else {
    // Saved before the card view: keep the person's switches, not the old view.
    const old = (await $.store.get('settings').catch(() => undefined)) as Partial<PaneSettings> | undefined
    if (old && typeof old === 'object') {
      const kept: Partial<PaneSettings> = {}
      if (typeof old.focus === 'boolean') kept.focus = old.focus
      if (typeof old.catch === 'boolean') kept.catch = old.catch
      if (typeof old.showDone === 'boolean') kept.showDone = old.showDone
      await update($, settings, cur => ({ ...cur, ...kept }))
    }
  }
  await resize($)
}

// Other sessions' lists: drop those of another shape, empty, or older than
// KEEP_MS, and all but the newest KEEP_SESSIONS, so the store stays small.
async function pruneStore($: $T) {
  const now = await $.clock.now()
  const mine = `items:${local.sessionId}`
  const kept: { key: string; at: number }[] = []
  for (const key of await $.store.keys()) {
    if (!key.startsWith('items:') || key === mine) continue
    const v = asStored(await $.store.get(key))
    if (v && v.items.length && now - v.at < KEEP_MS) kept.push({ key, at: v.at })
    else await $.store.delete(key)
  }
  kept.sort((a, b) => b.at - a.at)
  for (const { key } of kept.slice(KEEP_SESSIONS)) await $.store.delete(key)
}

// Every change to the list goes through one atomic update over the latest
// value: a hook that read the list before a tool call wrote it (a turn step
// marking "seen" around a resolve) must not put the old list back.
async function setItems($: $T, fn: (list: readonly Item[]) => Item[]) {
  const next = await update($, items, fn)
  // The list in memory is what counts; a failed save (a full store) costs only
  // the copy a restart would read, so it is said once and the work goes on.
  try {
    const value: Stored = { shape: STORE_SHAPE, at: await $.clock.now(), items: next.filter(i => i.status !== 'done') }
    await $.store.set(`items:${local.sessionId}`, value)
  } catch (err) {
    if (!local.storeWarned) {
      local.storeWarned = true
      $.ui.toast(`Needs you: could not save the list (${String(err)}); it is kept for this session only.`)
    }
  }
  await resize($)
  await signal($)
}

async function setSettings($: $T, patch: Partial<PaneSettings>) {
  const next = await update($, settings, s => ({ ...s, ...patch }))
  await $.store.set(SETTINGS_KEY, next)
  await resize($)
}

async function title($: $T): Promise<string> {
  const open = openItems(await read($, items)).length
  return open ? `Needs you (${open})` : 'Needs you'
}

async function rows($: $T): Promise<number> {
  const list = await read($, items)
  return wantedRows(list, await read($, settings), shownItem(list, await read($, cursor)))
}

// The item the card view shows: the one the cursor is on while it is in the
// list, else the first one waiting on the person, else the first in the list.
function shownItem(list: readonly Item[], at: string): Item | undefined {
  const open = openItems(list)
  return open.find(i => i.id === at) ?? open.find(i => i.status === 'open') ?? open[0]
}

// The person picked an item from the list, or stepped through the cards.
async function show($: $T, id: string) {
  await update($, cursor, () => id)
  if ((await read($, settings)).view !== 'card') await setSettings($, { view: 'card' })
  else await resize($)
}

async function step($: $T, by: number) {
  const list = await read($, items)
  const open = openItems(list)
  const here = shownItem(list, await read($, cursor))
  if (!here || open.length < 2) return
  const at = open.findIndex(i => i.id === here.id)
  await show($, open[(at + by + open.length) % open.length]!.id)
}

// The person dropped an item they do not want to answer: it leaves, and the
// model is told quietly (a reminder of their own needs no word).
async function dismiss($: $T, id: string) {
  const item = (await read($, items)).find(i => i.id === id)
  if (!item || item.status === 'done') return
  const next = nextWaiting(await read($, items), id)
  if (next) await update($, cursor, () => next.id)
  await setItems($, cur => cur.map(i => (i.id === id ? { ...i, status: 'done' as const } : i)))
  if (item.from !== 'you') await appendRow($, droppedNote([item]))
}

// The pane follows its content: a re-open with the same id only re-sizes. A
// pane the person closed stays closed; the next pin brings it back.
async function resize($: $T) {
  if (!local.paneIsPlaced) return
  const isUp = (await $.ui.panes()).some(p => p.id === PANE)
  if (!isUp) {
    local.paneIsPlaced = false
    return
  }
  await $.ui.open(await openArgs($))
}

// Every open of the pane: its title and size follow the content, and Escape
// closes it while it holds the keyboard (a running turn or typed text keeps
// Escape for the main session).
async function openArgs($: $T) {
  const s = await read($, settings)
  return {
    id: PANE,
    title: await title($),
    columns: s.view === 'icon' ? 24 : COLUMNS,
    rows: await rows($),
    closeOnEscape: true as const,
  }
}

// While items wait and the pane is not on screen (closed by hand, or an unasked
// open held back on a narrow terminal), a pinned line under the prompt says so.
async function signal($: $T) {
  const waiting = openItems(await read($, items)).filter(i => i.status === 'open').length
  const next = waiting > 0 && !local.paneIsPlaced ? waiting : 0
  if (next !== local.offScreen) {
    local.offScreen = next
    $.ui.invalidate('ui.render')
  }
}

async function closePane($: $T) {
  local.paneIsPlaced = false
  try {
    await $.ui.close({ id: PANE })
  } catch (err) {
    $.ui.toast(`Needs you: could not close (${String(err)})`)
  }
  await signal($)
}

// A new item. `isCounted: false` (the reply catcher, the person's own `add`)
// leaves the turn's pin count alone, which only the model's pins should move.
async function pin(
  $: $T,
  p: Pin,
  o: { agentId?: string; from?: string; isCounted?: boolean } = {},
): Promise<{ item: Item; isPlaced: boolean }> {
  const now = await $.clock.now()
  const list = await read($, items)
  const item = newItem(list, p, o.from ?? (await whoAsked($, o.agentId)), now, o.agentId)
  await setItems($, cur => [...cur, item])
  const counted = o.isCounted === false ? 0 : 1
  await update($, live, l => ({ ...l, pinsThisTurn: l.pinsThisTurn + counted, lastPinAt: now }))
  const opened = await $.ui.open(await openArgs($))
  local.paneIsPlaced = opened.isPlaced
  if (!opened.isPlaced) $.ui.toast(`Needs you #${item.n}: ${item.title} (/needs-you)`, { timeoutMs: 8000 })
  await signal($)
  return { item, isPlaced: opened.isPlaced }
}

async function whoAsked($: $T, agentId?: string): Promise<string> {
  if (!agentId) return ''
  try {
    const agent = (await $.agent.list()).find(a => a.id === agentId)
    return agent ? `${agent.name ?? agent.type} (${agent.description})` : 'a helper agent'
  } catch {
    return 'a helper agent'
  }
}

// The person acted on an item. One answer per item at a time: a second press
// while the first is still being handled (a double press, the same chip drawn
// on two surfaces) is dropped.
async function answer($: $T, id: string, given: Answer) {
  if (local.inFlight.has(id)) return
  local.inFlight.add(id)
  try {
    await handleAnswer($, id, given)
  } finally {
    local.inFlight.delete(id)
    local.holding.delete(id)
  }
}

async function handleAnswer($: $T, id: string, given: Answer) {
  const item = (await read($, items)).find(i => i.id === id)
  if (!item || item.status === 'done') return
  let a = normalize(item, given)
  // A tick or a choice answers the item once; after that it is on its way.
  if ((a.kind === 'check' || a.kind === 'option') && item.status !== 'open') return
  if (a.kind === 'note') {
    const text = oneLine(a.text)
    if (!text) return
    a = { kind: 'note', text }
  }
  const now = await $.clock.now()
  if (a.kind === 'chat') {
    if (item.chatAt !== undefined || now - (local.chatAt[id] ?? -CHAT_MS) < CHAT_MS) return
    local.chatAt[id] = now
  }
  react(a.kind === 'check' ? 'love' : a.kind === 'option' ? 'ok' : a.kind === 'note' ? 'note' : 'chat', now)

  // The route: to the helper agent that asked (a chat goes to the main session,
  // where the person talks), appended to the running turn (a quiet one to the
  // conversation, running or not), or a prompt that starts a turn.
  const quiet = isQuiet(item, a)
  const agentId = a.kind === 'chat' ? undefined : item.agentId
  const isRunning = (await read($, live)).isTurnRunning
  // An appended row may miss a request that starts while it is on its way, so
  // none counts as carrying it until the append is done. A prompt's turn starts
  // after this, so its requests do carry it.
  if (agentId || isRunning || quiet) local.holding.add(id)

  // A tick or a choice moves the card view on to the next item waiting.
  if (a.kind === 'check' || a.kind === 'option') {
    const next = nextWaiting(await read($, items), id)
    if (next) await update($, cursor, () => next.id)
  }
  const note = a.kind === 'note' ? { text: a.text, at: now, status: 'sent' as const } : undefined
  await patchItem($, id, i => markSent(i, a, now, note))
  if (note) local.drafts[id] = ''

  const r = await deliver($, item, a, { agentId, quiet })
  if ('failed' in r) {
    await patchItem($, id, i => unmarkSent(i, item, a, note))
    if (a.kind === 'note') local.drafts[id] = a.text
    if (a.kind === 'chat') delete local.chatAt[id]
    $.ui.toast(`Needs you #${item.n}: not delivered (${r.failed}). It is still open; try again.`)
    return
  }
  const at = r.submitted ? now : await $.clock.now()
  await patchItem($, id, i => stampSent(i, a, at, r.to, note))
  local.holding.delete(id)
  // The turn ended while the row went in: nothing will read it until a turn starts.
  if (!r.submitted && !r.to && !quiet && !(await read($, live)).isTurnRunning) await wakeIfStranded($)
}

async function patchItem($: $T, id: string, fn: (i: Item) => Item) {
  await setItems($, cur => cur.map(i => (i.id === id ? fn(i) : i)))
}

function sameNote(n: Note, note: Note | undefined): boolean {
  return note !== undefined && n.at === note.at && n.text === note.text
}

// On its way: what the pane shows at once.
function markSent(i: Item, a: Answer, now: number, note: Note | undefined): Item {
  if (a.kind === 'check' || a.kind === 'option') {
    const next: Item = { ...i, status: 'sent', sentAt: now, answer: a.kind === 'option' ? a.text : i.answer }
    delete next.sentTo
    return next
  }
  if (a.kind === 'note' && note) return { ...i, notes: [...i.notes, note] }
  return { ...i, chatAt: now }
}

// Not delivered: back to how it was.
function unmarkSent(i: Item, before: Item, a: Answer, note: Note | undefined): Item {
  if (a.kind === 'check' || a.kind === 'option') {
    if (i.status !== 'sent') return i
    const next: Item = { ...i, status: before.status, answer: before.answer }
    delete next.sentAt
    delete next.sentTo
    return next
  }
  if (a.kind === 'note') return { ...i, notes: i.notes.filter(n => !sameNote(n, note)) }
  const next = { ...i }
  delete next.chatAt
  return next
}

// Handed over at `at`, to agent `to` (absent: the main conversation). What a
// request has already carried stays as it is.
function stampSent(i: Item, a: Answer, at: number, to: string | undefined, note: Note | undefined): Item {
  if (a.kind === 'check' || a.kind === 'option') {
    if (i.status !== 'sent') return i
    const next: Item = { ...i, sentAt: at }
    if (to) next.sentTo = to
    return next
  }
  if (a.kind === 'note') {
    return {
      ...i,
      notes: i.notes.map(n => (n.status === 'sent' && sameNote(n, note) ? { ...n, at, ...(to ? { to } : {}) } : n)),
    }
  }
  return i.chatAt === undefined ? i : { ...i, chatAt: at }
}

type Delivered = { submitted: boolean; to?: string } | { failed: string }

// Puts the answer in front of the model without interrupting anything. A
// helper agent's item goes to that agent, the main session getting an FYI; if
// the agent has finished, the main session takes the answer itself.
async function deliver($: $T, item: Item, a: Answer, o: { agentId?: string; quiet: boolean }): Promise<Delivered> {
  const hidden = messageFor(item, a)
  if (o.agentId) {
    const denied = await appendRow($, hidden, o.agentId)
    if (denied === undefined) {
      await appendRow($, fyiFor(item, a))
      return { submitted: false, to: o.agentId }
    }
  }
  if (o.quiet || (await read($, live)).isTurnRunning) {
    const denied = await appendRow($, hidden)
    return denied === undefined ? { submitted: false } : { failed: denied }
  }
  local.holding.delete(item.id)
  try {
    const r = await $.prompt.submit({ text: personMessageFor(item, a), asUser: true })
    return r.drop !== undefined ? { failed: r.drop } : { submitted: true }
  } catch (err) {
    return { failed: String(err) }
  }
}

// A hidden user row in a conversation (main, or `agentId`'s); the reason when
// it was refused or failed, undefined once it is stored.
async function appendRow($: $T, text: string, agentId?: string): Promise<string | undefined> {
  try {
    const r = await $.session.append({
      message: { type: 'user', content: [{ type: 'text', text }] },
      ...(agentId ? { agentId } : {}),
    })
    return r.deny
  } catch (err) {
    return String(err)
  }
}

// A helper agent finished with answers handed to it that none of its requests
// carried: the main session takes them, as actionable rows.
async function rescueFromAgent($: $T, agentId: string) {
  const list = await read($, items)
  const texts: string[] = []
  for (const i of list) {
    if (i.status === 'sent' && i.sentTo === agentId) {
      texts.push(messageFor(i, i.answer ? { kind: 'option', text: i.answer } : { kind: 'check' }))
    }
    for (const n of i.notes) if (n.status === 'sent' && n.to === agentId) texts.push(messageFor(i, { kind: 'note', text: n.text }))
  }
  if (!texts.length) return
  for (const text of texts) await appendRow($, text)
  const at = await $.clock.now()
  await setItems($, cur =>
    cur.map(i => {
      let next = i
      if (i.status === 'sent' && i.sentTo === agentId) {
        next = { ...next, sentAt: at }
        delete next.sentTo
      }
      if (i.notes.some(n => n.status === 'sent' && n.to === agentId)) {
        next = {
          ...next,
          notes: next.notes.map(n => (n.status === 'sent' && n.to === agentId ? { text: n.text, at, status: n.status } : n)),
        }
      }
      return next
    }),
  )
  if (!(await read($, live)).isTurnRunning) await wakeIfStranded($)
}

// Answers in the main conversation that no request carried, with the session
// idle: start a turn so they are read. Once per set of answers, so a wake-up
// that raced a request does not repeat.
async function wakeIfStranded($: $T) {
  if ((await read($, live)).isTurnRunning) return
  const key = pendingKey(await read($, items))
  if (!key) {
    local.wokeFor = ''
    return
  }
  if (key === local.wokeFor) return
  local.wokeFor = key
  void $.prompt.submit({ text: WAKE_TEXT }).catch(() => undefined)
}

async function catchFromReply($: $T, answer: string, turnId: string) {
  const r = await $.model.complete({
    model: 'haiku',
    system: CATCH_SYSTEM,
    prompt: catchPrompt(answer, openItems(await read($, items))),
    maxTokens: 700,
    effort: 'low',
    timeoutMs: 30_000,
  })
  if (!r.isAnswered) return
  const pins = parseCaught(r.text)
  // A new turn has started: the reply is old news, and that turn pins its own.
  if (!pins.length || (await read($, live)).turnId !== turnId) return
  const pinned: Item[] = []
  for (const p of pins) {
    // A turn started meanwhile: the rest is old news, and that turn pins its own.
    if ((await read($, live)).turnId !== turnId) break
    // Already asked, by the model or an earlier catch: not twice.
    if (findSameAsk(await read($, items), p.title)) continue
    pinned.push((await pin($, p, { from: 'the last reply', isCounted: false })).item)
  }
  if (!pinned.length || (await read($, live)).turnId !== turnId) return
  // Tell the model, which never saw these pins, so it can resolve them.
  await appendRow($, caughtNote(pinned))
}

async function tick($: $T) {
  if (!local.paneIsPlaced) return
  // Clawd is drawn in the hidden view only; nothing to animate in the list.
  if ((await read($, settings)).view !== 'icon') return
  const f = frameAt(await scene($))
  const key = frameKey(f)
  if (key === local.frameKey) return
  local.frameKey = key
  const g = draw(f)
  const r = local.pictures
    ? await $.ui.blit({ requestId: PANE, key: 'clawd', source: toRgba(g, PIC_SCALE), columns: PIC_COLS, rows: PIC_ROWS })
    : await $.ui.blit({ requestId: PANE, key: 'clawd', cells: toRaster(g), columns: RASTER_COLS, rows: RASTER_ROWS })
  if (r.deny && local.pictures && /alt/i.test(r.deny)) {
    local.pictures = false
    $.ui.invalidate('ui.render')
  }
}

// What the mascot reacts to right now.
async function scene($: $T) {
  const [list, l] = await Promise.all([read($, items), read($, live)])
  const now = await $.clock.now()
  const open = openItems(list)
  const done = doneItems(list)
  if (local.reaction && local.reaction.until < now) local.reaction = undefined
  const sc = { open: open.length, isFresh: now - l.lastPinAt < FRESH_MS, at: now, seed: open.length * 7 + done.length }
  return local.reaction ? { ...sc, reaction: local.reaction.kind } : sc
}

function react(kind: Reaction, now: number) {
  local.reaction = { kind, until: now + REACT_MS }
}

function kindHue(kind: Kind): string {
  return kind === 'decide' ? INK.decide : kind === 'do' ? INK.do : INK.know
}
