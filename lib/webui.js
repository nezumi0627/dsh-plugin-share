/**
 * The Host half of the Share button.
 *
 * The client half cannot publish on its own: only the Host can read the profile,
 * reach the author's plugin directory, and run `git` and `gh`. So this module
 * serves three exact routes behind a page-injected token — plan, publish, status
 * — and keeps a small job table so publishing, which takes seconds, never blocks
 * the page.
 *
 * No route here installs anything: installing is the `plugin_share` tool's job,
 * where the danger-full-access permission gates it.
 *
 * @module dsh-plugin-share/webui
 */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { planPublish, runPublish } from './publish.js';
import { githubIdentity, githubToken, publishToGitHub, startGitHubDeviceLogin, validateGitHubRepository } from './github.js';
import { getRepository, saveRepository } from './repositories.js';
import { assertNoSecrets } from './secret-scan.js';

/** The URL prefix the client asks for. */
export const ROUTE_PREFIX = '/plugin-share';

/** The `window` key the page reads to find the route and its token. */
export const BOOTSTRAP_KEY = '__DSH_PLUGIN_SHARE__';

const TOKEN_HEADER = 'x-plugin-share-token';

/**
 * The directory a bundle can be published from, when the profile points at one.
 *
 * A registry range, a git spec, or a `file:` pointing at a `.tgz` has no source
 * this plugin may edit, so only `link:` and directory `file:` specs qualify.
 *
 * @param {{dependencies?: Record<string, string>} | undefined} profileManifest
 * @param {string} name
 * @returns {string | undefined}
 */
export function shareableLocalDir(profileManifest, name) {
  const spec = profileManifest?.dependencies?.[name];
  if (typeof spec !== 'string') return undefined;
  const match = /^(?:link|file):(?<path>.+)$/.exec(spec.trim());
  const path = match?.groups?.path;
  if (path === undefined || path === '') return undefined;
  if (/\.(?:tgz|tar\.gz)$/i.test(path)) return undefined;
  return path;
}

/** Inject the route and token into the served page, the way the GUI can read it. */
export function injectBootstrap(html, token) {
  if (typeof html !== 'string') return html;
  const payload = JSON.stringify({ path: ROUTE_PREFIX, token }).replace(/</g, '\\u003c');
  const script = `<script>window.${BOOTSTRAP_KEY}=${payload};</script>`;
  const headEnd = html.search(/<\/head>/i);
  if (headEnd === -1) return `${html}${script}`;
  return `${html.slice(0, headEnd)}${script}${html.slice(headEnd)}`;
}

/**
 * Keep the job table from growing for the life of the desktop process.
 *
 * Called both when a job is added and when one settles, because jobs settle at
 * different times: a run that is still packing or publishing is never dropped,
 * since the panel that started it is still polling for it.
 *
 * @param {Map<string, object>} jobs
 */
const MAX_JOBS = 50;

function pruneJobs(jobs) {
  if (jobs.size <= MAX_JOBS) return;
  for (const [id, job] of jobs) {
    if (jobs.size <= MAX_JOBS) break;
    if (job.stage === 'done' || job.stage === 'error') jobs.delete(id);
  }
}

function authorized(req, token) {
  const header = req.headers?.[TOKEN_HEADER];
  if (typeof header !== 'string' || header.length !== token.length) return false;
  // The token only travels to the page this plugin serves, but comparing it in
  // constant time costs nothing and keeps the check honest.
  return timingSafeEqual(Buffer.from(header, 'utf8'), Buffer.from(token, 'utf8'));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}

/** A short, safe view of the plan for the confirmation panel. */
function planSummary(plan) {
  return {
    name: plan.name,
    version: plan.version,
    tag: plan.tag,
    owner: plan.owner,
    repo: plan.repo,
    repoHtmlUrl: plan.repoHtmlUrl,
    visibility: plan.visibility,
    files: plan.files,
    fileCount: plan.files.length,
    totalBytes: plan.totalBytes,
    tarballBytes: plan.tarballBytes,
    sha256: plan.sha256,
    artifactUrl: plan.artifactUrl,
    warnings: plan.warnings,
    hasGit: plan.hasGit,
    hasRemote: plan.hasRemote,
    ghAvailable: plan.ghAvailable,
  };
}

/**
 * Register the three routes and the page bootstrap.
 *
 * @param {object} ctx
 * @param {{profileManifest?: object | (() => object | undefined), run?: Function,
 *   token?: string, jobs?: Map<string, object>}} [deps]
 * @returns {{token: string, jobs: Map<string, object>}}
 */
export function registerWebUi(ctx, deps = {}) {
  const token = deps.token ?? randomBytes(24).toString('hex');
  const jobs = deps.jobs ?? new Map();
  // What each directory's shown plan was packed with, so the publish that follows
  // the panel can produce those same bytes. Without a git commit date the created
  // value is otherwise the clock, and the confirmed digest could never match.
  const plannedCreated = new Map();
  let connectJobId;
  const manifestOf = () =>
    typeof deps.profileManifest === 'function' ? deps.profileManifest() : deps.profileManifest;

  ctx.inject(['webServer'], (webCtx) => {
    const register = (path, handler) => {
      webCtx.effect(() => webCtx.webServer.register({ kind: 'exact', path, handler }), `plugin-share: ${path}`);
    };

    register(`${ROUTE_PREFIX}/setup`, async (req, res) => {
      if (!authorized(req, token)) return send(res, 403, { ok: false, error: 'forbidden' });
      try {
        const body = JSON.parse((await readBody(req)) || '{}');
        if (typeof body.name !== 'string' || body.name === '') return send(res, 400, { ok: false, error: 'a bundle name is required' });
        const dir = shareableLocalDir(manifestOf(), body.name);
        if (dir === undefined) return send(res, 400, { ok: false, error: `${body.name} is not shareable: install it from a local directory first.` });
        let connection = null;
        try { connection = await githubIdentity({ run: deps.run }); } catch { /* UI presents the connect step. */ }
        const repository = await getRepository(body.name, { root: deps.root });
        send(res, 200, { ok: true, connection, repository });
      } catch (error) {
        send(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });

    register(`${ROUTE_PREFIX}/github/connect`, async (req, res) => {
      if (!authorized(req, token)) return send(res, 403, { ok: false, error: 'forbidden' });
      if (connectJobId && jobs.get(connectJobId)?.stage === 'connecting') return send(res, 202, { ok: true, id: connectJobId });
      const id = randomUUID();
      connectJobId = id;
      jobs.set(id, { stage: 'connecting' });
      pruneJobs(jobs);
      try {
        const child = startGitHubDeviceLogin({ ...(deps.spawn === undefined ? {} : { spawnImpl: deps.spawn }) });
        child.once('error', () => jobs.set(id, { stage: 'error', error: 'GitHub CLI could not start. Install GitHub CLI and try again.' }));
        child.once('close', async (code) => {
          if (code !== 0) return jobs.set(id, { stage: 'error', error: 'GitHub sign-in did not finish. Try connecting again.' });
          try {
            const identity = await githubIdentity({ run: deps.run });
            jobs.set(id, { stage: 'done', connection: identity });
          } catch (error) {
            jobs.set(id, { stage: 'error', error: error instanceof Error ? error.message : String(error) });
          }
        });
      } catch {
        jobs.set(id, { stage: 'error', error: 'GitHub CLI could not start. Install GitHub CLI and try again.' });
      }
      send(res, 202, { ok: true, id });
    });

    register(`${ROUTE_PREFIX}/repository`, async (req, res) => {
      if (!authorized(req, token)) return send(res, 403, { ok: false, error: 'forbidden' });
      try {
        const body = JSON.parse((await readBody(req)) || '{}');
        if (typeof body.name !== 'string' || body.name === '') return send(res, 400, { ok: false, error: 'a bundle name is required' });
        const source = shareableLocalDir(manifestOf(), body.name);
        if (source === undefined) return send(res, 400, { ok: false, error: `${body.name} is not shareable: install it from a local directory first.` });
        const tokenValue = await githubToken({ run: deps.run });
        const repository = await validateGitHubRepository(body.url, tokenValue, { ...(deps.fetch === undefined ? {} : { fetchImpl: deps.fetch }) });
        await saveRepository(body.name, repository, { root: deps.root });
        send(res, 200, { ok: true, repository });
      } catch (error) {
        send(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });

    register(`${ROUTE_PREFIX}/share`, async (req, res) => {
      if (!authorized(req, token)) return send(res, 403, { ok: false, error: 'forbidden' });
      try {
        const body = JSON.parse((await readBody(req)) || '{}');
        const name = typeof body.name === 'string' ? body.name : '';
        if (!name) return send(res, 400, { ok: false, error: 'a bundle name is required' });
        const dir = shareableLocalDir(manifestOf(), name);
        if (!dir) return send(res, 400, { ok: false, error: `${name} is not shareable: install it from a local directory first.` });
        assertNoSecrets(dir);
        const repository = await getRepository(name, { root: deps.root });
        if (!repository) return send(res, 409, { ok: false, setupRequired: true, error: 'Set up a GitHub repository before sharing.' });
        const [identity, tokenValue] = await Promise.all([githubIdentity({ run: deps.run }), githubToken({ run: deps.run })]);
        const initialPlan = await planPublish({ dir, owner: repository.owner, repo: repository.repo, run: deps.run });
        const assetName = `${initialPlan.name.replace(/^@/, '').replace(/\//g, '-')}-${initialPlan.version}-${initialPlan.sha256.slice(0, 16)}.tgz`;
        const artifactUrl = `${repository.url}/releases/download/${encodeURIComponent(initialPlan.tag)}/${encodeURIComponent(assetName)}`;
        const plan = await planPublish({ dir, owner: repository.owner, repo: repository.repo, created: initialPlan.created, artifactUrl, run: deps.run });
        const id = randomUUID();
        pruneJobs(jobs);
        jobs.set(id, { stage: 'source' });
        void publishToGitHub(plan, repository, {
          token: tokenValue,
          ...(deps.fetch === undefined ? {} : { fetchImpl: deps.fetch }),
          onProgress: (stage, detail) => jobs.set(id, { stage, detail }),
        }).then((result) => {
          jobs.set(id, { stage: 'done', result: { ...result, owner: identity.login } });
          pruneJobs(jobs);
        }).catch((error) => {
          jobs.set(id, { stage: 'error', error: error instanceof Error ? error.message : String(error) });
          pruneJobs(jobs);
        });
        send(res, 202, { ok: true, id, repository });
      } catch (error) {
        send(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });

    register(`${ROUTE_PREFIX}/plan`, async (req, res) => {
      if (!authorized(req, token)) return send(res, 403, { ok: false, error: 'forbidden' });
      try {
        const body = JSON.parse((await readBody(req)) || '{}');
        const name = typeof body.name === 'string' ? body.name : '';
        if (name === '') return send(res, 400, { ok: false, error: 'a bundle name is required' });
        const dir = shareableLocalDir(manifestOf(), name);
        if (dir === undefined) {
          return send(res, 400, {
            ok: false,
            error: `${name} is not shareable: it was not installed from a local directory, so there is no source to publish. Install it with link: or pack it and publish from the CLI.`,
          });
        }
        assertNoSecrets(dir);
        const plan = await planPublish({ dir, ...(body.owner === undefined ? {} : { owner: body.owner }), ...(body.repo === undefined ? {} : { repo: body.repo }), run: deps.run });
        plannedCreated.set(dir, plan.created);
        send(res, 200, { ok: true, plan: planSummary(plan), dir });
      } catch (error) {
        send(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });

    register(`${ROUTE_PREFIX}/publish`, async (req, res) => {
      if (!authorized(req, token)) return send(res, 403, { ok: false, error: 'forbidden' });
      try {
        const body = JSON.parse((await readBody(req)) || '{}');
        const name = typeof body.name === 'string' ? body.name : '';
        if (name === '') return send(res, 400, { ok: false, error: 'a bundle name is required' });
        if (body.confirm !== true) {
          return send(res, 400, {
            ok: false,
            error: 'publishing is irreversible: send confirm: true only after the plan has been shown to the person',
          });
        }
        const dir = shareableLocalDir(manifestOf(), name);
        if (dir === undefined) {
          return send(res, 400, { ok: false, error: `${name} is not shareable: it was not installed from a local directory` });
        }
        assertNoSecrets(dir);
        // The digest is required, not optional: it is the only thing that ties this
        // request to the bytes the panel showed, and a caller that omits it would
        // otherwise publish whatever the directory holds at this moment.
        if (typeof body.sha256 !== 'string' || body.sha256 === '') {
          return send(res, 400, {
            ok: false,
            error: 'a sha256 is required: send the digest the plan showed, so the published bytes are the confirmed bytes',
          });
        }
        const planned = plannedCreated.get(dir);
        const plan = await planPublish({ dir, ...(planned === undefined ? {} : { created: planned }), ...(body.owner === undefined ? {} : { owner: body.owner }), ...(body.repo === undefined ? {} : { repo: body.repo }), ...(body.visibility === undefined ? {} : { visibility: body.visibility }), run: deps.run });
        if (body.sha256 !== plan.sha256) {
          return send(res, 409, {
            ok: false,
            error: `the confirmed digest ${body.sha256} is not the digest of the current files (${plan.sha256}); plan again`,
          });
        }
        const id = randomUUID();
        pruneJobs(jobs);
        jobs.set(id, { stage: 'pack', detail: plan.tarballPath });
        void runPublish(
          plan,
          (stage, detail) => {
            const job = jobs.get(id);
            if (job !== undefined) jobs.set(id, { ...job, stage, detail });
          },
          deps.run === undefined ? {} : { run: deps.run },
        )
          .then((result) => {
            jobs.set(id, { stage: 'done', result });
            pruneJobs(jobs);
          })
          .catch((error) => {
            jobs.set(id, { stage: 'error', error: error instanceof Error ? error.message : String(error) });
            pruneJobs(jobs);
          });
        send(res, 202, { ok: true, id, plan: planSummary(plan) });
      } catch (error) {
        send(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });

    register(`${ROUTE_PREFIX}/status`, async (req, res) => {
      if (!authorized(req, token)) return send(res, 403, { ok: false, error: 'forbidden' });
      try {
        const body =
          req.method === 'GET'
            ? { id: new URL(req.url ?? '/', 'http://localhost').searchParams.get('id') }
            : JSON.parse((await readBody(req)) || '{}');
        const job = typeof body.id === 'string' ? jobs.get(body.id) : undefined;
        if (job === undefined) return send(res, 404, { ok: false, error: 'no such job' });
        send(res, 200, { ok: true, ...job });
      } catch (error) {
        send(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });

    webCtx.effect(() => webCtx.webServer.tapIndex((html) => injectBootstrap(html, token)), 'plugin-share: page bootstrap');
  });

  return { token, jobs };
}
