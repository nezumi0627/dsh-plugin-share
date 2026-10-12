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

      function friendInstructions(repoUrl) {
        return `このDSHプラグインを確認してください:\n${repoUrl}\n\nまず plugin-share の inspect でプラグイン名・作者・SHA-256・依存関係を表示してください。インストールはまだせず、確認結果を私に見せてください。`;
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
        const [jobId, setJobId] = React.useState(null);
        const [copyStatus, setCopyStatus] = React.useState('');
        const [setup, setSetup] = React.useState(null);
        const [repoUrl, setRepoUrl] = React.useState('');
        const [account, setAccount] = React.useState(null);

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

        const openShare = async () => {
          setError(null);
          setPhase('setup-loading');
          try {
            const answer = await call('/setup', { name });
            if (!answer.ok) throw new Error(answer.payload?.error ?? 'Could not load setup.');
            setSetup(answer.payload);
            setAccount(answer.payload.connection);
            setRepoUrl(answer.payload.repository?.url ?? '');
            setPhase(answer.payload.repository && answer.payload.connection ? 'ready' : 'setup');
            if (answer.payload.repository && answer.payload.connection) void startQuickShare();
          } catch (failure) {
            setError(failure?.message ?? String(failure));
            setPhase('error');
          }
        };

        const connectGitHub = async () => {
          setError(null);
          setPhase('connecting');
          try {
            const answer = await call('/github/connect', {});
            if (!answer.ok || !answer.payload?.id) throw new Error(answer.payload?.error ?? 'Could not start GitHub sign-in.');
            setJobId(answer.payload.id);
          } catch (failure) {
            setError(failure?.message ?? String(failure));
            setPhase('setup');
          }
        };

        const saveRepository = async () => {
          setError(null);
          setPhase('saving-repository');
          try {
            const answer = await call('/repository', { name, url: repoUrl });
            if (!answer.ok) throw new Error(answer.payload?.error ?? 'Could not save repository.');
            setSetup((previous) => ({ ...previous, repository: answer.payload.repository }));
            void startQuickShare();
          } catch (failure) {
            setError(failure?.message ?? String(failure));
            setPhase('setup');
          }
        };

        const startQuickShare = async () => {
          setError(null);
          setStage('準備中');
          setPhase('working');
          try {
            const accepted = await call('/share', { name });
            if (!accepted.ok || !accepted.payload?.id) {
              if (accepted.payload?.setupRequired) { setPhase('setup'); return; }
              throw new Error(accepted.payload?.error ?? `share failed (${accepted.status})`);
            }
            setJobId(accepted.payload.id);
          } catch (failure) {
            setError(failure?.message ?? String(failure));
            setPhase('error');
          }
        };

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
            setJobId(accepted.payload.id);
          } catch (failure) {
            setError(failure && failure.message ? failure.message : String(failure));
            setPhase('error');
          }
        };

        const copyFriendInstructions = async () => {
          try {
            if (typeof navigator === 'undefined' || typeof navigator.clipboard?.writeText !== 'function') {
              throw new Error('clipboard unavailable');
            }
            await navigator.clipboard.writeText(friendInstructions(result.repoHtmlUrl));
            setCopyStatus('copied');
          } catch {
            setCopyStatus('failed');
          }
        };

        // The status poll is an effect, not a timer started in the click handler:
        // the Plugins page can unmount this panel mid-publish, and a timer with no
        // effect-level owner keeps polling until the page reloads. Leaving the
        // 'working' phase ends it too.
        React.useEffect(() => {
          if ((phase !== 'working' && phase !== 'connecting') || jobId === null) return undefined;
          let cancelled = false;
          const timer = setInterval(async () => {
            // The publish job runs on the Host whether or not this window is on
            // screen, so a hidden document has nothing to poll for.
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
            try {
              const answer = await call('/status', { id: jobId });
              if (cancelled) return;
              const job = answer.payload ?? {};
              if (job.stage === 'done' && job.connection) {
                setAccount(job.connection);
                setJobId(null);
                setPhase('setup');
                return;
              }
              if (job.stage === 'done') {
                setResult(job.result ?? {});
                setPhase('done');
                return;
              }
              if (job.stage === 'error') {
                setError(job.error ?? 'publishing failed');
                setPhase(phase === 'connecting' ? 'setup' : 'error');
                setJobId(null);
                return;
              }
              setStage(typeof job.stage === 'string' ? job.stage : 'working');
            } catch {
              // A failed poll is retried on the next tick.
            }
          }, 1000);
          return () => {
            cancelled = true;
            clearInterval(timer);
          };
          // `call` closes over the page bootstrap only, which cannot change while
          // this panel is mounted.
        }, [phase, jobId]);

        if (bootstrap === undefined || name === undefined) return null;

        if (phase === 'idle') {
          return h(
            'div',
            { className: 'ps-row' },
            h('button', { type: 'button', className: 'ps-button', onClick: () => void openShare() }, tr('pluginShare.share', 'Share')),
            h('span', { className: 'ps-hint' }, name),
          );
        }
        if (phase === 'setup-loading' || phase === 'saving-repository') return h('div', { className: 'ps-panel', role: 'status' }, phase === 'setup-loading' ? '設定を確認しています…' : 'リポジトリを確認して保存しています…');
        if (phase === 'setup' || phase === 'connecting' || phase === 'ready') {
          return h('div', { className: 'ps-panel' },
            h('div', { className: 'ps-title' }, 'GitHub共有のセットアップ'),
            h('div', null, '1. GitHubを連携'),
            account
              ? h('div', { className: 'ps-hint', role: 'status' }, `接続済み: ${account.login}`)
              : h('button', { type: 'button', className: 'ps-button', onClick: () => void connectGitHub() }, phase === 'connecting' ? 'ブラウザーで認証中…' : 'GitHubに接続'),
            phase === 'connecting' ? h('span', { className: 'ps-hint' }, 'ブラウザーが開きます。表示された認証コードを入力して完了するまでお待ちください。') : null,
            h('div', null, '2. GitHubで空のリポジトリを手動作成し、URLを入力'),
            h('input', { type: 'url', value: repoUrl, placeholder: 'https://github.com/owner/repo', onChange: (event) => setRepoUrl(event.target.value), 'aria-label': 'GitHub repository URL' }),
            h('button', { type: 'button', className: 'ps-button', disabled: !account || repoUrl.trim() === '', onClick: () => void saveRepository() }, '保存して共有'),
            setup?.repository?.private ? h('span', { className: 'ps-hint' }, 'このリポジトリはPrivateです。友だちにも閲覧権限が必要です。') : null,
            setup?.repository && account ? h('button', { type: 'button', className: 'ps-button', onClick: () => void startQuickShare() }, '共有する') : null,
            error ? h('span', { className: 'ps-error', role: 'alert' }, error) : null,
            h('button', { type: 'button', className: 'ps-button', onClick: () => { setPhase('idle'); setJobId(null); } }, '閉じる'),
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
          const friendMessage = friendInstructions(result.repoHtmlUrl);
          return h(
            'div',
            { className: 'ps-panel' },
            h('div', { className: 'ps-title' }, result.unchanged ? '変更はありません' : result.updated ? '共有内容を更新しました' : tr('pluginShare.done', 'Published')),
            h('div', { className: 'ps-code' }, result.repoHtmlUrl ?? ''),
            h('div', { className: 'ps-code' }, result.artifactUrl ?? ''),
            h('div', { className: 'ps-hint' }, tr('pluginShare.install', 'Anyone can install it with plugin-share from that repository URL.')),
            h('button', { type: 'button', className: 'ps-button', onClick: () => void copyFriendInstructions() }, '友だちに送る文面をコピー'),
            copyStatus === 'copied' ? h('span', { className: 'ps-hint', role: 'status' }, 'コピーしました') : null,
            copyStatus === 'failed'
              ? h('label', null,
                  h('span', { className: 'ps-hint' }, 'コピーできませんでした。下の文面を手動でコピーしてください。'),
                  h('textarea', { readOnly: true, value: friendMessage, 'aria-label': '友だちに送る文面' }),
                )
              : null,
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
        // The Client runtime hands `apply` a guarded ctx: reading a service the
        // returned plugin did not declare is denied, not undefined, so without this
        // line `ctx.slots` is refused and no button is ever registered.
        inject: ['slots', 'locale'],
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
