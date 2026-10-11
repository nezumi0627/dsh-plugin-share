import ms from 'ms';

/**
 * Saying something about the resolved dependency is the point of this one: if it
 * loads and the line is right, pnpm fetched and linked `ms` from the registry.
 */
export function apply(ctx) {
  ctx.logger?.info?.(`[share-demo-dep] active — ms('2h') is ${ms('2h')}`);
}
