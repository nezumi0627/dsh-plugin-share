/** Host-only GitHub auth and REST API publishing. Tokens never leave this module. */
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { collectEntries } from './pack.js';
import { defaultRun } from './publish.js';
import { assertNoSecrets } from './secret-scan.js';
import { mergeCatalogReadme, upsertCatalogEntry, validateCatalog } from './catalog.js';

const API = 'https://api.github.com';
const API_VERSION = '2022-11-28';

/** Start GitHub CLI's browser/device login without exposing its clipboard code. */
export function startGitHubDeviceLogin({ spawnImpl = spawn } = {}) {
  return spawnImpl('gh', ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--clipboard', '--skip-ssh-key'], {
    stdio: 'ignore', windowsHide: true,
  });
}

/** Parse a plain github.com repository URL, rejecting paths and credentials. */
export function parseGitHubRepositoryUrl(input) {
  if (typeof input !== 'string') throw new Error('Enter a GitHub repository URL, such as https://github.com/owner/repo.');
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error('Enter a GitHub repository URL, such as https://github.com/owner/repo.');
  }
  const parts = url.pathname.split('/').filter(Boolean);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' || parts.length !== 2) {
    throw new Error('Enter a GitHub repository URL, such as https://github.com/owner/repo.');
  }
  const owner = decodeURIComponent(parts[0]);
  let repo = decodeURIComponent(parts[1]);
  if (repo.endsWith('.git')) repo = repo.slice(0, -4);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner) ||
      !/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/.test(repo) ||
      owner.includes('..') || repo.includes('..')) {
    throw new Error('Enter a GitHub repository URL, such as https://github.com/owner/repo.');
  }
  return { owner, repo, url: `https://github.com/${owner}/${repo}` };
}

/** Return only the account name; gh's error output may contain credential details. */
export async function githubIdentity({ run = defaultRun, cwd = process.cwd() } = {}) {
  let result;
  try {
    result = await run('gh', ['api', 'user', '--jq', '.login'], { cwd });
  } catch {
    throw new Error('GitHub is not connected. Select Connect GitHub and finish the browser sign-in.');
  }
  const login = result.code === 0 ? result.stdout.trim() : '';
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(login)) {
    throw new Error('GitHub is not connected. Select Connect GitHub and finish the browser sign-in.');
  }
  return { login };
}

/** Read a token only for a Host-side API call. Never include this result in a response. */
export async function githubToken({ run = defaultRun, cwd = process.cwd() } = {}) {
  let result;
  try {
    result = await run('gh', ['auth', 'token', '--hostname', 'github.com'], { cwd });
  } catch {
    throw new Error('GitHub is not connected. Select Connect GitHub and finish the browser sign-in.');
  }
  const token = result.code === 0 ? result.stdout.trim() : '';
  if (token === '' || /\s/.test(token)) {
    throw new Error('GitHub is not connected. Select Connect GitHub and finish the browser sign-in.');
  }
  return token;
}

async function request(path, token, { fetchImpl = fetch, method = 'GET', body, headers = {}, allowNotFound = false } = {}) {
  const response = await fetchImpl(path.startsWith('https://') ? path : `${API}${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': API_VERSION,
      ...(body instanceof Uint8Array ? { 'content-type': 'application/gzip' } : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: body instanceof Uint8Array ? body : JSON.stringify(body) }),
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }
  if (allowNotFound && response.status === 404) return undefined;
  if (!response.ok) {
    const detail = typeof payload?.message === 'string' ? payload.message : `HTTP ${response.status}`;
    throw new Error(`GitHub API refused the request: ${detail}`);
  }
  return payload;
}

/** Validate the URL and confirm that the authenticated account can push to it. */
export async function validateGitHubRepository(input, token, opts = {}) {
  const repo = parseGitHubRepositoryUrl(input);
  let details;
  try {
    details = await request(`/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`, token, opts);
  } catch (error) {
    throw new Error(`Cannot access ${repo.url}. Check the URL and GitHub permissions. ${error.message}`);
  }
  if (details?.permissions?.push !== true) {
    throw new Error(`The connected GitHub account does not have write access to ${repo.url}.`);
  }
  return { ...repo, private: details.private === true, defaultBranch: details.default_branch ?? '' };
}

function sourceEntries(plan) {
  const entries = collectEntries(plan.dir)
    .filter((entry) => !entry.name.endsWith('/'))
    .map((entry) => ({ path: entry.name.slice('package/'.length), content: entry.data }));
  if (entries.length === 0) throw new Error('The plugin contains no files to publish.');
  return entries;
}

function gitBlobSha(content) {
  return createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}

function releasedResult(plan, repository, release, isPrivate, unchanged, updated = false) {
  const fallbackAsset = basename(plan.tarballPath);
  return {
    repoHtmlUrl: repository.url ?? `https://github.com/${repository.owner}/${repository.repo}`,
    artifactUrl: plan.artifactUrl ?? `https://github.com/${repository.owner}/${repository.repo}/releases/download/${encodeURIComponent(plan.tag)}/${encodeURIComponent(fallbackAsset)}`,
    releaseUrl: release.html_url,
    tag: plan.tag,
    private: isPrivate,
    unchanged,
    updated,
  };
}

async function readCatalogSnapshot(prefix, token, branch, fetchImpl) {
  const ref = await request(`${prefix}/git/ref/heads/${encodeURIComponent(branch)}`, token, { fetchImpl, allowNotFound: true });
  if (ref === undefined) return { branch, commit: undefined, catalog: { version: 1, plugins: [] }, readme: '' };
  const commitSha = ref.object?.sha;
  if (typeof commitSha !== 'string') throw new Error('The shared repository branch is invalid; no changes were published.');
  const commit = await request(`${prefix}/git/commits/${encodeURIComponent(commitSha)}`, token, { fetchImpl });
  const tree = await request(`${prefix}/git/trees/${encodeURIComponent(commit.tree.sha)}?recursive=1`, token, { fetchImpl });
  if (tree.truncated) throw new Error('The shared repository is too large to update safely; no files were published.');
  const files = new Map((tree.tree ?? []).filter((item) => item.type === 'blob').map((item) => [item.path, item.sha]));
  const readFile = async (path) => {
    const sha = files.get(path);
    if (sha === undefined) return undefined;
    const blob = await request(`${prefix}/git/blobs/${encodeURIComponent(sha)}`, token, { fetchImpl });
    if (blob.encoding !== 'base64' || typeof blob.content !== 'string') throw new Error(`The shared repository file ${path} could not be decoded safely.`);
    return Buffer.from(blob.content, 'base64').toString('utf8');
  };
  const rawCatalog = await readFile('catalog.json');
  let catalog = { version: 1, plugins: [] };
  if (rawCatalog !== undefined) {
    try { catalog = JSON.parse(rawCatalog); } catch { throw new Error('The shared repository catalog is invalid; no changes were published.'); }
    validateCatalog(catalog);
  }
  return { branch, commit: commitSha, catalog, readme: (await readFile('README.md')) ?? '' };
}

async function writeCatalogSnapshot(prefix, token, snapshot, catalog, fetchImpl) {
  const contents = [
    { path: 'catalog.json', content: `${JSON.stringify(catalog, null, 2)}\n` },
    { path: 'README.md', content: mergeCatalogReadme(snapshot.readme, catalog.plugins) },
  ];
  const blobs = await Promise.all(contents.map(({ content }) => request(`${prefix}/git/blobs`, token, {
    fetchImpl, method: 'POST', body: { content: Buffer.from(content).toString('base64'), encoding: 'base64' },
  })));
  const currentCommit = snapshot.commit === undefined ? undefined : await request(`${prefix}/git/commits/${encodeURIComponent(snapshot.commit)}`, token, { fetchImpl });
  const tree = await request(`${prefix}/git/trees`, token, {
    fetchImpl,
    method: 'POST',
    body: {
      ...(currentCommit === undefined ? {} : { base_tree: currentCommit.tree.sha }),
      tree: contents.map(({ path }, index) => ({ path, mode: '100644', type: 'blob', sha: blobs[index].sha })),
    },
  });
  const commit = await request(`${prefix}/git/commits`, token, {
    fetchImpl,
    method: 'POST',
    body: {
      message: 'Update DSH plugin catalog',
      tree: tree.sha,
      ...(snapshot.commit === undefined ? {} : { parents: [snapshot.commit] }),
    },
  });
  if (snapshot.commit === undefined) {
    await request(`${prefix}/git/refs`, token, {
      fetchImpl, method: 'POST', body: { ref: `refs/heads/${snapshot.branch}`, sha: commit.sha },
    });
  } else {
    await request(`${prefix}/git/ref/heads/${encodeURIComponent(snapshot.branch)}`, token, {
      fetchImpl, method: 'PATCH', body: { sha: commit.sha, force: false },
    });
  }
}

async function verifyReleaseAsset(asset, expectedBytes, expectedDigest, owner, repo, token, fetchImpl) {
  const apiUrl = typeof asset?.url === 'string' ? new URL(asset.url) : undefined;
  const expectedPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/assets/`;
  if (apiUrl === undefined || apiUrl.protocol !== 'https:' || apiUrl.hostname !== 'api.github.com' ||
      apiUrl.username !== '' || apiUrl.password !== '' || !apiUrl.pathname.startsWith(expectedPath) ||
      !/^\d+$/.test(apiUrl.pathname.slice(expectedPath.length)) || asset.size !== expectedBytes) {
    throw new Error('The existing release asset cannot be verified safely; no catalog entry was updated.');
  }
  const response = await fetchImpl(apiUrl.href, {
    headers: {
      accept: 'application/octet-stream',
      authorization: `Bearer ${token}`,
      'x-github-api-version': API_VERSION,
    },
    redirect: 'follow',
  });
  if (!response.ok) throw new Error('The existing release asset could not be downloaded for verification.');
  if (response.url !== '') {
    let finalUrl;
    try { finalUrl = new URL(response.url); } catch { throw new Error('GitHub returned an invalid release asset URL.'); }
    if (finalUrl.protocol !== 'https:' || !['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(finalUrl.hostname)) {
      throw new Error('GitHub redirected the release asset to an unexpected host.');
    }
  }
  const hash = createHash('sha256');
  let size = 0;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > expectedBytes) {
        await reader.cancel();
        throw new Error('The existing release asset is larger than the confirmed tarball.');
      }
      hash.update(value);
    }
  } else {
    const data = Buffer.from(await response.arrayBuffer());
    size = data.length;
    if (size > expectedBytes) throw new Error('The existing release asset is larger than the confirmed tarball.');
    hash.update(data);
  }
  if (size !== expectedBytes || hash.digest('hex') !== expectedDigest) {
    throw new Error('The existing release asset does not match the confirmed SHA-256; no catalog entry was updated.');
  }
}

async function publishCatalogRelease(plan, repository, { token, fetchImpl, onProgress }) {
  const owner = repository.owner;
  const repo = repository.repo;
  const prefix = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const current = await request(prefix, token, { fetchImpl });
  if (current?.permissions?.push !== true) throw new Error(`The connected GitHub account does not have write access to ${owner}/${repo}.`);
  assertNoSecrets(plan.dir);
  const tarball = await readFile(plan.tarballPath);
  const actualDigest = createHash('sha256').update(tarball).digest('hex');
  if (actualDigest !== plan.sha256) throw new Error('The tarball changed after confirmation; plan again before publishing.');
  const branch = current.default_branch || repository.defaultBranch || 'main';
  let snapshot = await readCatalogSnapshot(prefix, token, branch, fetchImpl);
  mergeCatalogReadme(snapshot.readme, snapshot.catalog.plugins);
  const existingRelease = await request(`${prefix}/releases/tags/${encodeURIComponent(plan.tag)}`, token, { fetchImpl, allowNotFound: true });
  if (!existingRelease && await request(`${prefix}/git/ref/tags/${encodeURIComponent(plan.tag)}`, token, { fetchImpl, allowNotFound: true })) {
    throw new Error(`Tag ${plan.tag} already exists without a release; no files were published.`);
  }
  const assetName = decodeURIComponent(new URL(plan.artifactUrl).pathname.split('/').at(-1));
  const predictedReleaseUrl = `${repository.url ?? `https://github.com/${owner}/${repo}`}/releases/tag/${encodeURIComponent(plan.tag)}`;
  const candidate = {
    name: plan.name, version: plan.version, summary: plan.summary ?? '', tag: plan.tag,
    releaseUrl: predictedReleaseUrl, artifactUrl: plan.artifactUrl, sha256: plan.sha256, bytes: tarball.length,
  };
  validateCatalog({ version: 1, plugins: [candidate] });
  const priorAsset = existingRelease?.assets?.find((asset) => asset.name === assetName);
  const oldEntry = snapshot.catalog.plugins.find((item) => item.name === plan.name);
  if (priorAsset && (oldEntry?.sha256 !== plan.sha256 || oldEntry.artifactUrl !== plan.artifactUrl)) {
    throw new Error('A release asset with this digest-derived name exists without a matching catalog record. Remove the unverified asset and retry.');
  }
  if (priorAsset) await verifyReleaseAsset(priorAsset, tarball.length, plan.sha256, owner, repo, token, fetchImpl);
  if (existingRelease && existingRelease.draft !== true && priorAsset && oldEntry?.sha256 === plan.sha256 && oldEntry.artifactUrl === plan.artifactUrl) {
    return releasedResult(plan, repository, existingRelease, current.private === true, true);
  }
  if (snapshot.commit === undefined) {
    await writeCatalogSnapshot(prefix, token, snapshot, snapshot.catalog, fetchImpl);
    snapshot = await readCatalogSnapshot(prefix, token, branch, fetchImpl);
  }

  let release = existingRelease ?? await request(`${prefix}/releases`, token, {
    fetchImpl, method: 'POST',
    body: { tag_name: plan.tag, target_commitish: branch, name: plan.releaseName, body: plan.notes, draft: true, prerelease: false },
  });
  if (!priorAsset) {
    const uploadUrl = new URL(release.upload_url.replace(/\{[^}]*\}$/, ''));
    if (uploadUrl.hostname !== 'uploads.github.com') throw new Error('GitHub returned an unexpected release upload URL.');
    uploadUrl.searchParams.set('name', assetName);
    await request(uploadUrl.href, token, { fetchImpl, method: 'POST', body: tarball });
  }
  onProgress('asset', assetName);
  release = await request(`${prefix}/releases/${release.id}`, token, {
    fetchImpl, method: 'PATCH',
    body: { draft: false, target_commitish: branch, name: plan.releaseName, body: plan.notes },
  });
  const result = releasedResult(plan, repository, release, current.private === true, false, Boolean(existingRelease && existingRelease.draft !== true));
  const entry = { ...candidate, releaseUrl: release.html_url, artifactUrl: result.artifactUrl };
  const catalog = upsertCatalogEntry(snapshot.catalog, entry);
  try {
    await writeCatalogSnapshot(prefix, token, snapshot, catalog, fetchImpl);
  } catch {
    throw new Error(`The release is available at ${release.html_url}, but the catalog index could not be updated. Share again to retry the index update.`);
  }
  onProgress('catalog', 'updated');
  return { ...result, catalogUrl: `${repository.url ?? `https://github.com/${owner}/${repo}`}/blob/${encodeURIComponent(branch)}/README.md` };
}

/** Publish files and a release asset without using Git remotes or git push. */
export async function publishToGitHub(plan, repository, {
  token,
  fetchImpl = fetch,
  onProgress = () => {},
  catalogMode = false,
} = {}) {
  if (typeof token !== 'string' || token === '') throw new Error('GitHub authentication is required.');
  if (catalogMode) return publishCatalogRelease(plan, repository, { token, fetchImpl, onProgress });
  const owner = repository.owner;
  const repo = repository.repo;
  const prefix = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const current = await request(prefix, token, { fetchImpl });
  if (current?.permissions?.push !== true) throw new Error(`The connected GitHub account does not have write access to ${owner}/${repo}.`);
  const releasePath = `${prefix}/releases/tags/${encodeURIComponent(plan.tag)}`;
  const existingRelease = await request(releasePath, token, { fetchImpl, allowNotFound: true });
  if (!existingRelease && await request(`${prefix}/git/ref/tags/${encodeURIComponent(plan.tag)}`, token, { fetchImpl, allowNotFound: true })) {
    throw new Error(`Tag ${plan.tag} already exists. Increase the plugin version before sharing it again.`);
  }
  assertNoSecrets(plan.dir);

  const branch = current.default_branch;
  if (typeof branch !== 'string' || branch === '') throw new Error('The destination repository has no default branch. Create it on GitHub, then try again.');
  const branchPath = `${prefix}/git/ref/heads/${encodeURIComponent(branch)}`;
  const ref = await request(branchPath, token, { fetchImpl, allowNotFound: true });
  const baseCommit = ref?.object?.sha;
  const entries = sourceEntries(plan);
  const manifestPath = plan.manifestPath ?? join(plan.dir, 'plugin-share.json');
  entries.push({ path: 'plugin-share.json', content: await readFile(manifestPath) });
  const remoteEntries = new Map();
  let baseTree;
  if (baseCommit !== undefined) {
    const base = await request(`${prefix}/git/commits/${baseCommit}`, token, { fetchImpl });
    baseTree = base.tree.sha;
    const fullTree = await request(`${prefix}/git/trees/${baseTree}?recursive=1`, token, { fetchImpl });
    if (fullTree.truncated) throw new Error('The GitHub repository is too large to compare safely; no files were published.');
    for (const item of fullTree.tree ?? []) if (item.type === 'blob') remoteEntries.set(item.path, item.sha);
  }
  const changedEntries = entries.filter(({ path, content }) => remoteEntries.get(path) !== gitBlobSha(content));
  if (changedEntries.length === 0 && existingRelease && existingRelease.draft !== true) {
    return releasedResult(plan, repository, existingRelease, current.private === true, true);
  }
  const treeEntries = [];
  for (let offset = 0; offset < changedEntries.length; offset += 5) {
    const batch = changedEntries.slice(offset, offset + 5);
    const blobs = await Promise.all(batch.map(({ content }) => request(`${prefix}/git/blobs`, token, {
      fetchImpl,
      method: 'POST',
      body: { content: Buffer.from(content).toString('base64'), encoding: 'base64' },
    })));
    blobs.forEach((blob, index) => treeEntries.push({
      path: batch[index].path,
      mode: '100644',
      type: 'blob',
      sha: blob.sha,
    }));
    onProgress('source', Math.min(offset + batch.length, changedEntries.length), changedEntries.length);
  }

  let commit;
  if (changedEntries.length > 0) {
    const tree = await request(`${prefix}/git/trees`, token, {
      fetchImpl,
      method: 'POST',
      body: { ...(baseTree === undefined ? {} : { base_tree: baseTree }), tree: treeEntries },
    });
    commit = await request(`${prefix}/git/commits`, token, {
      fetchImpl,
      method: 'POST',
      body: {
        message: `Share ${plan.name} ${plan.version}`,
        tree: tree.sha,
        ...(baseCommit === undefined ? {} : { parents: [baseCommit] }),
      },
    });
    if (ref === undefined) {
      await request(`${prefix}/git/refs`, token, { fetchImpl, method: 'POST', body: { ref: `refs/heads/${branch}`, sha: commit.sha } });
    } else {
      await request(branchPath, token, { fetchImpl, method: 'PATCH', body: { sha: commit.sha, force: false } });
    }
  }
  onProgress('source', changedEntries.length === 0 ? 'unchanged' : 'complete');

  const release = existingRelease ?? await request(`${prefix}/releases`, token, {
    fetchImpl,
    method: 'POST',
    body: { tag_name: plan.tag, target_commitish: branch, name: plan.releaseName, body: plan.notes, draft: true, prerelease: false },
  });
  const assetName = decodeURIComponent(new URL(plan.artifactUrl ?? `https://github.com/${owner}/${repo}/releases/download/${encodeURIComponent(plan.tag)}/${encodeURIComponent(basename(plan.tarballPath))}`).pathname.split('/').at(-1));
  const priorAsset = release.assets?.find((asset) => asset.name === assetName);
  if (!priorAsset) {
    const uploadUrl = new URL(release.upload_url.replace(/\{[^}]*\}$/, ''));
    if (uploadUrl.hostname !== 'uploads.github.com') throw new Error('GitHub returned an unexpected release upload URL.');
    uploadUrl.searchParams.set('name', assetName);
    await request(uploadUrl.href, token, { fetchImpl, method: 'POST', body: await readFile(plan.tarballPath) });
  }
  onProgress('asset', assetName);
  if (commit !== undefined && existingRelease) {
    await request(`${prefix}/git/refs/tags/${encodeURIComponent(plan.tag)}`, token, {
      fetchImpl, method: 'PATCH', body: { sha: commit.sha, force: true },
    });
  }
  const published = await request(`${prefix}/releases/${release.id}`, token, {
    fetchImpl,
    method: 'PATCH',
    body: { draft: false, target_commitish: branch, name: plan.releaseName, body: plan.notes },
  });
  onProgress('release', published.html_url);
  return releasedResult(plan, repository, published, current.private === true, false, Boolean(existingRelease && existingRelease.draft !== true && changedEntries.length > 0));
}
