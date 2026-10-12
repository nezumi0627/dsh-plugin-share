import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

/** React's dependency comparison: absent deps mean "run once, never again". */
function sameDeps(previous, next) {
  if (previous === undefined || next === undefined) return previous === next;
  return previous.length === next.length && previous.every((value, index) => Object.is(value, next[index]));
}

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
    useEffect(fn, deps) {
      const index = 500 + cursor;
      cursor += 1;
      const previous = cells[index];
      if (previous !== undefined) {
        // Same deps, same effect: React would not run it again either. The cleanup
        // half has to be reachable, or an effect that owns a timer cannot be
        // tested for the leak this suite exists to catch.
        if (sameDeps(previous.deps, deps)) return;
        if (typeof previous.cleanup === 'function') previous.cleanup();
      }
      cells[index] = { deps, cleanup: fn() };
    },
    __reset() {
      cursor = 0;
    },
    /** Unmount the tree: every effect cleanup runs, the way React runs them. */
    __unmount() {
      for (const cell of cells) {
        if (cell !== null && typeof cell === 'object' && typeof cell.cleanup === 'function') cell.cleanup();
      }
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
  const clipboardWrites = [];
  const appended = [];
  const window = { __DSH_PLUGIN_SHARE__: { path: '/plugin-share', token: 'tok' }, __ModuleLoader__: { load: (entry) => loads.push(entry) } };
  const document = {
    visibilityState: 'visible',
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
    if (route.endsWith('/setup')) return respond(routes.setup);
    if (route.endsWith('/repository')) return respond(routes.repository);
    if (route.endsWith('/share')) return respond(routes.share);
    if (route.endsWith('/github/connect')) return respond(routes.connect);
    if (route.endsWith('/plan')) return respond(routes.plan);
    if (route.endsWith('/publish')) return respond(routes.publish);
    if (route.endsWith('/status')) return respond(routes.status);
    return respond({ status: 404, payload: { ok: false } });
  };
  const context = createContext({
    window,
    document,
    navigator: { clipboard: { writeText: async (text) => clipboardWrites.push(text) } },
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
  const declared = new Set(module.inject ?? []);
  const services = {
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
    locale: { getLocale: () => ({ active: 'en' }) },
  };
  // The real runtime is stricter than a plain object: a service the returned plugin
  // did not declare in `inject` is denied when it is read. Mirroring that here is
  // what makes a missing declaration fail in this suite instead of in the browser.
  const ctx = new Proxy(
    {
      effect(fn) {
        const dispose = fn();
        effects.push(dispose);
        return dispose;
      },
    },
    {
      get(target, prop) {
        if (Reflect.has(target, prop)) return Reflect.get(target, prop);
        if (typeof prop === 'string' && Object.hasOwn(services, prop)) {
          if (!declared.has(prop)) {
            throw new Error(
              `client-guard: service "${prop}" is not declared by the plugin: add it to inject (${[...declared].join(', ')})`,
            );
          }
          return services[prop];
        }
        return undefined;
      },
    },
  );
  return { window, document, appended, fetches, intervals, clipboardWrites, loads, react, module, ctx, injected, registered, effects, declared };
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
  // Declared, because the runtime denies an undeclared service instead of leaving
  // it undefined: without this the button is never registered at all.
  assert.ok(harness.module.inject.includes('slots'), 'the plugin must declare ctx.slots');
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

test('a shareable bundle shows its per-plugin Share action without background publishing', () => {
  const harness = makeHarness();
  harness.module.apply(harness.ctx);
  const Action = harness.registered[0].component;
  harness.react.__reset();
  const tree = Action({ subject: SUBJECT });
  assert.ok(findButton(tree, 'Share'));
  assert.equal(harness.fetches.length, 0);
});

test('Share opens guided setup and a configured plugin publishes then offers copy text', async () => {
  const harness = makeHarness({
    setup: { ok: true, connection: { login: 'owner' }, repository: { url: 'https://github.com/o/x-demo', owner: 'o', repo: 'x-demo' } },
    share: { status: 202, payload: { ok: true, id: 'job-1' } },
    status: { ok: true, stage: 'done', result: { repoHtmlUrl: 'https://github.com/o/x-demo', artifactUrl: 'https://github.com/o/x-demo/releases/download/v1.0.0/x-demo.tgz', tag: 'v1.0.0', updated: true } },
  });
  harness.module.apply(harness.ctx);
  const Action = harness.registered[0].component;
  harness.react.__reset();
  findButton(Action({ subject: SUBJECT }), 'Share').props.onClick();
  await flush();
  harness.react.__reset();
  Action({ subject: SUBJECT });
  await flush();
  const shareRequest = harness.fetches.find((call) => call.url.endsWith('/plugin-share/share'));
  assert.ok(shareRequest);
  assert.equal(shareRequest.body.name, 'x-demo');
  harness.react.__reset();
  Action({ subject: SUBJECT });
  const interval = harness.intervals.at(-1);
  assert.equal(interval.ms, 1000);
  await interval.fn();
  harness.react.__reset();
  const done = Action({ subject: SUBJECT });
  assert.match(textOf(done), /github\.com\/o\/x-demo/);
  assert.match(textOf(done), /共有内容を更新しました/);
  const copy = findButton(done, '友だちに送る文面をコピー');
  assert.ok(copy);
  copy.props.onClick();
  await flush();
  assert.match(harness.clipboardWrites[0], /inspect/);
  assert.match(harness.clipboardWrites[0], /SHA-256/);
  assert.match(harness.clipboardWrites[0], /インストールはまだせず/);
});

test('first-time Share presents numbered GitHub and manual repository setup', async () => {
  const harness = makeHarness({ setup: { ok: true, connection: null, repository: null } });
  harness.module.apply(harness.ctx);
  const Action = harness.registered[0].component;
  harness.react.__reset();
  findButton(Action({ subject: SUBJECT }), 'Share').props.onClick();
  await flush();
  harness.react.__reset();
  const setup = Action({ subject: SUBJECT });
  assert.match(textOf(setup), /1\. GitHub/);
  assert.match(textOf(setup), /2\. GitHub/);
  assert.match(textOf(setup), /手動作成/);
  assert.ok(findButton(setup, 'GitHubに接続'));
});
