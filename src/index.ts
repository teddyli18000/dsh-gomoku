/**
 * Gomoku (five-in-a-row) node half for the dsh web GUI. The plugin owns three
 * routes under `/plugins/gomoku`:
 *
 * - `GET  /plugins/gomoku/prompt`  — the default system prompt (game rules,
 *   strict return format, and worked examples). The browser half fetches it to
 *   show and to restore, so the rules text lives in exactly one place.
 * - `GET  /plugins/gomoku/models`  — the model catalog (registered provider
 *   routes and their models) for the side-model selectors.
 * - `POST /plugins/gomoku/move`    — frame the board into a single-shot LLM
 *   request through the chosen provider/model route (optionally with a
 *   thinking level and per-request timeout/token overrides), parse and
 *   validate the reply, and return the chosen intersection plus the model's
 *   reasoning text. Transient stream failures (a dropped connection, a
 *   provider rate limit) retry within the attempt budget before the request
 *   gives up.
 *
 * The board itself (state, turn order, win detection) lives in the browser
 * half; this plugin only arbitrates AI moves, so a malformed or illegal model
 * reply is rejected here and can never corrupt the client-side board.
 *
 * The game is freestyle gomoku (no forbidden moves): black may play double
 * threes, double fours, and overlines freely — any five-in-a-row or longer
 * wins. That rule, the return format, the blocking/attack tactics, and the
 * correct examples are all spelled out in {@link DEFAULT_SYSTEM_PROMPT};
 * users may hand-edit the prompt in the UI, in which case the edited text is
 * sent verbatim as the system prompt.
 * @module @deepseek-ai/dsh-gomoku
 */

import type { IncomingMessage } from 'node:http'
import type { Context } from 'cordis'
import z from 'schemastery'
import { BlockAssembler, ReasoningEffortId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, GenerateOptions, LlmModelInfo, Message } from '@deepseek-ai/dsh-llm'
// Type-only: the ctx.httpServer merge (the webserver host plugin).
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-llm'

/** Cordis plugin name (diagnostics only). */
export const name = 'gomoku'

/** Services required before the board routes can mount. */
export const inject = ['httpServer', 'llm']

/** Board edge length in intersections (standard freestyle gomoku board). */
export const BOARD_SIZE = 15

/** Empty intersection. */
export const EMPTY = 0
/** Black stone (moves first). */
export const BLACK = 1
/** White stone (moves second). */
export const WHITE = 2

/** The side an AI move request plays for. */
export type GomokuSide = 'black' | 'white'

/** The AI thinking level for one move request (wire spelling). */
export type GomokuThinking = 'off' | 'high' | 'max'

/** Required plugin configuration. */
export interface Config {
  /** End-to-end deadline for one AI move attempt, in milliseconds. */
  moveTimeoutMs: number
  /** Output-token cap for one AI move reply. */
  maxMoveOutputTokens: number
  /** Total AI move attempts per request (1 = no retry); the last attempt carries corrective feedback. */
  maxMoveAttempts: number
}

/** Loader schema with deployment defaults (no library defaults). */
export const Config: z<Config> = z.object({
  moveTimeoutMs: z.number().step(1).min(1000).default(30_000),
  // Generous by default: reasoning models count their thinking toward the
  // output budget, and a truncated reply is only salvageable when the JSON
  // itself survives the cut.
  maxMoveOutputTokens: z.number().step(1).min(8).default(8192),
  maxMoveAttempts: z.number().step(1).min(1).max(3).default(3),
})

/** Route prefix owned by this plugin (the browser half calls under it). */
export const GOMOKU_PATH = '/plugins/gomoku'

/** Stable plugin identity stamped into auxiliary LLM request sources. */
const PLUGIN_ID = 'dsh-gomoku'

/**
 * The default system prompt: freestyle (no forbidden moves) gomoku rules,
 * terminology with JSON demonstrations (live twos, threes, fours, five),
 * the strict JSON return format, basic tactics (win now, block fours, block
 * live threes) each with a worked return case, and an explicit wrong
 * example. Users may edit this text in the browser half; the edited text
 * replaces it verbatim per move request.
 */
export const DEFAULT_SYSTEM_PROMPT = [
  '你是五子棋对局引擎（无禁手规则）。请根据给定的棋盘局面，为你的执子方选择一步合法落子，并严格按照规定的 JSON 格式返回。',
  '',
  '# 术语解释（每个概念附一条 JSON 示范；坐标 (r,c) 表示第 r 行第 c 列，即 [r, c]）',
  '- 活二：两子相连，且两端都能继续延伸。',
  '  {"概念": "活二", "示范": "白子 (5,5)(5,6)，(5,4) 与 (5,7) 均为空"}',
  '- 冲三：三子相连，只有一端开口，下一步可成冲四。',
  '  {"概念": "冲三", "示范": "黑子 (3,0)(3,1)(3,2)，仅 (3,3) 一端为空"}',
  '- 活三：三子相连，两端都是空位，下一步可成活四；对手出现活三时，必须立即堵住其中一端。',
  '  {"概念": "活三", "示范": "黑子 (3,3)(3,4)(3,5)，两端 (3,2) 与 (3,6) 均为空", "应对": {"move": [3, 2]}}',
  '- 冲四：四子相连，只有一端开口，下一步即成五；必须立即堵住开口端。',
  '  {"概念": "冲四", "示范": "黑子 (3,3)(3,4)(3,5)(3,6)，(3,2) 已有白子，仅 (3,7) 一端为空", "应对": {"move": [3, 7]}}',
  '- 活四：四子相连，两端都是空位，下一步必成五，无法阻挡。',
  '  {"概念": "活四", "示范": "白子 (7,3)(7,4)(7,5)(7,6)，两端 (7,2) 与 (7,7) 均为空"}',
  '- 五连：任意方向连续 5 颗及以上己方棋子，即获胜（长连同样算赢）。',
  '  {"概念": "五连", "示范": "黑子 (8,5)(8,6)(8,7)(8,8)(8,9) 连成五子，黑方直接获胜"}',
  '',
  '# 棋盘',
  '- 棋盘为 15×15，共 225 个交叉点。行 row 与列 col 均从 0 到 14，坐标写作 [row, col]。',
  '- 棋盘在消息中以 16 行文本给出：第 1 行是列号（0 到 14，与每列对齐），随后 15 行每行以行号开头，后面是该行的 15 个交叉点，每格一个字符：`B` 表示黑子，`W` 表示白子，`·` 表示空交叉点。',
  '- 黑方先手，双方轮流落子；每一步只能落一子，且必须落在空交叉点上。',
  '',
  '# 胜负规则',
  '- 任意一方在横、竖或两条斜线（共 4 个方向）中的任一方向上，率先形成连续 5 颗及以上己方棋子，即获得胜利。',
  '- 本局采用无禁手规则：黑方没有任何落子限制。专业规则中禁止的「双三」「双四」「长连」（连续六子及以上）在本局中全部允许——只要连成五子及以上，无论用什么手段都算赢。',
  '- 棋盘没有空位且无人获胜时为和棋。',
  '',
  '# 基本战术（落子前逐条检查；沿横、竖、两条斜线共 4 个方向分别扫描双方棋型；每条附返回案例）',
  '1. 取胜优先：若本步能直接形成五连（包括把己方四连补成五连），立即落子取胜，不要贪图其他棋型。',
  '   案例：黑方执子，黑方在 (6,6)(6,7)(6,8)(6,9) 已有四连，(6,10) 为空。',
  '   返回：{"move": [6, 10]}',
  '2. 必防冲四：若对手已有四连且只差一子即成五，必须立即堵住其成五点（四连只有一端开口时堵住开口端），否则对手下一步直接获胜。',
  '   案例：白方执子，黑方在 (4,4)(4,5)(4,6)(4,7) 已有四连，(4,3) 已有白子，只剩 (4,8) 一个成五点。',
  '   返回：{"move": [4, 8]}',
  '3. 活三必挡：若对手已形成活三（三连且两端都是空位），必须立即堵住其中一端；否则对手下一步形成两端都能成五的活四，将无法阻止。',
  '   案例：黑方执子，白方在 (7,3)(7,4)(7,5) 连成三子，两端 (7,2) 与 (7,6) 均为空。',
  '   返回：{"move": [7, 2]}',
  '4. 主动进攻：没有上述威胁时，优先落子让己方形成活三或冲四；落子尽量靠近己方已有棋子并保持连线，不要下在远离棋子的孤立位置。',
  '   案例：黑方执子，黑方已有 (5,5)(5,6) 两连，(5,4) 为空，在 (5,4) 落子可形成两端 (5,3)(5,7) 皆空的活三。',
  '   返回：{"move": [5, 4]}',
  '5. 双重威胁：一个落点若能同时形成两个威胁（如双三、四三）应优先选择；防守时若能一子同时堵住对手多个威胁则更佳。',
  '   案例：黑方执子，黑方已有横向 (5,3)(5,4) 与纵向 (3,5)(4,5) 各两连，在 (5,5) 落子可同时形成两个活三（双活三）。',
  '   返回：{"move": [5, 5]}',
  '',
  '# 返回格式（必须严格遵守）',
  '只返回一个 JSON 对象，不要输出任何思考过程、解释、Markdown 代码块或前后缀（思考会占用输出预算，导致回复被截断）：',
  '- 正常落子：{"move": [row, col]}',
  '- 和棋：{"draw": true}',
  '- 局面无法理解：{"error": "一句话说明原因"}',
  '',
  '# 正确案例',
  '示例 1：黑方执子。棋盘上第 7 行第 8 列（row=7, col=8）为空，黑方在此落子即可形成连续五子并获胜。',
  '返回：{"move": [7, 8]}',
  '错误示范（禁止返回）："我认为应该下在这里。{"move": [7, 8]}" —— 带解释的文字不是合法输出。',
  '',
  '# 坐标校验',
  'row 与 col 必须是 0 到 14 的整数，且目标交叉点必须为空；违反任何一条都是非法落子，你会收到纠正提示并重新选择。',
].join('\n')

/** The wire shape of one model group served to the browser half. */
export interface ModelGroupWire {
  /** Provider route key (passed back as the move request's `provider`). */
  provider: string
  /** Human-readable provider name. */
  displayName: string
  /** The provider's selectable models. */
  models: { id: string; name: string }[]
}

/** One provider whose model listing failed (the sound groups still serve). */
export interface ModelFailureWire {
  provider: string
  error: string
}

/** A parsed AI move reply (before board legality is checked). */
export type MoveReply =
  | { kind: 'move'; row: number; col: number }
  | { kind: 'draw' }
  | { kind: 'error'; message: string }
  | { kind: 'invalid'; reason: string }

/** The validated move-request wire body. */
export interface MoveRequestBody {
  /** Registered provider route key. */
  provider: string
  /** Model id the provider accepts. */
  model: string
  /** The side the AI plays in this request. */
  side: GomokuSide
  /** BOARD_SIZE² cells in row-major order: 0 empty, 1 black, 2 white. */
  board: number[]
  /** Custom system prompt; empty or absent falls back to the default. */
  system?: string
  /**
   * AI thinking level; forwarded only when the selected model advertises
   * that effort, otherwise the model's own default applies.
   */
  thinking?: GomokuThinking
  /** Per-request deadline override (milliseconds); absent uses the config default. */
  moveTimeoutMs?: number
  /** Per-request output-token cap override; absent uses the config default. */
  maxMoveOutputTokens?: number
}

/**
 * Whether an intersection is inside the board and currently empty.
 * @param board - row-major cell values (length must be BOARD_SIZE²).
 * @param row - intersection row.
 * @param col - intersection column.
 * @returns true when the move may be played.
 */
export function isLegalMove(board: readonly number[], row: number, col: number): boolean {
  return row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE
    && board[row * BOARD_SIZE + col] === EMPTY
}

/**
 * Render the board as the 16-line labeled text the prompt describes: a
 * column-number header (digits aligned over their columns) followed by one
 * line per row, each prefixed with its row number, one character per
 * intersection.
 * @param board - row-major cell values (length must be BOARD_SIZE²).
 * @returns the labeled board text.
 */
export function boardText(board: readonly number[]): string {
  const lines: string[] = []
  // Three-character columns: header digits right-aligned (so two-digit
  // numbers keep their place), cells rendered as two spaces plus the stone.
  lines.push(`   ${Array.from({ length: BOARD_SIZE }, (_, col) => String(col).padStart(3)).join('')}`)
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    let line = `${String(row).padStart(2)} `
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      const cell = board[row * BOARD_SIZE + col]
      line += `  ${cell === BLACK ? 'B' : cell === WHITE ? 'W' : '·'}`
    }
    lines.push(line)
  }
  return lines.join('\n')
}

/** Tolerant extraction of the JSON object region from a model reply (first `{` … last `}`). */
function jsonObjectRegion(text: string): string | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  return text.slice(start, end + 1)
}

/**
 * Parse and shape-check one model reply into a {@link MoveReply}. The reply
 * may wrap the JSON in prose or a code fence (models do), so the object
 * region is extracted before parsing; the move coordinates themselves are
 * still strictly validated here.
 * @param text - the assembled model reply text.
 * @returns the parsed reply.
 */
export function parseMoveReply(text: string): MoveReply {
  const region = jsonObjectRegion(text)
  if (region === undefined) return { kind: 'invalid', reason: '回复中没有 JSON 对象' }
  let parsed: unknown
  try {
    parsed = JSON.parse(region)
  } catch {
    return { kind: 'invalid', reason: '回复中的 JSON 无法解析' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'invalid', reason: '回复不是 JSON 对象' }
  }
  const value = parsed as Record<string, unknown>
  const error = value.error
  if (typeof error === 'string') return { kind: 'error', message: error }
  if (value.draw === true) return { kind: 'draw' }
  const move = value.move
  if (Array.isArray(move) && move.length === 2
    && Number.isInteger(move[0]) && Number.isInteger(move[1])
    && typeof move[0] === 'number' && typeof move[1] === 'number') {
    const row = move[0]
    const col = move[1]
    if (row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) {
      return { kind: 'invalid', reason: `落子坐标越界：[${row}, ${col}]` }
    }
    return { kind: 'move', row, col }
  }
  return { kind: 'invalid', reason: '缺少合法的 move 字段（应为 [row, col] 整数坐标）' }
}

/** Translate a terminal finish reason into a move failure. */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'stop':
      return undefined
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message) as Error & { code?: string }
      error.code = finish.failure.code
      return error
    }
    case 'max-tokens':
      return new Error('gomoku: AI 回复超过最大输出长度')
    case 'tool-calls':
      return new Error('gomoku: AI 意外请求了工具调用')
    /* v8 ignore next -- closed-union exhaustiveness guard */
    default:
      return new Error(`gomoku: unsupported finish reason "${String((finish as { kind?: unknown }).kind)}"`)
  }
}

/** One attempt's assembled reply, reasoning, and whether the output budget cut it short. */
interface MoveAttemptText {
  /** The model's assembled visible text (may be incomplete). */
  text: string
  /** The model's reasoning/thinking text, when the reply carried any. */
  reasoning: string
  /** True when the stream hit maxMoveOutputTokens (the JSON may still be complete). */
  truncated: boolean
}

/**
 * Failure codes the move loop treats as transient, mirroring the harness's
 * default provider retry policy (dsh-llm retry-policy.ts): a stream that
 * dropped mid-response (e.g. pi-ai's "Stream ended without finish_reason") or
 * a transient provider failure deserves one more attempt before the move
 * request gives up. Auth, validation, and cancellation failures stay fatal.
 */
const RETRYABLE_MOVE_FAILURE_CODES: ReadonlySet<string> = new Set([
  'EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT',
])

/**
 * Whether a thrown move-stream failure is transient and worth one retry.
 * @param error - the error thrown by {@link streamMoveText}.
 * @returns true when the failure carries one of the retryable codes.
 */
export function isRetryableMoveFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && RETRYABLE_MOVE_FAILURE_CODES.has(code)
}

/**
 * Run one AI move attempt: stream the framed board through the chosen
 * provider/model route and assemble the reply text plus any reasoning blocks.
 * The requested thinking level is forwarded only when the selected model
 * advertises that exact effort; an unsupported level falls back to the
 * model's own default instead of failing the attempt.
 * @param ctx - host context exposing the llm service.
 * @param request - the validated move request.
 * @param system - the system prompt for this attempt.
 * @param user - the user message for this attempt.
 * @param maxTokens - the output-token cap for this attempt (per-request override or config default).
 * @param signal - cancellation (request deadline / plugin disposal).
 * @returns the assembled reply text, the reasoning text, and the truncation flag.
 * @throws when the stream fails or the model produced no text at all.
 */
async function streamMoveText(
  ctx: Context,
  request: MoveRequestBody,
  system: string,
  user: Message,
  maxTokens: number,
  signal: AbortSignal,
): Promise<MoveAttemptText> {
  let reasoningEffort: ReasoningEffortId | undefined
  if (request.thinking !== undefined) {
    const info = await ctx.llm.resolveModelInfo(request.provider, request.model, signal)
    if (info.reasoning?.efforts.some(effort => effort.id === request.thinking)) {
      reasoningEffort = ReasoningEffortId(request.thinking)
    }
  }
  const options: GenerateOptions = {
    provider: request.provider,
    model: request.model,
    messages: [user],
    system,
    maxTokens,
    signal,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
  }
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream(options)) {
    signal.throwIfAborted()
    assembler.push(chunk)
  }
  signal.throwIfAborted()
  const truncated = assembler.finish.kind === 'max-tokens'
  // A max-tokens cut is NOT a hard failure: reasoning models spend most of
  // the budget thinking, and the visible text may already hold a complete
  // JSON object — parsing it is the caller's job.
  const terminal = finishError(assembler.finish)
  if (terminal !== undefined && !truncated) throw terminal
  const blocks = assembler.blocks()
  const text = blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join(' ')
    .trim()
  if (text.length === 0 && !truncated) throw new Error('gomoku: AI 没有返回任何内容')
  const reasoning = blocks
    .filter((block): block is Extract<ContentBlock, { type: 'reasoning' }> => block.type === 'reasoning')
    .map(block => block.text)
    .join(' ')
    .trim()
  return { text, reasoning, truncated }
}

/**
 * Validate an untrusted move-request body into a typed request.
 * @param value - the parsed request body.
 * @returns the validated request.
 * @throws {Error} with a user-readable reason on the first invalid field.
 */
export function validateMoveRequest(value: unknown): MoveRequestBody {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('请求体必须是 JSON 对象')
  }
  const candidate = value as Record<string, unknown>
  if (typeof candidate.provider !== 'string' || candidate.provider.length === 0) {
    throw new Error('provider 必须是非空字符串')
  }
  if (typeof candidate.model !== 'string' || candidate.model.length === 0) {
    throw new Error('model 必须是非空字符串')
  }
  if (candidate.side !== 'black' && candidate.side !== 'white') {
    throw new Error('side 必须是 "black" 或 "white"')
  }
  if (candidate.thinking !== undefined && candidate.thinking !== 'off'
    && candidate.thinking !== 'high' && candidate.thinking !== 'max') {
    throw new Error('thinking 必须是 "off"、"high" 或 "max"')
  }
  if (candidate.moveTimeoutMs !== undefined
    && (typeof candidate.moveTimeoutMs !== 'number'
      || !Number.isInteger(candidate.moveTimeoutMs) || candidate.moveTimeoutMs < 1000)) {
    throw new Error('moveTimeoutMs 必须是 >= 1000 的整数毫秒数')
  }
  if (candidate.maxMoveOutputTokens !== undefined
    && (typeof candidate.maxMoveOutputTokens !== 'number'
      || !Number.isInteger(candidate.maxMoveOutputTokens) || candidate.maxMoveOutputTokens < 8)) {
    throw new Error('maxMoveOutputTokens 必须是 >= 8 的整数')
  }
  const board = candidate.board
  if (!Array.isArray(board) || board.length !== BOARD_SIZE * BOARD_SIZE
    || board.some(cell => cell !== EMPTY && cell !== BLACK && cell !== WHITE)) {
    throw new Error(`board 必须是 ${BOARD_SIZE * BOARD_SIZE} 个 0/1/2 组成的数组`)
  }
  const system = candidate.system
  if (system !== undefined && typeof system !== 'string') {
    throw new Error('system 必须是字符串')
  }
  return {
    provider: candidate.provider,
    model: candidate.model,
    side: candidate.side,
    board: board as number[],
    ...(typeof system === 'string' ? { system } : {}),
    ...(candidate.thinking !== undefined ? { thinking: candidate.thinking } : {}),
    ...(candidate.moveTimeoutMs !== undefined ? { moveTimeoutMs: candidate.moveTimeoutMs } : {}),
    ...(candidate.maxMoveOutputTokens !== undefined ? { maxMoveOutputTokens: candidate.maxMoveOutputTokens } : {}),
  }
}

/** Frame the user message for one move attempt (board + side + optional corrective feedback). */
export function buildMoveUserMessage(request: MoveRequestBody, previous: string | undefined, reason: string | undefined): Message {
  const sideLabel = request.side === 'black' ? '黑方' : '白方'
  const lines = [`你执${sideLabel}。当前棋盘（黑=B，白=W，空=·）：`, boardText(request.board), `轮到你（${sideLabel}）落子。请只返回合法的 JSON 落子。`]
  if (previous !== undefined && reason !== undefined) {
    lines.push('', `警告：你上一次的返回不合法（${reason}），完整输出如下：`, previous)
    lines.push('你的上一次落子已被拒绝。请重新观察棋盘，选择另一个未被占用的空交叉点，不要输出任何思考过程或解释，只返回一个合法的 JSON 对象。')
  }
  return createUserMessage({
    content: [{ type: 'text', text: lines.join('\n') }],
    source: { kind: 'plugin', plugin: PLUGIN_ID },
  })
}

/**
 * Mount the gomoku plugin: the three routes plus the move-request lifecycle.
 * @param ctx - host cordis context.
 * @param config - validated loader configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved: Required<Config> = {
    moveTimeoutMs: config.moveTimeoutMs,
    maxMoveOutputTokens: config.maxMoveOutputTokens,
    maxMoveAttempts: config.maxMoveAttempts,
  }

  /** Collect the request body into a parsed JSON value. */
  const readJson = async (req: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const raw = Buffer.concat(chunks).toString('utf8')
    if (raw.length === 0) return {}
    return JSON.parse(raw)
  }

  ctx.effect(() => {
    const dispose = ctx.httpServer.register({
      kind: 'prefix',
      path: GOMOKU_PATH,
      handler: async (req, res) => {
        const writeJson = (status: number, body: unknown): void => {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(body))
        }
        try {
          const url = new URL(req.url ?? '/', 'http://dsh.internal')
          const segments = url.pathname.slice(GOMOKU_PATH.length).split('/').filter(Boolean)
          if (req.method === 'GET' && segments.length === 1 && segments[0] === 'prompt') {
            writeJson(200, { prompt: DEFAULT_SYSTEM_PROMPT })
            return
          }
          if (req.method === 'GET' && segments.length === 1 && segments[0] === 'models') {
            const groups: ModelGroupWire[] = []
            const failures: ModelFailureWire[] = []
            for (const provider of ctx.llm.listProviders()) {
              let models: readonly LlmModelInfo[]
              try {
                models = await ctx.llm.listModels(provider.id)
              } catch (error) {
                failures.push({ provider: provider.id, error: error instanceof Error ? error.message : String(error) })
                continue
              }
              groups.push({
                provider: provider.id,
                displayName: provider.name,
                models: models.map(model => ({ id: model.id, name: model.name })),
              })
            }
            writeJson(200, { groups, failures })
            return
          }
          if (req.method === 'POST' && segments.length === 1 && segments[0] === 'move') {
            const request = validateMoveRequest(await readJson(req))
            // Per-request overrides stand; absent values fall back to the
            // deployment policy from the loader config.
            const effectiveTimeoutMs = request.moveTimeoutMs ?? resolved.moveTimeoutMs
            const effectiveMaxTokens = request.maxMoveOutputTokens ?? resolved.maxMoveOutputTokens
            const controller = new AbortController()
            const timer = setTimeout(
              () => { controller.abort(new Error('gomoku: AI 落子超时')) },
              effectiveTimeoutMs,
            )
            try {
              const system = request.system !== undefined && request.system.trim().length > 0
                ? request.system
                : DEFAULT_SYSTEM_PROMPT
              let lastText: string | undefined
              let lastReason: string | undefined
              let lastReasoning = ''
              for (let attempt = 1; attempt <= resolved.maxMoveAttempts; attempt += 1) {
                const user = buildMoveUserMessage(request, lastText, lastReason)
                let attemptText: MoveAttemptText
                try {
                  attemptText = await streamMoveText(ctx, request, system, user, effectiveMaxTokens, controller.signal)
                } catch (error) {
                  // A transient stream failure (the connection dropped
                  // mid-response, a provider rate limit, ...) is worth one more
                  // attempt — the model never saw a completed reply, so retry
                  // without corrective feedback. The last attempt falls through
                  // to the bounded failure response below instead of a raw 400.
                  if (!isRetryableMoveFailure(error)) throw error
                  lastText = undefined
                  lastReason = error instanceof Error ? error.message : String(error)
                  // A failed stream carries no usable reasoning; drop any
                  // earlier attempt's text so the error response stays honest.
                  lastReasoning = ''
                  ctx.logger.warn('gomoku: transient AI move failure: %s', lastReason)
                  if (attempt < resolved.maxMoveAttempts) continue
                  break
                }
                const text = attemptText.text
                lastReasoning = attemptText.reasoning
                const reply = parseMoveReply(text)
                if (reply.kind === 'move') {
                  if (!isLegalMove(request.board, reply.row, reply.col)) {
                    lastText = text
                    lastReason = `目标交叉点 [${reply.row}, ${reply.col}] 已被占用或越界`
                    continue
                  }
                  writeJson(200, { move: { row: reply.row, col: reply.col }, reasoning: lastReasoning })
                  return
                }
                if (reply.kind === 'draw') {
                  writeJson(200, { draw: true, reasoning: lastReasoning })
                  return
                }
                if (reply.kind === 'error') {
                  writeJson(200, { error: `AI 报告：${reply.message}`, reasoning: lastReasoning })
                  return
                }
                lastText = text
                lastReason = attemptText.truncated
                  ? 'AI 回复被截断（超过最大输出长度），可能未输出完整的 JSON'
                  : reply.reason
              }
              writeJson(200, {
                error: `AI 连续 ${resolved.maxMoveAttempts} 次未能完成落子（最后原因：${lastReason ?? '未知'}）`,
                reasoning: lastReasoning,
              })
            } finally {
              clearTimeout(timer)
            }
            return
          }
          writeJson(404, { error: 'unknown gomoku route' })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          writeJson(400, { error: message })
        }
      },
    })
    return () => { dispose() }
  }, 'gomoku: routes + move lifecycle')
}
