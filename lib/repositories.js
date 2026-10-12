/** One non-secret GitHub catalog target, stored in the plugin-share store. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { isValidPackageName } from './manifest.js';
import { storeRoot } from './store.js';
import { parseGitHubRepositoryUrl } from './github.js';

const FILE = 'repositories.json';

async function readRepository(opts) {
  try {
    const saved = JSON.parse(await readFile(join(storeRoot(opts), FILE), 'utf8'));
    if (saved?.version === 2) return normalizeTarget(saved.repository);
    if (saved?.version !== 1 || saved.repositories === null || typeof saved.repositories !== 'object' || Array.isArray(saved.repositories)) return undefined;
    const targets = Object.values(saved.repositories).map(normalizeTarget).filter(Boolean);
    if (targets.length === 0) return undefined;
    const first = targets[0];
    return targets.every((target) => target.url.toLowerCase() === first.url.toLowerCase() && target.private === first.private) ? first : undefined;
  } catch {
    return undefined;
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
  return readRepository(opts);
}

export async function saveRepository(name, target, opts = {}) {
  if (!isValidPackageName(name)) throw new Error(`Invalid package name: ${name}`);
  const parsed = parseGitHubRepositoryUrl(target?.url);
  if (parsed.owner.toLowerCase() !== target.owner?.toLowerCase() || parsed.repo.toLowerCase() !== target.repo?.toLowerCase()) {
    throw new Error('The repository URL does not match its GitHub owner and repository.');
  }
  const root = storeRoot(opts);
  const normalized = { ...parsed, private: target.private === true };
  await mkdir(root, { recursive: true });
  const temporary = join(root, `.${FILE}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify({ version: 2, repository: normalized }, null, 2)}\n`, { flag: 'wx' });
  await rename(temporary, join(root, FILE));
  return normalized;
}
