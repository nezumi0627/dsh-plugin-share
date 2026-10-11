import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL('../bin/plugin-share.mjs', import.meta.url));

async function cli(...args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

async function makePluginDir({ name = 'x-demo', version = '1.0.0' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'plugin-share-cli-'));
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name, version, private: true, type: 'module', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
  );
  await writeFile(join(dir, 'cordis.patch.yml'), "- insert:\n    - id: x-demo\n      name: 'x-demo'\n");
  await writeFile(join(dir, 'index.js'), 'export function apply(ctx) {}\n');
  return dir;
}

test('--help names every command and exits 0', async () => {
  const result = await cli('--help');
  assert.equal(result.code, 0);
  for (const command of ['pack', 'inspect', 'verify', 'plugin-share']) {
    assert.match(result.stdout, new RegExp(command));
  }
});

test('install is not a command this side implements', async () => {
  const result = await cli('install', 'https://github.com/o/r');
  assert.equal(result.code, 2);
  assert.match(`${result.stdout}${result.stderr}`, /not available/);
});

test('pack writes the tarball, the repository manifest, and the digest', async () => {
  const dir = await makePluginDir();
  const result = await cli('pack', dir, '--repo', 'demo');
  assert.equal(result.code, 0);
  assert.equal(existsSync(join(dir, 'dist', 'x-demo-1.0.0.tgz')), true);
  const manifest = JSON.parse(await readFile(join(dir, 'plugin-share.json'), 'utf8'));
  assert.equal(manifest.name, 'x-demo');
  assert.equal(manifest.artifact.sha256.length, 64);
  assert.match(result.stdout, new RegExp(manifest.artifact.sha256));
  assert.equal(manifest.artifact.url, 'https://github.com/local/demo/releases/download/v1.0.0/x-demo-1.0.0.tgz');
});

test('pack honours --owner, --site and --created', async () => {
  const dir = await makePluginDir();
  const created = '2026-10-11T00:00:00.000Z';
  const result = await cli('pack', dir, '--owner', 'o', '--repo', 'x-demo', '--site', 'https://example.com', '--created', created);
  assert.equal(result.code, 0);
  const manifest = JSON.parse(await readFile(join(dir, 'plugin-share.json'), 'utf8'));
  assert.equal(manifest.author.github, 'o');
  assert.equal(manifest.author.site, 'https://example.com');
  assert.equal(manifest.created, created);
  const again = await cli('pack', dir, '--owner', 'o', '--repo', 'x-demo', '--site', 'https://example.com', '--created', created);
  assert.equal(again.code, 0);
  const second = JSON.parse(await readFile(join(dir, 'plugin-share.json'), 'utf8'));
  assert.equal(second.artifact.sha256, manifest.artifact.sha256);
});

test('verify accepts the published digest and refuses another', async () => {
  const dir = await makePluginDir();
  await cli('pack', dir, '--owner', 'o', '--repo', 'x-demo');
  const manifest = JSON.parse(await readFile(join(dir, 'plugin-share.json'), 'utf8'));
  const tarball = join(dir, 'dist', 'x-demo-1.0.0.tgz');
  const ok = await cli('verify', tarball, '--expect-sha256', manifest.artifact.sha256);
  assert.equal(ok.code, 0);
  assert.match(ok.stdout, new RegExp(manifest.artifact.sha256));
  const bad = await cli('verify', tarball, '--expect-sha256', 'b'.repeat(64));
  assert.equal(bad.code, 1);
  assert.match(`${bad.stdout}${bad.stderr}`, /sha256/);
});

test('verify without a digest still reports one', async () => {
  const dir = await makePluginDir();
  await cli('pack', dir, '--owner', 'o', '--repo', 'x-demo');
  const result = await cli('verify', join(dir, 'dist', 'x-demo-1.0.0.tgz'));
  assert.equal(result.code, 0);
  assert.match(result.stdout, /[0-9a-f]{64}/);
});

test('a missing argument is a usage error', async () => {
  assert.equal((await cli('pack')).code, 2);
  assert.equal((await cli('verify')).code, 2);
  assert.equal((await cli('inspect')).code, 2);
  assert.equal((await cli('nonsense')).code, 2);
});

test('pack without --owner says which account it assumed', async () => {
  const dir = await makePluginDir();
  const result = await cli('pack', dir, '--repo', 'demo');
  assert.equal(result.code, 0);
  assert.match(`${result.stdout}${result.stderr}`, /owner/);
});
