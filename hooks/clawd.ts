// Pixel Clawd: the orange Claude mascot on a 30×28 pixel grid (the same
// proportions as DockCrab's Clawdy), wearing a random hat, holding a random
// thing, dancing while something needs the person, reacting when they press.
// Pure: the grid becomes RGBA bytes for a terminal picture, or half-block
// cells for a Raster where pictures cannot be drawn. No engine in here.

export const GRID_W = 30
export const GRID_H = 28
export const CLAY = '#D97757'
export const INK = '#1F1E1D'
const WHITE = '#F4F3EE'
const GOLD = '#F2C14E'
const PINK = '#F06A7A'
const SKY = '#6CB4EE'
const LEAF = '#5FB36A'
const WOOD = '#A0643A'
const STEEL = '#B8BCC6'
const RED = '#D64550'

export type Mood = 'asleep' | 'surprised' | 'dancing'
export type Reaction = 'love' | 'ok' | 'note' | 'chat'
export type Frame = {
  mood: Mood
  step: number // 0..3, the dance beat
  hat: number
  thing: number
  emote: string // '', '!', '?', 'z', 'zz', 'heart', 'note'
  reaction?: Reaction
}

type Grid = (string | undefined)[] // GRID_W * GRID_H colours

const fill = (g: Grid, x: number, y: number, w: number, h: number, c: string): void => {
  for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) {
    const px = x + dx, py = y + dy
    if (px >= 0 && px < GRID_W && py >= 0 && py < GRID_H) g[py * GRID_W + px] = c
  }
}
const stamp = (g: Grid, x: number, y: number, rows: string[], map: Record<string, string>): void =>
  rows.forEach((row, dy) => [...row].forEach((ch, dx) => { const c = map[ch]; if (c) fill(g, x + dx, y + dy, 1, 1, c) }))

// ---- the body --------------------------------------------------------------

function body(g: Grid, f: Frame): void {
  const bob = f.mood === 'dancing' && f.step % 2 === 1 ? 1 : 0
  const armUp = f.mood === 'surprised' ? -4 : f.mood === 'dancing' && (f.step === 1 || f.step === 2) ? -3 : 0
  const y = 10 + bob
  fill(g, 7, y, 16, 12, CLAY)
  fill(g, 3, y + 4 + (f.mood === 'surprised' ? -4 : 0), 4, 4, CLAY) // left arm
  fill(g, 23, y + 4 + armUp, 4, 4, CLAY) // right arm, the one that holds
  // eyes
  if (f.mood === 'asleep') {
    fill(g, 9, y + 3, 2, 1, INK); fill(g, 19, y + 3, 2, 1, INK)
  } else if (f.mood === 'surprised' || f.reaction === 'love') {
    fill(g, 9, y + 1, 2, 3, INK); fill(g, 19, y + 1, 2, 3, INK)
    if (f.reaction === 'love') { fill(g, 9, y + 1, 2, 3, PINK); fill(g, 19, y + 1, 2, 3, PINK) }
  } else if (f.mood === 'dancing' && f.step === 3 && f.hat % 3 === 0) {
    fill(g, 9, y + 2, 2, 2, INK); fill(g, 19, y + 3, 2, 1, INK) // wink
  } else {
    fill(g, 9, y + 2, 2, 2, INK); fill(g, 19, y + 2, 2, 2, INK)
  }
  // legs: two pairs that alternate while dancing
  const a = f.mood === 'dancing' && f.step % 2 === 0 ? -1 : 0
  const b = f.mood === 'dancing' && f.step % 2 === 1 ? -1 : 0
  fill(g, 7, 22, 2, 4 + a, CLAY); fill(g, 17, 22, 2, 4 + a, CLAY)
  fill(g, 11, 22, 2, 4 + b, CLAY); fill(g, 21, 22, 2, 4 + b, CLAY)
}

// ---- hats: drawn over the head (y 2..9), x 5..24 ----------------------------

export const HATS: ReadonlyArray<{ name: string; draw: (g: Grid, bob: number) => void }> = [
  { name: 'top hat', draw: (g, b) => { fill(g, 9, 2 + b, 12, 7, INK); fill(g, 6, 8 + b, 18, 2, INK); fill(g, 9, 6 + b, 12, 1, RED) } },
  { name: 'crown', draw: (g, b) => stamp(g, 7, 3 + b, ['g....gg....g', 'gg..gggg..gg', 'gggggggggggg', 'gggggggggggg', 'g.rr.gg.rr.g', 'gggggggggggg', 'dddddddddddd'], { g: GOLD, r: RED, d: '#A67C00' }) },
  { name: 'party cone', draw: (g, b) => stamp(g, 11, 1 + b, ['...yy...', '...pp...', '..pppp..', '..yyyy..', '.pppppp.', '.yyyyyy.', 'pppppppp'], { p: PINK, y: GOLD }) },
  { name: 'cowboy', draw: (g, b) => { fill(g, 10, 3 + b, 10, 5, WOOD); fill(g, 4, 8 + b, 22, 2, WOOD); fill(g, 10, 6 + b, 10, 1, INK) } },
  { name: 'chef', draw: (g, b) => { fill(g, 8, 2 + b, 14, 5, WHITE); fill(g, 6, 4 + b, 18, 3, WHITE); fill(g, 9, 7 + b, 12, 3, WHITE) } },
  { name: 'propeller', draw: (g, b) => { fill(g, 9, 6 + b, 12, 4, SKY); fill(g, 9, 8 + b, 12, 1, RED); fill(g, 14, 4 + b, 2, 2, STEEL); fill(g, 10, 3 + b, 10, 1, GOLD) } },
  { name: 'halo', draw: (g, b) => { fill(g, 9, 3 + b, 12, 1, GOLD); fill(g, 8, 4 + b, 1, 1, GOLD); fill(g, 21, 4 + b, 1, 1, GOLD); fill(g, 9, 5 + b, 12, 1, GOLD) } },
  { name: 'wizard', draw: (g, b) => stamp(g, 8, 0 + b, ['......ss......', '.....ssss.....', '.....ssss.....', '....ssyyss....', '....ssssss....', '...ssssssss...', '...ssyyssss...', '..ssssssssss..', '..ssssssssss..', 'ssssssssssssss'], { s: '#5A4FB5', y: GOLD }) },
  { name: 'bucket', draw: (g, b) => { fill(g, 8, 3 + b, 14, 6, STEEL); fill(g, 7, 9 + b, 16, 1, '#8A8E99'); fill(g, 10, 2 + b, 10, 1, '#8A8E99') } },
  { name: 'headphones', draw: (g, b) => { fill(g, 8, 6 + b, 14, 1, INK); fill(g, 7, 7 + b, 1, 2, INK); fill(g, 22, 7 + b, 1, 2, INK); fill(g, 5, 10 + b, 3, 5, INK); fill(g, 22, 10 + b, 3, 5, INK); fill(g, 6, 11 + b, 1, 3, SKY); fill(g, 23, 11 + b, 1, 3, SKY) } },
  { name: 'viking', draw: (g, b) => { fill(g, 8, 6 + b, 14, 4, STEEL); fill(g, 5, 3 + b, 2, 5, WHITE); fill(g, 7, 6 + b, 1, 2, WHITE); fill(g, 23, 3 + b, 2, 5, WHITE); fill(g, 22, 6 + b, 1, 2, WHITE); fill(g, 8, 8 + b, 14, 1, GOLD) } },
  { name: 'beanie', draw: (g, b) => { fill(g, 9, 4 + b, 12, 6, LEAF); fill(g, 8, 8 + b, 14, 2, '#3E8A48'); fill(g, 14, 2 + b, 2, 2, WHITE) } },
  { name: 'bow', draw: (g, b) => stamp(g, 14, 5 + b, ['pp..pp', 'pppppp', '.pppp.', 'pppppp', 'pp..pp'], { p: PINK }) },
  { name: 'none', draw: () => undefined },
]

// ---- things held in the right claw: x 24..29 -------------------------------

export const THINGS: ReadonlyArray<{ name: string; draw: (g: Grid, y: number, step: number) => void }> = [
  { name: 'wrench', draw: (g, y) => { fill(g, 27, y - 6, 2, 8, STEEL); fill(g, 26, y - 7, 4, 2, STEEL); fill(g, 27, y - 7, 2, 1, INK) } },
  { name: 'coffee', draw: (g, y, s) => { fill(g, 25, y - 5, 5, 5, WHITE); fill(g, 26, y - 4, 3, 1, WOOD); fill(g, 29, y - 4, 1, 3, WHITE); if (s % 2) { fill(g, 26, y - 7, 1, 1, '#9A9A9A'); fill(g, 28, y - 8, 1, 1, '#9A9A9A') } } },
  { name: 'pizza', draw: (g, y) => stamp(g, 24, y - 6, ['yyyyyy', '.rrrr.', '.rprp.', '..rr..', '..pp..', '...r..'], { y: GOLD, r: '#E8A24A', p: RED }) },
  { name: 'balloon', draw: (g, y, s) => { const d = s % 2; fill(g, 25, y - 10 + d, 4, 5, RED); fill(g, 26, y - 11 + d, 2, 1, RED); fill(g, 26, y - 5 + d, 2, 1, RED); fill(g, 27, y - 4 + d, 1, 4, WHITE) } },
  { name: 'flag', draw: (g, y, s) => { fill(g, 27, y - 9, 1, 11, WOOD); fill(g, 28, y - 9, s % 2 ? 2 : 3, 4, SKY) } },
  { name: 'magnifier', draw: (g, y) => { stamp(g, 25, y - 8, ['.kkk.', 'k.b.k', 'kbbbk', 'k.b.k', '.kkk.'], { k: INK, b: '#B9E3FF' }); fill(g, 27, y - 3, 1, 4, WOOD) } },
  { name: 'hammer', draw: (g, y, s) => { const t = s % 2 ? -2 : 0; fill(g, 27, y - 6 + t, 1, 8, WOOD); fill(g, 25, y - 8 + t, 5, 3, STEEL) } },
  { name: 'guitar', draw: (g, y) => stamp(g, 24, y - 8, ['....w.', '....w.', '....w.', '...ww.', '..wwww', '.wwwww', '.wwwww', '..www.'], { w: WOOD }) },
  { name: 'book', draw: (g, y) => { fill(g, 24, y - 4, 6, 5, SKY); fill(g, 25, y - 3, 4, 3, WHITE); fill(g, 27, y - 3, 1, 3, SKY) } },
  { name: 'lollipop', draw: (g, y) => { stamp(g, 25, y - 9, ['.ppp.', 'pwpwp', 'pppwp', 'pwppp', '.ppp.'], { p: PINK, w: WHITE }); fill(g, 27, y - 4, 1, 5, WHITE) } },
  { name: 'torch', draw: (g, y, s) => { fill(g, 26, y - 3, 2, 5, WOOD); fill(g, 25, y - 6, 4, 3, GOLD); fill(g, 26, y - 8 + (s % 2), 2, 2, RED) } },
  { name: 'nothing', draw: () => undefined },
]

// ---- emotes beside the head (x 23..29, y 0..7) ------------------------------

const EMOTE: Record<string, (g: Grid) => void> = {
  '!': g => { fill(g, 27, 1, 2, 4, WHITE); fill(g, 27, 6, 2, 1, WHITE) },
  '?': g => stamp(g, 25, 0, ['.www.', 'w...w', '....w', '...w.', '..w..', '.....', '..w..'], { w: WHITE }),
  'z': g => stamp(g, 26, 2, ['www', '..w', '.w.', 'www'], { w: '#9A9A9A' }),
  'zz': g => { stamp(g, 23, 4, ['www', '..w', '.w.', 'www'], { w: '#9A9A9A' }); stamp(g, 27, 0, ['www', '..w', '.w.', 'www'], { w: '#C0C0C0' }) },
  'heart': g => stamp(g, 24, 1, ['.pp.pp.', 'ppppppp', 'ppppppp', '.ppppp.', '..ppp..', '...p...'], { p: PINK }),
  'note': g => stamp(g, 25, 0, ['...w', '...w', '...w', '.www', 'wwww', '.ww.'], { w: WHITE }),
  'ok': g => stamp(g, 24, 1, ['.....g', '....gg', 'g..gg.', 'gggg..', '.gg...'], { g: LEAF }),
  'dots': g => { fill(g, 24, 4, 1, 1, WHITE); fill(g, 26, 4, 1, 1, WHITE); fill(g, 28, 4, 1, 1, WHITE) },
  'pencil': g => stamp(g, 25, 1, ['....y', '...yy', '..yy.', '.yy..', 'kk...'], { y: GOLD, k: INK }),
}

export function draw(f: Frame): Grid {
  const g: Grid = new Array(GRID_W * GRID_H).fill(undefined)
  const bob = f.mood === 'dancing' && f.step % 2 === 1 ? 1 : 0
  body(g, f)
  HATS[f.hat % HATS.length]?.draw(g, bob)
  const armY = 10 + bob + 4 + (f.mood === 'surprised' ? -4 : f.mood === 'dancing' && (f.step === 1 || f.step === 2) ? -3 : 0)
  if (f.reaction !== 'note') THINGS[f.thing % THINGS.length]?.draw(g, armY, f.step)
  const emote = f.reaction === 'love' ? 'heart' : f.reaction === 'ok' ? 'ok' : f.reaction === 'note' ? 'pencil' : f.reaction === 'chat' ? 'dots' : f.emote
  if (emote) EMOTE[emote]?.(g)
  return g
}

// ---- outputs ----------------------------------------------------------------

const hex = (c: string): [number, number, number] => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]

function b64(bytes: Uint8Array): string {
  const anyBytes = bytes as unknown as { toBase64?: () => string }
  if (typeof anyBytes.toBase64 === 'function') return anyBytes.toBase64()
  const T = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0, b = bytes[i + 1] ?? 0, c = bytes[i + 2] ?? 0
    const n = (a << 16) | (b << 8) | c
    out += T[(n >> 18) & 63]! + T[(n >> 12) & 63]! + (i + 1 < bytes.length ? T[(n >> 6) & 63]! : '=') + (i + 2 < bytes.length ? T[n & 63]! : '=')
  }
  return out
}

// The grid as RGBA pixels, each grid pixel `scale` wide and tall, transparent
// where nothing is drawn; for a terminal `Image`.
export function toRgba(g: Grid, scale = 4): { rgba: string; width: number; height: number } {
  const width = GRID_W * scale, height = GRID_H * scale
  const out = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const c = g[Math.floor(y / scale) * GRID_W + Math.floor(x / scale)]
    if (!c) continue
    const [r, gg, b] = hex(c)
    const i = (y * width + x) * 4
    out[i] = r; out[i + 1] = gg; out[i + 2] = b; out[i + 3] = 255
  }
  return { rgba: b64(out), width, height }
}

// The grid as half-block cells (two pixels per cell, `▀` top over `▄` bottom),
// `step` grid pixels per cell column; for a terminal `Raster`.
export const RASTER_COLS = GRID_W / 2
export const RASTER_ROWS = GRID_H / 4
const DEFAULT_BG = 0x01000000
const rgb = (c: string | undefined): number => (c ? parseInt(c.slice(1), 16) : DEFAULT_BG)
export function toRaster(g: Grid): string {
  const words = new Uint32Array(RASTER_COLS * RASTER_ROWS * 3)
  let k = 0
  for (let row = 0; row < RASTER_ROWS; row++) for (let col = 0; col < RASTER_COLS; col++) {
    const x = col * 2, yt = row * 4, yb = row * 4 + 2
    const t = g[yt * GRID_W + x] ?? g[(yt + 1) * GRID_W + x] ?? g[yt * GRID_W + x + 1]
    const b = g[yb * GRID_W + x] ?? g[(yb + 1) * GRID_W + x] ?? g[yb * GRID_W + x + 1]
    if (t && b) { words[k++] = 0x2580; words[k++] = rgb(t); words[k++] = rgb(b) }
    else if (t) { words[k++] = 0x2580; words[k++] = rgb(t); words[k++] = DEFAULT_BG }
    else if (b) { words[k++] = 0x2584; words[k++] = rgb(b); words[k++] = DEFAULT_BG }
    else { words[k++] = 0x20; words[k++] = DEFAULT_BG; words[k++] = DEFAULT_BG }
  }
  return b64(new Uint8Array(words.buffer))
}

// The same grid as plain text lines (for tests and previews): `#` body, `.` empty.
export function toAscii(g: Grid): string[] {
  const lines: string[] = []
  for (let y = 0; y < GRID_H; y++) {
    let s = ''
    for (let x = 0; x < GRID_W; x++) { const c = g[y * GRID_W + x]; s += !c ? '.' : c === CLAY ? '#' : c === INK ? '@' : '+' }
    lines.push(s)
  }
  return lines
}

// ---- picking the frame -------------------------------------------------------

function hash(n: number): number {
  let x = (n ^ 0x9e3779b9) >>> 0
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0
  return (x ^ (x >>> 16)) >>> 0
}

export type Scene = { open: number; isFresh: boolean; at: number; seed: number; reaction?: Reaction }

// What Clawd looks like at time `at` (ms): the beat runs at 4 a second while
// dancing, 1 a second asleep; hat and thing change with the seed and slowly
// with time, so a long wait gets a wardrobe change.
export function frameAt(s: Scene): Frame {
  const mood: Mood = s.open === 0 ? 'asleep' : s.isFresh ? 'surprised' : 'dancing'
  const beat = Math.floor(s.at / (mood === 'asleep' ? 1000 : 250))
  const wardrobe = Math.floor(s.at / 45_000)
  const hat = hash(s.seed * 5 + wardrobe) % HATS.length
  const thing = hash(s.seed * 11 + 3 + Math.floor(s.at / 30_000)) % THINGS.length
  const emotes = ['', '', '', 'note', '', '!', '', '?', '', 'heart', '', '']
  const emote = mood === 'asleep' ? (beat % 2 ? 'zz' : 'z') : mood === 'surprised' ? (beat % 2 ? '!' : '') : emotes[hash(s.seed + Math.floor(s.at / 3000)) % emotes.length]!
  const f: Frame = { mood, step: beat % 4, hat, thing, emote }
  if (s.reaction) f.reaction = s.reaction
  return f
}

// Two frames draw the same picture: nothing to blit.
export const frameKey = (f: Frame): string => `${f.mood}:${f.step}:${f.hat}:${f.thing}:${f.emote}:${f.reaction ?? ''}`
