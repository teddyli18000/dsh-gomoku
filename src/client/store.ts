/**
 * Gomoku browser-half store: module-level game/settings state plus the AI
 * move lifecycle. Living outside React means the conversation view can
 * unmount (tab switches) without resetting the game or interrupting an
 * in-flight AI move — the game and AI thinking continue in the background,
 * exactly the plugin's "弹窗关闭不中断对局" contract, now applied to tab
 * switches. The view subscribes via useSyncExternalStore.
 */
import {
  BLACK, BOARD_SIZE, CELL_COUNT, EMPTY, TENGEN, WHITE,
  hasEmpty, isLegalMove, requestAiMove, winsAt,
  type Board, type Cell, type GameMode, type MoveResponse, type Thinking,
} from './game.ts'

/** One entry in the per-move reasoning log. */
export interface ReasoningEntry {
  /** Move number (1-based). */
  n: number
  /** The side the AI played. */
  side: 'black' | 'white'
  /** The chosen intersection as "r,c", or null when the move failed. */
  move: string | null
  /** The model's reasoning text for this attempt. */
  reasoning: string
  /** The failure message when this attempt did not produce a move. */
  error?: string
  /** True when the request was cut off (aborted/timed out) mid-thought. */
  interrupted?: boolean
}

/** The playable game state (board, turn, outcome, log). */
export interface GameState {
  board: Board
  /** Whose turn it is (BLACK opens). */
  turn: Cell
  /** The winning side, or EMPTY while the game runs. */
  winner: Cell | typeof EMPTY
  /** True when the board is full with no winner. */
  draw: boolean
  /** True while an AI move request is in flight. */
  thinking: boolean
  /** True in manual-takeover (pause) mode: AI requests are cut off and the
   *  human plays both sides until the pause is released. */
  paused: boolean
  /** The last played intersection (win-marker highlight). */
  lastMove: { row: number; col: number } | null
  /** The reasoning log, newest last. */
  log: ReasoningEntry[]
  /** Played stones so far (for log labels). */
  moveCount: number
}

/** One provider group from the node half's model catalog. */
export interface ModelGroup {
  provider: string
  displayName: string
  models: { id: string; name: string }[]
}

/** One side's model selection (provider route + model id). */
export interface SideModel {
  provider: string | undefined
  model: string | undefined
}

/** The user-adjustable settings, kept across tab switches. */
export interface SettingsState {
  mode: GameMode
  /** The model used when the AI plays black (white-side human games, both-mode). */
  blackModel: SideModel
  /** The model used when the AI plays white (black-side human games, both-mode). */
  whiteModel: SideModel
  /** The AI thinking level when the AI plays black. */
  blackThinking: Thinking
  /** The AI thinking level when the AI plays white. */
  whiteThinking: Thinking
  /** Fixed per-move deadline; not user-adjustable (see DEFAULT_MOVE_TIMEOUT_MS). */
  moveTimeoutMs: number
  /** Fixed per-move output-token cap; not user-adjustable (see DEFAULT_MAX_MOVE_OUTPUT_TOKENS). */
  maxMoveOutputTokens: number
  /** Black's custom system prompt; undefined uses the node half's default. */
  blackPrompt: string | undefined
  /** White's custom system prompt; undefined uses the node half's default. */
  whitePrompt: string | undefined
  groups: ModelGroup[]
  modelsError: string | undefined
}

/** The fixed per-move deadline in milliseconds (3000 seconds; not user-adjustable). */
export const DEFAULT_MOVE_TIMEOUT_MS = 3_000_000
/** The fixed per-move output-token cap (not user-adjustable). */
export const DEFAULT_MAX_MOVE_OUTPUT_TOKENS = 32_000

/** The whole store snapshot the view subscribes to. */
export interface Snapshot {
  game: GameState
  settings: SettingsState
}

/** A fresh empty board. */
export function emptyBoard(): Board {
  return new Array<Cell>(CELL_COUNT).fill(EMPTY)
}

/** The fresh game state for a new game. */
function freshGame(): GameState {
  return {
    board: emptyBoard(),
    turn: BLACK,
    winner: EMPTY,
    draw: false,
    thinking: false,
    paused: false,
    lastMove: null,
    log: [],
    moveCount: 0,
  }
}

/** The default settings (models fill in from the catalog fetch). */
function freshSettings(): SettingsState {
  return {
    mode: 'black',
    blackModel: { provider: undefined, model: undefined },
    whiteModel: { provider: undefined, model: undefined },
    blackThinking: 'off',
    whiteThinking: 'off',
    moveTimeoutMs: DEFAULT_MOVE_TIMEOUT_MS,
    maxMoveOutputTokens: DEFAULT_MAX_MOVE_OUTPUT_TOKENS,
    blackPrompt: undefined,
    whitePrompt: undefined,
    groups: [],
    modelsError: undefined,
  }
}

let snapshot: Snapshot = { game: freshGame(), settings: freshSettings() }
const listeners = new Set<() => void>()
/** Game generation: bumped on every new game; stale async results are dropped. */
let generation = 0
/** The in-flight move request's abort handle (cancelled on new game / teardown). */
let abort: AbortController | null = null

/** Subscribe to store changes (useSyncExternalStore's subscribe). */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** The current stable snapshot (useSyncExternalStore's getSnapshot). */
export function getSnapshot(): Snapshot {
  return snapshot
}

/** Whether the side belongs to the human in this mode. */
function isHumanTurn(mode: GameMode, turn: Cell): boolean {
  return (mode === 'black' && turn === BLACK) || (mode === 'white' && turn === WHITE)
}

/** Whether the side belongs to the AI in this mode. */
function isAiTurn(mode: GameMode, turn: Cell): boolean {
  return (mode === 'both') || (mode === 'black' && turn === WHITE) || (mode === 'white' && turn === BLACK)
}

/** The AI wire side spelling for a cell color. */
function sideOf(turn: Cell): 'black' | 'white' {
  return turn === BLACK ? 'black' : 'white'
}

/** Whether the game has settled (win or draw). */
function gameOver(game: GameState): boolean {
  return game.winner !== EMPTY || game.draw
}

/** Publish one game state to all subscribers. */
function commitGame(game: GameState): void {
  snapshot = { ...snapshot, game }
  for (const listener of [...listeners]) listener()
}

/** Publish one settings state to all subscribers. */
function commitSettings(settings: SettingsState): void {
  snapshot = { ...snapshot, settings }
  for (const listener of [...listeners]) listener()
}

/**
 * The pure place-transition: put the current turn's stone at (row, col) and
 * advance the game. Returns null when the move is illegal or the game is
 * settled; the caller commits the result. (The thinking flag is NOT a guard
 * here — callers own it; an AI reply arrives while thinking is still set.)
 *
 * Freestyle rules with one house rule: black's opening move (moveCount 0,
 * always black) must land on the tengen (board center) intersection.
 */
function placed(game: GameState, row: number, col: number): GameState | null {
  if (gameOver(game)) return null
  if (!isLegalMove(game.board, row, col)) return null
  if (game.moveCount === 0 && game.turn === BLACK
    && (row !== TENGEN.row || col !== TENGEN.col)) {
    return null
  }
  const board = [...game.board] as Cell[]
  const color = game.turn
  board[row * BOARD_SIZE + col] = color
  const base: GameState = {
    ...game,
    board,
    lastMove: { row, col },
    moveCount: game.moveCount + 1,
    turn: color === BLACK ? WHITE : BLACK,
  }
  if (winsAt(board, row, col)) return { ...base, winner: color }
  if (!hasEmpty(board)) return { ...base, draw: true }
  return base
}

/** Fetch the model catalog once; failures surface in settings.modelsError. */
export function loadModels(): void {
  if (snapshot.settings.groups.length > 0) return
  fetch('/plugins/gomoku/models')
    .then(response => response.json() as Promise<{ groups?: ModelGroup[]; failures?: { provider: string; error: string }[] }>)
    .then((body) => {
      const groups = body.groups ?? []
      const next: SettingsState = { ...snapshot.settings, groups, modelsError: undefined }
      if (groups.length > 0) {
        // Both sides default to the first catalog model; the user can pick
        // per-side models afterwards.
        const first = groups[0]!
        const defaultModel = first.models[0]?.id
        if (next.blackModel.provider === undefined) {
          next.blackModel = { provider: first.provider, model: defaultModel }
        }
        if (next.whiteModel.provider === undefined) {
          next.whiteModel = { provider: first.provider, model: defaultModel }
        }
      }
      commitSettings(next)
    })
    .catch((error: unknown) => {
      if (snapshot.settings.groups.length > 0) return
      commitSettings({ ...snapshot.settings, modelsError: error instanceof Error ? error.message : String(error) })
    })
}

/** Start a new game in the given mode (or the current one), opening with AI when required. */
export function newGame(mode?: GameMode): void {
  generation += 1
  abort?.abort()
  const nextMode = mode ?? snapshot.settings.mode
  commitGame(freshGame())
  if (nextMode === 'white' || nextMode === 'both') scheduleAi()
}

/** Switch the play mode and restart the game in it. */
export function changeMode(mode: GameMode): void {
  if (mode === snapshot.settings.mode) return
  commitSettings({ ...snapshot.settings, mode })
  newGame(mode)
}

/** Human click on an empty intersection. While paused the human may play
 * either side (turn order still alternates, no move-count limit); otherwise
 * only the human's own side accepts clicks. */
export function placeStone(row: number, col: number): void {
  const { game, settings } = snapshot
  if (gameOver(game) || game.thinking) return
  if (!game.paused && !isHumanTurn(settings.mode, game.turn)) return
  const next = placed(game, row, col)
  if (next === null) return
  commitGame(next)
  if (!gameOver(next) && !next.paused && isAiTurn(settings.mode, next.turn)) scheduleAi()
}

/**
 * Toggle manual-takeover (pause) mode. Pausing cuts off any in-flight AI
 * move (the board stays fully playable for both sides, and the interrupted
 * request's catch path only records a log entry — it can never touch the
 * board, because the pause commit already cleared the thinking flag).
 * Releasing the pause hands the turn back to the AI when it is the AI's side.
 */
export function togglePause(): void {
  const { game, settings } = snapshot
  if (gameOver(game)) return
  if (game.paused) {
    commitGame({ ...game, paused: false })
    if (isAiTurn(settings.mode, game.turn)) scheduleAi()
  } else {
    abort?.abort()
    commitGame({ ...game, paused: true, thinking: false })
  }
}

/** Apply one settings patch (model selection, thinking, overrides, prompt). */
export function patchSettings(patch: Partial<SettingsState>): void {
  commitSettings({ ...snapshot.settings, ...patch })
}

/**
 * Retry the current move: re-run the AI move for the side whose last attempt
 * failed (the board is unchanged and it is that side's turn). A no-op while
 * the game is settled, a request is in flight, the game is paused (manual
 * play owns the board), or it is the human's turn (the human can simply
 * click the board).
 */
export function retryMove(): void {
  const { game, settings } = snapshot
  if (gameOver(game) || game.thinking || game.paused) return
  if (!isAiTurn(settings.mode, game.turn)) return
  scheduleAi()
}

/** Max AI attempts per move before the move fails (rejected moves retry). */
const MAX_AI_ATTEMPTS = 3

/** The side model selection for one turn color. */
function sideModelOf(settings: SettingsState, turn: Cell): SideModel {
  return turn === BLACK ? settings.blackModel : settings.whiteModel
}

/** The side thinking level for one turn color. */
function sideThinkingOf(settings: SettingsState, turn: Cell): Thinking {
  return turn === BLACK ? settings.blackThinking : settings.whiteThinking
}

/** The side custom system prompt for one turn color (undefined = node default). */
function sidePromptOf(settings: SettingsState, turn: Cell): string | undefined {
  return turn === BLACK ? settings.blackPrompt : settings.whitePrompt
}

/**
 * How long past the node half's own deadline a request may stay silent
 * before the client declares the thinking interrupted (the node half answers
 * within moveTimeoutMs; only a dropped connection stays silent longer).
 */
const WATCHDOG_MARGIN_MS = 5000

/** Per-request sequence: a settled reply only applies to the request it came from. */
let requestSeq = 0

/** Run one AI move attempt for the current turn of the current game generation. */
function scheduleAi(attempt: number = 1): void {
  const { game, settings } = snapshot
  if (gameOver(game) || game.thinking) return
  const gen = generation
  const turn = game.turn
  const model = sideModelOf(settings, turn)
  if (model.provider === undefined || model.model === undefined) {
    commitGame({
      ...game,
      thinking: false,
      log: [...game.log, {
        n: game.moveCount + 1, side: sideOf(turn), move: null,
        reasoning: '', error: settings.modelsError ?? 'model catalog unavailable',
      }],
    })
    return
  }
  commitGame({ ...game, thinking: true })
  const controller = new AbortController()
  abort = controller
  const seq = ++requestSeq
  // Watchdog: if the request stays silent past the node half's own deadline
  // plus margin, abort it — the catch below then records an interruption
  // instead of leaving the board stuck on "AI 思考中" forever.
  const watchdog = window.setTimeout(() => {
    if (gen === generation && seq === requestSeq) controller.abort()
  }, settings.moveTimeoutMs + WATCHDOG_MARGIN_MS)
  const system = sidePromptOf(settings, turn)
  requestAiMove({
    provider: model.provider,
    model: model.model,
    side: sideOf(turn),
    board: [...game.board],
    thinking: sideThinkingOf(settings, turn),
    moveTimeoutMs: settings.moveTimeoutMs,
    maxMoveOutputTokens: settings.maxMoveOutputTokens,
    ...(system !== undefined ? { system } : {}),
  }, controller.signal)
    .then((reply: MoveResponse) => {
      window.clearTimeout(watchdog)
      if (gen !== generation || seq !== requestSeq) return
      applyAiReply(reply, turn, gen, attempt)
    })
    .catch((error: unknown) => {
      window.clearTimeout(watchdog)
      if (gen !== generation || seq !== requestSeq) return
      const current = snapshot.game
      if (current.turn !== turn) return
      // An aborted request (watchdog or an external abort) is an
      // interruption, not a model failure: the user gets a dedicated status
      // and a retry, and the stale promise can never touch the board.
      if ((error as { name?: string } | null)?.name === 'AbortError') {
        commitGame({
          ...current,
          thinking: false,
          log: [...current.log, {
            n: current.moveCount + 1, side: sideOf(turn), move: null, reasoning: '', interrupted: true,
          }],
        })
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      commitGame({
        ...current,
        thinking: false,
        log: [...current.log, { n: current.moveCount + 1, side: sideOf(turn), move: null, reasoning: '', error: message }],
      })
    })
}

/** Apply one settled AI reply for the turn it was requested for. */
function applyAiReply(reply: MoveResponse, turn: Cell, gen: number, attempt: number): void {
  const { game, settings } = snapshot
  // `thinking` guards stale replies landing after an interruption (the seq
  // guard above already filtered superseded requests).
  if (game.turn !== turn || !game.thinking) return
  if (reply.move !== undefined) {
    const next = placed(game, reply.move.row, reply.move.col)
    if (next !== null) {
      const withLog: GameState = {
        ...next,
        // placed() spreads the in-flight game (thinking still true); the
        // move has now settled, so the flag must drop before commit or the
        // board stays locked on "AI 思考中".
        thinking: false,
        log: [...next.log, {
          n: next.moveCount,
          side: sideOf(turn),
          move: `${reply.move.row},${reply.move.col}`,
          reasoning: reply.reasoning ?? '',
        }],
      }
      commitGame(withLog)
      if (!gameOver(withLog) && isAiTurn(settings.mode, withLog.turn)) {
        window.setTimeout(() => { if (gen === generation) scheduleAi() }, 350)
      }
      return
    }
    // The node half only checks board legality; the client-side house rules
    // (the tengen opening) can still reject a reply, so retry within the
    // attempt budget before failing the move. Clear the thinking flag first
    // so the re-entrant scheduleAi can pass its own in-flight guard.
    if (attempt < MAX_AI_ATTEMPTS) {
      commitGame({ ...game, thinking: false })
      window.setTimeout(() => { if (gen === generation) scheduleAi(attempt + 1) }, 200)
      return
    }
  }
  if (reply.draw === true) {
    commitGame({ ...game, thinking: false, draw: true })
    return
  }
  const error = reply.error ?? 'unknown error'
  commitGame({
    ...game,
    thinking: false,
    log: [...game.log, { n: game.moveCount + 1, side: sideOf(turn), move: null, reasoning: reply.reasoning ?? '', error }],
  })
}
