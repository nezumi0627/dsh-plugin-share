import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BOOTSTRAP_KEY, ROUTE_PREFIX, registerWebUi, shareableLocalDir } from '../lib/webui.js';

const TOKEN = 'test-token';

async function makePluginDir({ name = 'x-demo', version = '1.0.0' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'plugin-share-webui-'));
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name, version, private: true, type: 'module', description: 'a demo', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
  );
  await writeFile(join(dir, 'cordis.patch.yml'), "- insert:\n    - id: x-demo\n      name: 'x-demo'\n");
  await writeFile(join(dir, 'index.js'), 'export function apply(ctx) {}\n');
  return dir;
}

function fakeReq({ method = 'POST', body = '', token, url = `${ROUTE_PREFIX}/plan` } = {}) {
  const listeners = new Map();
  const req = {
    method,
    url,
    headers: token === undefined ? {} : { 'x-plugin-share-token': token },
    on(event, listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return req;
    },
    async emit() {
      for (const listener of listeners.get('data') ?? []) listener(Buffer.from(body));
      for (const listener of listeners.get('end') ?? []) listener();
    },
  };
  return req;
}

function fakeRes() {
  const state = { status: 0, headers: undefined, body: '' };
  return {
    state,
    writeHead(status, headers) {
      state.status = status;
      state.headers = headers;
    },
    end(text) {
      state.body = text ?? '';
    },
    payload() {
      return state.body === '' ? undefined : JSON.parse(state.body);
    },
  };
}

async function call(handler, options = {}) {
  const req = fakeReq(options);
  const res = fakeRes();
  const done = handler(req, res);
  await req.emit();
  await done;
  return { status: res.state.status, payload: res.payload(), headers: res.state.headers };
}

/** A context whose inject fires immediately, with the web server recorded. */
function makeCtx() {
  const registered = [];
  const taps = [];
  const logger = { info() {}, warn() {} };
  const ctx = {
    logger,
    inject(_services, callback) {
      callback({
        logger,
        effect: (fn) => fn(),
        webServer: {
          register(route) {
            registered.push(route);
            return () => {};
          },
          tapIndex(fn) {
            taps.push(fn);
            return () => {};
          },
        },
      });
    },
  };
  return { ctx, registered, taps };
}

function routeFor(registered, path) {
  const route = registered.find((entry) => entry.path === path);
  assert.ok(route, `no route registered for ${path}`);
  return route.handler;
}

function makeRun(overrides = {}) {
  const calls = [];
  const run = async (cmd, args, options) => {
    calls.push(`${cmd} ${args.join(' ')}`);
    for (const [prefix, response] of Object.entries(overrides)) {
      if (`${cmd} ${args.join(' ')}`.startsWith(prefix)) {
        return typeof response === 'function' ? response() : response;
      }
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  run.calls = calls;
  return run;
}

/** The publisher's plugin directory is not a repository with a remote yet. */
const NO_REMOTE = { 'git remote get-url origin': { code: 1, stdout: '', stderr: '' } };

async function waitFor(predicate, tries = 60) {  for (let attempt = 0; attempt < tries; attempt += 1) {
    const value = await predicate();
    if (value !== undefined && value !== false) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the job never reached the expected state');
}

async function makeUi({ profileManifest, run }) {
  const { ctx, registered, taps } = makeCtx();
  const { jobs } = registerWebUi(ctx, { profileManifest, run, token: TOKEN });
  return {
    jobs,
    registered,
    taps,
    plan: routeFor(registered, `${ROUTE_PREFIX}/plan`),
    publish: routeFor(registered, `${ROUTE_PREFIX}/publish`),
    status: routeFor(registered, `${ROUTE_PREFIX}/status`),
  };
}

test('three exact routes are registered and the page gets a bootstrap', async () => {
  const ui = await makeUi({ profileManifest: {} });
  assert.deepEqual(
    ui.registered.map((route) => [route.path, route.kind]),
    [
      [`${ROUTE_PREFIX}/plan`, 'exact'],
      [`${ROUTE_PREFIX}/publish`, 'exact'],
      [`${ROUTE_PREFIX}/status`, 'exact'],
    ],
  );
  const html = ui.taps[0]('<html><head></head><body></body></html>');
  assert.match(html, /window\.__DSH_PLUGIN_SHARE__/);
  assert.match(html, new RegExp(TOKEN));
  assert.match(html, new RegExp(ROUTE_PREFIX));
  assert.equal(BOOTSTRAP_KEY, '__DSH_PLUGIN_SHARE__');
});

test('a request without the token is forbidden', async () => {
  const ui = await makeUi({ profileManifest: {} });
  assert.equal((await call(ui.plan, { body: '{}' })).status, 403);
  assert.equal((await call(ui.plan, { body: '{}', token: 'nope' })).status, 403);
});

test('plan describes what a link-installed bundle would publish', async () => {
  const dir = await makePluginDir();
  const ui = await makeUi({ profileManifest: { dependencies: { 'x-demo': `link:${dir}` } } });
  const response = await call(ui.plan, { token: TOKEN, body: JSON.stringify({ name: 'x-demo' }) });
  assert.equal(response.status, 200);
  const plan = response.payload.plan;
  assert.equal(plan.name, 'x-demo');
  assert.equal(plan.version, '1.0.0');
  assert.equal(plan.visibility, 'public');
  assert.equal(plan.tag, 'v1.0.0');
  assert.match(plan.sha256, /^[0-9a-f]{64}$/);
  assert.ok(plan.files.some((file) => file.path === 'package.json'));
  assert.ok(plan.totalBytes > 0);
  assert.match(response.headers['content-type'], /application\/json/);
});

test('plan refuses a bundle that is not a local directory', async () => {
  const ui = await makeUi({ profileManifest: { dependencies: { 'x-demo': '^1.2.3' } } });
  const response = await call(ui.plan, { token: TOKEN, body: JSON.stringify({ name: 'x-demo' }) });
  assert.equal(response.status, 400);
  assert.match(response.payload.error, /not shareable/);
});

test('publish runs in the background and status reports it', async () => {
  const dir = await makePluginDir();
  const run = makeRun(NO_REMOTE);
  const live = await makeUi({ profileManifest: { dependencies: { 'x-demo': `link:${dir}` } }, run });
  const planned = await call(live.plan, { token: TOKEN, body: JSON.stringify({ name: 'x-demo' }) });
  const accepted = await call(live.publish, {
    token: TOKEN,
    body: JSON.stringify({ name: 'x-demo', confirm: true, sha256: planned.payload.plan.sha256 }),
  });
  assert.equal(accepted.status, 202);
  assert.match(accepted.payload.id, /^[0-9a-f-]{36}$/);
  assert.equal(accepted.payload.plan.visibility, 'public');
  const done = await waitFor(async () => {
    const status = await call(live.status, { token: TOKEN, body: JSON.stringify({ id: accepted.payload.id }) });
    return status.payload.stage === 'done' ? status.payload : false;
  });
  assert.equal(done.result.tag, 'v1.0.0');
  assert.equal(done.result.repoHtmlUrl, 'https://github.com/local/x-demo');
  assert.match(done.result.artifactUrl, /releases\/download\/v1\.0\.0\//);
  const release = run.calls.find((entry) => entry.startsWith('gh release create '));
  assert.ok(release.includes(join(dir, 'dist', 'x-demo-1.0.0.tgz')));
  assert.ok(release.includes(`sha256: ${accepted.payload.plan.sha256}`));
});

test('publish is refused without an explicit confirmation', async () => {
  const dir = await makePluginDir();
  const ui = await makeUi({ profileManifest: { dependencies: { 'x-demo': `link:${dir}` } } });
  const response = await call(ui.publish, { token: TOKEN, body: JSON.stringify({ name: 'x-demo' }) });
  assert.equal(response.status, 400);
  assert.match(response.payload.error, /confirm/);
  assert.equal(ui.jobs.size, 0);
});

test('a failing publish is reported through status instead of thrown', async () => {
  const dir = await makePluginDir();
  const run = makeRun({ ...NO_REMOTE, 'gh repo create': { code: 1, stdout: '', stderr: 'gh: not logged in' } });
  const ui = await makeUi({ profileManifest: { dependencies: { 'x-demo': `link:${dir}` } }, run });
  const planned = await call(ui.plan, { token: TOKEN, body: JSON.stringify({ name: 'x-demo' }) });
  const accepted = await call(ui.publish, {
    token: TOKEN,
    body: JSON.stringify({ name: 'x-demo', confirm: true, sha256: planned.payload.plan.sha256 }),
  });
  assert.equal(accepted.status, 202);
  const failed = await waitFor(async () => {
    const status = await call(ui.status, { token: TOKEN, body: JSON.stringify({ id: accepted.payload.id }) });
    return status.payload.stage === 'error' ? status.payload : false;
  });
  assert.match(failed.error, /repo create/);
  assert.match(failed.error, /not logged in/);
});

test('an unknown job id is a 404', async () => {
  const ui = await makeUi({ profileManifest: {} });
  const response = await call(ui.status, { token: TOKEN, body: JSON.stringify({ id: 'nope' }) });
  assert.equal(response.status, 404);
});

test('shareableLocalDir reads only link and directory specs', () => {
  assert.equal(shareableLocalDir({ dependencies: { a: 'link:C:\\x' } }, 'a'), 'C:\\x');
  assert.equal(shareableLocalDir({ dependencies: { a: 'file:C:\\dir' } }, 'a'), 'C:\\dir');
  assert.equal(shareableLocalDir({ dependencies: { a: 'file:C:\\a.tgz' } }, 'a'), undefined);
  assert.equal(shareableLocalDir({ dependencies: { a: '1.2.3' } }, 'a'), undefined);
  assert.equal(shareableLocalDir({ dependencies: {} }, 'a'), undefined);
  assert.equal(shareableLocalDir(undefined, 'a'), undefined);
});

test('the digest on the panel is the digest that gets published', async () => {
  // The plugin directory is not a git repository, so a second pack would take its
  // timestamp from the clock and produce different bytes. The panel's digest has to
  // be the one confirmed and published, or the honest flow can never finish.
  const dir = await makePluginDir();
  const run = makeRun(NO_REMOTE);
  const live = await makeUi({ profileManifest: { dependencies: { 'x-demo': `link:${dir}` } }, run });

  const planned = await call(live.plan, { token: TOKEN, body: JSON.stringify({ name: 'x-demo' }) });
  assert.equal(planned.status, 200);
  const shown = planned.payload.plan.sha256;

  const accepted = await call(live.publish, {
    token: TOKEN,
    body: JSON.stringify({ name: 'x-demo', confirm: true, sha256: shown }),
  });
  assert.equal(accepted.status, 202, JSON.stringify(accepted.payload));
  assert.equal(accepted.payload.plan.sha256, shown);
});

test('publish without a digest is refused, and a wrong digest publishes nothing', async () => {
  const dir = await makePluginDir();
  const run = makeRun(NO_REMOTE);
  const ui = await makeUi({ profileManifest: { dependencies: { 'x-demo': `link:${dir}` } }, run });

  const noDigest = await call(ui.publish, { token: TOKEN, body: JSON.stringify({ name: 'x-demo', confirm: true }) });
  assert.equal(noDigest.status, 400);
  assert.match(noDigest.payload.error, /sha256 is required/);
  assert.equal(ui.jobs.size, 0);

  const wrong = await call(ui.publish, {
    token: TOKEN,
    body: JSON.stringify({ name: 'x-demo', confirm: true, sha256: 'f'.repeat(64) }),
  });
  assert.equal(wrong.status, 409);
  assert.equal(ui.jobs.size, 0);
  // Planning asks git and gh about the directory, but a refused request publishes
  // nothing: no repository is created and no release is uploaded.
  assert.deepEqual(
    run.calls.filter((call) => call.startsWith('gh repo create') || call.startsWith('git push')),
    [],
  );
});

test('the token is compared in full, and a same-length wrong token is refused', async () => {
  const dir = await makePluginDir();
  const ui = await makeUi({ profileManifest: { dependencies: { 'x-demo': `link:${dir}` } } });
  const sameLength = `${TOKEN.slice(0, -1)}${TOKEN.endsWith('a') ? 'b' : 'a'}`;
  assert.equal(sameLength.length, TOKEN.length);
  assert.equal((await call(ui.plan, { token: sameLength, body: JSON.stringify({ name: 'x-demo' }) })).status, 403);
  assert.equal((await call(ui.plan, { token: TOKEN, body: JSON.stringify({ name: 'x-demo' }) })).status, 200);
});

test('the job table does not grow without bound', async () => {
  const dir = await makePluginDir();
  const run = makeRun(NO_REMOTE);
  const ui = await makeUi({ profileManifest: { dependencies: { 'x-demo': `link:${dir}` } }, run });
  const planned = await call(ui.plan, { token: TOKEN, body: JSON.stringify({ name: 'x-demo' }) });
  assert.equal(planned.status, 200);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    // Each round waits for the previous publish to finish, because a publish writes
    // `.gitignore` (which is packed) and the panel would plan again after it.
    const fresh = await call(ui.plan, { token: TOKEN, body: JSON.stringify({ name: 'x-demo' }) });
    assert.equal(fresh.status, 200);
    const accepted = await call(ui.publish, {
      token: TOKEN,
      body: JSON.stringify({ name: 'x-demo', confirm: true, sha256: fresh.payload.plan.sha256 }),
    });
    assert.equal(accepted.status, 202, JSON.stringify(accepted.payload));
    await waitFor(async () => {
      const status = await call(ui.status, { token: TOKEN, body: JSON.stringify({ id: accepted.payload.id }) });
      return status.payload.stage === 'done' || status.payload.stage === 'error' ? status.payload : false;
    });
  }
  // 60 runs went through; once they have all settled the table has shrunk, because a
  // job that is still packing or publishing is never pruned.
  assert.ok(ui.jobs.size <= 55, `jobs should be pruned, saw ${ui.jobs.size}`);
});
