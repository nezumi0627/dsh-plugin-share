import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packDirectory } from '../lib/pack.js';
import { sha256Hex } from '../lib/sha256.js';
import { artifactPath, findInstalled, readInstalled, recordInstall, storeArtifact } from '../lib/store.js';
import { makeTool } from '../lib/tool.js';

const SOURCE = 'https://github.com/o/x-demo';
const MANIFEST_URL = 'https://raw.githubusercontent.com/o/x-demo/HEAD/plugin-share.json';

async function makePluginDir({ name = 'x-demo', version = '1.0.0' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'plugin-share-tool-'));
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name, version, private: true, type: 'module', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
  );
  await writeFile(join(dir, 'cordis.patch.yml'), "- insert:\n    - id: x-demo\n      name: 'x-demo'\n");
  await writeFile(join(dir, 'index.js'), 'export function apply(ctx) {}\n');
  return dir;
}

async function makeShared() {
  const dir = await makePluginDir();
  const packed = await packDirectory(dir, { owner: 'o', repo: 'x-demo' });
  return {
    packed,
    routes: {
      [MANIFEST_URL]: JSON.stringify(packed.repoManifest),
      [packed.repoManifest.artifact.url]: packed.tarballBytes,
    },
  };
}

function fakeFetch(routes) {
  const impl = async (url) => {
    const body = routes[url];
    if (body === undefined) return new Response('missing', { status: 404, statusText: 'Not Found' });
    return new Response(typeof body === 'string' ? Buffer.from(body) : body, { status: 200 });
  };
  impl.calls = [];
  return impl;
}

function makeInstaller({ names = [], fail = false } = {}) {
  const state = { calls: [], removed: [], names: [...names] };
  return {
    state,
    async installedNames() {
      return state.names;
    },
    async installBundle(spec, options) {
      state.calls.push({ spec, options });
      if (fail) return { ok: false, error: 'pnpm refused the spec' };
      return { ok: true };
    },
    async removeBundle(name) {
      state.removed.push(name);
      state.names = state.names.filter((entry) => entry !== name);
    },
  };
}

async function makeToolWithDeps({ installer = makeInstaller(), routes = {}, mode = 'danger-full-access' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'plugin-share-toolroot-'));
  const tool = makeTool({ installer, root, fetchImpl: fakeFetch(routes), mode });
  return { tool, installer, root };
}

async function run(tool, args) {
  return JSON.parse(await tool.execute(args, { callId: 'test' }));
}

test('the tool is a registry-ready plain object', () => {
  const tool = makeTool({ installer: makeInstaller(), mode: 'danger-full-access' });
  assert.equal(tool.name, 'plugin_share');
  assert.equal(tool.parameters.type, 'object');
  assert.deepEqual(tool.parameters.required, ['action']);
  assert.ok(tool.parameters.properties.action.enum.includes('install'));
  assert.ok(tool.parameters.properties.action.enum.includes('verify'));
  assert.equal(tool.output.schema.type, 'string');
  assert.equal(typeof tool.execute, 'function');
  assert.deepEqual(tool.output.render({}, 'text'), [{ type: 'text', text: 'text' }]);
  assert.equal(tool.presentCall({ action: 'list' }).kind, 'read');
});

test('every action is refused without danger-full-access', async () => {
  const { tool } = await makeToolWithDeps({ mode: 'workspace-write' });
  await assert.rejects(tool.execute({ action: 'list' }, { callId: 'test' }), /danger-full-access/);
});

test('inspect reports the plan and installs nothing', async () => {
  const { packed, routes } = await makeShared();
  const { tool, installer, root } = await makeToolWithDeps({ routes });
  const result = await run(tool, { action: 'inspect', source: SOURCE });
  assert.equal(result.ok, true);
  assert.equal(result.name, 'x-demo');
  assert.equal(result.version, '1.0.0');
  assert.equal(result.sha256, packed.sha256);
  assert.equal(result.alreadyInstalled, false);
  assert.equal(installer.state.calls.length, 0);
  assert.deepEqual(await readInstalled({ root }), []);
});

test('install installs the plugin and reports where it came from', async () => {
  const { packed, routes } = await makeShared();
  const { tool, installer, root } = await makeToolWithDeps({ routes });
  const result = await run(tool, { action: 'install', source: SOURCE });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'installed');
  assert.equal(result.sha256, packed.sha256);
  assert.equal(installer.state.calls.length, 1);
  assert.equal((await findInstalled('x-demo', { root })).version, '1.0.0');
});

test('install passes replace through so a collision can be overridden', async () => {
  const { routes } = await makeShared();
  const installer = makeInstaller({ names: ['x-demo'] });
  const { tool } = await makeToolWithDeps({ installer, routes });
  const refused = await run(tool, { action: 'install', source: SOURCE });
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 'already-installed');
  const replaced = await run(tool, { action: 'install', source: SOURCE, replace: true });
  assert.equal(replaced.ok, true);
  assert.equal(installer.state.calls.length, 1);
});

test('install reports a digest mismatch instead of throwing', async () => {
  const { packed, routes } = await makeShared();
  routes[packed.repoManifest.artifact.url] = Buffer.from('swapped');
  const { tool, installer } = await makeToolWithDeps({ routes });
  const result = await run(tool, { action: 'install', source: SOURCE });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'sha256-mismatch');
  assert.equal(installer.state.calls.length, 0);
});

test('list reports the ledger and the profile side by side', async () => {
  const { tool, installer, root } = await makeToolWithDeps();
  installer.state.names.push('x-demo');
  await recordInstall(
    { name: 'x-demo', version: '1.0.0', sha256: 'a'.repeat(64), installedAt: '2026-10-11T00:00:00.000Z', source: SOURCE, profileSpec: 'file:C:/x.tgz', format: 'tgz', status: 'installed' },
    { root },
  );
  await recordInstall(
    { name: 'y-demo', version: '2.0.0', sha256: 'b'.repeat(64), installedAt: '2026-10-11T00:00:00.000Z', source: SOURCE, profileSpec: 'file:C:/y.tgz', format: 'tgz', status: 'installed' },
    { root },
  );
  const result = await run(tool, { action: 'list' });
  assert.equal(result.ok, true);
  assert.equal(result.total, 2);
  assert.deepEqual(
    result.entries.map((entry) => [entry.name, entry.inProfile]),
    [['x-demo', true], ['y-demo', false]],
  );
});

test('verify re-hashes the stored artifact and reports a swap', async () => {
  const { tool, root, installer } = await makeToolWithDeps();
  const bytes = Buffer.from('the verified bytes');
  await storeArtifact('x-demo', '1.0.0', bytes, { root });
  const digest = sha256Hex(bytes);
  await recordInstall(
    { name: 'x-demo', version: '1.0.0', sha256: digest, installedAt: '2026-10-11T00:00:00.000Z', source: SOURCE, profileSpec: 'file:C:/x.tgz', format: 'tgz', status: 'installed' },
    { root },
  );
  const good = await run(tool, { action: 'verify', name: 'x-demo' });
  assert.equal(good.ok, true);
  assert.equal(good.status, 'verified');
  await storeArtifact('x-demo', '1.0.0', Buffer.from('swapped bytes'), { root });
  const bad = await run(tool, { action: 'verify', name: 'x-demo' });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 'sha256-mismatch');
  assert.notEqual(bad.actual, digest);
  const missing = await run(tool, { action: 'verify', name: 'nope' });
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 'unknown');
  assert.equal(installer.state.removed.length, 0);
});

test('remove takes the bundle out of the profile and clears the ledger', async () => {
  const { tool, installer, root } = await makeToolWithDeps();
  installer.state.names.push('x-demo');
  await recordInstall(
    { name: 'x-demo', version: '1.0.0', sha256: 'a'.repeat(64), installedAt: '2026-10-11T00:00:00.000Z', source: SOURCE, profileSpec: 'file:C:/x.tgz', format: 'tgz', status: 'installed' },
    { root },
  );
  const result = await run(tool, { action: 'remove', name: 'x-demo' });
  assert.equal(result.ok, true);
  assert.deepEqual(installer.state.removed, ['x-demo']);
  assert.deepEqual(await readInstalled({ root }), []);
  const again = await run(tool, { action: 'remove', name: 'x-demo' });
  assert.equal(again.ok, false);
  assert.equal(again.status, 'not-found');
});

test('an action outside the enum is refused', async () => {
  const { tool } = await makeToolWithDeps();
  await assert.rejects(tool.execute({ action: 'explode' }, { callId: 'test' }), /action/);
});

test('install without a source is refused', async () => {
  const { tool } = await makeToolWithDeps();
  await assert.rejects(tool.execute({ action: 'install' }, { callId: 'test' }), /source/);
});

test('a stored artifact path is reachable for the message a person reads', async () => {
  const { root } = await makeToolWithDeps();
  assert.match(artifactPath('x-demo', '1.0.0', { root }), /x-demo/);
});
