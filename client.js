/**
 * Client half of dsh-plugin-share: a Share button on a plugin's detail page.
 *
 * Hand-written plain script, the way the Web loader takes a client bundle: no
 * bundler, no imports beyond react. It never installs anything and it never
 * publishes without the person pressing Publish on the confirmation panel that
 * shows the digest they are about to make public.
 */
(function bootstrap() {
  const CSS_ID = 'dsh-plugin-share';
  const SLOT = 'plugins.detail.actions';
  const CSS = `
[data-plugin-css="${CSS_ID}"] { all: initial; }
.ps-row { display: flex; align-items: center; gap: 8px; }
.ps-button { font: inherit; padding: 4px 12px; border-radius: 6px; border: 1px solid currentColor; background: transparent; color: inherit; cursor: pointer; }
.ps-panel { display: flex; flex-direction: column; gap: 8px; max-width: 44rem; padding: 12px; border: 1px solid currentColor; border-radius: 8px; }
.ps-title { font-weight: 600; }
.ps-facts { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 0; }
.ps-facts dt { opacity: 0.7; }
.ps-facts dd { margin: 0; overflow-wrap: anywhere; }
.ps-code { font-family: ui-monospace, monospace; overflow-wrap: anywhere; }
.ps-actions { display: flex; gap: 8px; }
.ps-hint { opacity: 0.7; }
.ps-error { color: #c0392b; }
`;

  /** Add the stylesheet once per page, and hand back the node to remove. */
  function ensureStyles() {
    if (typeof document === 'undefined' || document === null) return undefined;
    if (document.querySelector(`style[data-plugin-css="${CSS_ID}"]`) !== null) return undefined;
    const style = document.createElement('style');
    style.setAttribute('data-plugin-css', CSS_ID);
    style.textContent = CSS;
    document.head.appendChild(style);
    return style;
  }

  window.__ModuleLoader__.load({
    id: 'dsh-plugin-share',
    factory(require) {
      const React = require('react');
      const h = React.createElement;

      function facts(plan) {
        const rows = [
          ['Name', plan.name],
          ['Version', plan.version],
          ['Files', String(plan.fileCount ?? plan.files?.length ?? 0)],
          ['Size', `${plan.totalBytes} bytes`],
          ['Repository', plan.repoHtmlUrl],
          ['Visibility', plan.visibility],
        ];
        const items = [];
        for (const [label, value] of rows) {
          items.push(h('dt', { key: `${label}-t` }, label), h('dd', { key: `${label}-d` }, value));
        }
        items.push(
          h('dt', { key: 'sha-t' }, 'sha256'),
          h('dd', { key: 'sha-d', className: 'ps-code' }, plan.sha256),
        );
        return h('dl', { className: 'ps-facts' }, items);
      }

      /** The Share button and its confirmation, progress, and result states. */
      function Action(props) {
        const subject = props ? props.subject : undefined;
        const t = props ? props.t : undefined;
        const bootstrap = typeof window === 'undefined' ? undefined : window.__DSH_PLUGIN_SHARE__;
        const isBundle = subject !== null && typeof subject === 'object' && subject.kind === 'bundle';
        const installed = isBundle && subject.pkg !== null && typeof subject.pkg === 'object' && subject.pkg.installed === true;
        const name = installed && typeof subject.pkg.name === 'string' ? subject.pkg.name : undefined;

        const [phase, setPhase] = React.useState('idle');
        const [plan, setPlan] = React.useState(null);
        const [stage, setStage] = React.useState('');
        const [result, setResult] = React.useState(null);
        const [error, setError] = React.useState(null);
        const [visibility, setVisibility] = React.useState('public');
        const timer = React.useRef(null);

        const tr = (key, fallback) => {
          if (typeof t !== 'function') return fallback;
          try {
            const value = t(key);
            return typeof value === 'string' && value !== '' ? value : fallback;
          } catch {
            return fallback;
          }
        };

        const call = async (path, body) => {
          const response = await fetch(`${bootstrap.path}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-plugin-share-token': bootstrap.token },
            body: JSON.stringify(body),
          });
          let payload;
          try {
            payload = await response.json();
          } catch {
            payload = undefined;
          }
          return { ok: response.ok, status: response.status, payload };
        };

        React.useEffect(() => {
          if (bootstrap === undefined || name === undefined) return undefined;
          let cancelled = false;
          (async () => {
            try {
              const answer = await call('/plan', { name });
              if (cancelled || !answer.ok || answer.payload?.plan === undefined) return;
              setPlan(answer.payload.plan);
            } catch {
              // Leaving the button off the page is the right answer when the
              // Host cannot say what would be published.
            }
          })();
          return () => {
            cancelled = true;
          };
        }, [bootstrap === undefined ? '' : bootstrap.token, name]);

        const startPublish = async () => {
          setError(null);
          setStage('pack');
          setPhase('working');
          try {
            const accepted = await call('/publish', {
              name,
              confirm: true,
              visibility,
              sha256: plan.sha256,
            });
            if (!accepted.ok || accepted.payload?.id === undefined) {
              setError(accepted.payload?.error ?? `publish failed (${accepted.status})`);
              setPhase('error');
              return;
            }
            timer.current = setInterval(async () => {
              try {
                const answer = await call('/status', { id: accepted.payload.id });
                const job = answer.payload ?? {};
                if (job.stage === 'done') {
                  clearInterval(timer.current);
                  timer.current = null;
                  setResult(job.result ?? {});
                  setPhase('done');
                  return;
                }
                if (job.stage === 'error') {
                  clearInterval(timer.current);
                  timer.current = null;
                  setError(job.error ?? 'publishing failed');
                  setPhase('error');
                  return;
                }
                setStage(typeof job.stage === 'string' ? job.stage : 'working');
              } catch {
                // A failed poll is retried on the next tick.
              }
            }, 1000);
          } catch (failure) {
            setError(failure && failure.message ? failure.message : String(failure));
            setPhase('error');
          }
        };

        if (bootstrap === undefined || name === undefined) return null;
        if (phase === 'idle' && plan === null) return null;

        if (phase === 'idle') {
          return h(
            'div',
            { className: 'ps-row' },
            h('button', { type: 'button', className: 'ps-button', onClick: () => setPhase('confirm') }, tr('pluginShare.share', 'Share')),
            h('span', { className: 'ps-hint' }, `${plan.name}@${plan.version}`),
          );
        }
        if (phase === 'confirm') {
          return h(
            'div',
            { className: 'ps-panel' },
            h('div', { className: 'ps-title' }, tr('pluginShare.confirm', 'Publish this plugin to GitHub?')),
            facts(plan),
            h(
              'div',
              { className: 'ps-actions' },
              h(
                'label',
                null,
                h('input', {
                  type: 'radio',
                  name: `plugin-share-visibility-${plan.name}`,
                  checked: visibility === 'public',
                  onChange: () => setVisibility('public'),
                }),
                ' Public',
              ),
              h(
                'label',
                null,
                h('input', {
                  type: 'radio',
                  name: `plugin-share-visibility-${plan.name}`,
                  checked: visibility === 'private',
                  onChange: () => setVisibility('private'),
                }),
                ' Private',
              ),
            ),
            h('span', { className: 'ps-hint' }, tr('pluginShare.irreversible', 'Publishing creates a repository, a tag, and a release. It cannot be undone from here.')),
            h(
              'div',
              { className: 'ps-actions' },
              h('button', { type: 'button', className: 'ps-button', onClick: () => void startPublish() }, tr('pluginShare.publish', 'Publish')),
              h('button', { type: 'button', className: 'ps-button', onClick: () => setPhase('idle') }, tr('pluginShare.cancel', 'Cancel')),
            ),
          );
        }
        if (phase === 'working') {
          return h('div', { className: 'ps-panel' }, h('div', { className: 'ps-title' }, tr('pluginShare.working', 'Publishing…')), h('span', { className: 'ps-hint' }, stage));
        }
        if (phase === 'done') {
          return h(
            'div',
            { className: 'ps-panel' },
            h('div', { className: 'ps-title' }, tr('pluginShare.done', 'Published')),
            h('div', { className: 'ps-code' }, result.repoHtmlUrl ?? ''),
            h('div', { className: 'ps-code' }, result.artifactUrl ?? ''),
            h('div', { className: 'ps-hint' }, tr('pluginShare.install', 'Anyone can install it with plugin-share from that repository URL.')),
          );
        }
        return h(
          'div',
          { className: 'ps-panel' },
          h('div', { className: 'ps-title ps-error' }, tr('pluginShare.failed', 'Publishing failed')),
          h('div', { className: 'ps-code' }, error ?? ''),
          h(
            'div',
            { className: 'ps-actions' },
            h('button', { type: 'button', className: 'ps-button', onClick: () => setPhase('idle') }, tr('pluginShare.close', 'Close')),
          ),
        );
      }

      return {
        apply(ctx) {
          ctx.effect(() => {
            const style = ensureStyles();
            const dispose = ctx.slots.inject(SLOT, () =>
              ctx.slots.register({ name: SLOT, id: 'plugin-share', locale: 'pluginShare' }, Action),
            );
            return () => {
              if (typeof dispose === 'function') dispose();
              if (style !== undefined && style !== null && typeof document !== 'undefined') {
                document.head.removeChild(style);
              }
            };
          });
        },
      };
    },
  });
})();
