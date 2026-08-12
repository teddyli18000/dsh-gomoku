// Quick logic verification for the gomoku browser store: tengen opening rule,
// per-side models, and AI retry on rejected moves. Run with plain node (type
// stripping) from the package root.
import { pathToFileURL } from 'node:url'

const settle = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms))

// Browser-ish globals the store touches.
globalThis.window = { setTimeout: (fn) => setTimeout(fn, 0), clearTimeout: (id) => clearTimeout(id) }

const store = await import(pathToFileURL('/Users/yejiming/Desktop/OpenSource/dsh-gomoku/src/client/store.ts').href)
const game = await import(pathToFileURL('/Users/yejiming/Desktop/OpenSource/dsh-gomoku/src/client/game.ts').href)

let failures = 0
const check = (label, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) failures += 1
}

// --- tengen opening rule (human black) ---
store.newGame('black')
check('opening is black turn', store.getSnapshot().game.turn === game.BLACK)
store.placeStone(0, 0)
check('non-tengen opening rejected (moveCount 0)', store.getSnapshot().game.moveCount === 0)
store.placeStone(7, 7)
check('tengen opening accepted', store.getSnapshot().game.moveCount === 1 && store.getSnapshot().game.board[7 * 15 + 7] === game.BLACK)

// --- per-side model selection: AI white uses whiteModel ---
let lastRequest = null
let aiMoveIndex = 0
globalThis.fetch = async (_url, options) => {
  lastRequest = JSON.parse(options.body)
  // Each reply lands on a fresh empty spot: (8,8), (9,9), (10,10), ...
  const n = aiMoveIndex++
  return { ok: true, status: 200, json: async () => ({ move: { row: 8 + n, col: 8 + n }, reasoning: 'test' }) }
}
store.patchSettings({
  whiteModel: { provider: 'prov-w', model: 'model-w' },
  blackModel: { provider: 'prov-b', model: 'model-b' },
  blackThinking: 'max',
  whiteThinking: 'high',
  blackPrompt: 'black-side prompt',
  whitePrompt: 'white-side prompt',
})
store.newGame('black')
store.placeStone(7, 7) // human black tengen → AI white moves next
await settle()
check('AI white requested with whiteModel', lastRequest?.provider === 'prov-w' && lastRequest?.model === 'model-w' && lastRequest?.side === 'white')
check('AI white request uses whiteThinking', lastRequest?.thinking === 'high')
check('AI white request uses whitePrompt', lastRequest?.system === 'white-side prompt')
check('AI white move placed', store.getSnapshot().game.moveCount === 2)
check('thinking cleared after AI move', store.getSnapshot().game.thinking === false)
store.placeStone(6, 6) // human black's next move must be accepted
check('human can move right after AI move', store.getSnapshot().game.moveCount === 3 && store.getSnapshot().game.board[6 * 15 + 6] === game.BLACK)
check('AI thinking in flight after human move (AI white next)', store.getSnapshot().game.thinking === true)
await settle()
check('thinking cleared after the follow-up AI move', store.getSnapshot().game.moveCount === 4 && store.getSnapshot().game.thinking === false)

// --- AI black opening must land on tengen; a wrong reply retries then fails ---
store.changeMode('white') // human plays white; AI opens as black
check('AI black opening request uses blackModel', lastRequest?.provider === 'prov-b' && lastRequest?.model === 'model-b' && lastRequest?.side === 'black')
check('AI black opening request uses blackThinking', lastRequest?.thinking === 'max')
check('AI black opening request uses blackPrompt', lastRequest?.system === 'black-side prompt')
await settle(120) // the stub replies (8,8) forever → MAX_AI_ATTEMPTS retries then failure
const snapshot = store.getSnapshot()
check('AI opening move rejected (tengen rule) after retries', snapshot.game.moveCount === 0)
check('failure logged after attempt budget', snapshot.game.log.some(e => e.error !== undefined))

// --- retryMove after a failed move: a corrected reply lands the move ---
globalThis.fetch = async (_url, options) => {
  lastRequest = JSON.parse(options.body)
  return { ok: true, status: 200, json: async () => ({ move: { row: 7, col: 7 }, reasoning: 'retry ok' }) }
}
store.retryMove()
check('retryMove starts a request for the failed side', store.getSnapshot().game.thinking === true && lastRequest?.side === 'black')
await settle()
check('retryMove lands the move and clears thinking', store.getSnapshot().game.moveCount === 1 && store.getSnapshot().game.thinking === false)
store.retryMove()
check('retryMove is a no-op on the human turn', store.getSnapshot().game.thinking === false && store.getSnapshot().game.moveCount === 1)

// --- a tengen reply succeeds ---
globalThis.fetch = async (_url, options) => {
  lastRequest = JSON.parse(options.body)
  const n = aiMoveIndex++
  return { ok: true, status: 200, json: async () => ({ move: { row: 7, col: 7 }, reasoning: '' }) }
}
store.changeMode('white')
await settle()
check('AI tengen opening accepted', store.getSnapshot().game.moveCount === 1 && store.getSnapshot().game.board[7 * 15 + 7] === game.BLACK)
check('thinking cleared after AI tengen opening', store.getSnapshot().game.thinking === false)

// --- interruption: the request aborts (AbortError) mid-thought ---
globalThis.fetch = async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }) }
store.changeMode('both') // AI black opens → the request is cut off
await settle()
{
  const s = store.getSnapshot().game
  check('aborted request → interrupted state (no thinking lock)', s.thinking === false && s.log.at(-1)?.interrupted === true)
  check('interrupted entry carries no move', s.log.at(-1)?.move === null)
}
store.retryMove() // black is the AI side in both mode → retry fires
check('retry after interruption starts a new request', store.getSnapshot().game.thinking === true)

// --- watchdog: a request that never settles is declared interrupted ---
globalThis.fetch = (_url, options) => new Promise((_, reject) => {
  options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
})
store.patchSettings({ moveTimeoutMs: 1000 })
store.changeMode('both') // new game; the request hangs → watchdog aborts at ~6s
await settle(8000)
{
  const s = store.getSnapshot().game
  check('hung request → watchdog declares interruption', s.thinking === false && s.log.at(-1)?.interrupted === true)
}
// a reply to the interrupted request must be ignored; a fresh retry lands.
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ move: { row: 7, col: 7 }, reasoning: '' }) })
store.patchSettings({ moveTimeoutMs: 30000 })
store.retryMove()
await settle()
check('retry after watchdog interruption lands the move', store.getSnapshot().game.moveCount === 1 && store.getSnapshot().game.thinking === false)

process.exit(failures === 0 ? 0 : 1)
