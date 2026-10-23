import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  ARCHIVE_TURNS,
  WAKE_TEXT,
  archiveSeen,
  avatarLine,
  hasCue,
  markSeen,
  messageFor,
  newItem,
  parseCaught,
  parsePin,
  pendingKey,
  personMessageFor,
  wantedRows,
} from './items'
import type { Item } from '../types'

const PANE = {
  plugin: 'needs-you',
  component: 'Pane',
  requestId: 'needs-you',
  props: {
    title: 'Needs you',
    isFocused: false,
    bodyColumns: 44,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const TOOL_ROW = {
  plugin: 'needs-you',
  component: 'ToolUse',
  requestId: 'tu1',
  props: { tool_use_id: 'tu1', tool: 'Bash', input: { command: 'ls' }, isRunning: false, isErrored: false, isInterrupted: false },
} as const

// Nothing sits beneath the plugin: these hooks stand for the engine.
function engine(on: On) {
  const sent: string[] = []
  const asUser: boolean[] = []
  mock.store(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.id', () => ({ value: 'sess-1' }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__needs-you__${e.name}` } }))
  on('command.register', () => ({ value: { command: 'needs-you' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [{ id: 'needs-you', title: 'Needs you', isShown: true, isFocused: false, isPlaced: true }] }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('agent.list', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    asUser.push(e.origin.kind === 'plugin' && e.origin.asUser === true)
    return { text: e.text }
  })
  return { sent, asUser, clock }
}

async function drain(stream: AsyncIterable<unknown>) {
  for await (const _ of stream) {
    // drain the stream
  }
}

const DONE = { answer: 'done', durationMs: 10, isAborted: false, reason: 'answer' } as const

// A typed slash command, as the engine stamps it.
function typed(args: string) {
  return { command: 'needs-you', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 80 } }
}

test('a pinned item shows in the pane on every surface', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const pinned = await $.tool.call({
    tool: 'mcp__needs-you__pin',
    kind: 'decide',
    title: 'Which model should the night job use?',
    detail: 'Haiku is cheaper; Sonnet reads messy notes better.',
    options: ['Sonnet', 'Haiku'],
  })
  expect(String(pinned.result)).toStartWith('Pinned #1')

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Which model/ })).toBeDefined()
    await ui.unmount()
  }
})

test('checking a box mid-turn appends a quiet message; idle it submits a prompt as the person', async ($, on) => {
  const { sent, asUser, clock } = engine(on)
  const session = mock.session(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__needs-you__pin', kind: 'do', title: 'Mint a new Retell key named night_job' })
  await $.tool.call({ tool: 'mcp__needs-you__pin', kind: 'do', title: 'Approve the night job in the dashboard' })

  await $.turn.start({ text: 'go', turnId: 't1' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const boxes = await ui.findAll({ type: 'Button' })
  const check = boxes.find(b => b.key?.startsWith('d:'))
  expect(check).toBeDefined()
  await ui.press({ key: check!.key! })

  const rows = session.appended().filter(r => r.door === 'note')
  expect(rows).toHaveLength(1)
  expect(rows[0]!.message.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('[needs-you] #1') })
  expect(sent).toHaveLength(0)
  // The box is gone and the row says the answer is on its way.
  expect(await ui.find({ key: check!.key! })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /sending/ })).toBeDefined()

  // The next model request carries the row: the row says Claude has it.
  await drain($.turn.step({ turnId: 't1', index: 1, model: 'claude', messageCount: 3 }))
  expect(await ui.find({ type: 'Text', text: /Claude has it/ })).toBeDefined()

  await $.turn.complete({ ...DONE, turnId: 't1' })
  await clock.settle()
  // Nothing was stranded, so no wake-up prompt.
  expect(sent).toHaveLength(0)
  const second = (await ui.findAll({ type: 'Button' })).find(b => b.key?.startsWith('d:') && b.key !== check!.key)
  await ui.press({ key: second!.key! })
  expect(sent).toHaveLength(1)
  expect(sent[0]).toBe('[needs-you] #2 "Approve the night job in the dashboard": done.')
  expect(asUser[0]).toBe(true)
  await ui.unmount()
})

test('a "know" ack and the person\'s own reminder never start a turn', async ($, on) => {
  const { sent, clock } = engine(on)
  const session = mock.session(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__needs-you__pin', kind: 'know', title: 'The old key stops working at midnight' })
  await $.command.run(typed('add call the bank'))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  for (const b of (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('d:'))) await ui.press({ key: b.key! })
  await clock.settle()
  expect(sent).toHaveLength(0)
  const rows = session.appended().filter(r => r.door === 'note').map(r => JSON.stringify(r.message.content))
  expect(rows).toHaveLength(2)
  expect(rows.every(r => r.includes('No reply needed'))).toBe(true)
  await ui.unmount()
})

test('a double press delivers once, and a second chat press is ignored', async ($, on) => {
  engine(on)
  const session = mock.session(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__needs-you__pin', kind: 'decide', title: 'Which model?', options: ['Sonnet', 'Haiku'] })
  await $.turn.start({ text: 'go', turnId: 't1' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const buttons = await ui.findAll({ type: 'Button' })
  const first = buttons.find(b => b.key?.startsWith('o:') && b.key.endsWith(':0'))!
  const chat = buttons.find(b => b.key?.startsWith('c:'))!
  await ui.press({ key: chat.key! })
  await ui.press({ key: chat.key! })
  await Promise.allSettled([ui.press({ key: first.key! }), ui.press({ key: first.key! })])
  const rows = session.appended().filter(r => r.door === 'note').map(r => JSON.stringify(r.message.content))
  expect(rows.filter(r => r.includes('chose \\"Sonnet\\" (your recommendation)'))).toHaveLength(1)
  expect(rows.filter(r => r.includes('talk this one through'))).toHaveLength(1)
  await ui.unmount()
})

test('an answer that lands after the last request wakes the session once', async ($, on) => {
  const { sent, asUser, clock } = engine(on)
  mock.session(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__needs-you__pin', kind: 'do', title: 'Mint a key' })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await drain($.turn.step({ turnId: 't1', index: 0, model: 'claude', messageCount: 2 }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const check = (await ui.findAll({ type: 'Button' })).find(b => b.key?.startsWith('d:'))!
  await ui.press({ key: check.key! })
  // No request after the press: the turn ends with the answer unread.
  await $.turn.complete({ ...DONE, turnId: 't1' })
  await clock.settle()
  expect(sent).toEqual([WAKE_TEXT])
  expect(asUser[0]).toBe(false)
  // The same unread answer does not wake it twice.
  await $.turn.complete({ ...DONE, turnId: 't1' })
  await clock.settle()
  expect(sent).toHaveLength(1)
  await ui.unmount()
})

test('focus mode hides a tool row, and lets ctrl+o show it', async ($, on) => {
  engine(on)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const hidden = await $.ui.mount({ ...TOOL_ROW, surface: 'terminal' })
  expect(await hidden.drawn()).toMatchObject({ type: 'Box', props: { display: 'none' } })
  await hidden.unmount()

  const shown = await $.ui.mount({ ...TOOL_ROW, surface: 'terminal', props: { ...TOOL_ROW.props, isExpanded: true } })
  expect((await shown.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await shown.unmount()

  await $.command.run(typed('focus off'))
  const back = await $.ui.mount({ ...TOOL_ROW, surface: 'terminal', requestId: 'tu2' })
  expect((await back.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await back.unmount()
})

test('the helpers: parsing, messages, seen and archived', () => {
  expect(parsePin({ kind: 'decide', title: 'x', options: ['a'] })).toMatchObject({ ok: false })
  expect(parsePin({ kind: 'nonsense', title: '  Two   words ' })).toMatchObject({ ok: true, pin: { kind: 'know', title: 'Two words' } })

  const a = newItem([], { kind: 'do', title: 'Mint a key', detail: '', options: [] }, '', 1)
  const b = newItem([a], { kind: 'decide', title: 'Pick one', detail: '', options: ['x', 'y'] }, '', 2)
  expect(b.n).toBe(2)
  expect(messageFor(a, { kind: 'check' })).toContain('#1 "Mint a key": the person has done this')
  expect(messageFor(b, { kind: 'option', text: 'y' })).toContain('chose "y"')
  expect(messageFor(b, { kind: 'note', text: 'cheaper please' })).toContain('call mcp__needs-you__update')
  expect(messageFor(b, { kind: 'note', text: 'cheaper please' })).not.toContain('Act on this')
  expect(personMessageFor(b, { kind: 'option', text: 'x' })).toBe('[needs-you] #2 "Pick one": go with your recommendation, "x".')

  // Seen only by a request that started after the answer was handed over.
  const sent: Item = { ...a, status: 'sent', sentAt: 50 }
  expect(markSeen([sent], 't1', 40)[0]!.status).toBe('sent')
  expect(pendingKey([sent])).not.toBe('')
  let seen = markSeen([sent, b], 't1', 60)
  expect(seen[0]).toMatchObject({ status: 'seen', seenTurn: 't1' })
  expect(pendingKey(seen)).toBe('')
  // Seen stays in the list ("Claude has it") until resolved, or a few turns.
  expect(archiveSeen(seen, 't1')[0]!.status).toBe('seen')
  for (let k = 1; k < ARCHIVE_TURNS; k++) seen = archiveSeen(seen, `t${k + 1}`)
  expect(seen[0]!.status).toBe('seen')
  expect(archiveSeen(seen, 'tN')[0]!.status).toBe('done')
  expect(avatarLine({ open: 0, isFresh: false, tick: 0, seed: 0 })).toHaveLength(avatarLine({ open: 2, isFresh: false, tick: 3, seed: 1 }).length)

  expect(hasCue('Done. Let me know if you want the second one too.')).toBe(true)
  expect(hasCue('All tests pass.')).toBe(false)
  expect(parseCaught('Sure: [{"kind":"do","title":"Rotate the key","detail":"","options":[]}]')).toHaveLength(1)
  expect(parseCaught('nothing here')).toHaveLength(0)
  expect(wantedRows([a, b], { view: 'icon', focus: true, catch: true, showDone: false })).toBe(3)
})
