import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../index.js';

/**
 * A context shaped like the one DSH hands a plugin: `inject` only fires for the
 * services that exist, and `effect` runs what it is given.
 */
function makeCtx({ services = ['tools', 'pluginManager', 'webServer'], mode = 'danger-full-access' } = {}) {
  const state = { tools: [], routes: [], taps: [], effects: [], bundles: [], installed: [] };
  const logger = { info() {}, warn() {} };
  const ctx = {
    logger,
    get(name) {
      if (name === 'sandboxPolicy') return { resolve: () => ({ mode }) };
      return undefined;
    },
    inject(names, callback) {
      if (!names.every((name) => services.includes(name))) return;
      return callback({
        logger,
        get: ctx.get,
        effect(fn) {
          const dispose = fn();
          state.effects.push(dispose);
          return dispose;
        },
        tools: {
          register(tool) {
            state.tools.push(tool);
            return () => {};
          },
        },
        pluginManager: {
          async listBundles() {
            return state.bundles;
          },
          async installBundle(spec) {
            state.installed.push(spec);
            return { ok: true };
          },
          async removeBundle() {},
        },
        webServer: {
          register(route) {
            state.routes.push(route);
            return () => {};
          },
          tapIndex(fn) {
            state.taps.push(fn);
            return () => {};
          },
        },
      });
    },
  };
  return { ctx, state };
}

test('apply registers the plugin_share tool and the three share routes', async () => {
  const { ctx, state } = makeCtx();
  const root = await mkdtemp(join(tmpdir(), 'plugin-share-host-'));
  process.env.DSH_PLUGIN_SHARE_HOME = root;
  apply(ctx);
  assert.equal(state.tools.length, 1);
  const tool = state.tools[0];
  assert.equal(tool.name, 'plugin_share');
  assert.deepEqual(tool.parameters.properties.action.enum, ['inspect', 'install', 'verify', 'list', 'remove']);
  assert.equal(typeof tool.output.render, 'function');
  assert.deepEqual(
    state.routes.map((route) => route.path),
    ['/plugin-share/plan', '/plugin-share/publish', '/plugin-share/status'],
  );
  assert.equal(state.routes.every((route) => route.kind === 'exact'), true);
  const html = state.taps[0]('<html><head></head><body></body></html>');
  assert.match(html, /window\.__DSH_PLUGIN_SHARE__/);
  assert.match(html, /x-plugin-share-token|token/);
  for (const dispose of state.effects) assert.equal(typeof dispose, 'function');
});

test('the registered tool refuses anything outside danger-full-access', async () => {
  const { ctx, state } = makeCtx({ mode: 'workspace-write' });
  apply(ctx);
  await assert.rejects(state.tools[0].execute({ action: 'list' }, { callId: 'test' }), /danger-full-access/);
});

test('a profile without the plugin manager service still gets the share routes', async () => {
  const { ctx, state } = makeCtx({ services: ['webServer'] });
  apply(ctx);
  assert.equal(state.tools.length, 0);
  assert.equal(state.routes.length, 3);
});

test('the tool lists and removes against the adapter it was given', async () => {
  const { ctx, state } = makeCtx();
  state.bundles = [{ name: 'x-demo', version: '1.0.0' }];
  apply(ctx);
  const tool = state.tools[0];
  const listed = JSON.parse(await tool.execute({ action: 'list' }, { callId: 'test' }));
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.inProfileNotRecorded, ['x-demo']);
  const removed = JSON.parse(await tool.execute({ action: 'remove', name: 'x-demo' }, { callId: 'test' }));
  assert.equal(removed.ok, true);
  assert.equal(state.tools.length, 1);
});
