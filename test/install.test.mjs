import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installShare, inspectShare, toPnpmSpec } from '../lib/install.js';
import { buildEmbeddedManifest, buildRepoManifest } from '../lib/manifest.js';
import { packDirectory } from '../lib/pack.js';
import { sha256Hex } from '../lib/sha256.js';
import { artifactPath, findInstalled, readArtifact, readInstalled } from '../lib/store.js';
import { writeTarball } from '../lib/tgz-write.js';

const SOURCE = 'https://github.com/o/x-demo';
const MANIFEST_URL = 'https://raw.githubusercontent.com/o/x-demo/HEAD/plugin-share.json';

async function makePluginDir({ name = 'x-demo', version = '1.0.0' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'plugin-share-install-'));
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({
      name,
      version,
      private: true,
      type: 'module',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }),
  );
  await writeFile(join(dir, 'cordis.patch.yml'), "- insert:\n    - id: x-demo\n      name: 'x-demo'\n");
  await writeFile(join(dir, 'index.js'), 'export function apply(ctx) {}\n');
  return dir;
}

async function makeStoreRoot() {
  return await mkdtemp(join(tmpdir(), 'plugin-share-store-'));
}

/** A shared plugin: its manifest location, its tarball URL, and both payloads. */
async function makeShared({ name = 'x-demo', version = '1.0.0' } = {}) {
  const dir = await makePluginDir({ name, version });
  const packed = await packDirectory(dir, { owner: 'o', repo: 'x-demo' });
  const routes = {
    [MANIFEST_URL]: JSON.stringify(packed.repoManifest),
    [packed.repoManifest.artifact.url]: packed.tarballBytes,
  };
  return { packed, routes };
}

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const body = routes[url];
    if (body === undefined) return new Response('missing', { status: 404, statusText: 'Not Found' });
    return new Response(typeof body === 'string' ? Buffer.from(body) : body, { status: 200 });
  };
  impl.calls = calls;
  return impl;
}

function makeInstaller({ names = [], fail = false, pending = [], onInstall } = {}) {
  const state = { calls: [], removed: [], names: [...names] };
  return {
    state,
    async installedNames() {
      return state.names;
    },
    async installBundle(spec, options) {
      state.calls.push({ spec, options });
      if (onInstall !== undefined) onInstall(state);
      if (fail) return { ok: false, error: 'pnpm refused the spec' };
      if (pending.length > 0 && state.calls.length === 1) return { ok: true, pendingBuilds: [...pending] };
      return { ok: true };
    },
    async removeBundle(name) {
      state.removed.push(name);
    },
  };
}

test('installs a repository source after verifying its digest', async () => {
  const { packed, routes } = await makeShared();
  const root = await makeStoreRoot();
  const installer = makeInstaller();
  const fetchImpl = fakeFetch(routes);
  const result = await installShare(SOURCE, { installer, root, fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'installed');
  assert.equal(result.name, 'x-demo');
  assert.equal(result.version, '1.0.0');
  assert.equal(result.sha256, packed.sha256);
  const stored = artifactPath('x-demo', '1.0.0', { root });
  assert.equal(installer.state.calls.length, 1);
  assert.equal(installer.state.calls[0].spec, toPnpmSpec(stored));
  assert.match(installer.state.calls[0].spec, /^file:[A-Za-z]:\//);
  assert.deepEqual(await readArtifact('x-demo', '1.0.0', { root }), packed.tarballBytes);
  const record = await findInstalled('x-demo', { root });
  assert.equal(record.sha256, packed.sha256);
  assert.equal(record.version, '1.0.0');
  assert.equal(record.format, 'tgz');
  assert.equal(record.status, 'installed');
  assert.equal(record.source, SOURCE);
  assert.equal(record.profileSpec, toPnpmSpec(stored));
  assert.deepEqual(fetchImpl.calls, [MANIFEST_URL, packed.repoManifest.artifact.url]);
});

test('a digest mismatch is refused before the installer runs and stores nothing', async () => {
  const { packed, routes } = await makeShared();
  const root = await makeStoreRoot();
  routes[packed.repoManifest.artifact.url] = Buffer.from('not the tarball');
  const installer = makeInstaller();
  const result = await installShare(SOURCE, { installer, root, fetchImpl: fakeFetch(routes) });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'refused');
  assert.equal(result.code, 'sha256-mismatch');
  assert.equal(installer.state.calls.length, 0);
  assert.deepEqual(await readInstalled({ root }), []);
  assert.equal(await readArtifact('x-demo', '1.0.0', { root }), undefined);
});

test('an already-installed name is refused unless replace is set', async () => {
  const { routes } = await makeShared();
  const root = await makeStoreRoot();
  const installer = makeInstaller({ names: ['x-demo'] });
  const refused = await installShare(SOURCE, { installer, root, fetchImpl: fakeFetch(routes) });
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 'already-installed');
  assert.equal(installer.state.calls.length, 0);
  const replaced = await installShare(SOURCE, {
    installer,
    root,
    fetchImpl: fakeFetch(routes),
    replace: true,
  });
  assert.equal(replaced.ok, true);
  assert.equal(replaced.status, 'installed');
  assert.equal(installer.state.calls.length, 1);
});

test('a local tarball is installed from its own path without any download', async () => {
  const { packed } = await makeShared();
  const dir = await mkdtemp(join(tmpdir(), 'plugin-share-local-'));
  const path = join(dir, 'x-demo-1.0.0.tgz');
  await writeFile(path, packed.tarballBytes);
  const root = await makeStoreRoot();
  const installer = makeInstaller();
  const result = await installShare(path, { installer, root });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'installed');
  assert.equal(result.sha256, packed.sha256);
  assert.equal(installer.state.calls[0].spec, toPnpmSpec(artifactPath('x-demo', '1.0.0', { root })));
  assert.ok(result.warnings.some((warning) => warning.includes('no digest')));
});

test('a bare tarball URL needs the author\u2019s digest', async () => {
  const { packed } = await makeShared();
  const url = 'https://example.com/x-demo-1.0.0.tgz';
  const root = await makeStoreRoot();
  const installer = makeInstaller();
  const without = await installShare(url, { installer, root, fetchImpl: fakeFetch({ [url]: packed.tarballBytes }) });
  assert.equal(without.ok, false);
  assert.equal(without.code, 'sha256-required');
  assert.equal(installer.state.calls.length, 0);
  const withDigest = await installShare(url, {
    installer,
    root,
    fetchImpl: fakeFetch({ [url]: packed.tarballBytes }),
    sha256: packed.sha256,
  });
  assert.equal(withDigest.ok, true);
  assert.equal(withDigest.status, 'installed');
  assert.equal(withDigest.sha256, packed.sha256);
});

test('a wrong digest for a bare tarball URL is refused', async () => {
  const { packed } = await makeShared();
  const url = 'https://example.com/x-demo-1.0.0.tgz';
  const root = await makeStoreRoot();
  const result = await installShare(url, {
    installer: makeInstaller(),
    root,
    fetchImpl: fakeFetch({ [url]: packed.tarballBytes }),
    sha256: 'b'.repeat(64),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'sha256-mismatch');
});

test('a build approval round-trip finishes the install', async () => {
  const { routes } = await makeShared();
  const root = await makeStoreRoot();
  const installer = makeInstaller({
    pending: ['esbuild'],
    onInstall: (state) => {
      if (!state.names.includes('x-demo')) state.names.push('x-demo');
    },
  });
  const first = await installShare(SOURCE, { installer, root, fetchImpl: fakeFetch(routes) });
  assert.equal(first.ok, false);
  assert.equal(first.status, 'builds-pending');
  assert.deepEqual(first.pendingBuilds, ['esbuild']);
  assert.equal((await findInstalled('x-demo', { root })).status, 'pending-builds');
  const second = await installShare(SOURCE, {
    installer,
    root,
    fetchImpl: fakeFetch(routes),
    approvedBuilds: ['esbuild'],
  });
  assert.equal(second.ok, true);
  assert.equal(second.status, 'installed');
  assert.deepEqual(installer.state.calls[1].options.approvedBuilds, ['esbuild']);
  assert.equal((await findInstalled('x-demo', { root })).status, 'installed');
});

test('a failed install leaves no ledger entry', async () => {
  const { routes } = await makeShared();
  const root = await makeStoreRoot();
  const installer = makeInstaller({ fail: true });
  const result = await installShare(SOURCE, { installer, root, fetchImpl: fakeFetch(routes) });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'install-failed');
  assert.deepEqual(await readInstalled({ root }), []);
});

test('an embedded manifest that disagrees with the repository manifest is refused', async () => {
  const bytes = writeTarball(
    [
      { name: 'package/package.json', data: Buffer.from('{"name":"other-pkg","version":"9.9.9"}') },
      {
        name: 'package/plugin-share.json',
        data: Buffer.from(
          JSON.stringify(
            buildEmbeddedManifest({
              name: 'other-pkg',
              version: '9.9.9',
              author: { github: 'o' },
              created: '2026-10-11T00:00:00.000Z',
            }),
          ),
        ),
      },
    ],
    { mtimeMs: 0 },
  );
  const manifest = buildRepoManifest({
    name: 'x-demo',
    version: '1.0.0',
    author: { github: 'o' },
    created: '2026-10-11T00:00:00.000Z',
    artifact: { url: 'https://example.com/x.tgz', sha256: sha256Hex(bytes) },
  });
  const routes = { [MANIFEST_URL]: JSON.stringify(manifest), 'https://example.com/x.tgz': bytes };
  const root = await makeStoreRoot();
  const installer = makeInstaller();
  const result = await installShare(SOURCE, { installer, root, fetchImpl: fakeFetch(routes) });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'manifest-mismatch');
  assert.equal(installer.state.calls.length, 0);
});

test('inspectShare reports the plan without installing anything', async () => {
  const { packed, routes } = await makeShared();
  const root = await makeStoreRoot();
  const installer = makeInstaller({ names: ['x-demo'] });
  const result = await inspectShare(SOURCE, { installer, root, fetchImpl: fakeFetch(routes) });
  assert.equal(result.ok, true);
  assert.equal(result.inspection.name, 'x-demo');
  assert.equal(result.inspection.version, '1.0.0');
  assert.equal(result.inspection.sha256, packed.sha256);
  assert.equal(result.inspection.artifactUrl, packed.repoManifest.artifact.url);
  assert.equal(result.inspection.alreadyInstalled, true);
  assert.equal(installer.state.calls.length, 0);
  assert.deepEqual(await readInstalled({ root }), []);
});

test('a local directory source is refused with a hint to pack it', async () => {
  const dir = await makePluginDir();
  const result = await installShare(dir, { installer: makeInstaller(), root: await makeStoreRoot() });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'refused');
  assert.match(result.message, /pack/);
});

test('a missing manifest is reported as an error, not a crash', async () => {
  const root = await makeStoreRoot();
  const result = await installShare(SOURCE, {
    installer: makeInstaller(),
    root,
    fetchImpl: fakeFetch({}),
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'error');
  assert.match(result.message, /404/);
});

test('toPnpmSpec writes a file spec with forward slashes', () => {
  assert.equal(toPnpmSpec('C:\\Users\\x\\.dsh\\plugin-share\\a.tgz'), 'file:C:/Users/x/.dsh/plugin-share/a.tgz');
});
