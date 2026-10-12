import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertNoSecrets } from '../lib/secret-scan.js';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-secret-scan-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('blocks credential files before publication and never includes their contents in the error', async (t) => {
  const dir = await fixture(t);
  await writeFile(join(dir, 'package.json'), '{}');
  const credential = ['DATABASE_', 'PASSWORD=ultra-', 'secret-value-123456'].join('');
  await writeFile(join(dir, '.env.production'), credential);
  assert.throws(() => assertNoSecrets(dir), (error) => {
    assert.match(error.message, /\.env\.production/);
    assert.doesNotMatch(error.message, /ultra-secret-value/);
    return true;
  });
});

test('blocks common provider tokens and private keys in otherwise ordinary source files', async (t) => {
  const dir = await fixture(t);
  const fakeToken = ['ghp_', '123456789012345678901234567890123456'].join('');
  await writeFile(join(dir, 'client.js'), `const token = "${fakeToken}";`);
  assert.throws(() => assertNoSecrets(dir), /client\.js/);
});

test('detects credential assignments with application-specific prefixes', async (t) => {
  const dir = await fixture(t);
  const assignment = ['DATABASE_', 'PASSWORD=database-', 'password-value-12345'].join('');
  await writeFile(join(dir, 'config.js'), `const env = "${assignment}";`);
  assert.throws(() => assertNoSecrets(dir), /config\.js/);
});

test('allows examples and source code without secret-like values', async (t) => {
  const dir = await fixture(t);
  await mkdir(join(dir, 'src'));
  await writeFile(join(dir, '.env.example'), 'API_KEY=replace-me');
  await writeFile(join(dir, 'src', 'index.js'), 'export const greeting = "hello";');
  assert.equal(assertNoSecrets(dir), true);
});
