/**
 * The gomoku conversation view: the board tab content. Three columns —
 * black's AI panel (model, thinking level, always-editable prompt, black
 * reasoning log) on the left, the board with the mode / new-game controls
 * below it in the middle, and white's AI panel on the right. Rendered inside
 * the conversation view ring (the same slot Trajectory occupies),
 * one-at-a-time by the session body — so the component unmounts on tab
 * switches and the game state lives in the module-level store (see store.ts),
 * never here.
 *
 * While this view is active the composer seat is hidden: the view marks the
 * document root with a class on mount and the stylesheet hides the
 * platform's composer seat (`[data-composer-seat]`) under it.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-conversation view-slot declaration (register name)
// and the framework-standard view props (ConvViewProps) into this program.
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { NS, type GomokuKey } from './locales.ts'
import {
  BLACK, BOARD_SIZE, EMPTY, TENGEN, WHITE,
  type Cell, type GameMode, type Thinking,
} from './game.ts'
import {
  changeMode, getSnapshot, loadModels, newGame, patchSettings, placeStone, retryMove, subscribe, togglePause,
  type GameState, type ModelGroup, type ReasoningEntry, type SideModel,
} from './store.ts'
import css from './Gomoku.module.css'

/** The board tab's full component props: the framework view seat + the locale seat. */
export type GomokuViewProps = ConvViewProps & PropsLocale<'gomoku'>

const MODES: readonly { value: GameMode; key: GomokuKey }[] = [
  { value: 'black', key: 'mode.black' },
  { value: 'white', key: 'mode.white' },
  { value: 'both', key: 'mode.both' },
]

const THINKINGS: readonly { value: Thinking; key: GomokuKey }[] = [
  { value: 'off', key: 'thinking.off' },
  { value: 'high', key: 'thinking.high' },
  { value: 'max', key: 'thinking.max' },
]

/**
 * The five star points of a 15×15 board (row-major indices): the four corner
 * hoshi plus tengen. Drawn while the intersection is still empty.
 */
const HOSHI: ReadonlySet<number> = new Set([
  3 * BOARD_SIZE + 3, 3 * BOARD_SIZE + 11,
  11 * BOARD_SIZE + 3, 11 * BOARD_SIZE + 11,
  TENGEN.row * BOARD_SIZE + TENGEN.col,
])

/** The status line copy for the current game. */
function statusCopy(game: GameState, t: PropsLocale<'gomoku'>['t']): { text: string; error: boolean } {
  if (game.winner === BLACK) return { text: t('status.win.black'), error: false }
  if (game.winner === WHITE) return { text: t('status.win.white'), error: false }
  if (game.draw) return { text: t('status.draw'), error: false }
  if (game.paused) return { text: t('status.paused'), error: false }
  if (game.thinking) return { text: t('status.thinking'), error: false }
  const last = game.log[game.log.length - 1]
  if (last?.interrupted === true) return { text: t('status.interrupted'), error: true }
  if (last?.error !== undefined) return { text: t('status.error', { message: last.error }), error: true }
  return {
    text: game.turn === BLACK ? t('status.turn.black') : t('status.turn.white'),
    error: false,
  }
}

/** One intersection: clickable when it is the human's turn. */
function CellButton({
  row, col, cell, last, playable, preview, onClick,
}: {
  row: number
  col: number
  cell: Cell
  last: boolean
  playable: boolean
  /** The stone color shown as a ghost on hover (the side about to move). */
  preview: Cell
  onClick: (row: number, col: number) => void
}) {
  const index = row * BOARD_SIZE + col
  return (
    <button
      type="button"
      className={css.cell}
      disabled={!playable}
      aria-label={`${row},${col}`}
      title={`${row},${col}`}
      onClick={() => onClick(row, col)}
    >
      {cell !== EMPTY && <span className={`${css.stone} ${cell === BLACK ? css.stoneBlack : css.stoneWhite}${last ? ` ${css.lastMove}` : ''}`} />}
      {cell === EMPTY && playable && preview !== EMPTY && <span className={`${css.stone} ${preview === BLACK ? css.stoneBlack : css.stoneWhite} ${css.preview}`} />}
      {cell === EMPTY && HOSHI.has(index) && <span className={css.hoshi} />}
    </button>
  )
}

/** One per-side model selector. */
function ModelSelect({
  label, value, groups, onChange,
}: {
  label: string
  value: SideModel
  groups: readonly ModelGroup[]
  onChange: (model: SideModel) => void
}) {
  const selected = value.provider !== undefined && value.model !== undefined
    ? `${value.provider}/${value.model}`
    : ''
  return (
    <label className={css.field}>
      <span className={css.label}>{label}</span>
      <select
        className={css.select}
        value={selected}
        onChange={(event) => {
          const [provider, ...rest] = event.target.value.split('/')
          onChange({ provider, model: rest.join('/') })
        }}
        disabled={groups.length === 0}
      >
        {groups.length === 0 && <option value="">—</option>}
        {groups.map(group => (
          <optgroup key={group.provider} label={group.displayName}>
            {group.models.map(model => (
              <option key={model.id} value={`${group.provider}/${model.id}`}>{model.name}</option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  )
}

/**
 * One side's always-visible system-prompt editor. Starts from the stored
 * value (or the node half's default once loaded, when nothing is stored),
 * and saves back through the store — undefined restores the default prompt.
 */
function PromptEditor({
  label, value, onSave, t,
}: {
  label: string
  value: string | undefined
  onSave: (prompt: string | undefined) => void
  t: PropsLocale<'gomoku'>['t']
}) {
  const [text, setText] = useState(value ?? '')
  const [defaultPrompt, setDefaultPrompt] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [saved, setSaved] = useState(false)
  const savedTimer = useRef<number | undefined>(undefined)

  // Load the node half's default prompt once, for the restore button and to
  // show what the model actually receives when no custom prompt is stored.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch('/plugins/gomoku/prompt')
      .then(response => response.json() as Promise<{ prompt?: string }>)
      .then((body) => {
        if (cancelled || body.prompt === undefined) return
        setDefaultPrompt(body.prompt)
        if (value === undefined && text === '') setText(body.prompt)
      })
      .catch(() => { /* the editor stays usable; save still works */ })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
    // Fetch-and-fill runs once per mount; the store value is the source on remounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => () => { window.clearTimeout(savedTimer.current) }, [])

  const flashSaved = (): void => {
    setSaved(true)
    window.clearTimeout(savedTimer.current)
    savedTimer.current = window.setTimeout(() => setSaved(false), 1500)
  }

  return (
    <div className={css.promptArea}>
      <div className={css.promptTitle}>{label}</div>
      {loading && <div className={css.hint}>{t('panel.prompt.loading')}</div>}
      <textarea
        className={css.promptTextarea}
        value={text}
        rows={7}
        spellCheck={false}
        onChange={(event) => setText(event.target.value)}
      />
      <div className={css.promptActions}>
        <button type="button" className={css.ghost} onClick={() => {
          setText(defaultPrompt ?? '')
          onSave(undefined)
        }}>
          {t('panel.prompt.restore')}
        </button>
        <button type="button" className={css.primary} onClick={() => {
          onSave(text.trim().length > 0 ? text : undefined)
          flashSaved()
        }}>
          {t('panel.prompt.save')}
        </button>
        {saved && <span className={css.flash}>{t('panel.prompt.saved')}</span>}
      </div>
    </div>
  )
}

/**
 * One side's AI panel: the model selector, the side's thinking level, the
 * side's always-editable system prompt, and that side's reasoning log
 * (entries default collapsed; click to expand).
 */
function SidePanel({
  title, stone, modelLabel, promptLabel, logTitle, model, thinking, prompt, groups, log, expanded, t,
  onModelChange, onThinkingChange, onPromptSave, onToggleEntry,
}: {
  title: string
  stone: 'black' | 'white'
  modelLabel: string
  promptLabel: string
  logTitle: string
  model: SideModel
  thinking: Thinking
  prompt: string | undefined
  groups: readonly ModelGroup[]
  log: readonly ReasoningEntry[]
  expanded: ReadonlySet<number>
  t: PropsLocale<'gomoku'>['t']
  onModelChange: (model: SideModel) => void
  onThinkingChange: (thinking: Thinking) => void
  onPromptSave: (prompt: string | undefined) => void
  onToggleEntry: (n: number) => void
}) {
  return (
    <div className={css.sidePanel}>
      <div className={css.panelTitle}>
        <span className={`${css.titleStone} ${stone === 'black' ? css.titleStoneBlack : css.titleStoneWhite}`} />
        {title}
      </div>

      <ModelSelect
        label={modelLabel}
        value={model}
        groups={groups}
        onChange={onModelChange}
      />

      <div className={css.toolbar}>
        <span className={css.label}>{t('panel.thinking')}</span>
        <div className={css.segmented} role="group" aria-label={t('panel.thinking')}>
          {THINKINGS.map(level => (
            <button
              key={level.value}
              type="button"
              className={`${css.segButton}${thinking === level.value ? ` ${css.segActive}` : ''}`}
              onClick={() => onThinkingChange(level.value)}
            >
              {t(level.key)}
            </button>
          ))}
        </div>
      </div>

      <PromptEditor label={promptLabel} value={prompt} onSave={onPromptSave} t={t} />

      <div className={css.reasoningList}>
        <div className={css.reasoningTitle}>{logTitle}</div>
        {log.length === 0 && <div className={css.hint}>{t('reasoning.empty')}</div>}
        {log.map(entry => {
          const isExpanded = expanded.has(entry.n)
          return (
            <div key={entry.n} className={css.reasoningItem}>
              <button
                type="button"
                className={css.reasoningHeader}
                aria-expanded={isExpanded}
                aria-label={isExpanded ? t('reasoning.collapse') : t('reasoning.expand')}
                onClick={() => onToggleEntry(entry.n)}
              >
                <span className={`${css.chevron}${isExpanded ? ` ${css.chevronOpen}` : ''}`}>▸</span>
                <span className={css.reasoningMove}>
                  {t('reasoning.move', { n: entry.n })}
                  {entry.move !== null && <span className={css.reasoningCoord}>{entry.move}</span>}
                </span>
                {entry.interrupted === true && <span className={css.errorText}>{t('status.interrupted')}</span>}
                {entry.error !== undefined && entry.interrupted !== true && <span className={css.errorText}>{entry.error}</span>}
              </button>
              {isExpanded && entry.reasoning !== '' && (
                <pre className={css.reasoningText}>{entry.reasoning}</pre>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** The gomoku view tab body. */
export function GomokuView({ t }: GomokuViewProps) {
  const { game, settings } = useSyncExternalStore(subscribe, getSnapshot)
  // Reasoning log entries start collapsed; clicking a header expands it.
  // Keyed by move number (unique per side), so black and white panels share
  // one set while each shows only its own entries.
  const [expandedEntries, setExpandedEntries] = useState<ReadonlySet<number>>(new Set())

  // The catalog is needed the moment a game starts; retried on remount only
  // when a previous attempt failed (loadModels is idempotent on success).
  useEffect(() => { loadModels() }, [])

  // Hide the composer seat while the gomoku view is mounted (the stylesheet
  // rules target `html.dsh-gomoku-view [data-composer-seat]`).
  useEffect(() => {
    document.documentElement.classList.add(css.viewActive)
    return () => { document.documentElement.classList.remove(css.viewActive) }
  }, [])

  const status = statusCopy(game, t)
  const settled = game.winner !== EMPTY || game.draw
  const humanTurn = (settings.mode === 'black' && game.turn === BLACK)
    || (settings.mode === 'white' && game.turn === WHITE)
  const opening = game.moveCount === 0
  // A failed AI move leaves the game waiting on that side; offer a retry
  // (the store ignores it when it is the human's turn or a request is live).
  // While paused the human owns the board, so no retry is offered.
  const retryableError = status.error && !settled && !game.thinking && !game.paused

  // The status dot's voice follows the game state: the side to move (stone
  // color), amber for paused/thinking, red for errors.
  const statusDot = settled
    ? (game.winner === BLACK ? css.dotBlack : game.winner === WHITE ? css.dotWhite : css.dotNeutral)
    : status.error
      ? css.dotError
      : game.paused || game.thinking
        ? `${css.dotAmber} ${css.dotPulse}`
        : game.turn === BLACK ? css.dotBlack : css.dotWhite

  const toggleEntry = (n: number): void => {
    setExpandedEntries(prev => {
      const next = new Set(prev)
      if (next.has(n)) next.delete(n)
      else next.add(n)
      return next
    })
  }

  const blackLog = game.log.filter(entry => entry.side === 'black')
  const whiteLog = game.log.filter(entry => entry.side === 'white')

  return (
    <div className={css.view}>
      <div className={css.inner}>
        <SidePanel
          title={t('panel.black')}
          stone="black"
          modelLabel={t('panel.model.black')}
          promptLabel={t('panel.prompt.black')}
          logTitle={t('panel.log.black')}
          model={settings.blackModel}
          thinking={settings.blackThinking}
          prompt={settings.blackPrompt}
          groups={settings.groups}
          log={blackLog}
          expanded={expandedEntries}
          t={t}
          onModelChange={(blackModel) => patchSettings({ blackModel })}
          onThinkingChange={(blackThinking) => patchSettings({ blackThinking })}
          onPromptSave={(blackPrompt) => patchSettings({ blackPrompt })}
          onToggleEntry={toggleEntry}
        />

        <div className={css.boardColumn}>
          <div className={css.statusRow}>
            <span className={`${css.statusDot} ${statusDot}`} aria-hidden="true" />
            <div className={`${css.status}${status.error ? ` ${css.statusError}` : ''}`}>{status.text}</div>
            {retryableError && (
              <button type="button" className={css.retry} onClick={retryMove}>{t('status.retry')}</button>
            )}
          </div>
          <div className={css.hint}>
            {game.paused && t('status.paused.hint')}
            {!game.paused && settings.mode === 'black' && t('status.side.hint')}
            {!game.paused && settings.mode === 'white' && t('status.side.hint.white')}
            {!game.paused && settings.mode === 'both' && t('status.side.hint.both')}
            {opening && ` · ${t('rule.first.tengen')}`}
          </div>
          <div className={css.board} role="grid" aria-label={t('tab.label')}>
            {game.board.map((cell, index) => {
              const row = Math.floor(index / BOARD_SIZE)
              const col = index % BOARD_SIZE
              const last = game.lastMove !== null && game.lastMove.row === row && game.lastMove.col === col
              const playable = !settled && !game.thinking && (game.paused || humanTurn)
              return (
                <CellButton
                  key={index}
                  row={row}
                  col={col}
                  cell={cell}
                  last={last}
                  playable={playable}
                  preview={playable ? game.turn : EMPTY}
                  onClick={placeStone}
                />
              )
            })}
          </div>

          {/* Below the board: the mode selector, the new-game button, and the
              pause/resume button. Inline SVG icons (no image assets) paired
              with text labels; the pause button turns amber while paused. */}
          <div className={css.bottomBar}>
            <span className={css.label}>{t('panel.mode')}</span>
            <div className={css.segmented} role="group" aria-label={t('panel.mode')}>
              {MODES.map(mode => (
                <button
                  key={mode.value}
                  type="button"
                  className={`${css.segButton}${settings.mode === mode.value ? ` ${css.segActive}` : ''}`}
                  onClick={() => changeMode(mode.value)}
                >
                  {t(mode.key)}
                </button>
              ))}
            </div>
            <button
              type="button"
              className={css.action}
              onClick={() => newGame()}
              aria-label={t('panel.newGame')}
              title={t('panel.newGame')}
            >
              <svg className={css.actionIcon} viewBox="0 0 16 16" aria-hidden="true">
                <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                <path d="M13.7 1.9v3.2h-3.2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span>{t('panel.newGame')}</span>
            </button>
            <button
              type="button"
              className={`${css.action}${game.paused ? ` ${css.actionPaused}` : ''}`}
              disabled={settled}
              onClick={togglePause}
              aria-label={game.paused ? t('panel.resume') : t('panel.pause')}
              title={game.paused ? t('panel.resume') : t('panel.pause')}
            >
              <svg className={css.actionIcon} viewBox="0 0 16 16" aria-hidden="true">
                {game.paused ? (
                  <path d="M5.2 3.4l7 4.6-7 4.6z" fill="currentColor" />
                ) : (
                  <path d="M5.5 3.5v9M10.5 3.5v9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                )}
              </svg>
              <span>{game.paused ? t('panel.resume') : t('panel.pause')}</span>
            </button>
          </div>
        </div>

        <SidePanel
          title={t('panel.white')}
          stone="white"
          modelLabel={t('panel.model.white')}
          promptLabel={t('panel.prompt.white')}
          logTitle={t('panel.log.white')}
          model={settings.whiteModel}
          thinking={settings.whiteThinking}
          prompt={settings.whitePrompt}
          groups={settings.groups}
          log={whiteLog}
          expanded={expandedEntries}
          t={t}
          onModelChange={(whiteModel) => patchSettings({ whiteModel })}
          onThinkingChange={(whiteThinking) => patchSettings({ whiteThinking })}
          onPromptSave={(whitePrompt) => patchSettings({ whitePrompt })}
          onToggleEntry={toggleEntry}
        />
      </div>
    </div>
  )
}
