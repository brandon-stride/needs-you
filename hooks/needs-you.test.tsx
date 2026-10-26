import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  WAKE_TEXT,
  archiveSeen,
  avatarLine,
  hasCue,
  isSameAsk,
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
function engine(on: On, stored: Record<string, unknown> = {}) {
  const sent: string[] = []
  const asUser: boolean[] = []
  const contexts: (readonly string[] | undefined)[] = []
  mock.store(on, stored)
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
    contexts.push(e.context)
    if (e.origin.kind === 'composer') return e.text.includes('REFUSE') ? { drop: 'refused beneath' } : { text: e.text }
    sent.push(e.text)
    asUser.push(e.origin.kind === 'plugin' && e.origin.asUser === true)
    return { text: e.text }
  })
  return { sent, asUser, clock, contexts }
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
  // The box is gone, the card moved on to #2, and the list says #1 is on its way.
  expect(await ui.find({ key: check!.key! })).toBeUndefined()
  const second = (await ui.findAll({ type: 'Button' })).find(b => b.key?.startsWith('d:'))
  expect(second).toBeDefined()
  await ui.press({ key: 'list' })
  expect(await ui.find({ type: 'Text', text: /sending/ })).toBeDefined()

  // The next model request carries the row: the row says Claude has it.
  await drain($.turn.step({ turnId: 't1', index: 1, model: 'claude', messageCount: 3 }))
  expect(await ui.find({ type: 'Text', text: /Claude has it/ })).toBeDefined()

  await $.turn.complete({ ...DONE, turnId: 't1' })
  await clock.settle()
  // Nothing was stranded, so no wake-up prompt; #1 has left the list.
  expect(sent).toHaveLength(0)
  expect(await ui.find({ type: 'Text', text: /Mint a new Retell key/ })).toBeUndefined()
  const row = (await ui.findAll({ type: 'Button' })).find(b => b.key?.startsWith('open:'))
  await ui.press({ key: row!.key! })
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
  // The card shows one at a time and steps on after each tick.
  for (let k = 0; k < 2; k++) {
    const b = (await ui.findAll({ type: 'Button' })).find(b => b.key?.startsWith('d:'))
    if (b) await ui.press({ key: b.key! })
  }
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
  const seen = markSeen([sent, b], 't1', 60)
  expect(seen[0]).toMatchObject({ status: 'seen', seenTurn: 't1' })
  expect(pendingKey(seen)).toBe('')
  // Seen leaves the list when a main turn ends, resolved or not; a note still
  // on its way keeps it.
  expect(archiveSeen(seen)[0]!.status).toBe('done')
  const noting: Item = { ...seen[0]!, notes: [{ text: 'and the other one', at: 70, status: 'sent' }] }
  expect(archiveSeen([noting])[0]!.status).toBe('seen')
  expect(avatarLine({ open: 0, isFresh: false, tick: 0, seed: 0 })).toHaveLength(avatarLine({ open: 2, isFresh: false, tick: 3, seed: 1 }).length)

  expect(hasCue('Done. Let me know if you want the second one too.')).toBe(true)
  expect(hasCue('All tests pass.')).toBe(false)
  expect(parseCaught('Sure: [{"kind":"do","title":"Rotate the key","detail":"","options":[]}]')).toHaveLength(1)
  expect(parseCaught('nothing here')).toHaveLength(0)
  expect(wantedRows([a, b], { view: 'icon', focus: true, catch: true, showDone: false })).toBe(3)

  // Too long is refused with the reason, never cut.
  expect(parsePin({ kind: 'know', title: 'x'.repeat(101) })).toMatchObject({ ok: false })
  expect(parsePin({ kind: 'know', title: 'Short', detail: 'y'.repeat(401) })).toMatchObject({ ok: false })
  expect(parsePin({ kind: 'decide', title: 'Pick', options: ['z'.repeat(49), 'b'] })).toMatchObject({ ok: false })

  // The same ask in other words; different asks that share a word or two.
  expect(isSameAsk('Flip six Clerk settings so the new text-code sign-in works fully', 'Turn on the six Clerk settings for text-code sign-in')).toBe(true)
  expect(isSameAsk('Notifications: let the browser fetch one static file without signing in?', 'Should the browser fetch one static file before sign-in for notifications?')).toBe(true)
  expect(isSameAsk('Approve the night job in the dashboard', 'Mint a key for the night job')).toBe(false)
  expect(isSameAsk('Invite Alice to the billing workspace', 'Invite Bob to the billing workspace')).toBe(false)
  expect(isSameAsk('Approve the production deploy for Alpha', 'Approve the production deploy for Bravo')).toBe(false)
  expect(isSameAsk('Invite Al to the billing workspace', 'Invite Jo to the billing workspace')).toBe(false)
  expect(isSameAsk('Approve the production deploy for PR 12', 'Approve the production deploy for PR 13')).toBe(false)
  expect(isSameAsk('12 tests fail on the sign-in page', '13 tests fail on the sign-in page')).toBe(false)
})

test('the card shows every word of an item and steps to the next once answered', async ($, on) => {
  engine(on)
  mock.session(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const option = 'Yes, add a test owner login to the workspace'
  await $.tool.call({ tool: 'mcp__needs-you__pin', kind: 'decide', title: 'Can I add a test owner login for the screen walks?', detail: 'd'.repeat(380), options: [option, 'No'] })
  await $.tool.call({ tool: 'mcp__needs-you__pin', kind: 'do', title: 'Paste the Stripe test key into the env file' })
  await $.turn.start({ text: 'go', turnId: 't1' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: new RegExp(`★ ${option}`) })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /d{380}/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Stripe/ })).toBeUndefined()

  const first = (await ui.findAll({ type: 'Button' })).find(b => b.key?.startsWith('o:') && b.key.endsWith(':0'))!
  await ui.press({ key: first.key! })
  expect(await ui.find({ type: 'Text', text: /Stripe/ })).toBeDefined()
  // The list holds both, the answered one with its answer.
  await ui.press({ key: 'list' })
  expect(await ui.find({ type: 'Text', text: /→ Yes, add a test owner/ })).toBeDefined()
  await ui.unmount()
})

test('a second pin of the same ask is refused; not needed drops an item quietly', async ($, on) => {
  engine(on)
  const session = mock.session(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__needs-you__pin', kind: 'do', title: 'Flip six Clerk settings so the new text-code sign-in works fully' })
  const again = await $.tool.call({ tool: 'mcp__needs-you__pin', kind: 'do', title: 'Turn on the six Clerk settings for text-code sign-in' })
  expect(String(again.result)).toStartWith('Not pinned: #1')
  const different = await $.tool.call({ tool: 'mcp__needs-you__pin', kind: 'do', title: 'Turn on the six Clerk settings for text-code sign-in', distinct: true })
  expect(String(different.result)).toStartWith('Pinned #2')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const drop = (await ui.findAll({ type: 'Button' })).find(b => b.key?.startsWith('x:'))!
  await ui.press({ key: drop.key! })
  expect(String((await $.tool.call({ tool: 'mcp__needs-you__list' })).result)).not.toContain('#1')
  const rows = session.appended().map(r => JSON.stringify(r.message.content))
  expect(rows.some(r => r.includes('dismissed #1'))).toBe(true)
  await ui.unmount()
})

test('numbers are never given out twice, at once or after a restart', async ($, on) => {
  engine(on, { 'items:sess-1': { shape: 'items-2', at: 1, items: [], lastN: 7 } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const [a, b] = await Promise.all([
    $.tool.call({ tool: 'mcp__needs-you__pin', kind: 'do', title: 'Mint a key' }),
    $.tool.call({ tool: 'mcp__needs-you__pin', kind: 'do', title: 'Approve the night job' }),
  ])
  expect([String(a.result).slice(0, 9), String(b.result).slice(0, 9)].sort()).toEqual(['Pinned #8', 'Pinned #9'])
})

test('switches saved before the card view are kept', async ($, on) => {
  engine(on, { settings: { view: 'list', focus: false, catch: false, showDone: false } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const r = await $.command.run(typed(''))
  expect(String(r.text)).toContain('Focus mode is off')
})

test("the person's typed message carries the waiting items for the model", async ($, on) => {
  const { contexts } = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__needs-you__pin', kind: 'decide', title: 'Which model?', options: ['Sonnet', 'Haiku'] })
  await $.prompt.submit({ text: 'go with sonnet', origin: { kind: 'composer' } } as never)
  expect(contexts.at(-1)?.join('\n') ?? '').toContain('#1 "Which model?"')
  expect(contexts.at(-1)?.join('\n') ?? '').not.toContain('Do not mention')
  // A note typed after the pane's prefix lands on its card.
  await $.prompt.submit({ text: '[needs-you] #1 note: only if it stays under budget', origin: { kind: 'composer' } } as never)
  expect(String((await $.tool.call({ tool: 'mcp__needs-you__list' })).result)).toContain('notes: "only if it stays under budget"')
  // A prompt refused beneath leaves no note behind.
  await $.prompt.submit({ text: '[needs-you] #1 note: REFUSE this one', origin: { kind: 'composer' } } as never).catch(() => undefined)
  expect(String((await $.tool.call({ tool: 'mcp__needs-you__list' })).result)).not.toContain('REFUSE')
  // The pane's own answers carry nothing extra.
  await $.prompt.submit({ text: '[needs-you] #1 "Which model?": done.', origin: { kind: 'composer' } } as never)
  expect(contexts.at(-1)).toBeUndefined()
})
