/**
 * The author-side command line for plugin-share.
 *
 * This half only ever touches the author's own plugin: it packs a directory and
 * checks a digest. Installing would need the profile's own package manager and
 * the permission that goes with it, so `install`, `list` and `remove` point at
 * the plugin_share tool inside DSH instead of pretending to work here.
 */
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { inspectShare } from '../lib/install.js';
import { packDirectory } from '../lib/pack.js';
import { sha256File } from '../lib/sha256.js';

const USAGE = `plugin-share — pack a DSH plugin, and check a shared one

  plugin-share pack <dir> [--out <dir>] [--owner <github>] [--repo <name>] [--site <url>] [--created <iso>]
  plugin-share inspect <source> [--expect-sha256 <hex>]
  plugin-share verify <tarball> [--expect-sha256 <hex>]
  plugin-share --help

  pack     write <dir>/dist/<name>-<version>.tgz and <dir>/plugin-share.json
  inspect  read a source (repository URL, release URL, tarball URL, or local
           .tgz) and report what installing it would do
  verify   print the sha256 of a local tarball, and refuse a mismatch

Exit codes: 0 success, 1 a check failed, 2 the command line was wrong.
`;

const ELSEWHERE = `plugin-share: install, list and remove are not available in this command: they change a
DSH profile and run the profile's own package manager. Use the plugin_share tool
inside DSH, or the Share button on the plugin's detail page.
`;

function write(stream, text) {
  stream.write(text.endsWith('\n') ? text : `${text}\n`);
}

/** The GitHub account that owns the directory's origin remote, when there is one. */
function ownerFromGit(dir) {
  try {
    const remote = execFileSync('git', ['-C', dir, 'config', '--get', 'remote.origin.url'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return /github\.com[:/]+([^/]+)\//.exec(remote)?.[1];
  } catch {
    return undefined;
  }
}

function resolveOwner(dir, given) {
  if (given !== undefined) return given;
  const owner = ownerFromGit(dir) ?? process.env.GITHUB_OWNER ?? process.env.GITHUB_USER ?? 'local';
  write(
    process.stderr,
    `plugin-share: no --owner given, so the manifest records "${owner}". Pass --owner <github> to record the real account.`,
  );
  return owner;
}

async function runPack(rest, values) {
  const [dir, ...extra] = rest;
  if (dir === undefined || extra.length > 0) {
    write(process.stderr, USAGE);
    return 2;
  }
  const owner = resolveOwner(dir, values.owner);
  try {
    const result = await packDirectory(dir, {
      owner,
      repo: values.repo,
      site: values.site,
      created: values.created,
      outDir: values.out,
    });
    write(process.stdout, `packed ${result.repoManifest.name}@${result.repoManifest.version}`);
    write(process.stdout, `tarball ${result.tarballPath}`);
    write(process.stdout, `manifest ${result.manifestPath}`);
    write(process.stdout, `sha256 ${result.sha256}`);
    write(process.stdout, `bytes ${result.tarballBytes.length}`);
    for (const warning of result.warnings) write(process.stderr, `warning: ${warning}`);
    return 0;
  } catch (error) {
    write(process.stderr, `plugin-share: ${error.message}`);
    return 1;
  }
}

async function runInspect(rest, values) {
  const [source, ...extra] = rest;
  if (source === undefined || extra.length > 0) {
    write(process.stderr, USAGE);
    return 2;
  }
  const result = await inspectShare(source, { sha256: values['expect-sha256'] });
  if (!result.ok) {
    write(process.stderr, `plugin-share: ${result.code ?? result.status}: ${result.message}`);
    return 1;
  }
  const inspection = result.inspection;
  write(process.stdout, `name ${inspection.name}`);
  write(process.stdout, `version ${inspection.version}`);
  write(process.stdout, `manifest ${inspection.form}`);
  write(process.stdout, `sha256 ${inspection.sha256}`);
  write(process.stdout, `artifact ${inspection.artifactUrl}`);
  if (inspection.manifest?.author?.github !== undefined) {
    write(process.stdout, `author ${inspection.manifest.author.github}`);
  }
  for (const warning of inspection.warnings) write(process.stderr, `warning: ${warning}`);
  return 0;
}

async function runVerify(rest, values) {
  const [path, ...extra] = rest;
  if (path === undefined || extra.length > 0) {
    write(process.stderr, USAGE);
    return 2;
  }
  let actual;
  try {
    actual = await sha256File(path);
  } catch (error) {
    write(process.stderr, `plugin-share: cannot read ${path}: ${error.message}`);
    return 1;
  }
  const expected = values['expect-sha256'];
  write(process.stdout, `sha256 ${actual}`);
  if (expected === undefined) return 0;
  if (expected === actual) {
    write(process.stdout, 'ok');
    return 0;
  }
  write(process.stderr, `plugin-share: sha256 mismatch: expected ${expected}, got ${actual}`);
  return 1;
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        out: { type: 'string' },
        owner: { type: 'string' },
        repo: { type: 'string' },
        site: { type: 'string' },
        created: { type: 'string' },
        'expect-sha256': { type: 'string' },
      },
    });
  } catch (error) {
    write(process.stderr, `plugin-share: ${error.message}`);
    write(process.stderr, USAGE);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help === true) {
    write(process.stdout, USAGE);
    return 0;
  }
  const [command, ...rest] = positionals;
  if (command === undefined) {
    write(process.stderr, USAGE);
    return 2;
  }
  if (command === 'install' || command === 'list' || command === 'remove') {
    write(process.stderr, ELSEWHERE);
    return 2;
  }
  if (command === 'pack') return await runPack(rest, values);
  if (command === 'inspect') return await runInspect(rest, values);
  if (command === 'verify') return await runVerify(rest, values);
  write(process.stderr, `plugin-share: unknown command "${command}"`);
  write(process.stderr, USAGE);
  return 2;
}

process.exitCode = await main(process.argv.slice(2));
