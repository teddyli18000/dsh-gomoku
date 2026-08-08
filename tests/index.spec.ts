import { describe, expect, it } from 'vitest'
import {
  BLACK, BOARD_SIZE, DEFAULT_SYSTEM_PROMPT, EMPTY, GOMOKU_PATH, WHITE,
  boardText, buildMoveUserMessage, isLegalMove, isRetryableMoveFailure, parseMoveReply, validateMoveRequest,
} from '../src/index.ts'

const emptyBoard = (): number[] => new Array<number>(BOARD_SIZE * BOARD_SIZE).fill(EMPTY)

describe('boardText', () => {
  it('renders an empty board as a column header plus 15 labeled rows', () => {
    const text = boardText(emptyBoard())
    const lines = text.split('\n')
    expect(lines).toHaveLength(16)
    expect(lines[0]).toBe('     0  1  2  3  4  5  6  7  8  9 10 11 12 13 14')
    expect(lines[1]).toBe(` 0 ${'  ·'.repeat(BOARD_SIZE)}`)
    expect(lines[15]).toBe(`14 ${'  ·'.repeat(BOARD_SIZE)}`)
  })

  it('renders black and white stones with B and W', () => {
    const board = emptyBoard()
    board[0] = BLACK
    board[1 * BOARD_SIZE + 2] = WHITE
    const lines = boardText(board).split('\n')
    expect(lines[1]!.startsWith(' 0   B')).toBe(true)
    expect(lines[2]!.startsWith(' 1   ·  ·  W')).toBe(true)
  })
})

describe('isLegalMove', () => {
  it('accepts an empty in-bounds intersection', () => {
    expect(isLegalMove(emptyBoard(), 0, 0)).toBe(true)
    expect(isLegalMove(emptyBoard(), 14, 14)).toBe(true)
    expect(isLegalMove(emptyBoard(), 7, 7)).toBe(true)
  })

  it('rejects out-of-bounds intersections', () => {
    expect(isLegalMove(emptyBoard(), -1, 0)).toBe(false)
    expect(isLegalMove(emptyBoard(), 0, 15)).toBe(false)
    expect(isLegalMove(emptyBoard(), 15, 0)).toBe(false)
    expect(isLegalMove(emptyBoard(), 0, -1)).toBe(false)
  })

  it('rejects occupied intersections', () => {
    const board = emptyBoard()
    board[3 * BOARD_SIZE + 4] = BLACK
    expect(isLegalMove(board, 3, 4)).toBe(false)
  })
})

describe('parseMoveReply', () => {
  it('accepts a clean move object', () => {
    expect(parseMoveReply('{"move": [7, 8]}')).toEqual({ kind: 'move', row: 7, col: 8 })
  })

  it('accepts a move wrapped in prose and a code fence', () => {
    expect(parseMoveReply('我认为应该下在这里。```json\n{"move": [3, 4]}\n```')).toEqual({ kind: 'move', row: 3, col: 4 })
  })

  it('accepts the draw reply', () => {
    expect(parseMoveReply('{"draw": true}')).toEqual({ kind: 'draw' })
  })

  it('passes through a model-reported error', () => {
    expect(parseMoveReply('{"error": "局面无法理解"}')).toEqual({ kind: 'error', message: '局面无法理解' })
  })

  it('rejects out-of-bounds coordinates', () => {
    const reply = parseMoveReply('{"move": [15, 0]}')
    expect(reply.kind).toBe('invalid')
    if (reply.kind === 'invalid') expect(reply.reason).toContain('越界')
    const negative = parseMoveReply('{"move": [-1, 0]}')
    expect(negative.kind).toBe('invalid')
    if (negative.kind === 'invalid') expect(negative.reason).toContain('越界')
  })

  it('rejects malformed payloads', () => {
    const expectations: [string, string][] = [
      ['no json here', 'JSON 对象'],
      ['{"move": [1]}', 'move'],
      ['{"move": [1.5, 2]}', 'move'],
      ['{"move": "7,8"}', 'move'],
      ['{not json}', '无法解析'],
      ['[1, 2]', 'JSON 对象'],
    ]
    for (const [text, reason] of expectations) {
      const reply = parseMoveReply(text)
      expect(reply.kind).toBe('invalid')
      if (reply.kind === 'invalid') expect(reply.reason).toContain(reason)
    }
  })
})

describe('validateMoveRequest', () => {
  it('accepts a well-formed request', () => {
    const board = emptyBoard()
    expect(validateMoveRequest({ provider: 'deepseek-official', model: 'deepseek-v4-flash', side: 'black', board }))
      .toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-flash', side: 'black', board })
    expect(validateMoveRequest({ provider: 'p', model: 'm', side: 'white', board, system: '' }))
      .toMatchObject({ side: 'white', system: '' })
  })

  it('rejects non-object bodies', () => {
    expect(() => validateMoveRequest(null)).toThrow(/JSON 对象/)
    expect(() => validateMoveRequest([1])).toThrow(/JSON 对象/)
  })

  it('rejects missing or empty provider/model', () => {
    expect(() => validateMoveRequest({ model: 'm', side: 'black', board: emptyBoard() })).toThrow(/provider/)
    expect(() => validateMoveRequest({ provider: '', model: 'm', side: 'black', board: emptyBoard() })).toThrow(/provider/)
    expect(() => validateMoveRequest({ provider: 'p', side: 'black', board: emptyBoard() })).toThrow(/model/)
  })

  it('rejects invalid sides', () => {
    expect(() => validateMoveRequest({ provider: 'p', model: 'm', side: 'grey', board: emptyBoard() })).toThrow(/side/)
  })

  it('accepts an optional thinking level', () => {
    const board = emptyBoard()
    expect(validateMoveRequest({ provider: 'p', model: 'm', side: 'black', board, thinking: 'max' }))
      .toMatchObject({ thinking: 'max' })
    expect(validateMoveRequest({ provider: 'p', model: 'm', side: 'black', board }))
      .not.toHaveProperty('thinking')
  })

  it('rejects invalid thinking levels', () => {
    expect(() => validateMoveRequest({ provider: 'p', model: 'm', side: 'black', board: emptyBoard(), thinking: 'ultra' }))
      .toThrow(/thinking/)
    expect(() => validateMoveRequest({ provider: 'p', model: 'm', side: 'black', board: emptyBoard(), thinking: 3 }))
      .toThrow(/thinking/)
  })

  it('accepts per-request timeout and token overrides', () => {
    const board = emptyBoard()
    expect(validateMoveRequest({ provider: 'p', model: 'm', side: 'black', board, moveTimeoutMs: 45_000, maxMoveOutputTokens: 2048 }))
      .toMatchObject({ moveTimeoutMs: 45_000, maxMoveOutputTokens: 2048 })
    expect(validateMoveRequest({ provider: 'p', model: 'm', side: 'black', board }))
      .not.toHaveProperty('moveTimeoutMs')
  })

  it('rejects invalid timeout and token overrides', () => {
    expect(() => validateMoveRequest({ provider: 'p', model: 'm', side: 'black', board: emptyBoard(), moveTimeoutMs: 999 }))
      .toThrow(/moveTimeoutMs/)
    expect(() => validateMoveRequest({ provider: 'p', model: 'm', side: 'black', board: emptyBoard(), moveTimeoutMs: 1.5 }))
      .toThrow(/moveTimeoutMs/)
    expect(() => validateMoveRequest({ provider: 'p', model: 'm', side: 'black', board: emptyBoard(), maxMoveOutputTokens: 7 }))
      .toThrow(/maxMoveOutputTokens/)
    expect(() => validateMoveRequest({ provider: 'p', model: 'm', side: 'black', board: emptyBoard(), maxMoveOutputTokens: 'many' }))
      .toThrow(/maxMoveOutputTokens/)
  })

  it('rejects malformed boards', () => {
    expect(() => validateMoveRequest({ provider: 'p', model: 'm', side: 'black', board: [] })).toThrow(/board/)
    const short = emptyBoard().slice(0, 100)
    expect(() => validateMoveRequest({ provider: 'p', model: 'm', side: 'black', board: short })).toThrow(/board/)
    const bad = emptyBoard()
    bad[0] = 9
    expect(() => validateMoveRequest({ provider: 'p', model: 'm', side: 'black', board: bad })).toThrow(/board/)
  })

  it('rejects non-string system prompts', () => {
    expect(() => validateMoveRequest({ provider: 'p', model: 'm', side: 'black', board: emptyBoard(), system: 3 }))
      .toThrow(/system/)
  })
})

describe('buildMoveUserMessage', () => {
  it('frames side, labeled board, and turn for the model', () => {
    const request = { provider: 'p', model: 'm', side: 'black' as const, board: emptyBoard() }
    const message = buildMoveUserMessage(request, undefined, undefined)
    expect(message.role).toBe('user')
    const text = (message.content[0] as { type: 'text'; text: string }).text
    expect(text).toContain('你执黑方')
    expect(text).toContain('     0  1  2  3  4  5  6  7  8  9 10 11 12 13 14')
    expect(text).toContain(` 0 ${'  ·'.repeat(BOARD_SIZE)}`)
    expect(text).toContain('轮到你（黑方）落子')
  })

  it('appends corrective feedback on a retry', () => {
    const request = { provider: 'p', model: 'm', side: 'white' as const, board: emptyBoard() }
    const message = buildMoveUserMessage(request, '{"move": [99, 0]}', '落子坐标越界：[99, 0]')
    const text = (message.content[0] as { type: 'text'; text: string }).text
    expect(text).toContain('你上一次的返回不合法（落子坐标越界：[99, 0]）')
    expect(text).toContain('{"move": [99, 0]}')
  })
})

describe('default system prompt', () => {
  it('states terminology, blocking tactics with return cases, the strict format, and worked examples', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain('无禁手')
    expect(DEFAULT_SYSTEM_PROMPT).toContain('长连')
    expect(DEFAULT_SYSTEM_PROMPT).toContain('{"move": [row, col]}')
    expect(DEFAULT_SYSTEM_PROMPT).toContain('{"move": [7, 8]}')
    expect(DEFAULT_SYSTEM_PROMPT).toContain('{"draw": true}')
    expect(DEFAULT_SYSTEM_PROMPT).toContain('只返回一个 JSON 对象')
    expect(DEFAULT_SYSTEM_PROMPT).toContain('15×15')
    expect(DEFAULT_SYSTEM_PROMPT).toContain('术语解释')
    expect(DEFAULT_SYSTEM_PROMPT).toContain('活二')
    expect(DEFAULT_SYSTEM_PROMPT).toContain('活三')
    expect(DEFAULT_SYSTEM_PROMPT).toContain('活四')
    expect(DEFAULT_SYSTEM_PROMPT).toContain('冲四')
    expect(DEFAULT_SYSTEM_PROMPT).toContain('取胜优先')
    expect(DEFAULT_SYSTEM_PROMPT).toContain('双活三')
    expect(DEFAULT_SYSTEM_PROMPT).toContain('{"move": [6, 10]}')
    expect(DEFAULT_SYSTEM_PROMPT).toContain('{"move": [4, 8]}')
    expect(DEFAULT_SYSTEM_PROMPT).toContain('{"move": [3, 7]}')
    expect(DEFAULT_SYSTEM_PROMPT).toContain('{"move": [7, 2]}')
    expect(DEFAULT_SYSTEM_PROMPT).toContain('{"move": [5, 4]}')
    expect(DEFAULT_SYSTEM_PROMPT).toContain('{"move": [5, 5]}')
  })
})

describe('route constants', () => {
  it('keeps the route prefix stable for the browser half', () => {
    expect(GOMOKU_PATH).toBe('/plugins/gomoku')
  })
})

describe('isRetryableMoveFailure', () => {
  it('treats the harness transient failure codes as retryable', () => {
    for (const code of ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']) {
      const error = new Error('boom') as Error & { code?: string }
      error.code = code
      expect(isRetryableMoveFailure(error)).toBe(true)
    }
  })

  it('treats fatal, unknown, and codeless failures as non-retryable', () => {
    for (const code of ['AUTH', 'ABORTED', 'STREAM_CLOSED', 'NO_ADAPTER', 'INVALID_REQUEST', 'UNKNOWN']) {
      const error = new Error('boom') as Error & { code?: string }
      error.code = code
      expect(isRetryableMoveFailure(error)).toBe(false)
    }
    expect(isRetryableMoveFailure(new Error('no code'))).toBe(false)
    expect(isRetryableMoveFailure(null)).toBe(false)
    expect(isRetryableMoveFailure('string')).toBe(false)
  })
})
