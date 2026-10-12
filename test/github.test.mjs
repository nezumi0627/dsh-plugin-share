import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectEntries } from '../lib/pack.js';
import { githubIdentity, parseGitHubRepositoryUrl, publishToGitHub, validateGitHubRepository } from '../lib/github.js';
import { catalogReleaseTag } from '../lib/catalog.js';

function catalogApi() {
  const blobs = new Map();
  const trees = new Map();
  const commits = new Map();
  const releases = new Map();
  const assetBytes = new Map();
  const writes = [];
  let branch;
  let next = 0;
  const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    const path = url.pathname.replace(/^\/repos\/ren\/catalog/, '');
    if (method !== 'GET') writes.push(`${method} ${path}`);
    if (url.hostname === 'uploads.github.com') {
      const id = Number(url.pathname.match(/releases\/(\d+)/)?.[1]);
      const release = [...releases.values()].find((item) => item.id === id);
      const name = url.searchParams.get('name');
      const assetId = ++next;
      const bytes = Buffer.from(init.body);
      assetBytes.set(assetId, bytes);
      release.assets.push({ id: assetId, name, size: bytes.length, url: `https://api.github.com/repos/ren/catalog/releases/assets/${assetId}` });
      return response({ name }, 201);
    }
    const assetRoute = path.match(/^\/releases\/assets\/(\d+)$/);
    if (assetRoute && method === 'GET') return new Response(assetBytes.get(Number(assetRoute[1])), { status: 200 });
    if (path === '' && method === 'GET') return response({ permissions: { push: true }, default_branch: 'main', private: false });
    if (path.startsWith('/releases/tags/') && method === 'GET') {
      const tag = decodeURIComponent(path.slice('/releases/tags/'.length));
      const release = releases.get(tag);
      return release ? response(release) : response({ message: 'Not Found' }, 404);
    }
    if (path.startsWith('/git/ref/tags/') && method === 'GET') return response({ message: 'Not Found' }, 404);
    if (path === '/git/ref/heads/main' && method === 'GET') return branch ? response({ object: { sha: branch } }) : response({ message: 'Not Found' }, 404);
    if (path.startsWith('/git/commits/') && method === 'GET') return response({ tree: { sha: commits.get(decodeURIComponent(path.slice('/git/commits/'.length))) } });
    if (path.startsWith('/git/trees/') && method === 'GET') {
      const sha = decodeURIComponent(path.slice('/git/trees/'.length).split('?')[0]);
      return response({ tree: [...(trees.get(sha) ?? new Map())].map(([entryPath, blobSha]) => ({ path: entryPath, type: 'blob', sha: blobSha })) });
    }
    if (path.startsWith('/git/blobs/') && method === 'GET') return response({ encoding: 'base64', content: blobs.get(decodeURIComponent(path.slice('/git/blobs/'.length))).toString('base64') });
    if (path === '/git/blobs' && method === 'POST') {
      const body = JSON.parse(init.body);
      const sha = `blob-${++next}`;
      blobs.set(sha, Buffer.from(body.content, body.encoding));
      return response({ sha }, 201);
    }
    if (path === '/git/trees' && method === 'POST') {
      const body = JSON.parse(init.body);
      const map = new Map(body.base_tree ? trees.get(body.base_tree) : []);
      for (const item of body.tree) map.set(item.path, item.sha);
      const sha = `tree-${++next}`;
      trees.set(sha, map);
      return response({ sha }, 201);
    }
    if (path === '/git/commits' && method === 'POST') {
      const body = JSON.parse(init.body);
      const sha = `commit-${++next}`;
      commits.set(sha, body.tree);
      return response({ sha }, 201);
    }
    if (path === '/git/refs' && method === 'POST') {
      branch = JSON.parse(init.body).sha;
      return response({ ref: 'refs/heads/main' }, 201);
    }
    if (path === '/git/ref/heads/main' && method === 'PATCH') {
      branch = JSON.parse(init.body).sha;
      return response({ ref: 'refs/heads/main' });
    }
    if (path === '/releases' && method === 'POST') {
      const body = JSON.parse(init.body);
      const release = { id: ++next, tag_name: body.tag_name, draft: true, html_url: `https://github.com/ren/catalog/releases/tag/${body.tag_name}`, upload_url: `https://uploads.github.com/repos/ren/catalog/releases/${next}/assets{?name,label}`, assets: [] };
      releases.set(body.tag_name, release);
      return response(release, 201);
    }
    const patchRelease = path.match(/^\/releases\/(\d+)$/);
    if (patchRelease && method === 'PATCH') {
      const release = [...releases.values()].find((item) => item.id === Number(patchRelease[1]));
      Object.assign(release, JSON.parse(init.body));
      return response(release);
    }
    assert.fail(`unexpected ${method} ${url.href}`);
  };
  return { fetchImpl, writes, blobs, trees, commits, releases, assetBytes };
}

test('shared catalog publishes two same-version plugins, preserves the index, and repeats idempotently', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-catalog-github-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'package.json'), '{"name":"demo","version":"1.0.0"}');
  await writeFile(join(dir, 'index.js'), 'export const value = true;');
  const assetPath = join(dir, 'demo.tgz');
  await writeFile(assetPath, 'plugin asset one');
  const repo = { owner: 'ren', repo: 'catalog', url: 'https://github.com/ren/catalog' };
  const remote = catalogApi();
  const originalDigest = createHash('sha256').update('plugin asset one').digest('hex');
  const makePlan = async (name, summary, asset, digest) => ({
    dir, name, version: '1.0.0', summary, tag: catalogReleaseTag(name, '1.0.0'), releaseName: `${name} 1.0.0`, notes: summary,
    tarballPath: assetPath, tarballBytes: Buffer.byteLength(asset), sha256: digest,
    artifactUrl: `https://github.com/ren/catalog/releases/download/${catalogReleaseTag(name, '1.0.0')}/${name}-1.0.0-${digest.slice(0, 16)}.tgz`,
  });
  const first = await makePlan('demo', 'first plugin', 'plugin asset one', originalDigest);
  const firstResult = await publishToGitHub(first, repo, { token: 'token', fetchImpl: remote.fetchImpl, catalogMode: true });
  assert.match(firstResult.catalogUrl, /blob\/main\/README\.md$/);

  const second = await makePlan('other', 'second plugin', 'plugin asset one', originalDigest);
  await publishToGitHub(second, repo, { token: 'token', fetchImpl: remote.fetchImpl, catalogMode: true });
  const latestCommit = [...remote.commits.keys()].at(-1);
  const catalogTree = remote.trees.get(remote.commits.get(latestCommit));
  const catalog = JSON.parse(remote.blobs.get(catalogTree.get('catalog.json')).toString('utf8'));
  assert.deepEqual(catalog.plugins.map((entry) => entry.name), ['demo', 'other']);
  assert.notEqual(first.tag, second.tag);
  const writesBeforeRepeat = remote.writes.length;
  const repeated = await publishToGitHub(second, repo, { token: 'token', fetchImpl: remote.fetchImpl, catalogMode: true });
  assert.equal(repeated.unchanged, true);
  assert.equal(remote.writes.length, writesBeforeRepeat);
  const secondAsset = remote.releases.get(second.tag).assets[0];
  remote.assetBytes.set(secondAsset.id, Buffer.from('tampered asset!!'));
  await assert.rejects(publishToGitHub(second, repo, { token: 'token', fetchImpl: remote.fetchImpl, catalogMode: true }), /does not match the confirmed SHA-256/);
  assert.equal(remote.writes.length, writesBeforeRepeat);

  await writeFile(assetPath, 'changed asset bytes');
  const changedDigest = createHash('sha256').update('changed asset bytes').digest('hex');
  const changed = { ...first, tarballBytes: Buffer.byteLength('changed asset bytes'), sha256: changedDigest, artifactUrl: `https://github.com/ren/catalog/releases/download/${first.tag}/demo-1.0.0-${changedDigest.slice(0, 16)}.tgz` };
  const changedResult = await publishToGitHub(changed, repo, { token: 'token', fetchImpl: remote.fetchImpl, catalogMode: true });
  assert.equal(changedResult.updated, true);
  const finalCommit = [...remote.commits.keys()].at(-1);
  const finalTree = remote.trees.get(remote.commits.get(finalCommit));
  const finalCatalog = JSON.parse(remote.blobs.get(finalTree.get('catalog.json')).toString('utf8'));
  assert.deepEqual(finalCatalog.plugins.map((entry) => entry.name), ['demo', 'other']);
  assert.equal(finalCatalog.plugins[0].sha256, changedDigest);
  const readme = remote.blobs.get(finalTree.get('README.md')).toString('utf8');
  assert.match(readme, /first plugin|first plugin/);
  assert.match(readme, /second plugin/);
});

test('shared catalog refuses bytes that no longer match the confirmed digest before any write', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-catalog-digest-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'package.json'), '{"name":"demo","version":"1.0.0"}');
  const assetPath = join(dir, 'demo.tgz');
  await writeFile(assetPath, 'different bytes');
  const remote = catalogApi();
  await assert.rejects(publishToGitHub({
    dir, name: 'demo', version: '1.0.0', summary: 'demo', tag: 'demo-v1.0.0', sha256: 'a'.repeat(64),
    tarballPath: assetPath, artifactUrl: 'https://github.com/ren/catalog/releases/download/demo-v1.0.0/demo.tgz',
  }, { owner: 'ren', repo: 'catalog', url: 'https://github.com/ren/catalog' }, {
    token: 'token', fetchImpl: remote.fetchImpl, catalogMode: true,
  }), /changed after confirmation/);
  assert.deepEqual(remote.writes, []);
});

test('repository URLs accept only a GitHub owner and repository', () => {
  assert.deepEqual(parseGitHubRepositoryUrl('https://github.com/ren/plugin'), {
    owner: 'ren', repo: 'plugin', url: 'https://github.com/ren/plugin',
  });
  assert.deepEqual(parseGitHubRepositoryUrl('https://github.com/ren/plugin.git/'), {
    owner: 'ren', repo: 'plugin', url: 'https://github.com/ren/plugin',
  });
  for (const value of [
    'https://github.com/ren',
    'https://github.com/ren/plugin/issues',
    'http://github.com/ren/plugin',
    'https://github.com.evil.test/ren/plugin',
    'https://github.com/ren/%2Fplugin',
    'https://user:pass@github.com/ren/plugin',
  ]) assert.throws(() => parseGitHubRepositoryUrl(value), /GitHub repository URL/);
});

test('GitHub identity comes from gh and hides command output on failure', async () => {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd, args]);
    if (args[0] === 'api') return { code: 0, stdout: 'ren\n', stderr: '' };
    return { code: 1, stdout: '', stderr: 'sensitive process output' };
  };
  assert.deepEqual(await githubIdentity({ run }), { login: 'ren' });
  assert.ok(calls.some(([, args]) => args.join(' ').includes('api user')));
  await assert.rejects(githubIdentity({ run: async () => ({ code: 1, stdout: 'secret-token', stderr: 'bad token' }) }), (error) => {
    assert.match(error.message, /Connect GitHub/);
    assert.doesNotMatch(error.message, /secret-token|bad token/);
    return true;
  });
});

test('repository validation requires write access', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ full_name: 'ren/plugin', private: false, default_branch: 'main', permissions: { push: true } }), { status: 200 });
  };
  const checked = await validateGitHubRepository('https://github.com/ren/plugin', 'token', { fetchImpl });
  assert.deepEqual(checked, { owner: 'ren', repo: 'plugin', url: 'https://github.com/ren/plugin', private: false, defaultBranch: 'main' });
  assert.equal(calls[0].init.headers.authorization, 'Bearer token');
  await assert.rejects(
    validateGitHubRepository('https://github.com/ren/plugin', 'token', {
      fetchImpl: async () => new Response(JSON.stringify({ permissions: { push: false } }), { status: 200 }),
    }),
    /write access/,
  );
});

test('publishing commits source through GitHub API and publishes a release asset', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-plugin-share-github-'));
  try {
    await mkdir(join(dir, 'src'));
    await mkdir(join(dir, 'dist'));
    await writeFile(join(dir, 'package.json'), '{"name":"@local/demo","version":"1.2.0"}');
    await writeFile(join(dir, 'src', 'index.js'), 'export const value = 1;');
    await writeFile(join(dir, 'cordis.patch.yml'), '- insert: []\n');
    const manifest = '{"share":1,"name":"@local/demo","version":"1.2.0"}';
    await writeFile(join(dir, 'plugin-share.json'), manifest);
    const assetPath = join(dir, 'dist', 'demo.tgz');
    await writeFile(assetPath, Buffer.from('test tarball'));

    const calls = [];
    const routes = [
      { match: '/repos/ren/demo', method: 'GET', status: 200, body: { default_branch: 'main', permissions: { push: true } } },
      { match: '/releases/tags/v1.2.0', method: 'GET', status: 404, body: { message: 'Not Found' } },
      { match: '/git/ref/tags/v1.2.0', method: 'GET', status: 404, body: { message: 'Not Found' } },
      { match: '/git/ref/heads/main', method: 'GET', status: 200, body: { object: { sha: 'parent' } } },
      { match: '/git/commits/parent', method: 'GET', status: 200, body: { tree: { sha: 'base-tree' } } },
      { match: '/git/trees/base-tree', method: 'GET', status: 200, body: { tree: [] } },
      { match: '/git/blobs', method: 'POST', status: 201, body: { sha: 'blob-1' } },
      { match: '/git/blobs', method: 'POST', status: 201, body: { sha: 'blob-2' } },
      { match: '/git/blobs', method: 'POST', status: 201, body: { sha: 'blob-3' } },
      { match: '/git/blobs', method: 'POST', status: 201, body: { sha: 'blob-4' } },
      { match: '/git/trees', method: 'POST', status: 201, body: { sha: 'tree' } },
      { match: '/git/commits', method: 'POST', status: 201, body: { sha: 'commit' } },
      { match: '/git/ref/heads/main', method: 'PATCH', status: 200, body: { ref: 'refs/heads/main' } },
      { match: '/releases', method: 'POST', status: 201, body: { id: 7, upload_url: 'https://uploads.github.com/repos/ren/demo/releases/7/assets{?name,label}', html_url: 'https://github.com/ren/demo/releases/tag/v1.2.0' } },
      { match: '/assets', method: 'POST', host: 'uploads.github.com', status: 201, body: { name: 'demo.tgz' } },
      { match: '/releases/7', method: 'PATCH', status: 200, body: { html_url: 'https://github.com/ren/demo/releases/tag/v1.2.0' } },
    ];
    const fetchImpl = async (input, init = {}) => {
      const url = new URL(input);
      const method = init.method ?? 'GET';
      calls.push({ url, init, body: init.body });
      const index = routes.findIndex((route) =>
        url.pathname.endsWith(route.match) && (route.method === undefined || route.method === method) &&
        (route.host === undefined || route.host === url.hostname));
      assert.notEqual(index, -1, `${method} ${url.href} was not expected`);
      const [route] = routes.splice(index, 1);
      assert.equal(method, route.method);
      if (route.host) {
        assert.equal(url.hostname, route.host);
        assert.equal(url.searchParams.get('name'), 'demo.tgz');
      }
      if (route.match === '/git/blobs') assert.equal(JSON.parse(init.body).encoding, 'base64');
      if (route.match === '/git/tree') assert.ok(JSON.parse(init.body).tree.some((entry) => entry.path === 'plugin-share.json'));
      if (route.host) assert.equal(Buffer.from(init.body).toString(), 'test tarball');
      return new Response(JSON.stringify(route.body), { status: route.status });
    };

    const progress = [];
    const published = await publishToGitHub({
      dir,
      name: '@local/demo',
      version: '1.2.0',
      tag: 'v1.2.0',
      releaseName: '@local/demo 1.2.0',
      notes: 'Install this plugin',
      tarballPath: assetPath,
      files: [{ path: 'package.json' }, { path: 'src/index.js' }, { path: 'cordis.patch.yml' }, { path: 'plugin-share.json' }],
    }, { owner: 'ren', repo: 'demo', url: 'https://github.com/ren/demo' }, {
      token: 'token', fetchImpl, onProgress: (stage) => progress.push(stage),
    });

    assert.equal(published.repoHtmlUrl, 'https://github.com/ren/demo');
    assert.equal(published.artifactUrl, 'https://github.com/ren/demo/releases/download/v1.2.0/demo.tgz');
    assert.deepEqual(routes, []);
    assert.ok(progress.includes('source'));
    assert.ok(progress.includes('release'));
    assert.ok(calls.every((call) => call.init.headers.authorization === 'Bearer token'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('publishing refuses an orphaned version tag with no release to update', async () => {
  let call = 0;
  await assert.rejects(
    publishToGitHub({ owner: 'ren', repo: 'demo', tag: 'v1.2.0' }, { owner: 'ren', repo: 'demo' }, {
      token: 'token',
      fetchImpl: async () => {
        const step = call++;
        if (step === 0) return new Response(JSON.stringify({ permissions: { push: true }, default_branch: 'main' }), { status: 200 });
        if (step === 1) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
        return new Response(JSON.stringify({ object: { sha: 'tag' } }), { status: 200 });
      },
    }),
    /already exists/,
  );
});

test('an identical tree and release return the same artifact without writing to GitHub', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-plugin-share-idempotent-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'package.json'), '{"name":"demo","version":"1.0.0"}');
  await writeFile(join(dir, 'plugin-share.json'), '{"share":1,"name":"demo","version":"1.0.0"}\n');
  await writeFile(join(dir, 'index.js'), 'export const ok = true;');
  await mkdir(join(dir, 'dist'));
  const entries = collectEntries(dir).filter((entry) => !entry.name.endsWith('/')).map((entry) => ({
    path: entry.name.slice('package/'.length),
    sha: createHash('sha1').update(`blob ${entry.data.length}\0`).update(entry.data).digest('hex'),
    type: 'blob',
  }));
  entries.push({
    path: 'plugin-share.json',
    sha: createHash('sha1').update(`blob ${Buffer.byteLength('{"share":1,"name":"demo","version":"1.0.0"}\n')}\0`).update('{"share":1,"name":"demo","version":"1.0.0"}\n').digest('hex'),
    type: 'blob',
  });
  const assetPath = join(dir, 'dist', 'demo.tgz');
  await writeFile(assetPath, 'artifact');
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    calls.push(`${method} ${url.pathname}`);
    const responses = {
      'GET /repos/ren/demo': { permissions: { push: true }, default_branch: 'main', private: false },
      'GET /repos/ren/demo/releases/tags/v1.0.0': { id: 9, draft: false, html_url: 'https://github.com/ren/demo/releases/tag/v1.0.0' },
      'GET /repos/ren/demo/git/ref/heads/main': { object: { sha: 'parent' } },
      'GET /repos/ren/demo/git/commits/parent': { tree: { sha: 'tree-sha' } },
      'GET /repos/ren/demo/git/trees/tree-sha': { tree: entries },
    };
    const body = responses[`${method} ${url.pathname}`];
    assert.ok(body, `unexpected write or route: ${method} ${url.href}`);
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const result = await publishToGitHub({
    dir, name: 'demo', tag: 'v1.0.0', tarballPath: assetPath,
    artifactUrl: 'https://github.com/ren/demo/releases/download/v1.0.0/demo-abc123.tgz',
  }, { owner: 'ren', repo: 'demo', url: 'https://github.com/ren/demo' }, { token: 'token', fetchImpl });
  assert.equal(result.unchanged, true);
  assert.equal(result.artifactUrl, 'https://github.com/ren/demo/releases/download/v1.0.0/demo-abc123.tgz');
  assert.equal(calls.length, 5);
});

test('a changed tree updates the existing release and moves its tag', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-plugin-share-update-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'dist'));
  await writeFile(join(dir, 'package.json'), '{"name":"demo","version":"1.0.0"}');
  await writeFile(join(dir, 'plugin-share.json'), '{"share":1,"name":"demo","version":"1.0.0"}\n');
  await writeFile(join(dir, 'index.js'), 'export const value = "new";');
  const assetPath = join(dir, 'dist', 'demo.tgz');
  await writeFile(assetPath, 'new artifact');
  const entries = collectEntries(dir).filter((entry) => !entry.name.endsWith('/')).map((entry) => ({
    path: entry.name.slice('package/'.length),
    sha: createHash('sha1').update(`blob ${entry.data.length}\0`).update(entry.data).digest('hex'),
    type: 'blob',
  }));
  const stale = entries.map((entry) => entry.path === 'index.js' ? { ...entry, sha: 'old-blob' } : entry);
  stale.push({ path: 'plugin-share.json', sha: createHash('sha1').update(`blob ${Buffer.byteLength('{"share":1,"name":"demo","version":"1.0.0"}\n')}\0`).update('{"share":1,"name":"demo","version":"1.0.0"}\n').digest('hex'), type: 'blob' });
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    calls.push({ method, url, body: init.body });
    let status = 200;
    let body;
    if (url.pathname === '/repos/ren/demo' && method === 'GET') body = { permissions: { push: true }, default_branch: 'main', private: false };
    else if (url.pathname.endsWith('/releases/tags/v1.0.0') && method === 'GET') body = { id: 9, draft: false, html_url: 'https://github.com/ren/demo/releases/tag/v1.0.0', upload_url: 'https://uploads.github.com/repos/ren/demo/releases/9/assets{?name,label}', assets: [] };
    else if (url.pathname.endsWith('/git/ref/heads/main') && method === 'GET') body = { object: { sha: 'parent' } };
    else if (url.pathname.endsWith('/git/commits/parent') && method === 'GET') body = { tree: { sha: 'base-tree' } };
    else if (url.pathname.endsWith('/git/trees/base-tree') && method === 'GET') body = { tree: stale };
    else if (url.pathname.endsWith('/git/blobs') && method === 'POST') body = { sha: 'new-blob' };
    else if (url.pathname.endsWith('/git/trees') && method === 'POST') body = { sha: 'new-tree' };
    else if (url.pathname.endsWith('/git/commits') && method === 'POST') body = { sha: 'new-commit' };
    else if (url.pathname.endsWith('/git/ref/heads/main') && method === 'PATCH') body = { ref: 'refs/heads/main' };
    else if (url.hostname === 'uploads.github.com' && method === 'POST') { assert.equal(url.searchParams.get('name'), 'demo-new.tgz'); body = { name: 'demo-new.tgz' }; status = 201; }
    else if (url.pathname.endsWith('/git/refs/tags/v1.0.0') && method === 'PATCH') { assert.deepEqual(JSON.parse(init.body), { sha: 'new-commit', force: true }); body = { ref: 'refs/tags/v1.0.0' }; }
    else if (url.pathname.endsWith('/releases/9') && method === 'PATCH') { body = { id: 9, html_url: 'https://github.com/ren/demo/releases/tag/v1.0.0' }; }
    else assert.fail(`unexpected ${method} ${url.href}`);
    return new Response(JSON.stringify(body), { status });
  };
  const result = await publishToGitHub({
    dir, name: 'demo', tag: 'v1.0.0', releaseName: 'demo 1.0.0', notes: 'updated',
    tarballPath: assetPath, artifactUrl: 'https://github.com/ren/demo/releases/download/v1.0.0/demo-new.tgz',
  }, { owner: 'ren', repo: 'demo', url: 'https://github.com/ren/demo' }, { token: 'token', fetchImpl });
  assert.equal(result.updated, true);
  assert.ok(calls.some((call) => call.url.pathname.endsWith('/git/refs/tags/v1.0.0')));
});
