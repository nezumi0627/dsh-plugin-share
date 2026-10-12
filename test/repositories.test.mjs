import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRepository, saveRepository } from '../lib/repositories.js';

test('one repository target is shared by every package without storing credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-share-targets-'));
  try {
    assert.equal(await getRepository('@local/demo', { root }), undefined);
    const saved = await saveRepository('@local/demo', {
      owner: 'ren', repo: 'demo', url: 'https://github.com/ren/demo', private: false,
    }, { root });
    assert.deepEqual(saved, { owner: 'ren', repo: 'demo', url: 'https://github.com/ren/demo', private: false });
    assert.deepEqual(await getRepository('@local/demo', { root }), saved);
    assert.deepEqual(await getRepository('@local/another', { root }), saved);
    const file = await readFile(join(root, 'repositories.json'), 'utf8');
    assert.doesNotMatch(file, /token|secret/i);
    assert.match(file, /"version": 2/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('legacy per-package settings migrate only when they name one repository', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-share-targets-'));
  try {
    await writeFile(join(root, 'repositories.json'), JSON.stringify({
      version: 1,
      repositories: {
        '@local/a': { owner: 'ren', repo: 'catalog', url: 'https://github.com/ren/catalog' },
        '@local/b': { owner: 'ren', repo: 'catalog', url: 'https://github.com/ren/catalog' },
      },
    }));
    assert.deepEqual(await getRepository('@local/other', { root }), {
      owner: 'ren', repo: 'catalog', url: 'https://github.com/ren/catalog', private: false,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ambiguous legacy repositories require setup again', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-share-targets-'));
  try {
    await writeFile(join(root, 'repositories.json'), JSON.stringify({
      version: 1,
      repositories: {
        '@local/a': { owner: 'ren', repo: 'one', url: 'https://github.com/ren/one' },
        '@local/b': { owner: 'ren', repo: 'two', url: 'https://github.com/ren/two' },
      },
    }));
    assert.equal(await getRepository('@local/other', { root }), undefined);
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
