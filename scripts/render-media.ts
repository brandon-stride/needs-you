// Renders media/clawd.png, the mascot sheet in the README, from the same
// drawing code the pane uses. Run with `bun run scripts/render-media.ts`.

import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'

import { GRID_H, GRID_W, HATS, THINGS, draw } from '../hooks/clawd'
import type { Frame } from '../hooks/clawd'

const SCALE = 6
const GAP = 2 // grid cells between sprites
const BG = [0x0d, 0x0f, 0x12] as const

// One sprite per hat, each holding a different thing, mid-dance.
const frames: Frame[] = HATS.filter(h => h.name !== 'none').map((_, k) => ({
  mood: 'dancing',
  step: k % 4,
  hat: k,
  thing: k % (THINGS.length - 1),
  emote: ['', '♪', '!', '', '?', '', 'heart', '', 'note', '', '', '', ''][k] ?? '',
}))

const cols = 7
const rows = Math.ceil(frames.length / cols)
const cellW = GRID_W + GAP
const cellH = GRID_H + GAP
const width = (cols * cellW + GAP) * SCALE
const height = (rows * cellH + GAP) * SCALE
const px = new Uint8Array(width * height * 3)
for (let i = 0; i < width * height; i++) px.set(BG, i * 3)

const hex = (c: string) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]
frames.forEach((f, k) => {
  const g = draw(f)
  const ox = (GAP + (k % cols) * cellW) * SCALE
  const oy = (GAP + Math.floor(k / cols) * cellH) * SCALE
  for (let y = 0; y < GRID_H; y++) for (let x = 0; x < GRID_W; x++) {
    const c = g[y * GRID_W + x]
    if (!c) continue
    const rgb = hex(c)
    for (let dy = 0; dy < SCALE; dy++) for (let dx = 0; dx < SCALE; dx++) {
      px.set(rgb, ((oy + y * SCALE + dy) * width + ox + x * SCALE + dx) * 3)
    }
  }
})

// ---- a minimal PNG writer ----------------------------------------------------

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc = (b: Uint8Array) => {
  let c = 0xffffffff
  for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type: string, data: Uint8Array) => {
  const t = new TextEncoder().encode(type)
  const out = new Uint8Array(12 + data.length)
  const v = new DataView(out.buffer)
  v.setUint32(0, data.length)
  out.set(t, 4)
  out.set(data, 8)
  v.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)))
  return out
}
const ihdr = new Uint8Array(13)
new DataView(ihdr.buffer).setUint32(0, width)
new DataView(ihdr.buffer).setUint32(4, height)
ihdr.set([8, 2, 0, 0, 0], 8) // 8-bit RGB
const raw = new Uint8Array((width * 3 + 1) * height)
for (let y = 0; y < height; y++) raw.set(px.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1)
const png = new Uint8Array([
  ...[137, 80, 78, 71, 13, 10, 26, 10],
  ...chunk('IHDR', ihdr),
  ...chunk('IDAT', new Uint8Array(deflateSync(raw))),
  ...chunk('IEND', new Uint8Array(0)),
])
mkdirSync('media', { recursive: true })
writeFileSync('media/clawd.png', png)
console.log(`media/clawd.png: ${frames.length} sprites, ${width}×${height}`)
