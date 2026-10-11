import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { validateManifest, defaultArtifactUrl } from '../lib/manifest.js';
import { packDirectory } from '../lib/pack.js';
import { sha256File } from '../lib/sha256.js';
import { readEntry, readTarball } from '../lib/tgz-read.js';

const PATCH = "- insert:\n    - id: x-demo\n      name: 'x-demo'\n";

async function makePlugin({ patch = true, extra = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'plugin-share-pack-'));
  const manifest = { name: 'x-demo', version: '1.0.0', private: true, type: 'module', ...extra };
  if (patch) manifest.dsh = { bundle: { patch: './cordis.patch.yml' } };
  await writeFile(join(dir, 'package.json'), JSON.stringify(manifest, null, 2));
  if (patch) await writeFile(join(dir, 'cordis.patch.yml'), PATCH);
  await writeFile(join(dir, 'index.js'), 'export function apply(ctx) {}\n');
  return dir;
}

function hasGit() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('packs a plugin with both manifests', async () => {
  const dir = await makePlugin();
  const result = await packDirectory(dir, { owner: 'nezumi0627', repo: 'x-demo' });
  const names = readTarball(result.tarballBytes).map((entry) => entry.name);
  assert.ok(names.includes('package/package.json'));
  assert.ok(names.includes('package/index.js'));
  assert.ok(names.includes('package/cordis.patch.yml'));
  assert.ok(names.includes('package/plugin-share.json'));
  const embedded = JSON.parse(readEntry(result.tarballBytes, 'package/plugin-share.json').toString('utf8'));
  assert.equal('artifact' in embedded, false);
  assert.equal(embedded.name, 'x-demo');
  assert.equal(validateManifest(embedded, 'embedded').ok, true);
  assert.equal(validateManifest(result.repoManifest, 'repo').ok, true);
});

test('the repo manifest digest matches the written file', async () => {
  const dir = await makePlugin();
  const result = await packDirectory(dir, { owner: 'o', repo: 'r' });
  assert.equal(result.manifestPath, join(dir, 'plugin-share.json'));
  assert.equal(result.tarballPath, join(dir, 'dist', 'x-demo-1.0.0.tgz'));
  assert.equal(result.sha256, await sha256File(result.tarballPath));
  assert.equal(result.repoManifest.artifact.sha256, result.sha256);
  assert.equal(result.repoManifest.artifact.bytes, result.tarballBytes.length);
  assert.equal(
    result.repoManifest.artifact.url,
    'https://github.com/o/r/releases/download/v1.0.0/x-demo-1.0.0.tgz',
  );
  assert.deepEqual(JSON.parse(await readFile(result.manifestPath, 'utf8')), result.repoManifest);
});

test('a package.json without dsh.bundle.patch is refused', async () => {
  const dir = await makePlugin({ patch: false });
  await assert.rejects(packDirectory(dir, { owner: 'o', repo: 'r' }), /dsh\.bundle\.patch/);
});

test('a declared patch file that does not exist is refused', async () => {
  const dir = await makePlugin();
  await rm(join(dir, 'cordis.patch.yml'));
  await assert.rejects(packDirectory(dir, { owner: 'o', repo: 'r' }), /cordis\.patch\.yml/);
});

test('node_modules, .git, dist, logs and a root manifest are excluded', async () => {
  const dir = await makePlugin();
  await mkdir(join(dir, 'node_modules'), { recursive: true });
  await writeFile(join(dir, 'node_modules', 'x.js'), 'x');
  await mkdir(join(dir, 'dist'), { recursive: true });
  await writeFile(join(dir, 'dist', 'old.tgz'), 'x');
  await mkdir(join(dir, '.git'), { recursive: true });
  await writeFile(join(dir, '.git', 'config'), 'x');
  await writeFile(join(dir, 'debug.log'), 'x');
  await writeFile(join(dir, 'plugin-share.json'), '{"decoy":true}');
  const result = await packDirectory(dir, { owner: 'o', repo: 'r' });
  const names = readTarball(result.tarballBytes).map((entry) => entry.name);
  assert.deepEqual(
    names.filter((name) => /node_modules|\.git|dist\/|\.log|plugin-share\.json/.test(name)),
    ['package/plugin-share.json'],
  );
  const embedded = JSON.parse(readEntry(result.tarballBytes, 'package/plugin-share.json').toString('utf8'));
  assert.equal(embedded.decoy, undefined);
});

test('packing twice with the same created value gives the same digest', async () => {
  const dir = await makePlugin();
  const first = await packDirectory(dir, { owner: 'o', repo: 'r', created: '2026-10-11T00:00:00.000Z' });
  const second = await packDirectory(dir, { owner: 'o', repo: 'r', created: '2026-10-11T00:00:00.000Z' });
  assert.equal(first.sha256, second.sha256);
});

test('a scoped package name produces an npm-style asset filename', async () => {
  const dir = await makePlugin({ extra: { name: '@local/x-demo' } });
  const result = await packDirectory(dir, { owner: 'o', repo: 'r' });
  assert.equal(basename(result.tarballPath), 'local-x-demo-1.0.0.tgz');
  assert.equal(
    result.repoManifest.artifact.url,
    'https://github.com/o/r/releases/download/v1.0.0/local-x-demo-1.0.0.tgz',
  );
  assert.equal(
    defaultArtifactUrl({ owner: 'o', repo: 'r', tag: 'v1.0.0', name: '@local/x-demo', version: '1.0.0' }),
    'https://github.com/o/r/releases/download/v1.0.0/local-x-demo-1.0.0.tgz',
  );
});

test('declared dependencies are reported as a warning', async () => {
  const dir = await makePlugin({ extra: { dependencies: { ms: '^2.1.3' } } });
  const result = await packDirectory(dir, { owner: 'o', repo: 'r' });
  assert.ok(result.warnings.some((warning) => warning.includes('ms')));
});

test('created defaults to the git commit date when the directory is a repository', async (t) => {
  if (!hasGit()) return t.skip('git is not available');
  const dir = await makePlugin();
  const env = {
    ...process.env,
    GIT_AUTHOR_DATE: '2026-01-02T03:04:05+09:00',
    GIT_COMMITTER_DATE: '2026-01-02T03:04:05+09:00',
  };
  const git = (...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { env, stdio: 'ignore' });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'x');
  const result = await packDirectory(dir, { owner: 'o', repo: 'r' });
  assert.equal(result.repoManifest.created, '2026-01-02T03:04:05+09:00');
  return undefined;
});
