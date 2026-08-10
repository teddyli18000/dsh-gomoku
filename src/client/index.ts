/**
 * Gomoku browser half, plugin entry: registers the gomoku conversation view
 * tab (right of Trajectory) and the gomoku dictionaries. The board state
 * lives in the module-level store, so tab switches never reset the game.
 * @module @deepseek-ai/dsh-gomoku/client
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale) and the
// conversation view-slot declaration into this program.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { GomokuView } from './GomokuView.tsx'
import { NS, en, zh, type GomokuKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The gomoku board tab copy. */
    gomoku: GomokuKey
  }
}

/** Required services: the locale service and the slot registry. */
export const inject = ['locale', 'slots']

/**
 * Client plugin body: register the gomoku dictionaries and the
 * conversation-view tab. The registration rides the slot service's effect
 * wrapper, so plugin unload removes the tab.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'gomoku: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    // order 20 places the tab right of Trajectory (order 10).
    id: 'gomoku',
    order: 20,
    label: () => t('tab.label'),
    locale: NS,
  }, GomokuView))
}
