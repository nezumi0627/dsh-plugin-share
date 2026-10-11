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
import { randomBytes, randomUUID } from 'node:crypto';
import { planPublish, runPublish } from './publish.js';

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

function authorized(req, token) {
  const header = req.headers?.[TOKEN_HEADER];
  return typeof header === 'string' && header === token;
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
  const manifestOf = () =>
    typeof deps.profileManifest === 'function' ? deps.profileManifest() : deps.profileManifest;

  ctx.inject(['webServer'], (webCtx) => {
    const register = (path, handler) => {
      webCtx.effect(() => webCtx.webServer.register({ kind: 'exact', path, handler }), `plugin-share: ${path}`);
    };

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
        const plan = await planPublish({ dir, ...(body.owner === undefined ? {} : { owner: body.owner }), ...(body.repo === undefined ? {} : { repo: body.repo }), run: deps.run });
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
        const plan = await planPublish({ dir, ...(body.owner === undefined ? {} : { owner: body.owner }), ...(body.repo === undefined ? {} : { repo: body.repo }), ...(body.visibility === undefined ? {} : { visibility: body.visibility }), run: deps.run });
        if (typeof body.sha256 === 'string' && body.sha256 !== plan.sha256) {
          return send(res, 409, {
            ok: false,
            error: `the confirmed digest ${body.sha256} is not the digest of the current files (${plan.sha256}); plan again`,
          });
        }
        const id = randomUUID();
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
          })
          .catch((error) => {
            jobs.set(id, { stage: 'error', error: error instanceof Error ? error.message : String(error) });
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
