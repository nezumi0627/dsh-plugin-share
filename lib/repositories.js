/** Non-secret per-package GitHub repository targets, stored in the plugin-share store. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { isValidPackageName } from './manifest.js';
import { storeRoot } from './store.js';
import { parseGitHubRepositoryUrl } from './github.js';

const FILE = 'repositories.json';

async function readTargets(opts) {
  try {
    const saved = JSON.parse(await readFile(join(storeRoot(opts), FILE), 'utf8'));
    if (saved?.version !== 1 || saved.repositories === null || typeof saved.repositories !== 'object' || Array.isArray(saved.repositories)) return {};
    return saved.repositories;
  } catch {
    return {};
  }
}

function normalizeTarget(target) {
  if (target === null || typeof target !== 'object' || typeof target.url !== 'string') return undefined;
  try {
    const parsed = parseGitHubRepositoryUrl(target.url);
    if (parsed.owner.toLowerCase() !== target.owner?.toLowerCase() || parsed.repo.toLowerCase() !== target.repo?.toLowerCase()) return undefined;
    return { ...parsed, private: target.private === true };
  } catch {
    return undefined;
  }
}

export async function getRepository(name, opts = {}) {
  if (!isValidPackageName(name)) throw new Error('A valid package name is required.');
  return normalizeTarget((await readTargets(opts))[name]);
}

export async function saveRepository(name, target, opts = {}) {
  if (!isValidPackageName(name)) throw new Error(`Invalid package name: ${name}`);
  const parsed = parseGitHubRepositoryUrl(target?.url);
  if (parsed.owner.toLowerCase() !== target.owner?.toLowerCase() || parsed.repo.toLowerCase() !== target.repo?.toLowerCase()) {
    throw new Error('The repository URL does not match its GitHub owner and repository.');
  }
  const root = storeRoot(opts);
  const repositories = await readTargets(opts);
  const normalized = { ...parsed, private: target.private === true };
  repositories[name] = normalized;
  await mkdir(root, { recursive: true });
  const temporary = join(root, `.${FILE}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify({ version: 1, repositories }, null, 2)}\n`, { flag: 'wx' });
  await rename(temporary, join(root, FILE));
  return normalized;
}
