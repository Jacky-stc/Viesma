import { Buffer } from 'node:buffer'
import { mkdirSync, writeFileSync } from 'node:fs'
import { URL } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'

const images = new URL('./images/', import.meta.url)
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

function pngChunk(type, bytes) {
  const chunk = Buffer.alloc(12 + bytes.length)
  chunk.writeUInt32BE(bytes.length)
  chunk.write(type, 4)
  bytes.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4)
  return chunk
}

function drawAtlas(file, width, height, scale, frames) {
  const rowBytes = 1 + 4 * width
  const pixels = Buffer.alloc(rowBytes * height)
  for (const [offsetX, offsetY, draw] of frames) {
    draw((x, y, w, h, color) => {
      const rgb = Number.parseInt(color, 16)
      for (let row = y * scale; row < (y + h) * scale; row++) {
        for (let col = x * scale; col < (x + w) * scale; col++) {
          const offset = (offsetY + row) * rowBytes + 1 + 4 * (offsetX + col)
          pixels.writeUInt32BE(rgb * 256 + 255, offset)
        }
      }
    })
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  writeFileSync(
    new URL(file, images),
    Buffer.concat([
      signature,
      pngChunk('IHDR', header),
      pngChunk('IDAT', deflateSync(pixels, { level: 9 })),
      pngChunk('IEND', Buffer.alloc(0)),
    ])
  )
}

const outline = '172638'
const skin = 'f5ce9b'
const hat = '316c79'
const gold = 'ffbc67'
const boots = '485771'

function beginner(state, phase, rect) {
  if (state === 'death') {
    rect(5, 21, 21, 6, outline)
    rect(6, 22, 6, 4, boots)
    rect(12, 22, 9, 4, '91afc4')
    rect(21, 22, 4, 4, skin)
    rect(24, 22, 2, 4, hat)
    return
  }
  const lift = state === 'jump' || (state === 'run' && phase) ? 1 : 0
  const lean = state === 'hurt' ? -2 : 0
  const torso = state === 'attack' ? 'f9e7ae' : state === 'hurt' ? 'ff8b91' : gold
  const rightFoot = state === 'fall' || (state === 'run' && phase) ? 2 : 0
  const leftFoot = state === 'run' && !phase ? -2 : 0
  rect(11 + leftFoot, 22 - lift, 5, 6, outline)
  rect(11 + leftFoot, 23 - lift, 4, 4, boots)
  rect(16 + rightFoot, 22, 5, 6, outline)
  rect(17 + rightFoot, 23, 3, 4, '8397aa')
  rect(10 + lean, 12 - lift, 12, 12, outline)
  rect(11 + lean, 13 - lift, 10, 9, torso)
  rect(12 + lean, 20 - lift, 8, 1, 'a86043')
  rect(12 + lean, 13 - lift, 5, 2, '55b6a8')
  rect(11 + lean, 5 - lift, 10, 9, outline)
  rect(12 + lean, 8 - lift, 8, 5, skin)
  rect(18 + lean, 9 - lift, 1, 2, outline)
  rect(12 + lean, 5 - lift, 8, 3, hat)
  rect(11 + lean, 7 - lift, 12, 1, hat)
  rect(13 + lean, 5 - lift, 5, 1, '55b6a8')
  if (state === 'attack') {
    const height = phase ? 17 : 13
    rect(20, height - 1, 12, 4, outline)
    rect(22, height, 10, 2, 'fff2d7')
    rect(23, height - 2, 1, 6, 'b8784a')
  }
}

function trail(rect) {
  rect(0, 11, 16, 5, '493f52')
  rect(0, 10, 16, 3, '887458')
  rect(1, 8, 7, 3, 'b7b875')
  rect(3, 7, 3, 1, 'd9cd95')
  rect(9, 9, 6, 3, '9b9d6d')
  rect(12, 13, 3, 1, '6b645c')
}

function guide(rect) {
  rect(4, 9, 8, 14, outline)
  rect(5, 10, 6, 8, skin)
  rect(3, 6, 10, 5, 'a66b47')
  rect(5, 4, 6, 4, 'dc9e62')
  rect(5, 15, 6, 7, '589985')
  rect(5, 16, 5, 1, 'd3d99d')
  rect(9, 11, 1, 1, outline)
  rect(5, 22, 2, 2, boots)
  rect(9, 22, 2, 2, boots)
  rect(13, 13, 1, 11, 'c2a781')
}

function slime(rect) {
  rect(1, 9, 14, 7, outline)
  rect(3, 7, 10, 8, '3b917e')
  rect(2, 11, 12, 4, '56b990')
  rect(4, 8, 4, 1, '91dfb9')
  rect(9, 10, 1, 2, outline)
  rect(12, 10, 1, 2, outline)
}

function mushroom(rect) {
  rect(4, 8, 8, 8, outline)
  rect(5, 9, 6, 6, 'e8c59c')
  rect(1, 6, 14, 4, 'ae6265')
  rect(3, 3, 10, 5, 'c77c71')
  rect(5, 4, 2, 2, 'ffdaad')
  rect(10, 6, 2, 1, 'ffdaad')
  rect(8, 11, 2, 1, outline)
}

function bat(rect) {
  rect(1, 3, 4, 6, '8c79a6')
  rect(11, 3, 4, 6, '8c79a6')
  rect(3, 5, 10, 6, '77698f')
  rect(5, 7, 6, 6, outline)
  rect(5, 6, 6, 5, 'aa8daf')
  rect(6, 8, 1, 1, 'ffd189')
  rect(9, 8, 1, 1, 'ffd189')
}

function loot(rect) {
  rect(3, 8, 10, 7, outline)
  rect(4, 9, 8, 5, 'b57541')
  rect(6, 6, 4, 4, 'e6ae63')
  rect(5, 8, 6, 1, 'ffdda2')
  rect(6, 10, 2, 2, 'e6ae63')
}

mkdirSync(images, { recursive: true })
const states = ['idle', 'run', 'run', 'jump', 'fall', 'attack', 'attack', 'hurt', 'death']
drawAtlas(
  'beginner.png',
  192,
  168,
  2,
  states.map((state, index) => [(index % 3) * 64, Math.floor(index / 3) * 56, (rect) => beginner(state, index === 2 || index === 6, rect)])
)
drawAtlas('village.png', 64, 48, 2, [
  [0, 0, trail],
  [32, 0, guide],
])
drawAtlas(
  'field.png',
  128,
  32,
  2,
  [slime, mushroom, bat, loot].map((draw, index) => [index * 32, 0, draw])
)
