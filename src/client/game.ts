/**
 * Gomoku browser-half game core: pure board state helpers (no React, no
 * services). The board itself (state, turn order, win detection) lives in
 * the browser half per the plugin's architecture; this module is the single
 * source of truth both for rendering and for framing AI move requests.
 */

/** Board edge length in intersections (standard freestyle gomoku board). */
export const BOARD_SIZE = 15

/** Empty intersection. */
export const EMPTY = 0
/** Black stone (moves first). */
export const BLACK = 1
/** White stone (moves second). */
export const WHITE = 2

/** A board cell value. */
export type Cell = typeof EMPTY | typeof BLACK | typeof WHITE

/** The side an AI move request plays for. */
export type GomokuSide = 'black' | 'white'

/** The side the human plays; 'both' means AI vs AI. */
export type GameMode = 'black' | 'white' | 'both'

/** The AI thinking level for one move request (wire spelling). */
export type Thinking = 'off' | 'high' | 'max'

/** A 15×15 board in row-major order. */
export type Board = readonly Cell[]

/** A legal 15×15 board is exactly BOARD_SIZE² cells. */
export const CELL_COUNT = BOARD_SIZE * BOARD_SIZE

/** The board center intersection (天元): black's opening move is pinned here. */
export const TENGEN = { row: 7, col: 7 } as const

/** The AI move request wire body (mirrors the node half's validateMoveRequest). */
export interface MoveRequest {
  /** Registered provider route key. */
  provider: string
  /** Model id the provider accepts. */
  model: string
  /** The side the AI plays in this request. */
  side: GomokuSide
  /** BOARD_SIZE² cells in row-major order: 0 empty, 1 black, 2 white. */
  board: number[]
  /** Custom system prompt; absent falls back to the node half's default. */
  system?: string
  /** AI thinking level; forwarded only when the selected model advertises it. */
  thinking?: Thinking
  /** Per-request deadline override (milliseconds). */
  moveTimeoutMs?: number
  /** Per-request output-token cap override. */
  maxMoveOutputTokens?: number
}

/** The AI move reply wire body (one of move / draw / error). */
export interface MoveResponse {
  /** The chosen intersection, when the AI produced a legal move. */
  move?: { row: number; col: number }
  /** True when the AI declared the game drawn. */
  draw?: boolean
  /** A failure message (validation, AI-reported, or exhausted attempts). */
  error?: string
  /** The model's reasoning text for this attempt, when present. */
  reasoning?: string
}

/**
 * Whether an intersection is inside the board and currently empty.
 * @param board - row-major cell values (length must be CELL_COUNT).
 * @param row - intersection row.
 * @param col - intersection column.
 * @returns true when the move may be played.
 */
export function isLegalMove(board: Board, row: number, col: number): boolean {
  return row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE
    && board[row * BOARD_SIZE + col] === EMPTY
}

/** Whether any empty intersection remains. */
export function hasEmpty(board: Board): boolean {
  return board.includes(EMPTY)
}

/** The four line directions scanned for a win. */
const DIRECTIONS: readonly (readonly [number, number])[] = [
  [0, 1], // horizontal
  [1, 0], // vertical
  [1, 1], // diagonal ↘
  [1, -1], // diagonal ↙
]

/**
 * Whether the stone at (row, col) completes a freestyle win: five or more
 * consecutive stones of the same color along any of the four directions
 * (overlines count — this game has no forbidden moves).
 * @param board - row-major cell values.
 * @param row - the intersection just played.
 * @param col - the intersection just played.
 * @returns true when the placed stone wins the game.
 */
export function winsAt(board: Board, row: number, col: number): boolean {
  const color = board[row * BOARD_SIZE + col]
  if (color === EMPTY) return false
  for (const [dr, dc] of DIRECTIONS) {
    let count = 1
    for (const step of [1, -1]) {
      let r = row + dr * step
      let c = col + dc * step
      while (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE
        && board[r * BOARD_SIZE + c] === color) {
        count += 1
        r += dr * step
        c += dc * step
      }
    }
    if (count >= 5) return true
  }
  return false
}

/**
 * Post one AI move request to the node half's route.
 * @param body - the validated move request.
 * @param signal - optional abort (request teardown).
 * @returns the parsed reply.
 * @throws {Error} with the node half's error message on a non-OK status.
 */
export async function requestAiMove(body: MoveRequest, signal?: AbortSignal): Promise<MoveResponse> {
  const response = await fetch('/plugins/gomoku/move', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  const parsed = await response.json() as MoveResponse
  if (!response.ok) {
    throw new Error(typeof parsed.error === 'string' ? parsed.error : `gomoku: HTTP ${response.status}`)
  }
  return parsed
}
