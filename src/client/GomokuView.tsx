/**
 * The gomoku conversation view: the board tab content. Board on the left,
 * settings (mode, per-side models, thinking, timeouts, prompt, reasoning)
 * in a right-hand panel. Rendered inside the conversation view ring (the
 * same slot Trajectory occupies), one-at-a-time by the session body — so the
 * component unmounts on tab switches and the game state lives in the
 * module-level store (see store.ts), never here.
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
  changeMode, getSnapshot, loadModels, newGame, patchSettings, placeStone, retryMove, subscribe,
  type GameState, type SideModel,
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

/** The status line copy for the current game. */
function statusCopy(game: GameState, t: PropsLocale<'gomoku'>['t']): { text: string; error: boolean } {
  if (game.winner === BLACK) return { text: t('status.win.black'), error: false }
  if (game.winner === WHITE) return { text: t('status.win.white'), error: false }
  if (game.draw) return { text: t('status.draw'), error: false }
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
  row, col, cell, last, playable, onClick,
}: {
  row: number
  col: number
  cell: Cell
  last: boolean
  playable: boolean
  onClick: (row: number, col: number) => void
}) {
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
      {cell === EMPTY && row === TENGEN.row && col === TENGEN.col && <span className={css.tengen} />}
    </button>
  )
}

/** One per-side model selector. */
function ModelSelect({
  label, value, groups, onChange,
}: {
  label: string
  value: SideModel
  groups: readonly { provider: string; displayName: string; models: { id: string; name: string }[] }[]
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

/** The gomoku view tab body. */
export function GomokuView({ t }: GomokuViewProps) {
  const { game, settings } = useSyncExternalStore(subscribe, getSnapshot)
  const [promptEditing, setPromptEditing] = useState(false)
  const [reasoningOpen, setReasoningOpen] = useState(false)
  const [promptText, setPromptText] = useState('')
  const [defaultPrompt, setDefaultPrompt] = useState<string | undefined>(undefined)
  const [promptLoading, setPromptLoading] = useState(false)
  const [promptSaved, setPromptSaved] = useState(false)
  const savedTimer = useRef<number | undefined>(undefined)
  // Reasoning log entries start collapsed; clicking a header expands it.
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

  // Load the default prompt when the editor first opens.
  useEffect(() => {
    if (!promptEditing || defaultPrompt !== undefined) return
    let cancelled = false
    setPromptLoading(true)
    fetch('/plugins/gomoku/prompt')
      .then(response => response.json() as Promise<{ prompt?: string }>)
      .then((body) => {
        if (cancelled) return
        const prompt = body.prompt
        if (prompt !== undefined) {
          setDefaultPrompt(prompt)
          setPromptText(settings.customPrompt ?? prompt)
        }
      })
      .catch(() => { /* the editor stays usable; save still works */ })
      .finally(() => { if (!cancelled) setPromptLoading(false) })
    return () => { cancelled = true }
  }, [promptEditing, defaultPrompt, settings.customPrompt])

  useEffect(() => () => { window.clearTimeout(savedTimer.current) }, [])

  const flashSaved = (): void => {
    setPromptSaved(true)
    window.clearTimeout(savedTimer.current)
    savedTimer.current = window.setTimeout(() => setPromptSaved(false), 1500)
  }

  const status = statusCopy(game, t)
  const settled = game.winner !== EMPTY || game.draw
  const humanTurn = (settings.mode === 'black' && game.turn === BLACK)
    || (settings.mode === 'white' && game.turn === WHITE)
  const opening = game.moveCount === 0
  // A failed AI move leaves the game waiting on that side; offer a retry
  // (the store ignores it when it is the human's turn or a request is live).
  const retryableError = status.error && !settled && !game.thinking

  const toggleEntry = (index: number): void => {
    setExpandedEntries(prev => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  return (
    <div className={css.view}>
      <div className={css.inner}>
        <div className={css.boardColumn}>
          <div className={css.statusRow}>
            <div className={`${css.status}${status.error ? ` ${css.statusError}` : ''}`}>{status.text}</div>
            {retryableError && (
              <button type="button" className={css.retry} onClick={retryMove}>{t('status.retry')}</button>
            )}
          </div>
          <div className={css.hint}>
            {settings.mode === 'black' && t('status.side.hint')}
            {settings.mode === 'white' && t('status.side.hint.white')}
            {settings.mode === 'both' && t('status.side.hint.both')}
            {opening && ` · ${t('rule.first.tengen')}`}
          </div>
          <div className={css.board} role="grid" aria-label={t('tab.label')}>
            {game.board.map((cell, index) => {
              const row = Math.floor(index / BOARD_SIZE)
              const col = index % BOARD_SIZE
              const last = game.lastMove !== null && game.lastMove.row === row && game.lastMove.col === col
              return (
                <CellButton
                  key={index}
                  row={row}
                  col={col}
                  cell={cell}
                  last={last}
                  playable={!settled && !game.thinking && humanTurn}
                  onClick={placeStone}
                />
              )
            })}
          </div>
        </div>

        <div className={css.sidePanel}>
          <div className={css.toolbar}>
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
          </div>

          <div className={css.toolbar}>
            <span className={css.label}>{t('panel.thinking')}</span>
            <div className={css.segmented} role="group" aria-label={t('panel.thinking')}>
              {THINKINGS.map(level => (
                <button
                  key={level.value}
                  type="button"
                  className={`${css.segButton}${settings.thinking === level.value ? ` ${css.segActive}` : ''}`}
                  onClick={() => patchSettings({ thinking: level.value })}
                >
                  {t(level.key)}
                </button>
              ))}
            </div>
          </div>

          <ModelSelect
            label={t('panel.model.black')}
            value={settings.blackModel}
            groups={settings.groups}
            onChange={(blackModel) => patchSettings({ blackModel })}
          />
          <ModelSelect
            label={t('panel.model.white')}
            value={settings.whiteModel}
            groups={settings.groups}
            onChange={(whiteModel) => patchSettings({ whiteModel })}
          />

          <div className={css.settingsRow}>
            <label className={css.field}>
              <span className={css.label}>{t('panel.timeout')}</span>
              <input
                className={css.input}
                type="number"
                min={1000}
                step={1000}
                value={settings.moveTimeoutMs}
                onChange={(event) => {
                  const value = Number(event.target.value)
                  if (Number.isFinite(value) && value >= 1000) patchSettings({ moveTimeoutMs: Math.floor(value) })
                }}
              />
            </label>
            <label className={css.field}>
              <span className={css.label}>{t('panel.tokens')}</span>
              <input
                className={css.input}
                type="number"
                min={8}
                step={256}
                value={settings.maxMoveOutputTokens}
                onChange={(event) => {
                  const value = Number(event.target.value)
                  if (Number.isFinite(value) && value >= 8) patchSettings({ maxMoveOutputTokens: Math.floor(value) })
                }}
              />
            </label>
          </div>

          <div className={css.toolbar}>
            <button type="button" className={css.ghost} onClick={() => newGame()}>{t('panel.newGame')}</button>
            <button type="button" className={css.ghost} onClick={() => setReasoningOpen(open => !open)}>{t('panel.reasoning')}</button>
            <button type="button" className={css.ghost} onClick={() => {
              const next = !promptEditing
              setPromptEditing(next)
              if (next) setPromptText(settings.customPrompt ?? defaultPrompt ?? '')
            }}>
              {t('panel.prompt.toggle')}
            </button>
          </div>

          {promptEditing && (
            <div className={css.promptArea}>
              {promptLoading && <div className={css.hint}>{t('panel.prompt.loading')}</div>}
              <textarea
                className={css.promptTextarea}
                value={promptText}
                rows={8}
                spellCheck={false}
                onChange={(event) => setPromptText(event.target.value)}
              />
              <div className={css.promptActions}>
                <button type="button" className={css.ghost} onClick={() => {
                  setPromptText(defaultPrompt ?? '')
                  patchSettings({ customPrompt: undefined })
                }}>
                  {t('panel.prompt.restore')}
                </button>
                <button type="button" className={css.primary} onClick={() => {
                  patchSettings({ customPrompt: promptText.trim().length > 0 ? promptText : undefined })
                  flashSaved()
                }}>
                  {t('panel.prompt.save')}
                </button>
                {promptSaved && <span className={css.flash}>{t('panel.prompt.saved')}</span>}
              </div>
            </div>
          )}

          {reasoningOpen && (
            <div className={css.reasoningList}>
              <div className={css.reasoningTitle}>{t('reasoning.title')}</div>
              {game.log.length === 0 && <div className={css.hint}>{t('reasoning.empty')}</div>}
              {game.log.map((entry, index) => {
                const isExpanded = expandedEntries.has(index)
                return (
                  <div key={index} className={css.reasoningItem}>
                    <button
                      type="button"
                      className={css.reasoningHeader}
                      aria-expanded={isExpanded}
                      aria-label={isExpanded ? t('reasoning.collapse') : t('reasoning.expand')}
                      onClick={() => toggleEntry(index)}
                    >
                      <span className={`${css.chevron}${isExpanded ? ` ${css.chevronOpen}` : ''}`}>▸</span>
                      <span className={css.reasoningMove}>
                        {t('reasoning.move', { n: entry.n })}
                        {' · '}
                        {entry.side === 'black' ? '⚫' : '⚪'}
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
          )}
        </div>
      </div>
    </div>
  )
}
