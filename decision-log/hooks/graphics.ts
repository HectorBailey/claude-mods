// Pixel graphics for the terminal's Raster element: each cell is a character with a 24-bit
// foreground and background, so a half block (▀) shows two square pixels stacked.

export const DEFAULT_COLOR = 0x01000000

export const PALETTE = {
  claude: 0xd97757,
  violet: 0x8a6fd8,
  white: 0xffffff,
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

const toBase64 = (bytes: Uint8Array): string => {
  let out = ''

  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += BASE64.charAt((n >> 18) & 63) + BASE64.charAt((n >> 12) & 63)
    out += i + 1 < bytes.length ? BASE64.charAt((n >> 6) & 63) : '='
    out += i + 2 < bytes.length ? BASE64.charAt(n & 63) : '='
  }

  return out
}

const mix = (from: number, to: number, t: number): number => {
  const channel = (shift: number) => {
    const a = (from >> shift) & 0xff
    const b = (to >> shift) & 0xff
    return Math.round(a + (b - a) * t) << shift
  }

  return channel(16) | channel(8) | channel(0)
}

class Cells {
  private readonly words: number[]

  constructor(
    readonly columns: number,
    readonly rows: number,
  ) {
    this.words = []

    for (let i = 0; i < columns * rows; i += 1) {
      this.words.push(0x20, DEFAULT_COLOR, DEFAULT_COLOR)
    }
  }

  set(x: number, y: number, char: string, foreground: number, background: number) {
    if (x < 0 || y < 0 || x >= this.columns || y >= this.rows) {
      return
    }

    const at = (y * this.columns + x) * 3
    this.words[at] = char.codePointAt(0) ?? 0x20
    this.words[at + 1] = foreground
    this.words[at + 2] = background
  }

  encode(): string {
    const view = new DataView(new ArrayBuffer(this.words.length * 4))
    this.words.forEach((word, index) => view.setUint32(index * 4, word, true))

    return toBase64(new Uint8Array(view.buffer))
  }
}

// One row: text over a left-to-right gradient, the right-hand text flush with the end.
// `glow`, a column, lights the gradient around it: moved each frame, it sweeps along.
export function banner(columns: number, left: string, right: string, glow?: number): string {
  const cells = new Cells(columns, 1)
  const rightStart = columns - right.length

  for (let x = 0; x < columns; x += 1) {
    const gradient = mix(PALETTE.claude, PALETTE.violet, columns === 1 ? 0 : x / (columns - 1))
    const light = glow === undefined ? 0 : Math.max(0, 1 - Math.abs(x - glow) / 6) * 0.45
    const background = mix(gradient, PALETTE.white, light)
    const char = left[x] ?? (x >= rightStart ? right[x - rightStart] : undefined) ?? ' '
    cells.set(x, 0, char, PALETTE.white, background)
  }

  return cells.encode()
}

export type Glyph = { column: number; row: number; char: string; color: number }

// Quarter blocks by which of a cell's four pixels are lit: upper left 1, upper right 2,
// lower left 4, lower right 8.
const QUADRANTS = ' ▘▝▀▖▌▞▛▗▚▐▜▄▙▟█'

// A one-colour picture in quarter blocks: each cell shows 2 by 2 pixels, each half a column wide
// and half a row tall, the way Claude Code draws its own logo. Lit pixels are letters, unlit dots.
export function quarterSprite(
  art: readonly string[],
  color: number,
  glyphs: readonly Glyph[] = [],
): { columns: number; rows: number; cells: string } {
  const columns = Math.ceil(Math.max(...art.map(line => line.length)) / 2)
  const rows = Math.ceil(art.length / 2)
  const cells = new Cells(columns, rows)
  const isLit = (x: number, y: number) => (art[y]?.charAt(x) ?? '.') !== '.' && art[y]?.charAt(x) !== ''

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const [x, y] = [column * 2, row * 2]
      const mask =
        (isLit(x, y) ? 1 : 0) | (isLit(x + 1, y) ? 2 : 0) | (isLit(x, y + 1) ? 4 : 0) | (isLit(x + 1, y + 1) ? 8 : 0)

      if (mask !== 0) {
        cells.set(column, row, QUADRANTS.charAt(mask), color, DEFAULT_COLOR)
      }
    }
  }

  glyphs.forEach(({ column, row, char, color: glyphColor }) => cells.set(column, row, char, glyphColor, DEFAULT_COLOR))

  return { columns, rows, cells: cells.encode() }
}

// The mascot: Claude Code's critter, a fan homage drawn pixel for pixel from the block-character
// logo on its welcome screen (2 by 2 pixels per character, so 18 by 6: 9 columns by 3 rows). It glances about
// and mulls a decision over until a tick or a cross appears in its thought bubble.
const CRITTER = [
  '...OOOOOOOOOOOO...',
  '...OOOOOOOOOOOO...',
  '.OOOOOOOOOOOOOOOO.',
  '...OOOOOOOOOOOO...',
  '....O.O....O.O....',
  '..................',
]

// Its eyes are holes in the head; looking left or right moves them a pixel.
const EYES = { left: [4, 11], ahead: [5, 12], right: [6, 13], shut: [] } as const

// In pixels: the critter sits in the middle, under a row for its thought bubble, with as much
// room on its left as the bubble takes on its right, so centring the picture centres the critter.
const CANVAS = { width: 42, height: 8, headroom: 2, inset: 12 }

// A thought bubble builds up from the head in stages: a dot, a small ring, then the bubble,
// where the decision appears. Cells, clear of the critter.
const BUBBLE_COLOR = 0x9aa0a6
const BUBBLE_STAGES: readonly Glyph[][] = [
  [],
  [{ column: 16, row: 1, char: '·', color: BUBBLE_COLOR }],
  [{ column: 17, row: 0, char: 'o', color: BUBBLE_COLOR }],
  [
    { column: 18, row: 0, char: '(', color: BUBBLE_COLOR },
    { column: 20, row: 0, char: ')', color: BUBBLE_COLOR },
  ],
]
const VERDICTS = {
  approved: { column: 19, row: 0, char: '✓', color: 0x4eba65 },
  rejected: { column: 19, row: 0, char: '✗', color: 0xe5534b },
} as const

type Pose = {
  eyes: keyof typeof EYES
  bubble?: 0 | 1 | 2 | 3
  verdict?: keyof typeof VERDICTS
}

// While Claude works: look about, let a thought slowly form, blink on it, then decide. Twice:
// once a tick, once a cross. Each pose shows for one frame of the pane's animation.
const decision = (verdict: keyof typeof VERDICTS): Pose[] => [
  { eyes: 'ahead' },
  { eyes: 'ahead' },
  { eyes: 'left' },
  { eyes: 'right' },
  { eyes: 'left' },
  { eyes: 'ahead' },
  { eyes: 'ahead', bubble: 1 },
  { eyes: 'ahead', bubble: 1 },
  { eyes: 'ahead', bubble: 2 },
  { eyes: 'ahead', bubble: 2 },
  { eyes: 'ahead', bubble: 3 },
  { eyes: 'shut', bubble: 3 },
  { eyes: 'ahead', bubble: 3 },
  { eyes: 'ahead', bubble: 3, verdict },
  { eyes: 'ahead', bubble: 3, verdict },
  { eyes: 'ahead', bubble: 3, verdict },
  { eyes: 'ahead', bubble: 3, verdict },
]

const WORKING_POSES: readonly Pose[] = [...decision('approved'), ...decision('rejected')]

// While Claude is idle: sit still and blink now and then, sometimes twice.
const IDLE_POSES: readonly Pose[] = [
  ...Array.from({ length: 26 }, (): Pose => ({ eyes: 'ahead' })),
  { eyes: 'shut' },
  ...Array.from({ length: 14 }, (): Pose => ({ eyes: 'ahead' })),
  { eyes: 'shut' },
  { eyes: 'ahead' },
  { eyes: 'shut' },
]

const pose = ({ eyes }: Pose): string[] => {
  const critter = CRITTER.map(line => [...line])

  EYES[eyes].forEach(x => {
    const line = critter[1]

    if (line !== undefined) {
      line[x] = '.'
    }
  })

  const top = CANVAS.headroom
  const canvas = Array.from({ length: CANVAS.height }, () => [...'.'.repeat(CANVAS.width)])
  critter.forEach((line, y) =>
    line.forEach((letter, x) => {
      const row = canvas[top + y]

      if (letter !== '.' && row !== undefined) {
        row[CANVAS.inset + x] = letter
      }
    }),
  )

  return canvas.map(line => line.join(''))
}

const thought = ({ bubble = 0, verdict }: Pose): Glyph[] => [
  ...BUBBLE_STAGES.slice(1, bubble + 1).flat(),
  ...(verdict === undefined ? [] : [VERDICTS[verdict]]),
]

const frames = (poses: readonly Pose[]): readonly string[] =>
  poses.map(one => quarterSprite(pose(one), PALETTE.claude, thought(one)).cells)

export const MASCOT_WORKING_FRAMES = frames(WORKING_POSES)

export const MASCOT_IDLE_FRAMES = frames(IDLE_POSES)

export const MASCOT_SIZE = { columns: CANVAS.width / 2, rows: CANVAS.height / 2 }

