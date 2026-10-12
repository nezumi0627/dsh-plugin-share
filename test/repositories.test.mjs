import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRepository, saveRepository } from '../lib/repositories.js';

test('repository targets persist by package name without storing credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-share-targets-'));
  try {
    assert.equal(await getRepository('@local/demo', { root }), undefined);
    const saved = await saveRepository('@local/demo', {
      owner: 'ren', repo: 'demo', url: 'https://github.com/ren/demo', private: false,
    }, { root });
    assert.deepEqual(saved, { owner: 'ren', repo: 'demo', url: 'https://github.com/ren/demo', private: false });
    assert.deepEqual(await getRepository('@local/demo', { root }), saved);
    const file = await readFile(join(root, 'repositories.json'), 'utf8');
    assert.doesNotMatch(file, /token|secret/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('repository settings reject malformed state and invalid package keys', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-share-targets-'));
  try {
    await assert.rejects(saveRepository('../outside', { owner: 'ren', repo: 'demo', url: 'https://github.com/ren/demo' }, { root }), /package name/);
    await assert.rejects(saveRepository('@local/demo', { owner: 'ren', repo: 'demo', url: 'https://example.com/ren/demo' }, { root }), /GitHub repository URL/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
