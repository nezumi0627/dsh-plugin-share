/**
 * Host half of dsh-plugin-share.
 *
 * It contributes two things and nothing else: the `plugin_share` agent tool, which
 * is the only path that installs anything (and only with danger-full-access), and
 * the three Web routes behind the Share button, which only ever pack and publish
 * the author's own plugin.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTool } from './lib/tool.js';
import { registerWebUi } from './lib/webui.js';

/** The profile manifest, or undefined outside a desktop profile. */
function readProfileManifest() {
  const dir = process.env.DSH_PROFILE_DIR;
  if (typeof dir !== 'string' || dir === '') return undefined;
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

/** Adapt `ctx.pluginManager` to the narrow installer interface lib/install.js needs. */
function makeInstaller(ctx) {
  return {
    async installedNames() {
      // `listBundles()` rows carry `name`, plus the bundle's declared plugin rows.
      const rows = await ctx.pluginManager.listBundles();
      return rows
        .map((row) => (typeof row?.name === 'string' ? row.name : row?.packageName))
        .filter((name) => typeof name === 'string' && name !== '');
    },
    async installBundle(spec, options) {
      return await ctx.pluginManager.installBundle(spec, options);
    },
    async removeBundle(name) {
      return await ctx.pluginManager.removeBundle(name);
    },
  };
}

/** The effective sandbox mode for this call; anything unknown means "not allowed". */
function resolveMode(ctx, exec) {
  const policy = ctx.get?.('sandboxPolicy');
  if (policy === undefined) return 'workspace-write';
  try {
    const session = exec?.agent?.session;
    return policy.resolve(session === undefined ? {} : { session }).mode;
  } catch {
    return 'workspace-write';
  }
}

/**
 * @param {import('cordis').Context} ctx
 */
export function apply(ctx) {
  ctx.inject(['tools', 'pluginManager'], (toolCtx) => {
    const installer = makeInstaller(toolCtx);
    toolCtx.effect(
      // The sandbox policy is a root service, so it is read from the root context:
      // the injected context is a child, and a missing policy must mean "refuse".
      () => toolCtx.tools.register(makeTool({ installer, mode: (exec) => resolveMode(ctx, exec) })),
      'plugin-share: tool',
    );
  });
  registerWebUi(ctx, { profileManifest: readProfileManifest });
}
