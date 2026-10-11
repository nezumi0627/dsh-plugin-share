# プラグインシェア（`dsh-plugin-share`）設計

2026-10-11 / 対象: DeepSeek Harness (DSH) Desktop + Web GUI

---

## 1. なぜ作るのか

自作のDSHプラグインを他人に渡す手段が、いまは「エクスプローラーを開いて、このフォルダをここにコピーして」しかない。渡す側も受け取る側も手作業で、渡すたびに同じ説明を繰り返すことになる。

DSH側にはプラグインの**形式**（プロファイルのpnpmワークスペース、`dsh.bundle.patch`、`dsh.profile.bundles`）は既にあるが、**共有の型**がまだ無い。だから先に型を立てて、その上で共有を楽にする。

そのため、`dsh-plugin-share`（以下プラグインシェア）という1つのDSHプラグインを作る。プラグインシェアを入れることが共有方式を使う前提で、共有されたプラグインは**GitHubのURLをDSHに渡すだけ**で入り、入った後は普通のDSHプラグインと同じように動く。プラグインシェア自身も同じ形式で配る（自分の形式で自分を配れる＝ブートストラップが閉じる）。

## 2. ゴール

1. **共有の型**を定義する。プラグイン1つ＝マニフェスト1つ。名前・バージョン・作者のGitHub・作者サイト・作成日・sha256 を記録できる。
2. **作者側の道具**（配る用意）。プラグインフォルダから npm形式のtarball（`.tgz`）・sha256・マニフェストを生成する。
3. **利用者側の道具**（インストーラー）。GitHubのリポジトリURL／リリースURL／tarballのURLをDSHに渡すと、取得 → sha256照合 → 既存のプラグイン機構にtarballとして渡して有効化、まで自動でやる。依存はpnpmがレジストリから解決する。
4. 入れた後は**普通のDSHプラグインとして動く**（WebサイドバーのPluginsページにも出る）。
5. **来歴を記録する**。どこから・どの版・どのsha256で入れたかを残し、後から照合・更新・削除ができる。
6. **ブートストラップが閉じている**。プラグインシェア自身を、手作業のコピーなしで入れられる（READMEの短いプロンプト1つ）。
7. GitHubにリポジトリを立て、リリースを切り、実際に使える状態にする。
8. READMEに2つのプロンプト（自身を入れる用／自作を配る・入れる用）と、リポジトリに `AGENTS.md` を置く。
9. **GUI**。DSHのプラグイン詳細ページに「共有」ボタンを差し込み、押すと確認のうえ共有（GitHubへの出版）まで進む。

## 3. ノンゴール（v1では作らない）

- **中央カタログ／一覧サイト**。共有の入口は「作者のリポジトリURLまたはtarball」だけ。探すための場所は作らない（人間が明示的に不要と判断）。
- **npmレジストリへの公開**。配布の場はGitHub（リポジトリ＋Release添付）。レジストリは*tarballが宣言した依存を引くため*にだけ使う。
- **署名・作者の真正性証明**。sha256は破損・差し替えの検知であって署名ではない（第9節）。
- **GUIからのインストール**。GUIは共有（出版）だけを担う。受け取る側の操作はチャットのツールから行う。
- **現在のプロファイル以外へのインストール**。プロファイルは1つ固定。
- **CLIからのインストール**。インストールはDSHプロセス内の `pluginManager` を通す必要があるため、CLIは作者側（pack/inspect/verify）だけを担う。
- **依存のインストールスクリプトの自動承認**。既存プラグインマネージャーの承認フローに委ねる。
- **zip対応**。v1のコンテナは npm形式の `.tgz` のみ。

## 4. アンチゴール（技術的には動いても失敗）

- プラグインマネージャーを置き換える、または自前で `pnpm` を起動する。プロファイルの書き込みロックと `package.json`／ロックファイルの整合を壊すため。**必ず `ctx.pluginManager` に委譲する。**
- 検証したバイト列とは**別のもの**をインストールする（照合後に再ダウンロードする、URLをそのままpnpmに渡す等）。渡すのは常に、sha256を照合済みのローカルファイル。
- sha256照合を飛ばせる経路が存在する（`--force` のような逃げ道を含めて作らない）。唯一の例外は第11節のブートストラップで、これはプラグインシェアの外側なので検証の対象になりえない。だからこそリリース資産のURLを信頼の錨に固定する。
- ブートストラップに手作業コピーが必要。循環を残さない。
- 壊れた／細工したtarballで任意のパスに書き込める、または巨大なtarballでディスクを埋める（読み取り時のサイズ上限とパス検査）。
- 共有されたプラグインがDSH本体と非互換のまま入る。互換検査は既存プラグインマネージャーの判定に委ね、独自判定を足さない。

## 5. 前提（実地で確認した事実）

- 実行ユーザーのDSHホームは `C:\Users\ren11\.dsh`（環境変数 `DSH_HOME`）。プロファイルは `$DSH_PROFILE_DIR` = `C:\Users\ren11\.dsh\profiles\desktop`。
- プロファイルは1つのpnpmワークスペース。`package.json` の `dependencies` と `dsh.profile.bundles` の**両方**に載ったパッケージが有効になる。`cordis.patch.yml` がパッチ層。
- プラグインの実体は npm パッケージ。`package.json` の `dsh.bundle.patch` が cordis パッチYAMLを指し、そのYAMLが `insert:` でローダー行を足す。例: `@local/dsh-locale-ja`。
- `@deepseek-ai/dsh-plugin-manager` が同梱され、`pluginManager` サービスを提供する。ソースで確認した挙動:
  - `parseInstallSpec`（`lib/types/install-spec.js`）は、**絶対パスで末尾が `.tgz`/`.tar.gz` のspecを `kind: 'tarball'` として受理**する。`https` のtarball URLも同様。
  - `inspect` はローカルtarballについて**存在確認だけ**を行い、`package.json` は読まない（`kind: 'tarball'` として `accepted`）。
  - `installBundle(spec, { enabled?, approvedBuilds?, registry?, requestId? })` は `pnpm add <spec>` を実行し、前後の `package.json` の差分から追加されたパッケージ名を特定してバンドル選択まで行う。
  - tarball spec はGitHub到達性の事前チェックをスキップする。DSH本体とのpeer互換は、**tarballではインストール後に判定され、非互換ならプロファイルとロックファイルが元に戻される**。
  - 依存のインストールスクリプトは `pendingBuilds` として返り、`approvedBuilds` を渡したときだけ実行される。
  - 失敗時は `package.json` と `pnpm-lock.yaml` を復元し、プロファイルの書き込みロックを持つ。
  - エージェント向けツール `plugin_manager`（Creator系プリセットで有効、`danger-full-access` が必要）。
- 実行環境: `gh` CLI は `nezumi0627` で認証済み（`repo` スコープあり）。git の identity も設定済み。
- **`pnpm` と `dsh` は PATH に無い。** デスクトップアプリが「ランチャー事実」として自前のパッケージマネージャー呼び出しをプラグインマネージャーに渡している。したがってプラグインシェアがシェルから `pnpm` を叩く設計は成立しない。委譲は設計上の要請でもある。
- 既存の自作プラグイン6つは `link:C:/...` でプロファイルにリンクされている（`plugin_manager` の `install_bundle` 経由）。**このリンク方式はpnpmの依存木を作らない**（`.pnpm` に依存が入っていない）ため、依存を持つプラグインを配る道としては使えない。ここが `.tgz` を選んだ理由。
- プロファイル直下のプラグインが登録したツールは、エージェントから見える（実例: `@local/codex-plus-usage` のMCPツールがこのセッションから見えている）。

## 6. 決めたこと

### 人間が決めたこと

- 名前は「プラグインシェア」。
- GitHubにリポジトリを立てて使えるようにする。
- プラグインシェア自体を入れるのが必須。独自形式のプラグインを読むインストーラー役。
- 共有されたプラグインは、入れたら通常のDSHプラグインと同じように使える。
- 記録項目: バージョン・作者のGitHub・名前・サイト・作成日・sha（→ **sha256**）。
- 入口は作者のリポジトリURLまたはtarball。中央カタログは作らない。
- READMEに、AGENTS相当の内容、プラグインシェア自身を入れるための簡潔な英文プロンプト、それとは別に「プラグインシェアを使って自作を配る」ためのプロンプトを置く。
- **依存も許す**。配布はnpm形式の `.tgz` にしてpnpmに渡し、依存はレジストリから解決する。その代わりインストール時にネットワークと依存スクリプトの承認が要る。

### 私（設計者）の判断 — あとから覆してよい

| 判断 | 内容 | 理由 |
|---|---|---|
| リポジトリ／パッケージ名 | `dsh-plugin-share`（スコープ無し） | 既存の `dsh-*` 命名に合わせつつ、公開物なので `@local/` は付けない |
| 置き場所 | ワークスペース直下 `default-workspace/dsh-plugin-share/` | 他の自作プラグインと同じ並び |
| マニフェスト名 | `plugin-share.json`（リポジトリのルート） | 形式名と一致 |
| 成果物 | GitHub Release に `<name>-<version>.tgz` を添付 | npm形式なのでpnpmがそのまま食える。無認証で取れる。APIレート制限を避けられる |
| 検証済み資産の保持 | `$DSH_HOME/plugin-share/artifacts/<name>/<version>.tgz` にそのまま残す | `verify` が再ハッシュで確かめられる。**pnpmに渡すのは常にこのローカルファイル** |
| 一時領域 | `$DSH_HOME/plugin-share/tmp/` | 照合前にストアを汚さない |
| 展開 | しない（pnpmに任せる） | 展開コードを持たない＝zip slip級の危険を作らない |
| 来歴 | `$DSH_HOME/plugin-share/installed.json` | 単一ファイルで読み書きしやすい |
| 操作面 | エージェントツール `plugin_share` ＋ 作者側CLI | 「DSHに投げる」＝チャットにURLを貼る、が最短 |
| 依存 | 実行時依存ゼロ（tarballの読み書きも自前実装） | 小さくテストできる面積を優先 |
| ビルド | 無し。素のJSのみ | 導入時のビルド承認を発生させない |
| 名前衝突 | 既にプロファイルに入っている名前なら既定で拒否し、`replace` を明示したときだけ更新として扱う | 作者自身の開発用 `link:` を黙って潰さない |
| 権限 | `plugin_manager` と同じく `danger-full-access` を要求する | 遠隔のHostコードを取得して有効化する操作だから |
| ブートストラップ | Release添付の `.tgz` のURLを `plugin_manager` に渡す（gitタグにフォールバック） | プラグインシェアが入る前なのでsha256検証は原理的に使えない。循環を閉じる唯一の道 |
| GUI | プラグイン詳細ページの `plugins.detail.actions` スロットに「共有」ボタンを差し込む | DSHが公式に用意している拡張点で、バンドルの詳細ページ先頭に載る |
| GUI⇄Host | Hostが `webServer` にルートを登録し、`tapIndex` でブート値を注入。clientは `fetch` で呼ぶ | 同じワークスペースの `dsh-shared-memory` で実証済み。typert/ビルド不要 |
| クライアント実装 | 手書きの `client.js`（`__ModuleLoader__.load` ＋ `require('react')`）。ビルド無し | 既存の自作クライアントプラグインと同じ流儀。バンドラを持ち込まない |
| 出版の既定 | 公開（public）リポジトリ。確認画面で明示し、切り替えられる | 共有の既定として素直。押す前に何が出るか見せる |
| 共有可能な対象 | プロファイルの依存がローカルディレクトリを指しているバンドル（＝自分のソース）だけ | レジストリや他人のtarballから入ったものは作者ではないので共有できない |

## 7. 共有の型（v1）

### 7.1 マニフェスト `plugin-share.json`

```json
{
  "share": 1,
  "name": "dsh-locale-ja",
  "version": "1.0.0",
  "summary": "Japanese (ja) language pack for the DSH Web GUI",
  "license": "MIT",
  "author": {
    "name": "nezumi0627",
    "github": "nezumi0627",
    "site": "https://example.com/"
  },
  "created": "2026-10-11T09:00:00.000Z",
  "artifact": {
    "url": "https://github.com/nezumi0627/dsh-locale-ja/releases/download/v1.0.0/dsh-locale-ja-1.0.0.tgz",
    "format": "tgz",
    "sha256": "3b1f...（64桁の小文字16進）",
    "bytes": 123456
  }
}
```

- 必須: `share`(=1) / `name` / `version` / `author.github` / `created` / `artifact.sha256` / `artifact.format`(=`tgz`)。
- `artifact.url` は省略可。省略時は `releases/download/v<version>/<name>-<version>.tgz` を基準に解決する。相対URLはリポジトリ（と `ref`）を基準に解決する。
- `author.site` は任意（作者のサイト）。
- `created` の意味は **その版を作った日**。pack時に元ディレクトリのgitコミット日時が取れればそれを、取れなければ現在時刻を使う。インストール側は「いつ入れたか」を `installedAt` として別に記録する（両方の読み方をカバーする）。
- sha256 は **tarballのバイト列そのもの**に対する値。マニフェストはtarballの外（リポジトリ内）に置くので自己参照にならない。
- **埋め込み用の別形**: tarballの中に入れる `plugin-share.json` はメタデータだけの版とし、`artifact` ブロックを持たない（自分を含むtarballのsha256は自分には書けないため）。スキーマは「リポジトリ用（`artifact.sha256` 必須）」と「埋め込み用（`artifact` 禁止）」の2形を持つ。

### 7.2 tarballの中身

- npm形式（`npm pack` 互換）。全エントリが `package/` を接頭辞に持ち、`package/package.json` がある。
- `package/package.json` に `dsh.bundle.patch` があり、そのパッチファイルが実在すること。
- `package/plugin-share.json` に埋め込み用マニフェストを入れる（直接tarballを渡された場合のメタデータ源になる）。
- **依存を宣言してよい**。インストール時にpnpmがレジストリから解決する。同梱（`node_modules` を入れる）も妨げない。
- ライフサイクルスクリプト（`prepack`/`prepare` 等）は**pack時に実行しない**。tarballは依存ゼロの自前ライターが書く（npmに依存しない＝作者の環境差とスクリプト副作用を持ち込まない）。

### 7.3 検証規則（インストール時に必ず行う）

1. マニフェストがスキーマに適合し、`share` が対応版（1）。
2. `artifact.sha256` が64桁の小文字16進。
3. ダウンロードしたバイト列の sha256 が一致。**不一致なら何もインストールせず中断**。
4. tarballを読んで `package/package.json` を取り出し、`name` が `manifest.name` と一致。
5. 同 `version` が `manifest.version` と一致。
6. `dsh.bundle.patch` が宣言され、そのファイルがtarball内に実在する（無ければ `not-a-bundle` として中断）。
7. 読み取り時の安全性: エントリ名の絶対パス・`..` による親ディレクトリ脱出を拒否。エントリ数・総展開サイズ・単一エントリサイズに上限を設ける。**書き出しはしない**（展開はpnpmが行う）。
8. 渡すのは照合済みのローカル `.tgz` の絶対パス。pnpmにURLを渡して再取得させない。
9. DSH本体とのpeer互換は `installBundle` の判定に委ねる（tarballではインストール後に判定され、非互換なら自動で巻き戻る）。
10. 依存のインストールスクリプトが必要な場合（`pendingBuilds` が返った場合）は、**そのパッケージ名をユーザーに見せて承認を取ってから** `approvedBuilds` を付けて再試行する。

### 7.4 入れた記録 `installed.json`

```json
{
  "share": 1,
  "installs": [
    {
      "name": "dsh-locale-ja",
      "version": "1.0.0",
      "source": { "input": "https://github.com/nezumi0627/dsh-locale-ja", "kind": "repo", "ref": "main" },
      "artifact": {
        "url": "https://.../dsh-locale-ja-1.0.0.tgz",
        "sha256": "3b1f...",
        "path": "C:\\Users\\ren11\\.dsh\\plugin-share\\artifacts\\dsh-locale-ja\\1.0.0.tgz"
      },
      "author": { "name": "nezumi0627", "github": "nezumi0627", "site": "https://example.com/" },
      "created": "2026-10-11T09:00:00.000Z",
      "installedAt": "2026-10-11T10:00:00.000Z",
      "profileSpec": "file:C:/Users/ren11/.dsh/plugin-share/artifacts/dsh-locale-ja/1.0.0.tgz",
      "state": "installed"
    }
  ]
}
```

- `state` は `installed` / `failed` / `superseded`。`failed` は `error` を持つ。
- `profileSpec` には、pnpmがプロファイルに記録した実際のspecを記録する（実装時に実機で確認して埋める。第13節）。
- 同じプラグインの複数版は履歴として残し、最後に入れたものが `installed`。

## 8. 操作面

### 8.1 エージェントツール `plugin_share`

`inject = ['tools', 'pluginManager']`。`danger-full-access` を要求する。`$DSH_HOME/plugin-share/` の外には書かない。

| action | 引数 | 動作 |
|---|---|---|
| `inspect` | `source` | 取得と検証だけ行い、名前・版・作者・サイト・作成日・sha256・成果物URL・宣言された依存・既導入かを返す。インストールしない |
| `install` | `source`, `expectedSha256?`, `replace?`, `approvedBuilds?` | 第7.3節の検証を通し、tarballを `artifacts/` に保存して、`pluginManager.installBundle(<ローカル絶対パス>, { enabled: true })` を呼び、`installed.json` に記録する。名前が既にプロファイルにあれば `replace` が無い限り拒否する |
| `list` | — | `installed.json` をプロファイルの実際の状態（`listBundles`）と突き合わせて返す |
| `remove` | `name` | `pluginManager.removeBundle(name)` の後、記録を片付ける（`artifacts/` は残す） |
| `verify` | `name?` | `artifacts/` のtarballを再ハッシュし、記録したsha256と一致するか確認する |
| `pack` | `dir`, `out?` | 作者側。`.tgz`・sha256・`plugin-share.json`（リポジトリ用と埋め込み用）を生成する |

### 8.2 作者側CLI

`node bin/plugin-share.mjs <action>`。DSH無しでも動く。

- `pack <dir> [--out dist] [--publish]` — `.tgz`・sha256・マニフェストを生成。`--publish` は `gh release create` まで行う（`gh` が無ければ手順を表示して終わる）。
- `inspect <source>` / `verify <tarball>` — 取得・検証のみ。プロファイルには触らない。
- `install` / `remove` / `list` は**用意しない**（第3節）。

### 8.3 入力として受け付ける形

| 入力 | 例 | 扱い |
|---|---|---|
| リポジトリURL | `https://github.com/nezumi0627/dsh-locale-ja` | `plugin-share.json` を既定ブランチから取得 |
| リポジトリ＋ref | `https://github.com/o/r/tree/v1.0.0`、`https://github.com/o/r/releases/tag/v1.0.0` | そのrefのマニフェストを取得 |
| tarballのURL | `https://.../dsh-locale-ja-1.0.0.tgz` | tarball内の `plugin-share.json` をメタデータに使う。sha256の外部の出所が無いので初回はTOFU固定 |
| ローカルのtarball | `C:\...\dist\dsh-locale-ja-1.0.0.tgz` | 開発・検証用 |
| ローカルのフォルダ | `C:\...\dsh-locale-ja` | packしてから同じ経路に乗せる |

- `https` のみ許可。`http` は明示フラグで解禁。ローカルパスは開発用として許可する。
- **TOFU（初回信頼）**: 直接tarballを渡され、外部のsha256が無い場合は、計算したsha256を「この値で固定する」と明示してから入れる。2回目以降は記録と照合し、変わっていれば中断する。`expectedSha256` を渡せばそれを正とする。

### 8.4 GUI（共有ボタン）

- DSHのプラグイン詳細ページは `plugins.detail.actions` スロットを公開している（ページ先頭、標準のスイッチやアンインストールより前）。プラグインシェアのクライアント半分がここに「共有」ボタンを差し込む。登録は `ctx.slots.inject('plugins.detail.actions', () => ctx.slots.register({ name: 'plugins.detail.actions', id: 'plugin-share', locale: 'pluginShare' }, ...))`。
- 対象は `subject.kind === 'bundle'` かつ、プロファイルの依存がローカルディレクトリを指しているもの（＝自分のソース）。それ以外はボタンを出さない（理由を示す）。
- クライアントは手書きの `client.js`。`window.__ModuleLoader__.load({ id: 'dsh-plugin-share', factory(require) })` の中で `require('react')` から React を取り、`createElement` で描く。**ビルド無し**。
- Host ⇄ Client は `webServer` のルート登録と `tapIndex` によるブート値注入＋`fetch` で行う（`dsh-shared-memory` と同じ方式）。typertのRemote機構は使わない（生成物とビルドが要るため）。
- 押したときの流れ:
  1. `plan` を要求 → Hostが「何をどこへ出すか」を返す。パッケージ名・版・含まれるファイル一覧と合計サイズ・sha256・リポジトリ名・可視性・タグ・Release名・`gh` の有無。
  2. 確認パネルを表示する。公開範囲を明記し、既定は public（切り替え可）。
  3. 承認後に `publish` を要求 → pack → `gh repo create`（無ければ）→ commit → push → tag → Release作成と `.tgz` 添付。
  4. 完了表示: 共有URL（リポジトリURLと `.tgz` のURL）と、貼るだけで入る案内文をコピーできる。
- 進捗は `status` のポーリングで表示する。失敗はどの段で止まったかをそのまま出す。
- **出版は不可逆**（公開リポジトリに出る）。確認パネルを飛ばす経路は作らない。同名のリポジトリが既にある場合は上書きせず、既存リポジトリへの追加コミットとして扱い、その旨を確認画面に出す。

## 9. 信頼について（正直に書く）

- sha256は**破損と差し替えの検知**であり、**作者の証明ではない**。マニフェストとtarballが同じ出所から来るなら、その出所を信じていることになる。
- 信頼の錨は「あなたが貼ったURL」そのもの。だから `inspect` を用意し、インストール前に名前・作者・サイト・sha256・依存を見せる。
- **依存はレジストリから入り、プラグインシェアの検証対象外**。作者のtarballが「別のパッケージに依存している」と宣言していれば、そのパッケージはレジストリの権威で入る。`inspect` は依存一覧を表示し、インストール時のログを見せる。
- インストール後のプラグインはDSHプロセス内で、ワークスペースのサンドボックス外で動く。この危険はプラグインシェアが作り出したものではないが、導入を1クリックにした分だけ、`inspect` の表示を丁寧にする責任がある。
- 依存のインストールスクリプトは既存の承認フロー（`pendingBuilds` → ユーザー承認）に委ねる。**自動承認しない。**

## 10. 構成（ファイル）

```
dsh-plugin-share/
  package.json            # バンドルマニフェスト（dsh.bundle.patch, bin, files）
  cordis.patch.yml        # ローダー行 plugin-share を挿入
  index.js                # Host: inject=['tools','pluginManager'], ツール登録、webServerルート登録
  client.js               # Client: 手書きバンドル（__ModuleLoader__）。プラグイン詳細の共有ボタン
  lib/
    manifest.js           # マニフェストの読み書きとスキーマ検証（2形）
    source.js             # 入力URL/パスの解析（repo/ref/release/tarball/local）
    fetch.js              # 取得（https / ローカル）
    sha256.js             # ハッシュ
    tgz-read.js           # tarballの読み取り（gunzip + tar、安全性検査つき）
    tgz-write.js          # npm形式tarballの書き出し（自前、スクリプト実行なし）
    store.js              # $DSH_HOME/plugin-share/ の配置とinstalled.json
    install.js            # 検証パイプライン（installerを注入可能にしてテストする）
    tool.js               # plugin_share ツール定義
    webui.js              # webServerルート（plan/publish/status）とブート注入、GUI用の出版フロー
  bin/plugin-share.mjs    # 作者側CLI
  schema/plugin-share.schema.json
  docs/format.md          # 型の仕様（人間とエージェント向け）
  README.md               # 2つのプロンプトを含む
  AGENTS.md               # このリポジトリで作業するエージェント向け
  test/                   # node --test
```

- `install.js` は「プロファイルに適用する」部分を差し替え可能な `installer` として受け取る。実体は `ctx.pluginManager`、テストでは偽物。これでDSHを起動せずに全経路を検証できる。
- tarballの読み書きは自前実装（`zlib` の gzip と tar のヘッダ解釈・生成）。実行時依存はゼロ。

## 11. READMEに置く2つのプロンプト

**プロンプトA — プラグインシェア自身を入れる（英文・簡潔）**

```text
Install the DSH plugin "dsh-plugin-share" from this release tarball using the
plugin_manager tool (action: install_bundle, target: the .tgz URL below).
Make sure it appears in list_bundles and that a plugin_share tool becomes
available. If it does not, tell me what is missing instead of installing
anything else.

https://github.com/nezumi0627/dsh-plugin-share/releases/download/v1.0.0/dsh-plugin-share-1.0.0.tgz
```

- gitタグ（`git+https://…#v1.0.0`）にフォールバックする手順も1行添える。
- エージェントが `plugin_manager` を持っていない場合の手順（プロファイルパッチで `tool-plugin-manager` を有効にする／Creator系プリセットを使う）も添える。この操作が `danger-full-access` を要求することも書く。
- **これはプラグインシェアの検証を通らない唯一の経路**であること、信頼の錨はリリース資産（HTTPS＋タグ）であることを明記する。
- 入れた直後に `plugin_share` ツールが現れない場合はDSHを再起動する、と書く。

**プロンプトB — プラグインシェアを使って自作を配る／入れる**

- 作者向け: 「このリポジトリのプラグインをプラグインシェアの形式で配れるようにして。`pack` で `.tgz`・sha256・`plugin-share.json` を作り、GitHubのReleaseにその `.tgz` を上げて、貼るだけで入るURLを教えて。」
- 受け取る側: 「このURLのプラグインをプラグインシェアで入れて: `<URL>`。まず `inspect` で中身と依存を見せて、私がOKと言ったら `install` して。」
- どちらを主にするかは人間のレビューで決める（第13節）。

## 12. 受け入れ基準（検証できる形）

1. `node --test` が通る。マニフェスト検証（2形）、sha256の一致・不一致、tarballの読み書き往復（npm/pnpmが読めること）、読み取り時の安全性（`..`・絶対パス・上限超過）、入力URL解析、`installer` を偽物にしたインストール全経路。
2. 作者側: 実在のプラグイン（例 `dsh-locale-ja` のコピー）に `pack` を実行し、生成した `plugin-share.json` の `sha256` が独立ツール（`Get-FileHash`）の値と一致する。**生成した `.tgz` が実際にpnpmで入ること**を実機で確認する。
3. 改ざん検知: `.tgz` の1バイトを変えて `install` すると、sha不一致で中断し、プロファイルにも `artifacts/` にも何も残らない。
4. 実地エンドツーエンド: まず使い捨ての小さなテストプラグインをローカルで `pack` し、`plugin_share install <そのtarball>` で入れる。プロファイルの `dsh.profile.bundles` に載り、`plugin_manager list_bundles` に出て、通常のプラグインとして読み込まれることを確認し、`remove` で元に戻す。次に同じ経路をプラグインシェア自身のRelease（GitHub）から通す（ドッグフーディング。**公開リポジトリは増やさない**）。
5. 依存解決: 依存を1つ宣言したテストプラグインが、レジストリから依存を引いて入ること。インストールスクリプトを持つ依存では `pendingBuilds` が出て、承認するまで実行されないこと。
6. ブートストラップ: 手作業のコピーなしで、プロンプトAだけでプラグインシェアが入り `plugin_share` ツールが現れる。基準4の前に実施する。
7. リポジトリがGitHubに存在し、Releaseに `.tgz` とsha256が添付されている。READMEに2つのプロンプト、`AGENTS.md` がある。
8. GUI: プラグイン詳細ページに、自分のローカルプラグインの「共有」ボタンが出る。押すと確認パネルが出て、承認するとGitHubにリポジトリとReleaseができ、表示されたURLを `plugin_share install` に渡すと入る。
9. GUI: 共有できないバンドル（レジストリや他人のtarball由来）ではボタンが出ない、または理由付きで無効になっている。

## 13. 実装時に確認が要る点（設計者が把握している不確実性）

- **pnpmがプロファイルに記録するspecの形**: ローカルの `.tgz` 絶対パスを `pnpm add` したとき、`package.json` に何が書かれるか（`file:` か、絶対パスそのままか、相対化されるか）。`installed.json` の `profileSpec` に実測値を入れる。相対化される場合は `artifacts/` の位置が安定していることが前提になるため、READMEに「`artifacts/` を消さない」と明記する。
- **`installBundle` の成功判定**: tarball spec でバンドル判定が前後差分で正しく行われるか、`already-installed` 相当の拒否がどう出るか（実測する）。更新は「同じ名前で新しいtarballを `installBundle`」で足りなければ「remove→install」にフォールバックする。
- **ツールの見え方**: プロファイル直下のプラグインが登録したツールはエージェントから見える（実例あり）。ただしプリセットがツール行を明示列挙する構成では `plugin_share` を足す必要があるかもしれない。実機で確認し、必要ならプロンプトAに手順を含める。
- **HMR**: プラグインを入れた直後にツールが現れるか、再起動が要るか。
- **プロンプトBの主従**: 「作者が配る用」と「受け取る側が入れる用」のどちらを主に置くか。両方載せたうえで人間のレビューで決める。
- **`created` の意味**: 「その版を作った日」とした。人間の意図が「共有した日」なら `published` を必須項目に格上げする。
- **スロットの見え方（GUI）**: 第三者のクライアントプラグインが `plugins.detail.actions` に差し込めるか、バンドル詳細ページが第三者のバンドルでも `actions` を描画するかを実機で確認する。
- **GUIの通信路**: `webServer.register` / `tapIndex` のAPIは `dsh-shared-memory` の実装を参考にする。デスクトップ版（Electron）でも同じルートが使えるか実機で確認する。認証（ブートトークン）の作法も同実装に合わせる。
- **`gh` の実行環境（GUI）**: GUIから `gh` を起動するときの環境（PATH、認証、プロキシ）。デスクトップアプリのプロセス環境で `gh` が見つかるか実機で確認する。

## 14. この文書が定めないこと（実装者の裁量）

- tarballの読み書きの実装詳細（内部APIの形、ストリームか一括か）。
- エラーメッセージの文言、ログの粒度。
- テストの構成とファイル分割。
- `artifacts/<name>/<version>.tgz` という骨格は固定だが、それ以外のディレクトリ命名の細部。
- CLIのフラグ名の細部（`--out` など既定の提案はある）。
