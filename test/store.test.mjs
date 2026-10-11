import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Hex } from '../lib/sha256.js';
import {
  artifactPath,
  findInstalled,
  readArtifact,
  readInstalled,
  recordInstall,
  removeInstalled,
  storeArtifact,
  verifyArtifact,
} from '../lib/store.js';

async function makeRoot() {
  return await mkdtemp(join(tmpdir(), 'plugin-share-store-'));
}

const record = {
  name: 'dsh-demo',
  version: '1.0.0',
  sha256: 'a'.repeat(64),
  installedAt: '2026-10-11T00:00:00.000Z',
  source: 'https://github.com/o/r',
  profileSpec: 'file:C:/tmp/dsh-demo-1.0.0.tgz',
  format: 'tgz',
};

test('an artifact is stored under the root and read back byte for byte', async () => {
  const root = await makeRoot();
  const bytes = Buffer.from('tarball bytes');
  const path = await storeArtifact('dsh-demo', '1.0.0', bytes, { root });
  assert.equal(path, join(root, 'artifacts', 'dsh-demo', '1.0.0.tgz'));
  assert.equal(path, artifactPath('dsh-demo', '1.0.0', { root }));
  assert.deepEqual(await readArtifact('dsh-demo', '1.0.0', { root }), bytes);
});

test('a scoped name is flattened into one directory', async () => {
  const root = await makeRoot();
  const path = await storeArtifact('@local/x-demo', '1.0.0', Buffer.from('x'), { root });
  assert.equal(path, join(root, 'artifacts', 'local-x-demo', '1.0.0.tgz'));
});

test('a version that would escape the store is refused', async () => {
  const root = await makeRoot();
  await assert.rejects(storeArtifact('dsh-demo', '../../evil', Buffer.from('x'), { root }), /version/);
});

test('reading an artifact that was never stored gives undefined', async () => {
  const root = await makeRoot();
  assert.equal(await readArtifact('dsh-demo', '9.9.9', { root }), undefined);
});

test('verifyArtifact reports the actual digest when the expected one differs', async () => {
  const root = await makeRoot();
  const bytes = Buffer.from('tarball bytes');
  await storeArtifact('dsh-demo', '1.0.0', bytes, { root });
  const result = await verifyArtifact('dsh-demo', '1.0.0', 'a'.repeat(64), { root });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'mismatch');
  assert.equal(result.actual, sha256Hex(bytes));
});

test('verifyArtifact reports a missing artifact', async () => {
  const root = await makeRoot();
  const result = await verifyArtifact('dsh-demo', '1.0.0', 'a'.repeat(64), { root });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing');
});

test('verifyArtifact passes for the digest of the stored bytes', async () => {
  const root = await makeRoot();
  const bytes = Buffer.from('tarball bytes');
  const path = await storeArtifact('dsh-demo', '1.0.0', bytes, { root });
  const result = await verifyArtifact('dsh-demo', '1.0.0', sha256Hex(bytes), { root });
  assert.deepEqual(result, { ok: true, path });
});

test('the install ledger round-trips, replaces by name, and removes', async () => {
  const root = await makeRoot();
  assert.deepEqual(await readInstalled({ root }), []);
  assert.equal(await findInstalled('dsh-demo', { root }), undefined);
  await recordInstall(record, { root });
  assert.deepEqual(await findInstalled('dsh-demo', { root }), record);
  await recordInstall({ ...record, version: '1.1.0' }, { root });
  assert.deepEqual(await readInstalled({ root }), [{ ...record, version: '1.1.0' }]);
  assert.equal(await removeInstalled('dsh-demo', { root }), true);
  assert.equal(await removeInstalled('dsh-demo', { root }), false);
  assert.deepEqual(await readInstalled({ root }), []);
});

test('the install ledger is a JSON array under the root', async () => {
  const root = await makeRoot();
  await recordInstall(record, { root });
  const raw = JSON.parse(await readFile(join(root, 'installed.json'), 'utf8'));
  assert.deepEqual(raw, [record]);
  assert.equal(Array.isArray(raw), true);
  await writeFile(join(root, 'installed.json'), 'not json');
  assert.deepEqual(await readInstalled({ root }), []);
});
