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
export function banner(columns: number, left: string, right: string): string {
  const cells = new Cells(columns, 1)
  const rightStart = columns - right.length

  for (let x = 0; x < columns; x += 1) {
    const background = mix(PALETTE.claude, PALETTE.violet, columns === 1 ? 0 : x / (columns - 1))
    const char = left[x] ?? (x >= rightStart ? right[x - rightStart] : undefined) ?? ' '
    cells.set(x, 0, char, PALETTE.white, background)
  }

  return cells.encode()
}

// A picture from rows of letters, one letter per pixel; a letter with no colour is left blank.
export function sprite(
  art: readonly string[],
  colors: Readonly<Record<string, number>>,
): { columns: number; rows: number; cells: string } {
  const columns = Math.max(...art.map(line => line.length))
  const rows = Math.ceil(art.length / 2)
  const cells = new Cells(columns, rows)
  const pixel = (x: number, y: number): number | undefined => colors[art[y]?.charAt(x) ?? '']

  for (let row = 0; row < rows; row += 1) {
    for (let x = 0; x < columns; x += 1) {
      const top = pixel(x, row * 2)
      const bottom = pixel(x, row * 2 + 1)

      if (top !== undefined) {
        cells.set(x, row, '▀', top, bottom ?? DEFAULT_COLOR)
      } else if (bottom !== undefined) {
        cells.set(x, row, '▄', bottom, DEFAULT_COLOR)
      }
    }
  }

  return { columns, rows, cells: cells.encode() }
}

// An orange critter glancing over its shoulder while it fills in a clipboard: decisions, made in secret.
const MASCOT_ART = [
  '..........................',
  '....OOOOOOOOOOOO..........',
  '...OOOOOOOOOOOOOO....CCC..',
  '...ODDDOOOODDDOOO..BBBCBBB',
  '...OEWWOOOOEWWOOO.KBPPPPPB',
  '...OOOOOOOOOOOOOO.YBPLLLPB',
  '.DDOOOOOOOOOOOOOOOYBPPPPPB',
  '.DDOOOOOOOOOOOOOOODBPLLPPB',
  '...OOOOOOOOOOOOOO..BPPPPPB',
  '...OOOOOOOOOOOOOO..BPLLLPB',
  '...OOOOOOOOOOOOOO..BPPPPPB',
  '...OOOOOOOOOOOOOO..BBBBBBB',
  '....DD.DD...DD.DD.........',
  '....DD.DD...DD.DD.........',
]

const MASCOT_COLORS: Readonly<Record<string, number>> = {
  O: PALETTE.claude,
  D: 0xb0583a,
  E: 0x1f1f1f,
  W: 0xf4f4f4,
  B: 0x8a5a3b,
  P: 0xeeeeee,
  L: 0x8e959e,
  C: 0xb8bec6,
  Y: 0xe8c547,
  K: 0x3a3a3a,
}

export const MASCOT = sprite(MASCOT_ART, MASCOT_COLORS)
