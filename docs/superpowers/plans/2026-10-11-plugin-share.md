# プラグインシェア（dsh-plugin-share）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 自作DSHプラグインをGitHubのURL1つで配れるようにする形式（`plugin-share.json` ＋ npm形式 `.tgz` ＋ sha256）と、その形式を読むインストーラー兼出版ツールを、1つのDSHプラグインとして作る。

**Architecture:** プラグインシェアは Host 半分（`index.js` ＋ `lib/`）と Client 半分（`client.js`）からなる。Host は検証済みのローカル `.tgz` を既存の `ctx.pluginManager.installBundle()` に渡すだけで、展開も依存解決もpnpmに任せる。出版は `gh` CLI を呼ぶ。Client は `plugins.detail.actions` スロットに共有ボタンを差し込み、Host の `webServer` ルートと `fetch` で話す。

**Tech Stack:** Node.js ESM（実行時依存ゼロ）、`node:zlib` による自前tar/gzip、`node:test`、Cordis（DSHのプラグイン基盤）、`gh` CLI（出版時のみ）。

**Spec:** `docs/superpowers/specs/2026-10-11-plugin-share-design.md`（このリポジトリ内。実装前に必ず読む）

## Global Constraints

- Node 22 以上。ESM のみ（`package.json` に `"type": "module"`）。
- **実行時依存ゼロ。** `@deepseek-ai/*` を import してはならない（DSH内部パッケージはレジストリに無く、プラグインから解決できない）。使えるのは `ctx` のサービスと `node:*` と相対ファイルだけ。
- 書き込み先は `$DSH_HOME/plugin-share/` 配下のみ（`DSH_HOME` 未設定時は `~/.dsh`）。例外は出版時で、ユーザーのプラグインのgitリポジトリを触る。
- pnpm を直接起動しない。プロファイルの変更は必ず `ctx.pluginManager` 経由。
- sha256 は常に64桁の小文字16進として比較する。
- パスは `node:path` を通し、Windows/posix 両対応。tarball内の名前は posix 区切り固定。
- コミットはタスクごと。コミットメッセージは `feat:` / `test:` / `docs:` の接頭辞。
- 著作物の文言は英語を主とする（公開リポジトリ）。READMEは英語＋日本語。
- `git` と `gh` は出版のときだけ使い、無ければ「手順を表示して終わる」。

## Review Focus

仕様が黙っているが、実際に人を噛む入力・条件（各項目のテストは担当タスクに入れる）:

1. **細工したtarball**（`../` を含む名前、絶対パス、シンボリックリンク、上限超過のエントリ）— 何も書かずに中断し、理由を名指しする。
2. **sha256不一致**、およびTOFUで前回と違う値 — 中断し、`artifacts/` に残さない。
3. **プロファイルに既にある同じ名前**（作者自身の開発用 `link:`）— `replace` 無しでは何も変えない。
4. **依存のインストールスクリプト** — ユーザーの承認前に実行されない。
5. **GUIの共有ボタン** — 対象外のバンドルでは出ない。確認パネルを経ずに出版されない。

---

### Task 1: リポジトリの骨組みと sha256

**Files:**
- Create: `package.json`, `cordis.patch.yml`, `index.js`, `.gitignore`, `lib/sha256.js`, `test/sha256.test.mjs`

**Interfaces:**
- Produces: `sha256Hex(bytes: Uint8Array): string`、`sha256File(path: string): Promise<string>`

- [ ] **Step 1: 失敗するテストを書く** — `test/sha256.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sha256Hex } from '../lib/sha256.js';

test('hex of empty input is the known digest', () => {
  assert.equal(sha256Hex(new Uint8Array(0)),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('hex is 64 lowercase characters for arbitrary bytes', () => {
  const hex = sha256Hex(new Uint8Array([0, 1, 255]));
  assert.match(hex, /^[0-9a-f]{64}$/);
});
```

- [ ] **Step 2: 失敗を確認** — `node --test test/sha256.test.mjs` → `Cannot find module '../lib/sha256.js'`

- [ ] **Step 3: 実装** — `lib/sha256.js`（`node:crypto` の `createHash('sha256')`。`sha256File` は `createReadStream` で流す）

- [ ] **Step 4: 通過を確認** — `node --test test/sha256.test.mjs` → PASS

- [ ] **Step 5: 骨組みを書く**
  - `package.json`: name `dsh-plugin-share` / version `0.1.0` / `type: module` / `private: true` / `bin.plugin-share: ./bin/plugin-share.mjs` / `exports`（`.` → `./index.js`、`./client` → `./client.js`、`./package.json`）/ `files`（`index.js`, `client.js`, `cordis.patch.yml`, `icon.svg`, `lib/*.js`, `bin/*.mjs`, `schema/*.json`, `README.md`, `AGENTS.md`, `docs/*.md`）/ `dsh.bundle.patch: "./cordis.patch.yml"` / `dsh.client: { platform: 'web', immediately: true }`
  - `cordis.patch.yml`: `- insert: [{ id: plugin-share, name: 'dsh-plugin-share' }]`（`@local/dsh-locale-ja` の書式に合わせる）
  - `index.js`: `export function apply(ctx) {}` の最小（後続タスクで育てる）
  - `.gitignore`: `node_modules/`, `dist/`, `.superpowers/`
- [ ] **Step 6: 検証** — `node -e "JSON.parse(require('fs').readFileSync('package.json'))" && node --test` → PASS
- [ ] **Step 7: git init とコミット**

```bash
git init && git add -A && git commit -m "feat: scaffold dsh-plugin-share with sha256 helper"
```

---

### Task 2: npm形式tarballの書き出し

**Files:**
- Create: `lib/tgz-write.js`, `test/tgz-write.test.mjs`

**Interfaces:**
- Produces: `writeTarball(entries: Array<{name: string, data: Uint8Array, mode?: number}>, opts?: {mtimeMs?: number, gzipLevel?: number}): Uint8Array`
  - `name` は `package/` から始まる posix パス。全エントリに `package/` 接頭辞が無ければ例外。

- [ ] **Step 1: 失敗するテストを書く** — `test/tgz-write.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { writeTarball } from '../lib/tgz-write.js';

const entries = [
  { name: 'package/package.json', data: Buffer.from('{"name":"x"}') },
  { name: 'package/lib/a.js', data: Buffer.from('export const a = 1;') },
];

test('output is gzip whose payload starts with a 512-byte tar header naming the entry', () => {
  const tar = gunzipSync(writeTarball(entries, { mtimeMs: 0 }));
  const header = tar.subarray(0, 512).toString('utf8');
  assert.match(header.slice(0, 100), /^package\/package\.json\0/);
  assert.equal(header.slice(257, 262), 'ustar');
});

test('payload is padded to 512-byte blocks and ends with two zero blocks', () => {
  const tar = gunzipSync(writeTarball(entries, { mtimeMs: 0 }));
  assert.equal(tar.length % 512, 0);
  assert.deepEqual([...tar.subarray(tar.length - 1024)], new Array(1024).fill(0));
});

test('the same entries and mtime produce identical bytes', () => {
  const a = writeTarball(entries, { mtimeMs: 0 });
  const b = writeTarball(entries, { mtimeMs: 0 });
  assert.deepEqual(a, b);
});

test('a name outside package/ is refused', () => {
  assert.throws(() => writeTarball([{ name: 'evil.js', data: new Uint8Array(0) }]), /package\//);
});
```

- [ ] **Step 2: 失敗を確認** — `node --test test/tgz-write.test.mjs`
- [ ] **Step 3: 実装** — `lib/tgz-write.js`。512バイトのustarヘッダ（name 100 / mode 8 / uid 8 / gid 8 / size 12 八進 / mtime 12 八進 / typeflag 1 / magic `ustar\0` / version `00` / uname 32 / gname 32）。名前が100バイトを超える場合は `prefix` フィールドに分割する。チェックサムはヘッダの checksum 領域を空白6個＋NULにして計算。`zlib.gzipSync` で圧縮。
- [ ] **Step 4: 通過を確認** — `node --test test/tgz-write.test.mjs` → PASS
- [ ] **Step 5: コミット** — `git commit -m "feat: write npm-format tarballs without dependencies"`

---

### Task 3: tarballの読み取りと安全性検査

**Files:**
- Create: `lib/tgz-read.js`, `test/tgz-read.test.mjs`

**Interfaces:**
- Produces: `readTarball(bytes: Uint8Array, opts?: {maxEntries?: number, maxEntryBytes?: number, maxTotalBytes?: number, maxCompressedBytes?: number}): Array<{name: string, data: Uint8Array}>`
  - 既定値: `maxEntries: 5000`, `maxEntryBytes: 256 * 1024 * 1024`, `maxTotalBytes: 512 * 1024 * 1024`, `maxCompressedBytes: 128 * 1024 * 1024`
  - 拒否するもの: 入力が上限超過 / エントリ数超過 / 名前が絶対パス / 名前に `..` セグメント / 名前に NUL / typeflag が通常ファイル（`0` または `\0`）とディレクトリ（`5`）以外（シンボリックリンク `2`、ハードリンク `1`、デバイス等）
- Produces: `readPackageJsonFromTarball(bytes): Promise<{name: string, version: string, patch?: string}>` は Task 9 で使うため、ここでは `readEntry(bytes, name)` を出す: `readEntry(bytes, name: string, opts?): Uint8Array | undefined`

- [ ] **Step 1: 失敗するテストを書く** — `test/tgz-read.test.mjs`（Task 2 の `writeTarball` と往復させ、危険なヘッダは手で組み立てる）

```js
// 往復: writeTarball したものを readTarball すると同じ名前とバイト列が戻る
// 絶対パス: '/' で始まる名前 → /absolute path/ で throw
// 親脱出: 'package/../../evil' → /escapes/ で throw
// シンボリックリンク: typeflag '2' のヘッダ → /symbolic link/ で throw
// エントリ数: maxEntries: 1 で2件のtarball → /too many entries/ で throw
// 圧縮サイズ: maxCompressedBytes: 10 で 100 バイトのtarball → /compressed/ で throw
// 単一エントリ: maxEntryBytes: 3 で4バイトのファイル → /entry/ で throw
// readEntry: 名前を指定すると中身が返り、無い名前は undefined
```

- [ ] **Step 2: 失敗を確認** — `node --test test/tgz-read.test.mjs`
- [ ] **Step 3: 実装** — `lib/tgz-read.js`。`zlib.gunzipSync` の前に `maxCompressedBytes` を検査。512バイトずつヘッダを読み、`name` は `prefix + '/' + name` を組み立てて検査。サイズは八進12桁（先頭が `\x80` ならbase256）として読む。ディレクトリは中身を捨てて再帰しない。
- [ ] **Step 4: 通過を確認** — `node --test test/tgz-read.test.mjs` → PASS
- [ ] **Step 5: コミット** — `git commit -m "feat: read tarballs with path and size safety checks"`

---

### Task 4: マニフェスト（2形）とスキーマ

**Files:**
- Create: `lib/manifest.js`, `schema/plugin-share.schema.json`, `test/manifest.test.mjs`

**Interfaces:**
- Produces: `SHARE_VERSION = 1`
- Produces: `buildRepoManifest(input: {name, version, summary?, license?, author: {name?, github, site?}, created: string, artifact: {url?, format: 'tgz', sha256, bytes?}}): object`
- Produces: `buildEmbeddedManifest(input: {name, version, summary?, license?, author, created}): object`
- Produces: `validateManifest(value: unknown, form: 'repo' | 'embedded'): {ok: true, manifest: object} | {ok: false, errors: string[]}`
  - `repo` 形: `share`, `name`, `version`, `author.github`, `created`（ISO8601）, `artifact.format === 'tgz'`, `artifact.sha256` が `/^[0-9a-f]{64}$/` を必須。余分なキーは許可。
  - `embedded` 形: 上と同じだが `artifact` を**禁止**（あれば `errors`）。
- Produces: `defaultArtifactUrl(input: {owner, repo, tag, name, version}): string` → `https://github.com/{owner}/{repo}/releases/download/{tag}/{name}-{version}.tgz`
- Produces: `isValidPackageName(name: string): boolean`（npm規則: 小文字・任意スコープ。設計7.1の例に合わせる）

- [ ] **Step 1: 失敗するテストを書く** — `test/manifest.test.mjs`（正常な `repo` 形が通る / `artifact.sha256` が短いと `errors` に `artifact.sha256` を含む / `embedded` 形に `artifact` があると拒否 / `created` が日付でないと拒否 / `defaultArtifactUrl` の完全一致）
- [ ] **Step 2: 失敗を確認** → `Cannot find module '../lib/manifest.js'`
- [ ] **Step 3: 実装** — `lib/manifest.js`（依存ゼロの手書き検証。`schema/plugin-share.schema.json` は同じ規則をJSON Schemaとして書き、`docs/format.md` から参照する。実装はスキーマを読まず、二重管理を避けるため `test/manifest.test.mjs` で両者の必須キー集合が一致することを検査する）
- [ ] **Step 4: 通過を確認** — `node --test test/manifest.test.mjs` → PASS
- [ ] **Step 5: コミット** — `git commit -m "feat: define the plugin-share manifest in two forms"`

---

### Task 5: ディレクトリのpack（作者側の中核）

**Files:**
- Create: `lib/pack.js`, `test/pack.test.mjs`

**Interfaces:**
- Consumes: `writeTarball`（Task 2）、`sha256Hex`（Task 1）、`buildRepoManifest` / `buildEmbeddedManifest`（Task 4）
- Produces: `collectEntries(dir: string, opts?: {exclude?: string[]}): Array<{name: string, data: Uint8Array, mode: number}>`（`package/` 接頭辞つき。既定除外: `.git`, `node_modules`, `dist`, `plugin-share.json`, `*.log`。ルートの `plugin-share.json` はリポジトリ形式のマニフェストなのでtarballには入れない）
- Produces: `packDirectory(dir: string, opts: {owner: string, repo: string, site?: string, authorName?: string, created?: string, outDir?: string}): Promise<{tarballPath, tarballBytes, sha256, repoManifest, embeddedManifest, manifestPath, warnings: string[]}>`
  - `created` 既定: `git -C dir log -1 --format=%cI` の値、取れなければ現在時刻のISO文字列。
  - `tarballPath` 既定: `<dir>/dist/<name>-<version>.tgz`（`name` のスコープ `/` は `-` に置換）。`manifestPath` は**リポジトリのルート** `<dir>/plugin-share.json`（リポジトリ形式のマニフェストはここに置く。`manifestUrlFor` が読む場所）。
  - 埋め込みマニフェストは `package/plugin-share.json` としてtarballに入れる。
  - `package.json` に `dsh.bundle.patch` が無ければ例外。そのパッチファイルが実在しなければ例外。
  - `dependencies` があれば警告文字列を返り値の `warnings` に含める（インストール時にレジストリが要る旨）。

- [ ] **Step 1: 失敗するテストを書く** — `test/pack.test.mjs`（`node:fs` で一時ディレクトリに最小プラグインを作る: `package.json`（`name: 'x-demo'`, `version: '1.0.0'`, `dsh.bundle.patch: './cordis.patch.yml'`）、`cordis.patch.yml`、`index.js`）
  - 生成した `.tgz` を `readTarball` で読み、`package/package.json` がある
  - `readEntry(tgz, 'package/plugin-share.json')` があり、`artifact` キーを持たない
  - `sha256` が `sha256File(tarballPath)` と一致し、`repoManifest.artifact.sha256` と一致する
  - `dsh.bundle.patch` が無い `package.json` は `/dsh.bundle.patch/` で throw
  - `node_modules` が除外されている
  - 同じディレクトリと同じ `created` で2回packすると `.tgz` のsha256が一致する
- [ ] **Step 2: 失敗を確認** — `node --test test/pack.test.mjs`
- [ ] **Step 3: 実装** — `lib/pack.js`。再現性のため `mtimeMs` は `created` から固定値を渡す。
- [ ] **Step 4: 通過を確認** — `node --test test/pack.test.mjs` → PASS
- [ ] **Step 5: コミット** — `git commit -m "feat: pack a plugin directory into a shareable tarball"`

---

### Task 6: 入力の解析（repo / ref / release / tarball / ローカル）

**Files:**
- Create: `lib/source.js`, `test/source.test.mjs`

**Interfaces:**
- Produces: `parseSource(input: string): ParsedSource` where
  `ParsedSource = {kind:'repo', owner, repo, ref?, htmlUrl} | {kind:'release', owner, repo, tag, htmlUrl} | {kind:'tarball-url', url, filename} | {kind:'local-tarball', path} | {kind:'local-dir', path}`
- Produces: `manifestUrlFor(source): string | undefined`（`raw.githubusercontent.com/{owner}/{repo}/{ref}/plugin-share.json`、`ref` 既定 `HEAD`）
- Produces: `artifactUrlFor(source, name, version): string`（`defaultArtifactUrl` を `ref`/`tag` で呼ぶ。`ref` は `v{version}` を既定とする）
- 拒否: `http://`（`allowInsecure` を渡したときのみ許可）、相対パス

- [ ] **Step 1: 失敗するテストを書く** — `test/source.test.mjs`
```js
// 'https://github.com/o/r'                 → kind repo, ref undefined
// 'https://github.com/o/r/tree/v1.0.0'     → kind repo, ref 'v1.0.0'
// 'https://github.com/o/r/releases/tag/v1' → kind release, tag 'v1'
// 'https://x/y/dsh-locale-ja-1.0.0.tgz'    → kind tarball-url
// 'C:\\tmp\\a.tgz'                          → kind local-tarball
// 'C:\\tmp\\a'                              → kind local-dir
// 'http://github.com/o/r'                   → /https/ で throw
// './relative'                              → /absolute/ で throw
// manifestUrlFor(repo)                      → 'https://raw.githubusercontent.com/o/r/HEAD/plugin-share.json'
```

- [ ] **Step 2: 失敗を確認** → `Cannot find module '../lib/source.js'`
- [ ] **Step 3: 実装** — `lib/source.js`
- [ ] **Step 4: 通過を確認** — `node --test test/source.test.mjs` → PASS
- [ ] **Step 5: コミット** — `git commit -m "feat: parse plugin share sources"`

---

### Task 7: 取得（https / ローカル）

**Files:**
- Create: `lib/fetch.js`, `test/fetch.test.mjs`

**Interfaces:**
- Produces: `fetchBytes(url: string, opts?: {fetchImpl?: typeof fetch, timeoutMs?: number, allowInsecure?: boolean}): Promise<Uint8Array>`
  - 非2xxは `Error` に `status` と URL を含めて投げる。本文は読み捨てず、先頭512バイトをメッセージに含める。
  - `file://` は不可。ローカルは `readLocalFile` を直接使う。
- Produces: `readLocalFile(path: string): Promise<Uint8Array>`

- [ ] **Step 1: 失敗するテストを書く** — `test/fetch.test.mjs`（`fetchImpl` を差し替える）
```js
// 200 と 3バイト → Uint8Array(3)
// 404 → /404/ と URL を含む Error
// allowInsecure 無しの http:// → /https/ で throw（fetchImpl は呼ばれない）
// timeoutMs: 10 で解決しない fetchImpl → /timed out/ で throw
// readLocalFile: 一時ファイルの内容が返る
```

- [ ] **Step 2: 失敗を確認** → `Cannot find module '../lib/fetch.js'`
- [ ] **Step 3: 実装** — `lib/fetch.js`（`AbortSignal.timeout`）
- [ ] **Step 4: 通過を確認** — `node --test test/fetch.test.mjs` → PASS
- [ ] **Step 5: コミット** — `git commit -m "feat: fetch share bytes over https or from disk"`

---

### Task 8: ストア（artifacts と installed.json）

**Files:**
- Create: `lib/store.js`, `test/store.test.mjs`

**Interfaces:**
- Produces: `storeRoot(env = process.env): string` → `join(env.DSH_HOME ?? join(homedir(), '.dsh'), 'plugin-share')`
- Produces: `artifactPath(root: string, name: string, version: string): string` → `join(root, 'artifacts', name, version + '.tgz')`
- Produces: `writeArtifact(root, name, version, bytes): Promise<string>`（親ディレクトリを作る。同名が既にありバイト列が同じなら書き直さない）
- Produces: `readInstalled(root): Promise<{share: 1, installs: InstallRecord[]}>`（無ければ `{share: 1, installs: []}`）
- Produces: `upsertInstall(root, record: InstallRecord): Promise<void>`（同じ `name` の既存レコードは `state: 'superseded'` にして先頭に積む）
- Produces: `removeInstall(root, name): Promise<boolean>`
- Produces: `listInstalled(root): Promise<InstallRecord[]>`（`state: 'installed'` のものだけ）
- `InstallRecord = {name, version, source, artifact: {url?, sha256, path}, author, created, installedAt, profileSpec?, state: 'installed'|'failed'|'superseded', error?}`

- [ ] **Step 1: 失敗するテストを書く** — `test/store.test.mjs`（`os.tmpdir()` の一時ルートを使う。`storeRoot` に `DSH_HOME` を渡したときの一致 / 書き込み→読み出し / 同じバイト列の再書き込みで mtime が変わらない / `upsert` で旧版が `superseded` / `removeInstall` が true→false）
- [ ] **Step 2: 失敗を確認** → `Cannot find module '../lib/store.js'`
- [ ] **Step 3: 実装** — `lib/store.js`（JSONは2スペース整形、末尾改行。書き込みは一時ファイル＋rename）
- [ ] **Step 4: 通過を確認** — `node --test test/store.test.mjs` → PASS
- [ ] **Step 5: コミット** — `git commit -m "feat: keep verified tarballs and install provenance"`

---

### Task 9: インストールの検証パイプライン

**Files:**
- Create: `lib/install.js`, `test/install.test.mjs`

**Interfaces:**
- Consumes: `parseSource`/`manifestUrlFor`/`artifactUrlFor`（Task 6）、`fetchBytes`/`readLocalFile`（Task 7）、`store*`（Task 8）、`validateManifest`（Task 4）、`readTarball`/`readEntry`（Task 3）、`sha256Hex`（Task 1）
- Produces: `inspectShare(input: {source: string, expectedSha256?: string, storeRoot: string, env?, fetchImpl?, installer: Installer}): Promise<InspectResult>`
  `InspectResult = {ok: true, name, version, author, created, sha256, artifactUrl?, dependencies: string[], installed: boolean, tarballBytes: Uint8Array} | {ok: false, reason: string}`
- Produces: `installShare(input: {source, expectedSha256?, replace?, approvedBuilds?, storeRoot, env?, fetchImpl?, installer: Installer, now?: () => string}): Promise<InstallResult>`
  `InstallResult = {status: 'installed', name, version, sha256, artifactPath, profileSpec, pendingBuilds: string[]} | {status: 'needs-approval', pendingBuilds: string[]} | {status: 'refused', reason} | {status: 'failed', reason, diagnostics?}`
- Produces: `Installer` インターフェース: `{installedNames(): Promise<string[]>, installBundle(spec: string, opts: {approvedBuilds?: string[]}): Promise<{ok: boolean, packageResult?: unknown, pendingBuilds?: string[], error?: string}>, removeBundle(name: string): Promise<void>}`
  - 実体は `index.js` が `ctx.pluginManager` から作る。テストでは偽物を渡す。

検証順（設計7.3）: マニフェスト取得 → `validateManifest('repo')` → 成果物URL解決 → バイト取得 → sha256照合（`expectedSha256` があればそれを正とする。無ければ `installed.json` の同版記録と照合。それも無ければTOFUで `tofu: true` を立てる）→ `readTarball` → `package/package.json` の name/version 一致 → `dsh.bundle.patch` と実ファイルの存在 → 既存名の衝突（`replace` 無しなら `refused`）→ `writeArtifact` → `installer.installBundle(artifactPath, {approvedBuilds})` → `pendingBuilds` があれば `needs-approval` → `upsertInstall`。

- [ ] **Step 1: 失敗するテストを書く** — `test/install.test.mjs`。`makeInstaller(names)` の偽物と `fetchImpl` を渡す。
```
// 正常系: installShare → status 'installed'、artifacts/ にファイルがあり、installer が受け取った spec がその絶対パス
// 改ざん: expectedSha256 を変える → status 'refused'、理由に 'sha256'、artifacts/ にファイルが無い
// TOFU: 記録が無く expectedSha256 も無い → 'installed' でレコードの sha256 が実測値
// TOFUの2回目: 記録と違うバイト列 → 'refused'
// 名前衝突: installer.installedNames に同じ名前 → 'refused'、replace: true なら 'installed'
// バンドルでない: package.json に dsh.bundle.patch が無いtarball → 'refused'、理由に 'dsh.bundle.patch'
// 名前不一致: manifest.name と package.json の name が違う → 'refused'
// スクリプト承認: installer が pendingBuilds: ['sharp'] を返す → 'needs-approval'、レコードを書かない
// 承認後: approvedBuilds: ['sharp'] を渡すと 'installed'、installer が受け取った approvedBuilds が ['sharp']
// inspectShare: インストールせずに name/version/sha256/dependencies を返し、installer.installBundle が呼ばれない
```

- [ ] **Step 2: 失敗を確認** → `Cannot find module '../lib/install.js'`
- [ ] **Step 3: 実装** — `lib/install.js`。`installer` を必ず注入で受け取り、`ctx` を直接触らない。
- [ ] **Step 4: 通過を確認** — `node --test test/install.test.mjs` → PASS
- [ ] **Step 5: コミット** — `git commit -m "feat: verify and install a shared plugin through the plugin manager"`

---

### Task 10: `plugin_share` ツール（Host）

**Files:**
- Create: `lib/tool.js`, `test/tool.test.mjs`
- Modify: `index.js`

**Interfaces:**
- Consumes: `installShare`/`inspectShare`（Task 9）、`store*`（Task 8）、`packDirectory`（Task 5）、`sha256File`（Task 1）
- Produces: `createPluginShareTool(deps: {ctx, storeRoot, env?, fetchImpl?}): ToolDefinition`（`@deepseek-ai/dsh-tools` の `defineTool` は**使えない**ので、`{name, description, parameters, output, execute, presentCall}` の素のオブジェクトを返す）
- Produces: `makeInstaller(pluginManager): Installer`（`ctx.pluginManager` の薄い適合。`installedNames` は `listBundles()` の `package` 名を集める。`installBundle` は `{enabled: true, approvedBuilds}` を渡し、結果の `pendingBuilds` / `error` を写す）
- action: `inspect` / `install` / `list` / `remove` / `verify` / `pack`
- `danger-full-access` の要求: `ctx.sandboxPolicy.resolve()` と `ctx.get('approval')` を使って `plugin_manager` と同じ形でエスカレーションを要求する。承認が得られなければ何もせずエラーを返す。

- [ ] **Step 1: 失敗するテストを書く** — `test/tool.test.mjs`（`ctx` は偽物。`tools.register` を呼ばずに `createPluginShareTool` が返す定義を直接 `execute` する）
```
// parameters.action の enum が 6 つ
// execute({action:'inspect', source}) → installShare を呼ばず結果のJSON文字列
// execute({action:'install', source}) → installer に絶対パスが渡る
// execute({action:'list'}) → installed.json の内容
// execute({action:'remove', name}) → installer.removeBundle が呼ばれ、記録が消える
// execute({action:'verify'}) → artifacts/ の再ハッシュが一致
// 承認が拒否された場合（approval が throw）→ 例外が伝播し、installer は呼ばれない
```

- [ ] **Step 2: 失敗を確認** → `Cannot find module '../lib/tool.js'`
- [ ] **Step 3: 実装** — `lib/tool.js` と `index.js` の配線（`export const inject = ['tools']`、`ctx.inject(['tools'], ...)` で登録。`pluginManager` は `ctx.get('pluginManager')` で取得し、無ければ action 実行時にエラー文字列を返す）
- [ ] **Step 4: 通過を確認** — `node --test test/tool.test.mjs` → PASS、`node --test`（全体）
- [ ] **Step 5: コミット** — `git commit -m "feat: expose the plugin_share agent tool"`

---

### Task 11: 作者側CLI

**Files:**
- Create: `bin/plugin-share.mjs`, `test/cli.test.mjs`

**Interfaces:**
- Consumes: `packDirectory`（Task 5）、`inspectShare`（Task 9）、`sha256File`（Task 1）
- 使い方:
  - `plugin-share pack <dir> [--out <dir>] [--owner <github>] [--repo <name>] [--site <url>] [--created <iso>]`
  - `plugin-share inspect <source> [--expect-sha256 <hex>]`
  - `plugin-share verify <tarball> [--expect-sha256 <hex>]`
  - `plugin-share --help`
- 終了コード: 成功 0、検証失敗 1、使い方の誤り 2。
- `install` / `remove` / `list` は**実装しない**（渡されたら使い方を出して 2 で終わる）。

- [ ] **Step 1: 失敗するテストを書く** — `test/cli.test.mjs`（`child_process.execFile(process.execPath, ['bin/plugin-share.mjs', ...])`）
```
// '--help' → 終了0、pack/inspect/verify を含む
// 'install x' → 終了2、'not available' を含む
// pack <一時プラグイン> --repo demo → 終了0、dist/<name>-<version>.tgz と リポジトリ直下の plugin-share.json ができ、stdout に sha256 が出る
// verify <そのtgz> --expect-sha256 <正しい値> → 終了0
// verify <そのtgz> --expect-sha256 <違う値> → 終了1、'sha256' を含む
```

- [ ] **Step 2: 失敗を確認** — `node --test test/cli.test.mjs`
- [ ] **Step 3: 実装** — `bin/plugin-share.mjs`（`node:util` の `parseArgs`。shebang は付けない＝Windowsで動くように `node bin/...` で呼ぶ）
- [ ] **Step 4: 通過を確認** — `node --test test/cli.test.mjs` → PASS
- [ ] **Step 5: コミット** — `git commit -m "feat: add the author-side CLI"`

---

### Task 12: 出版（gh / git）

**Files:**
- Create: `lib/publish.js`, `test/publish.test.mjs`

**Interfaces:**
- Consumes: `packDirectory`（Task 5）、`sha256File`（Task 1）
- Produces: `planPublish(input: {dir: string, owner?: string, repo?: string, site?: string, visibility?: 'public'|'private', run?: RunFn}): Promise<PublishPlan>`
  `PublishPlan = {dir, name, version, files: Array<{path, bytes}>, totalBytes, sha256, tarballPath, manifestPath, owner, repo, visibility, tag, releaseName, hasGit: boolean, hasRemote: boolean, ghAvailable: boolean}`
- Produces: `runPublish(plan: PublishPlan, onProgress: (stage: string, detail?: string) => void, opts?: {run?: RunFn}): Promise<{repoHtmlUrl: string, artifactUrl: string, tag: string}>`
  段階: `pack` → `git init`（必要時）→ `git add -A` → `git commit`（差分が無ければ飛ばす）→ `gh repo create <owner>/<repo> --<visibility> --source . --push`（無ければ `git remote add` ＋ `git push -u origin HEAD`）→ `git tag <tag>` ＋ push → `gh release create <tag> --title <releaseName> --notes <summary> <tarballPath>`
  `tag` 既定は `v{version}`。既存タグがあれば失敗させる（上書きしない）。
- Produces: `type RunFn = (cmd: string, args: string[], opts: {cwd: string}) => Promise<{code: number, stdout: string, stderr: string}>`（既定は `node:child_process` の `spawn` を包む）

- [ ] **Step 1: 失敗するテストを書く** — `test/publish.test.mjs`（`run` を記録する偽物にして、呼ばれたコマンド列を検証する。実際の `gh`/`git` は呼ばない）
```
// planPublish が name/version/sha256/tag 'v1.0.0'/files を返し、.git や node_modules を含まない
// runPublish の呼び出し列が ['git','init'] から始まり、'gh','release','create' で終わる
// 差分が無いときは 'git','commit' が呼ばれない（run の偽物が code 0/stderr 'nothing to commit' を返す）
// 'gh','repo','create' が失敗（code 1）→ /repo create/ を含む Error で、'gh','release','create' は呼ばれない
// visibility 'private' は '--private' を渡す
// 既存タグ（'git','tag','-l',tag が tag を返す）→ /already exists/ で throw し、'gh','release','create' を呼ばない
```

- [ ] **Step 2: 失敗を確認** → `Cannot find module '../lib/publish.js'`
- [ ] **Step 3: 実装** — `lib/publish.js`（`run` を注入。標準入力を継がない＝プロンプトで止まらない。`gh` の有無は `run('gh', ['--version'])` で判定）
- [ ] **Step 4: 通過を確認** — `node --test test/publish.test.mjs` → PASS
- [ ] **Step 5: コミット** — `git commit -m "feat: publish a shared plugin to GitHub"`

---

### Task 13: GUI の Host 側（webServer ルート）

**Files:**
- Create: `lib/webui.js`, `test/webui.test.mjs`
- Modify: `index.js`

**Interfaces:**
- Consumes: `planPublish`/`runPublish`（Task 12）、`inspectShare`（Task 9）、`store*`（Task 8）
- Produces: `registerWebUi(ctx, deps): void` — `ctx.inject(['webServer'], (webCtx) => ...)` の中で
  - `webCtx.webServer.register({kind: 'exact', path: '/plugin-share/plan', handler})`
  - `webCtx.webServer.register({kind: 'exact', path: '/plugin-share/publish', handler})`
  - `webCtx.webServer.register({kind: 'exact', path: '/plugin-share/status', handler})`
  - `webCtx.webServer.tapIndex((html) => injectBootstrap(html, token))` で `window.__DSH_PLUGIN_SHARE__ = {path: '/plugin-share', token}` を差し込む
  - 3つのルートはすべて `x-plugin-share-token` ヘッダを検証する（`dsh-shared-memory` の `index.js` の作法をそのまま写す）
- Produces: `shareableLocalDir(profileManifest, name): string | undefined` — プロファイルの `dependencies[name]` が `link:` / `file:` でディレクトリを指すときだけそのパスを返す（`.tgz` を指す `file:` は `undefined`）
- Produces: ジョブ表 `Map<string, {stage, detail, result?, error?}>`。`plan` は同期、`publish` は `crypto.randomUUID()` の id を返して非同期で走らせ、`status` が現在の段階を返す。

- [ ] **Step 1: 失敗するテストを書く** — `test/webui.test.mjs`（`ctx` と `webServer` を偽物にし、`register` されたハンドラを直接呼ぶ）
```
// register が3ルートを登録し、tapIndex が 'window.__DSH_PLUGIN_SHARE__' を含むHTMLを返す
// token 無し/不正なリクエスト → 403
// plan: link: のローカルディレクトリを持つバンドル → name/version/files/sha256/visibility 'public' を返す
// plan: レジストリ由来のバンドル → 400 と 'not shareable'
// publish → 202 と id。status(id) が進行を返し、完了後に repoHtmlUrl と artifactUrl を含む
// publish の run が失敗 → status が error を含み、例外を投げない
// shareableLocalDir: 'link:C:\\x' → 'C:\\x'、'file:C:\\a.tgz' → undefined、'1.2.3' → undefined
```

- [ ] **Step 2: 失敗を確認** → `Cannot find module '../lib/webui.js'`
- [ ] **Step 3: 実装** — `lib/webui.js`。`dsh-shared-memory/index.js` の `webServer.register` / `tapIndex` / トークン部分を読み、同じ形にする。`profileManifest` は `ctx.get('pluginManager')` の `listBundles()` からではなく `$DSH_PROFILE_DIR/package.json` を読んで得る（`DSH_PROFILE_DIR` 環境変数）。
- [ ] **Step 4: 通過を確認** — `node --test test/webui.test.mjs` → PASS
- [ ] **Step 5: コミット** — `git commit -m "feat: serve the share GUI endpoints from the host"`

---

### Task 14: GUI の Client 側（共有ボタン）

**Files:**
- Create: `client.js`, `test/client.test.mjs`

**Interfaces:**
- Consumes: `window.__DSH_PLUGIN_SHARE__`（Task 13）、`window.__ModuleLoader__`
- Produces: `client.js` は `window.__ModuleLoader__.load({ id: 'dsh-plugin-share', factory(require) {...} })` の形で、`factory` は `{apply(ctx)}` を返す。`apply` の中で `ctx.effect(() => ctx.slots.inject('plugins.detail.actions', () => ctx.slots.register({name: 'plugins.detail.actions', id: 'plugin-share', locale: 'pluginShare'}, Action)))` を登録する。
- `Action({t, subject})`: `subject.kind !== 'bundle'` なら `null`。`subject.pkg` の `installed`/`name` を使い、`POST {path}/plan` を叩いて 400 なら**ボタンを描かない**（または無効＋理由）。200 なら「Share」ボタンを描く。
- 確認パネル: 名前・版・ファイル数・合計サイズ・sha256・リポジトリ・可視性（public/private のラジオ）を表示し、`Publish` と `Cancel` を持つ。
- 進行: `publish` の id を `status` で 1 秒ごとにポーリングし、段階を表示する。完了で `repoHtmlUrl`・`artifactUrl`・コピー用の案内文を表示する。

- [ ] **Step 1: 失敗するテストを書く** — `test/client.test.mjs`。`node:vm` でサンドボックスを作り、`window`（`__ModuleLoader__.load` を捕まえるだけの偽物）と `globalThis.fetch` の偽物を渡して `client.js` を評価する。
```
// load が id 'dsh-plugin-share' で1回呼ばれ、factory が {apply} を返す
// apply が 'plugins.detail.actions' に inject する
// 登録した Action を kind 'bundle' 以外で呼ぶと null
// plan が 400 を返す subject では null（ボタンを描かない）
// plan が 200 の subject では要素を返し、その中に 'Share' の文字列がある
// Publish を押すと POST /plugin-share/publish が呼ばれ、応答の id で status をポーリングする
```

- [ ] **Step 2: 失敗を確認** — `node --test test/client.test.mjs`
- [ ] **Step 3: 実装** — `client.js`。`require('react')` から `createElement` を取り、JSXを使わない。スタイルは `<style data-plugin-css="dsh-plugin-share">` を1回だけ挿入し、`ctx.effect` で外す（`dsh-trajectory-ui/client.js` と同じ作法）。i18nは `t()` をそのまま使い、辞書が無い環境でも読めるよう英語を既定にする。
- [ ] **Step 4: 通過を確認** — `node --test test/client.test.mjs` → PASS
- [ ] **Step 5: コミット** — `git commit -m "feat: add the Share button to the plugin detail page"`

---

### Task 15: README・AGENTS.md・形式仕様

**Files:**
- Create: `README.md`, `AGENTS.md`, `docs/format.md`, `icon.svg`

**Interfaces:**
- Consumes: 設計文書の第11節（2つのプロンプト）、第7節（形式）

- [ ] **Step 1: `docs/format.md` を書く** — `plugin-share.json` の2形、tarballの形、検証規則、`installed.json` の形、バージョン番号（`share: 1`）と後方互換の方針。
- [ ] **Step 2: `README.md` を書く** — 冒頭に「プラグインシェアとは」、次に**プロンプトA**（設計 §11 の英文をそのまま）、`plugin_manager` が無い場合の手順、`plugin_share` が出ない場合の再起動、**プロンプトB**（作者向け・受け取る側）、CLIの使い方、GUIの共有ボタン、セキュリティ（sha256は署名ではない・依存はレジストリから入る）。
- [ ] **Step 3: `AGENTS.md` を書く** — リポジトリで作業するエージェント向け: 実行時依存ゼロの規則、`@deepseek-ai/*` を import しない規則、テストは `node --test`、形式を変えるときは `docs/format.md` と `schema/plugin-share.schema.json` と `lib/manifest.js` を同時に直す、`artifacts/` を消さない。
- [ ] **Step 4: `icon.svg`** — 既存プラグインの `icon.svg` と同じ寸法・作法（24px グリッド、`currentColor` のみ）。
- [ ] **Step 5: 検証** — `node --test` が全て通り、READMEのプロンプトAのURLが `plan` の生成物と一致する書式であること（`grep` で確認）。
- [ ] **Step 6: コミット** — `git commit -m "docs: document the format, the two prompts, and the repo rules"`

---

### Task 16: GitHubに公開してブートストラップを実証する（実地）

**Files:**
- 変更なし（リポジトリの状態のみ）

**Interfaces:**
- Consumes: `gh`（認証済み `nezumi0627`）、Task 11 のCLI、Task 12 の出版

- [ ] **Step 1: 自分の形式で自分をpackする** — `node bin/plugin-share.mjs pack . --owner nezumi0627 --repo dsh-plugin-share` → `dist/dsh-plugin-share-<version>.tgz` とリポジトリ直下の `plugin-share.json`
- [ ] **Step 2: `git status` を確認** — `plugin-share.json` はコミットする。`dist/` は `.gitignore` に入れる（成果物はReleaseに添付するのでリポジトリには入れない）。未コミットが残っていればコミットする。
- [ ] **Step 3: GitHubに作成してReleaseを切る** — `gh repo create nezumi0627/dsh-plugin-share --public --source . --push`（既にあれば `git remote add origin` ＋ `git push -u origin HEAD`）→ `git tag v<version>` → `git push origin v<version>` → `gh release create v<version> --title v<version> --notes "<summary>" dist/dsh-plugin-share-<version>.tgz`
- [ ] **Step 4: リモートの実物を検証** — `gh release view v<version> --json assets` で `.tgz` の存在を確認し、`Get-FileHash`（またはダウンロードして `sha256File`）の値が `plugin-share.json` の `sha256` と一致することを確認する。
- [ ] **Step 5: ブートストラップを実証** — READMEのプロンプトAのとおりに `plugin_manager` の `install_bundle` にリリースの `.tgz` URLを渡し、プロファイルの `dsh.profile.bundles` に `dsh-plugin-share` が入り、`plugin_share` ツールが見えることを確認する（見えなければDSHを再起動）。
- [ ] **Step 6: 記録** — 実行したコマンドと結果（sha256、URL、`list_bundles` の出力）を `docs/verification.md` に残す。

---

### Task 17: 実地エンドツーエンド（インストール・依存解決・GUI）

**Files:**
- Create: `docs/verification.md`（Task 16 で作ったものを追記）
- Create: `test/fixtures/demo-plugin/`（リポジトリに置く小さなテスト用プラグイン。`dsh.bundle.patch` を持ち、依存を1つ宣言する版と、宣言しない版）

**Interfaces:**
- Consumes: `plugin_share` ツール（Task 10）、GUI（Task 13/14）

- [ ] **Step 1: テスト用プラグインを作る** — `test/fixtures/demo-plugin/`（`package.json` name `dsh-plugin-share-demo` / version / `dsh.bundle.patch` / `cordis.patch.yml` で `insert: [{id: demo, name: 'dsh-plugin-share-demo'}]` / `index.js` は `apply(ctx)` でログを1行出すだけ）
- [ ] **Step 2: packしてローカルtarballを入れる** — `plugin_share install <そのtarball>` → プロファイルの `dsh.profile.bundles` に載り、`plugin_manager list_bundles` に出る。JSONの出力を記録する。
- [ ] **Step 3: 依存解決を確かめる** — `dependencies` に小さな実在パッケージ（例 `ms`）を1つ足した版をpackして入れ、プロファイルの `node_modules` にそのパッケージが現れることを確認する。
- [ ] **Step 4: インストールスクリプトの承認を確かめる** — インストールスクリプトを持つ依存（例 `sharp`）で `needs-approval` が返り、依存のスクリプトが**実行されていない**ことを確認してから、承認して再実行する。
- [ ] **Step 5: 取り消し** — `plugin_share remove dsh-plugin-share-demo` → `dsh.profile.bundles` から消え、DSHが壊れていないことを確認する。
- [ ] **Step 6: GUIを確かめる** — DSHを再起動し、サイドバー Plugins → 自分のローカルプラグインの詳細ページに共有ボタンが出る。押すと確認パネルが出て、承認すると GitHub にリポジトリとReleaseができ、URLが表示される。（`dsh-plugin-share-demo` を対象に、公開リポジトリを1つ作る。人間の明示的な同意を得てから実行する。）
- [ ] **Step 7: `docs/verification.md` に結果を書いてコミット** — `git commit -m "docs: record the end-to-end verification"`

---

## 実行前の注意

- Task 9 と Task 10 は、実際の `ctx.pluginManager` の戻り値の形（`installBundle` の `packageResult`、`listBundles` の行のキー名）を `_asar_full/dsh/node_modules/@deepseek-ai/dsh-plugin-manager/lib/types/index.js` で確認してから実装する。設計 §13 の未確認事項はここで潰す。
- Task 13 と Task 14 は、`dsh-shared-memory/index.js` と `dsh-shared-memory/client.js` の該当箇所を写してから書く（トークン、`tapIndex`、`fetch` の作法）。
- Task 16 と Task 17 は**公開を伴う**。実行前に人間の同意を取る。
