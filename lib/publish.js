/**
 * Publishing a share: the author's own plugin, pushed to the author's own GitHub.
 *
 * Nothing here runs until the caller has the plan in hand and has said yes: the
 * plan names the version, every file, the size, the digest, and the visibility,
 * because publishing and tagging are what other people will trust. An existing
 * tag is never overwritten, and a repository that already exists only ever
 * receives another commit.
 *
 * Everything that touches the outside world goes through `run`, so the whole
 * sequence can be tested without `git`, `gh`, or a network.
 *
 * @module dsh-plugin-share/publish
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { collectEntries, packDirectory } from './pack.js';

/**
 * @typedef {(cmd: string, args: string[], opts: {cwd: string}) => Promise<{code: number, stdout: string, stderr: string}>} RunFn
 */

/**
 * Run a command with no inherited standard input, so nothing can block on a
 * prompt, and with both streams captured for the error message.
 *
 * @type {RunFn}
 */
export function defaultRun(cmd, args, opts) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      resolve({ code, stdout, stderr });
    };
    let child;
    try {
      child = spawn(cmd, args, { cwd: opts?.cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    } catch (error) {
      resolve({ code: -1, stdout, stderr: error.message });
      return;
    }
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      stderr += error.message;
      finish(-1);
    });
    child.on('close', (code) => finish(code ?? -1));
  });
}

function distIsIgnored(text) {
  return /^\s*\/?dist\/?\s*$/m.test(text);
}

function readGitignore(dir) {
  try {
    return readFileSync(join(dir, '.gitignore'), 'utf8');
  } catch {
    return '';
  }
}

/** The files that will land in the repository, as posix paths from the plugin root. */
function repoFiles(dir) {
  const entries = collectEntries(dir).filter((entry) => !entry.name.endsWith('/'));
  const files = entries.map((entry) => ({
    path: entry.name.slice('package/'.length),
    bytes: entry.data.length,
  }));
  files.push({ path: 'plugin-share.json', bytes: readFileSync(join(dir, 'plugin-share.json')).length });
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * Work out what publishing would do, and pack the artifact while doing it.
 *
 * Packing happens here rather than in `runPublish` because the digest has to be
 * on the confirmation panel before anything is published.
 *
 * @param {{dir: string, owner?: string, repo?: string, site?: string, artifactUrl?: string,
 *   visibility?: 'public' | 'private', created?: string, run?: RunFn}} input
 * @returns {Promise<object>} the plan
 */
export async function planPublish(input) {
  const run = input.run ?? defaultRun;
  const dir = input.dir;
  const owner = input.owner ?? (await ownerFromRemote(run, dir)) ?? (await ownerFromGh(run, dir)) ?? 'local';
  let previousCreated;
  try {
    const previousManifest = JSON.parse(readFileSync(join(dir, 'plugin-share.json'), 'utf8'));
    if (typeof previousManifest.created === 'string' && Number.isFinite(Date.parse(previousManifest.created))) {
      previousCreated = previousManifest.created;
    }
  } catch {
    // The first share has no repository manifest to reuse.
  }
  const packed = await packDirectory(dir, {
    owner,
    repo: input.repo,
    site: input.site,
    // Passing the created value back in is what makes a re-pack produce the bytes
    // the panel showed: without a git commit date it is otherwise the clock.
    ...((input.created ?? previousCreated) === undefined ? {} : { created: input.created ?? previousCreated }),
    ...(input.artifactUrl === undefined ? {} : { artifactUrl: input.artifactUrl }),
  });
  const { name, version } = packed.repoManifest;
  const repo = input.repo ?? name.replace(/^@/, '').replace(/\//g, '-');
  const visibility = input.visibility ?? 'public';
  const tag = input.releaseTag ?? `v${version}`;
  const files = repoFiles(dir);
  const repoHtmlUrl = `https://github.com/${owner}/${repo}`;
  const notes = [
    packed.repoManifest.summary,
    `sha256: ${packed.sha256}`,
    `Install with plugin-share from ${repoHtmlUrl}`,
  ]
    .filter((line) => typeof line === 'string' && line !== '')
    .join('\n\n');
  return {
    dir,
    name,
    version,
    files,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    tarballBytes: packed.tarballBytes.length,
    sha256: packed.sha256,
    created: packed.repoManifest.created,
    summary: packed.repoManifest.summary ?? '',
    tarballPath: packed.tarballPath,
    manifestPath: packed.manifestPath,
    owner,
    repo,
    repoHtmlUrl,
    visibility,
    tag,
    releaseName: `${name} ${version}`,
    notes,
    artifactUrl: packed.repoManifest.artifact.url,
    hasGit: existsSync(join(dir, '.git')),
    hasRemote: (await run('git', ['remote', 'get-url', 'origin'], { cwd: dir })).code === 0,
    ghAvailable: (await run('gh', ['--version'], { cwd: dir })).code === 0,
    writesGitignore: !distIsIgnored(readGitignore(dir)),
    warnings: packed.warnings,
  };
}

async function ownerFromRemote(run, dir) {
  const result = await run('git', ['config', '--get', 'remote.origin.url'], { cwd: dir });
  if (result.code !== 0) return undefined;
  return /github\.com[:/]+([^/]+)\//.exec(result.stdout.trim())?.[1];
}

/**
 * The account `gh` is authenticated as, for a directory that has no remote yet.
 *
 * A plugin the author has never pushed has no `.git`, and defaulting to a literal
 * "local" would plan a repository (`local/name`) that cannot exist — the panel would
 * show a URL that `gh repo create` then refuses. Publishing goes to the author's own
 * account, and `gh` is the tool that knows which one that is.
 *
 * @param {RunFn} run
 * @param {string} dir
 * @returns {Promise<string | undefined>}
 */
async function ownerFromGh(run, dir) {
  const result = await run('gh', ['api', 'user', '--jq', '.login'], { cwd: dir });
  if (result.code !== 0) return undefined;
  const login = result.stdout.trim();
  return login === '' ? undefined : login;
}

/** Run one command, and turn a failure into an error that names the step. */
async function step(run, cmd, args, cwd, label) {
  const result = await run(cmd, args, { cwd });
  if (result.code !== 0) {
    const detail = (result.stderr.trim() || result.stdout.trim()).split('\n')[0];
    throw new Error(`publish: ${label} failed (${result.code}): ${detail}`);
  }
  return result;
}

/**
 * Publish a planned share.
 *
 * @param {object} plan the value from `planPublish`
 * @param {(stage: string, detail?: string) => void} [onProgress]
 * @param {{run?: RunFn}} [opts]
 * @returns {Promise<{repoHtmlUrl: string, artifactUrl: string, tag: string}>}
 */
export async function runPublish(plan, onProgress = () => {}, opts = {}) {
  const run = opts.run ?? defaultRun;
  const cwd = plan.dir;
  onProgress('pack', plan.tarballPath);

  if (plan.writesGitignore) {
    const current = readGitignore(cwd);
    const next = current === '' || current.endsWith('\n') ? `${current}dist/\n` : `${current}\ndist/\n`;
    await writeFile(join(cwd, '.gitignore'), next);
    onProgress('gitignore', 'dist/');
  }
  if (!plan.hasGit) {
    await step(run, 'git', ['init'], cwd, 'git init');
    onProgress('init');
  }
  const existing = await run('git', ['tag', '-l', plan.tag], { cwd });
  if (existing.stdout.trim() !== '') {
    throw new Error(`publish: the tag ${plan.tag} already exists; refusing to overwrite a published version`);
  }
  await step(run, 'git', ['add', '-A'], cwd, 'git add');
  const status = await run('git', ['status', '--porcelain'], { cwd });
  if (status.stdout.trim() !== '') {
    const committed = await run('git', ['commit', '-m', `Share ${plan.name} ${plan.version}`], { cwd });
    if (committed.code !== 0 && !/nothing to commit|no changes added/i.test(`${committed.stdout}${committed.stderr}`)) {
      const detail = (committed.stderr.trim() || committed.stdout.trim()).split('\n')[0];
      throw new Error(`publish: git commit failed (${committed.code}): ${detail}`);
    }
    onProgress('commit');
  }
  if (plan.hasRemote) {
    await step(run, 'git', ['push', '-u', 'origin', 'HEAD'], cwd, 'git push');
  } else if (plan.ghAvailable) {
    await step(
      run,
      'gh',
      ['repo', 'create', `${plan.owner}/${plan.repo}`, `--${plan.visibility}`, '--source', '.', '--push'],
      cwd,
      'gh repo create',
    );
  } else {
    await step(
      run,
      'git',
      ['remote', 'add', 'origin', `https://github.com/${plan.owner}/${plan.repo}.git`],
      cwd,
      'git remote add',
    );
    await step(run, 'git', ['push', '-u', 'origin', 'HEAD'], cwd, 'git push');
  }
  onProgress('repo', plan.repoHtmlUrl);
  await step(run, 'git', ['tag', plan.tag], cwd, 'git tag');
  await step(run, 'git', ['push', 'origin', plan.tag], cwd, 'git push tag');
  onProgress('tag', plan.tag);
  await step(
    run,
    'gh',
    ['release', 'create', plan.tag, '--title', plan.releaseName, '--notes', plan.notes, plan.tarballPath],
    cwd,
    'gh release create',
  );
  onProgress('release', plan.artifactUrl);
  return { repoHtmlUrl: plan.repoHtmlUrl, artifactUrl: plan.artifactUrl, tag: plan.tag };
}
