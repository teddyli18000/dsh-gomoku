/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-gomoku`.
 * @module @deepseek-ai/dsh-gomoku/invariant
 */

/* jscpd:ignore-start */
import type { Context } from 'cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-gomoku'

/** Cordis companion plugin name. */
export const name = 'gomoku-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the gomoku plugin owns no cross-plugin mutable
 * state and emits no cordis events — the board routes validate every
 * untrusted input at the HTTP boundary, and behavior is asserted by this
 * package's route/reply tests.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
