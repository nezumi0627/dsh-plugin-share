import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planPublish, runPublish } from '../lib/publish.js';

async function makePluginDir({ name = 'x-demo', version = '1.0.0' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'plugin-share-publish-'));
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name, version, private: true, type: 'module', description: 'a demo', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
  );
  await writeFile(join(dir, 'cordis.patch.yml'), "- insert:\n    - id: x-demo\n      name: 'x-demo'\n");
  await writeFile(join(dir, 'index.js'), 'export function apply(ctx) {}\n');
  return dir;
}

/** Records every command; answers only what a test overrides, and fails the rest. */
function makeRun(overrides = {}) {
  const calls = [];
  const run = async (cmd, args, options) => {
    calls.push({ cmd, args, cwd: options?.cwd, key: `${cmd} ${args.join(' ')}` });
    for (const [prefix, response] of Object.entries(overrides)) {
      if (`${cmd} ${args.join(' ')}`.startsWith(prefix)) {
        return typeof response === 'function' ? response(cmd, args) : response;
      }
    }
    return { code: 1, stdout: '', stderr: `no such command in this test: ${cmd} ${args.join(' ')}` };
  };
  run.calls = calls;
  run.keys = () => calls.map((call) => call.key);
  return run;
}

const GH_OK = { 'gh --version': { code: 0, stdout: 'gh version 2.0.0', stderr: '' } };
const DIRTY = { 'git status --porcelain': { code: 0, stdout: ' M index.js\n', stderr: '' } };

/** The same recorder, but for the publish run itself: commands succeed unless a test says otherwise. */
function makeRunOk(overrides = {}) {
  const run = makeRun(overrides);
  const plain = run;
  const wrapped = async (cmd, args, options) => {
    const call = await plain(cmd, args, options);
    if (call.stderr.startsWith('no such command in this test')) return { code: 0, stdout: '', stderr: '' };
    return call;
  };
  wrapped.calls = run.calls;
  wrapped.keys = run.keys;
  return wrapped;
}

async function plan(dir, overrides = {}, input = {}) {
  return await planPublish({ dir, owner: 'o', repo: 'x-demo', ...input, run: makeRun(overrides) });
}

test('planPublish describes exactly what it will publish', async () => {
  const dir = await makePluginDir();
  await mkdir(join(dir, '.git'), { recursive: true });
  await mkdir(join(dir, 'node_modules'), { recursive: true });
  await writeFile(join(dir, 'node_modules', 'x.js'), 'x');
  await writeFile(join(dir, 'debug.log'), 'x');
  const publishPlan = await plan(dir, GH_OK);
  assert.equal(publishPlan.name, 'x-demo');
  assert.equal(publishPlan.version, '1.0.0');
  assert.equal(publishPlan.tag, 'v1.0.0');
  assert.equal(publishPlan.visibility, 'public');
  assert.match(publishPlan.sha256, /^[0-9a-f]{64}$/);
  assert.equal(publishPlan.hasGit, true);
  assert.equal(publishPlan.hasRemote, false);
  assert.equal(publishPlan.ghAvailable, true);
  assert.equal(existsSync(publishPlan.tarballPath), true);
  assert.equal(existsSync(publishPlan.manifestPath), true);
  assert.equal(publishPlan.writesGitignore, true);
  const paths = publishPlan.files.map((file) => file.path);
  assert.ok(paths.includes('package.json'));
  assert.ok(paths.includes('index.js'));
  assert.ok(paths.includes('plugin-share.json'));
  assert.deepEqual(paths.filter((path) => /^(\.git|node_modules|dist)\//.test(path) || path.endsWith('.log')), []);
  assert.equal(publishPlan.totalBytes, publishPlan.files.reduce((sum, file) => sum + file.bytes, 0));
  assert.match(publishPlan.artifactUrl, /^https:\/\/github\.com\/o\/x-demo\/releases\/download\/v1\.0\.0\//);
});

test('runPublish runs git then gh, ending with the release', async () => {
  const dir = await makePluginDir();
  const publishPlan = await plan(dir, GH_OK);
  const run = makeRunOk({ ...DIRTY });
  const result = await runPublish(publishPlan, () => {}, { run });
  assert.equal(run.calls[0].key, 'git init');
  assert.equal(run.keys().at(-1), `gh release create v1.0.0 --title x-demo 1.0.0 --notes ${publishPlan.notes} ${publishPlan.tarballPath}`);
  assert.ok(run.keys().includes('git add -A'));
  assert.ok(run.keys().includes('git commit -m Share x-demo 1.0.0'));
  assert.ok(run.keys().includes('gh repo create o/x-demo --public --source . --push'));
  assert.ok(run.keys().includes('git tag v1.0.0'));
  assert.ok(run.keys().includes('git push origin v1.0.0'));
  assert.equal(result.tag, 'v1.0.0');
  assert.equal(result.repoHtmlUrl, 'https://github.com/o/x-demo');
  assert.equal(result.artifactUrl, publishPlan.artifactUrl);
});

test('runPublish does not commit when the working tree is clean', async () => {
  const dir = await makePluginDir();
  const publishPlan = await plan(dir, GH_OK);
  const run = makeRunOk({ 'git status --porcelain': { code: 0, stdout: '', stderr: '' } });
  await runPublish(publishPlan, () => {}, { run });
  assert.equal(run.keys().includes('git commit -m Share x-demo 1.0.0'), false);
  assert.equal(run.keys().at(-1), `gh release create v1.0.0 --title x-demo 1.0.0 --notes ${publishPlan.notes} ${publishPlan.tarballPath}`);
});

test('a failed repository creation stops before the release', async () => {
  const dir = await makePluginDir();
  const publishPlan = await plan(dir, GH_OK);
  const run = makeRunOk({
    ...DIRTY,
    'gh repo create': { code: 1, stdout: '', stderr: 'name already exists on this account' },
  });
  await assert.rejects(runPublish(publishPlan, () => {}, { run }), /repo create/);
  assert.equal(run.keys().some((key) => key.startsWith('gh release create')), false);
});

test('visibility private is passed through to gh', async () => {
  const dir = await makePluginDir();
  const publishPlan = await plan(dir, GH_OK, { visibility: 'private' });
  assert.equal(publishPlan.visibility, 'private');
  const run = makeRunOk({ ...DIRTY });
  await runPublish(publishPlan, () => {}, { run });
  assert.ok(run.keys().includes('gh repo create o/x-demo --private --source . --push'));
});

test('an existing tag refuses to publish', async () => {
  const dir = await makePluginDir();
  const publishPlan = await plan(dir, GH_OK);
  const run = makeRunOk({ ...DIRTY, 'git tag -l': { code: 0, stdout: 'v1.0.0\n', stderr: '' } });
  await assert.rejects(runPublish(publishPlan, () => {}, { run }), /already exists/);
  assert.equal(run.keys().some((key) => key.startsWith('gh release create')), false);
  assert.equal(run.keys().includes('git add -A'), false);
});

test('runPublish ignores dist/ before it commits', async () => {
  const dir = await makePluginDir();
  const publishPlan = await plan(dir, GH_OK);
  assert.equal(publishPlan.writesGitignore, true);
  const run = makeRunOk({ ...DIRTY });
  await runPublish(publishPlan, () => {}, { run });
  assert.match(await readFile(join(dir, '.gitignore'), 'utf8'), /^dist\/$/m);
  assert.equal(run.keys().includes('git add -A'), true);
});

test('without gh, the push path is used instead of creating a repository', async () => {
  const dir = await makePluginDir();
  const publishPlan = await plan(dir, { 'gh --version': { code: 1, stdout: '', stderr: 'gh: not found' } });
  assert.equal(publishPlan.ghAvailable, false);
  const run = makeRunOk({
    ...DIRTY,
    'gh release create': { code: 1, stdout: '', stderr: 'gh: not found' },
  });
  await assert.rejects(runPublish(publishPlan, () => {}, { run }), /release create/);
  assert.ok(run.keys().includes('git remote add origin https://github.com/o/x-demo.git'));
  assert.ok(run.keys().includes('git push -u origin HEAD'));
  assert.equal(run.keys().some((key) => key.startsWith('gh repo create')), false);
});

test('a plan reuses the previous created date so repeated sharing is reproducible', async () => {
  const dir = await makePluginDir();
  const pinned = { dir, created: '2026-10-11T00:00:00.000Z', run: makeRun() };
  const first = await planPublish(pinned);
  const second = await planPublish(pinned);
  assert.equal(first.created, '2026-10-11T00:00:00.000Z');
  assert.equal(first.sha256, second.sha256);

  // A later run without an explicit pin inherits the manifest date written by
  // the previous plan instead of changing the digest just because the clock moved.
  const loose = await planPublish({ dir, run: makeRun() });
  assert.equal(loose.created, first.created);
  assert.equal(loose.sha256, first.sha256);
});

test('a directory with no remote publishes to the account gh is logged in as', async () => {
  const dir = await makePluginDir();
  // No .git at all: the plugin has never been pushed, so there is no remote to read
  // an owner from. A literal "local" would plan a repository that cannot exist.
  const run = makeRun({ 'gh api user --jq .login': { code: 0, stdout: 'nezumi0627\n', stderr: '' } });
  const publishPlan = await planPublish({ dir, repo: 'x-demo', run });
  assert.equal(publishPlan.owner, 'nezumi0627');
  assert.equal(publishPlan.repoHtmlUrl, 'https://github.com/nezumi0627/x-demo');

  // A remote still wins, and an explicit owner wins over both.
  const withRemote = makeRun({
    'git config --get remote.origin.url': { code: 0, stdout: 'https://github.com/someone/x-demo.git\n', stderr: '' },
    'gh api user --jq .login': { code: 0, stdout: 'nezumi0627\n', stderr: '' },
  });
  assert.equal((await planPublish({ dir, repo: 'x-demo', run: withRemote })).owner, 'someone');
  assert.equal((await planPublish({ dir, owner: 'explicit', run })).owner, 'explicit');

  // When gh cannot answer, the earlier behaviour stands.
  assert.equal((await planPublish({ dir, repo: 'x-demo', run: makeRun() })).owner, 'local');
});
