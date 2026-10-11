/**
 * The install path against a real package manager.
 *
 * Every other test fakes the installer, which is how a host that never answers
 * `{ok: true}` slipped through once. This one drives pnpm for real, in throwaway
 * directories: it packs the fixture, installs it the way the tool would, and then
 * tampers with the bytes to prove the digest check refuses before anything is
 * installed. It skips itself when pnpm cannot be found, so `node --test` stays
 * usable on a machine without one.
 *
 * It deliberately uses the fixture that declares no dependencies: nothing here
 * should need the network.
 *
 * @module dsh-plugin-share/test/e2e-pnpm
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installShare } from '../lib/install.js';
import { packDirectory } from '../lib/pack.js';
import { findInstalled, readArtifact, readInstalled } from '../lib/store.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/demo-plugin', import.meta.url));
const DEMO = 'dsh-plugin-share-demo';

/** The pnpm this DSH install ships, or whatever is on PATH. */
async function findPnpm() {
  if (typeof process.env.DSH_PNPM === 'string' && existsSync(process.env.DSH_PNPM)) return process.env.DSH_PNPM;
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const runtimes = join(home, 'dsh-runtimes');
  try {
    for (const runtime of await readdir(runtimes)) {
      const candidate = join(runtimes, runtime, 'dependencies', 'pnpm', 'bin', 'pnpm.mjs');
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // No runtimes directory: fall through to PATH below.
  }
  for (const name of ['pnpm.cmd', 'pnpm']) {
    try {
      const found = execFileSync('where', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .split(/\r?\n/)[0]
        .trim();
      if (found !== '') return found;
    } catch {
      // Try the next name.
    }
  }
  return undefined;
}

const pnpm = await findPnpm();
const skip = pnpm === undefined ? 'pnpm was not found; set DSH_PNPM to run this test' : false;

async function makeProfile() {
  const dir = await mkdtemp(join(tmpdir(), 'plugin-share-e2e-profile-'));
  await writeFile(join(dir, 'package.json'), `${JSON.stringify({ name: 'e2e-profile', private: true, version: '0.0.0' }, null, 2)}\n`);
  return dir;
}

async function readProfile(dir) {
  return JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
}

/** The installer adapter, driving pnpm the way the host drives it. */
function makeRealInstaller(profile) {
  const state = { specs: [], removed: [] };
  return {
    state,
    async installedNames() {
      const manifest = await readProfile(profile);
      return [
        ...Object.keys(manifest.dependencies ?? {}),
        ...(manifest.dsh?.profile?.bundles ?? []).map((entry) => (typeof entry === 'string' ? entry : entry.name)),
      ];
    },
    async installBundle(spec) {
      state.specs.push(spec);
      execFileSync(process.execPath, [pnpm, 'add', spec, '--dir', profile], { stdio: 'ignore' });
      const manifest = await readProfile(profile);
      const name = Object.keys(manifest.dependencies ?? {}).find((entry) => entry === DEMO) ?? DEMO;
      manifest.dsh = { profile: { bundles: [...(manifest.dsh?.profile?.bundles ?? []), name] } };
      await writeFile(join(profile, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      return { changed: true, application: 'applied', stage: 'install', target: spec };
    },
    async removeBundle(name) {
      state.removed.push(name);
      execFileSync(process.execPath, [pnpm, 'remove', name, '--dir', profile], { stdio: 'ignore' });
      const manifest = await readProfile(profile);
      manifest.dsh = { profile: { bundles: (manifest.dsh?.profile?.bundles ?? []).filter((entry) => entry !== name) } };
      await writeFile(join(profile, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      return { changed: true, application: 'applied', stage: 'remove', target: name };
    },
  };
}

test('pnpm installs a packed plugin into a profile, and the ledger records it', { skip }, async () => {
  const work = await mkdtemp(join(tmpdir(), 'plugin-share-e2e-pack-'));
  const store = await mkdtemp(join(tmpdir(), 'plugin-share-e2e-store-'));
  const packed = await packDirectory(FIXTURE, { owner: 'local', repo: DEMO, outDir: join(work, 'out') });

  const profile = await makeProfile();
  const installer = makeRealInstaller(profile);
  const result = await installShare(packed.tarballPath, { installer, root: store, sha256: packed.sha256 });

  assert.equal(result.ok, true, result.message);
  assert.equal(result.status, 'installed');
  assert.equal(result.sha256, packed.sha256);

  // The spec handed over is the verified copy in the store, never a URL and never
  // the caller's own file.
  const spec = `file:${result.artifactPath.replace(/\\/g, '/')}`;
  assert.match(installer.state.specs[0], /^file:[A-Za-z]:\//);
  assert.equal(installer.state.specs[0], spec);
  assert.equal(result.artifactPath.startsWith(store), true);

  // pnpm recorded it and unpacked it.
  const manifest = await readProfile(profile);
  assert.equal(manifest.dependencies[DEMO], spec);
  assert.deepEqual(manifest.dsh.profile.bundles, [DEMO]);
  assert.equal(existsSync(join(profile, 'node_modules', DEMO, 'index.js')), true);
  assert.equal(existsSync(join(profile, 'node_modules', DEMO, 'cordis.patch.yml')), true);

  // The verified copy and the record are in the store.
  assert.deepEqual(await readArtifact(DEMO, '0.1.0', { root: store }), packed.tarballBytes);
  const record = await findInstalled(DEMO, { root: store });
  assert.equal(record.state, 'installed');
  assert.equal(record.artifact.sha256, packed.sha256);
  assert.equal(record.profileSpec, installer.state.specs[0]);
  assert.equal(record.source.kind, 'local-tarball');

  // Removing goes through the installer and clears the record.
  const removed = await installer.removeBundle(DEMO);
  assert.equal(removed.application, 'applied');
  assert.equal((await readProfile(profile)).dependencies?.[DEMO], undefined);
  assert.equal(existsSync(join(profile, 'node_modules', DEMO)), false);
});

test('tampered bytes are refused before pnpm runs, and nothing is stored', { skip }, async () => {
  const work = await mkdtemp(join(tmpdir(), 'plugin-share-e2e-tamper-'));
  const store = await mkdtemp(join(tmpdir(), 'plugin-share-e2e-tamper-store-'));
  const packed = await packDirectory(FIXTURE, { owner: 'local', repo: DEMO, outDir: join(work, 'out') });

  const tampered = Buffer.from(packed.tarballBytes);
  tampered[tampered.length - 20] = tampered[tampered.length - 20] ^ 0xff;
  const tamperedPath = join(work, 'tampered.tgz');
  await writeFile(tamperedPath, tampered);

  const profile = await makeProfile();
  const installer = makeRealInstaller(profile);
  const result = await installShare(tamperedPath, { installer, root: store, sha256: packed.sha256 });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'sha256-mismatch');
  assert.equal(installer.state.specs.length, 0);
  assert.deepEqual(await readArtifact(DEMO, '0.1.0', { root: store }), undefined);
  assert.deepEqual(await readInstalled({ root: store }), []);
  assert.equal(existsSync(join(profile, 'node_modules')), false);
});
