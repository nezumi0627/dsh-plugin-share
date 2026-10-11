import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

/** The smallest React that a render-only component needs, with state that survives re-renders. */
function makeReact() {
  const cells = [];
  let cursor = 0;
  return {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(Infinity) };
    },
    useState(initial) {
      const index = cursor;
      cursor += 1;
      if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial;
      return [
        cells[index],
        (value) => {
          cells[index] = typeof value === 'function' ? value(cells[index]) : value;
        },
      ];
    },
    useRef(initial) {
      const index = 900 + cursor;
      cursor += 1;
      if (!(index in cells)) cells[index] = { current: initial };
      return cells[index];
    },
    useEffect(fn) {
      const index = 500 + cursor;
      cursor += 1;
      if (!(index in cells)) {
        cells[index] = true;
        fn();
      }
    },
    __reset() {
      cursor = 0;
    },
  };
}

function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  return (node.children ?? []).map(textOf).join(' ');
}

function findButton(node, label) {
  if (node === null || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findButton(child, label);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (node.type === 'button' && new RegExp(label, 'i').test(textOf(node))) return node;
  for (const child of node.children ?? []) {
    const found = findButton(child, label);
    if (found !== undefined) return found;
  }
  return undefined;
}

function makeHarness(routes = {}) {
  const loads = [];
  const fetches = [];
  const intervals = [];
  const appended = [];
  const window = { __DSH_PLUGIN_SHARE__: { path: '/plugin-share', token: 'tok' }, __ModuleLoader__: { load: (entry) => loads.push(entry) } };
  const document = {
    head: {
      appendChild(node) {
        appended.push(node);
      },
      removeChild(node) {
        const index = appended.indexOf(node);
        if (index !== -1) appended.splice(index, 1);
      },
    },
    querySelector: () => null,
    createElement: (tag) => {
      const node = { tag, attributes: {}, textContent: '', setAttribute(key, value) { node.attributes[key] = value; } };
      return node;
    },
  };
  const respond = (value) => {
    const status = value?.status ?? 200;
    return { ok: status < 400, status, json: async () => value?.payload ?? value };
  };
  const fetchImpl = async (url, init) => {
    const body = init?.body === undefined ? undefined : JSON.parse(init.body);
    fetches.push({ url: String(url), init, body, headers: init?.headers ?? {} });
    const route = String(url);
    if (route.endsWith('/plan')) return respond(routes.plan);
    if (route.endsWith('/publish')) return respond(routes.publish);
    if (route.endsWith('/status')) return respond(routes.status);
    return respond({ status: 404, payload: { ok: false } });
  };
  const context = createContext({
    window,
    document,
    fetch: fetchImpl,
    console,
    setInterval: (fn, ms) => {
      intervals.push({ fn, ms, cleared: false });
      return intervals.length;
    },
    clearInterval: (id) => {
      const entry = intervals[id - 1];
      if (entry !== undefined) entry.cleared = true;
    },
    setTimeout,
    clearTimeout,
  });
  runInContext(SOURCE, context);
  const react = makeReact();
  const module = loads[0].factory((name) => {
    if (name !== 'react') throw new Error(`unexpected require: ${name}`);
    return react;
  });
  const injected = [];
  const registered = [];
  const effects = [];
  const ctx = {
    effect(fn) {
      const dispose = fn();
      effects.push(dispose);
      return dispose;
    },
    slots: {
      inject(name, callback) {
        injected.push(name);
        return callback();
      },
      register(slot, component) {
        registered.push({ slot, component });
        return () => {
          registered.pop();
        };
      },
    },
  };
  return { window, document, appended, fetches, intervals, loads, react, module, ctx, injected, registered, effects };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

const SUBJECT = { kind: 'bundle', pkg: { name: 'x-demo', installed: true } };

const PLAN = {
  ok: true,
  plan: {
    name: 'x-demo',
    version: '1.0.0',
    tag: 'v1.0.0',
    repoHtmlUrl: 'https://github.com/o/x-demo',
    visibility: 'public',
    files: [{ path: 'package.json', bytes: 10 }],
    fileCount: 1,
    totalBytes: 10,
    sha256: 'a'.repeat(64),
    artifactUrl: 'https://github.com/o/x-demo/releases/download/v1.0.0/x-demo-1.0.0.tgz',
  },
};

test('the module registers itself, injects the detail action, and styles the page once', () => {
  const harness = makeHarness();
  assert.equal(harness.loads.length, 1);
  assert.equal(harness.loads[0].id, 'dsh-plugin-share');
  assert.equal(typeof harness.module.apply, 'function');
  harness.module.apply(harness.ctx);
  assert.deepEqual(harness.injected, ['plugins.detail.actions']);
  assert.equal(harness.registered.length, 1);
  assert.equal(harness.registered[0].slot.name, 'plugins.detail.actions');
  assert.equal(harness.appended.length, 1);
  assert.equal(harness.appended[0].attributes['data-plugin-css'], 'dsh-plugin-share');
  assert.equal(typeof harness.effects[0], 'function');
  harness.effects[0]();
  assert.equal(harness.appended.length, 0);
  assert.equal(harness.registered.length, 0);
});

test('a subject that is not an installed bundle draws nothing', () => {
  const harness = makeHarness({ plan: PLAN });
  harness.module.apply(harness.ctx);
  const Action = harness.registered[0].component;
  assert.equal(Action({ subject: { kind: 'plugin', pkg: { name: 'x-demo', installed: true } } }), null);
  assert.equal(Action({ subject: { kind: 'bundle', pkg: { name: 'x-demo', installed: false } } }), null);
  assert.equal(Action({ subject: undefined }), null);
});

test('a bundle whose plan is refused draws nothing', async () => {
  const harness = makeHarness({ plan: { status: 400, payload: { ok: false, error: 'not shareable' } } });
  harness.module.apply(harness.ctx);
  const Action = harness.registered[0].component;
  harness.react.__reset();
  assert.equal(Action({ subject: SUBJECT }), null);
  await flush();
  harness.react.__reset();
  assert.equal(Action({ subject: SUBJECT }), null);
  assert.equal(harness.fetches.length, 1);
  assert.match(harness.fetches[0].url, /\/plugin-share\/plan$/);
  assert.equal(harness.fetches[0].headers['x-plugin-share-token'], 'tok');
});

test('a shareable bundle draws a Share button', async () => {
  const harness = makeHarness({ plan: PLAN });
  harness.module.apply(harness.ctx);
  const Action = harness.registered[0].component;
  harness.react.__reset();
  assert.equal(Action({ subject: SUBJECT }), null);
  await flush();
  harness.react.__reset();
  const tree = Action({ subject: SUBJECT });
  assert.match(textOf(tree), /Share/);
  assert.equal(harness.fetches[0].body.name, 'x-demo');
});

test('Publish confirms, posts, and polls until the release exists', async () => {
  const harness = makeHarness({
    plan: PLAN,
    publish: { status: 202, payload: { ok: true, id: 'job-1', plan: PLAN.plan } },
    status: { ok: true, stage: 'done', result: { repoHtmlUrl: 'https://github.com/o/x-demo', artifactUrl: PLAN.plan.artifactUrl, tag: 'v1.0.0' } },
  });
  harness.module.apply(harness.ctx);
  const Action = harness.registered[0].component;
  harness.react.__reset();
  Action({ subject: SUBJECT });
  await flush();
  harness.react.__reset();
  const share = findButton(Action({ subject: SUBJECT }), 'Share');
  assert.ok(share, 'expected a Share button');
  harness.react.__reset();
  share.props.onClick();
  harness.react.__reset();
  const panel = Action({ subject: SUBJECT });
  assert.match(textOf(panel), /1\.0\.0/);
  assert.match(textOf(panel), new RegExp(PLAN.plan.sha256));
  assert.match(textOf(panel), /public/);
  const publish = findButton(panel, 'publish');
  assert.ok(publish, 'expected a Publish button');
  harness.react.__reset();
  publish.props.onClick();
  await flush();
  const posted = harness.fetches.find((call) => call.url.endsWith('/plugin-share/publish'));
  assert.ok(posted, 'expected a publish request');
  assert.equal(posted.body.confirm, true);
  assert.equal(posted.body.name, 'x-demo');
  const interval = harness.intervals.at(-1);
  assert.equal(interval.ms, 1000);
  await interval.fn();
  harness.react.__reset();
  const done = Action({ subject: SUBJECT });
  assert.match(textOf(done), /github\.com\/o\/x-demo/);
  assert.equal(interval.cleared, true);
  const status = harness.fetches.find((call) => call.url.endsWith('/plugin-share/status'));
  assert.equal(status.body.id, 'job-1');
});
