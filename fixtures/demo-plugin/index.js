/**
 * The smallest plugin that proves an install worked: it says one line when DSH
 * loads it, and nothing else.
 */
export function apply(ctx) {
  ctx.logger?.info?.('[share-demo] active — plugin-share installed this');
}
