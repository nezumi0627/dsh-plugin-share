# Guided GitHub Sharing

## Intent

Make sharing a locally installed DSH plugin a short, guided flow. The author connects GitHub, creates the destination repository themselves, supplies its URL, then uses a per-plugin Share action to upload the plugin and get a ready-to-send message.

## User flow

1. Open a plugin's detail page and choose **Share** beside its enabled switch.
2. On first use, follow a setup panel: connect GitHub, create a repository manually, paste its URL, and save it.
3. Later presses of **Share** package that plugin, publish its files and release asset through GitHub's API, then show a recipient message with a copy button.

The recipient message asks the friend to inspect the repository and show the plugin name, author, SHA-256, and dependencies before installing.

## Decisions

- Use GitHub CLI (`gh`) as the OAuth device-flow and secure credential-store bridge. The plugin never asks for or persists a token; Host code obtains it from `gh auth token` only for the API request.
- The author creates the destination repository manually. Setup accepts only a `github.com/<owner>/<repo>` URL and verifies that the connected account has push permission.
- Persist only the package-to-repository URL mapping under `$DSH_HOME/plugin-share/`.
- Publish source files with GitHub's Git Database API (tree, commit, ref), create a draft release, upload the `.tgz` asset, then publish the release. Do not shell out to `git push` or create repositories.
- On repeat shares, compare Git blob SHAs for all files that the packer includes. If the tree matches, return the existing URLs without a write. If it differs, commit the changed files, upload a SHA-named asset, and move the existing version tag/release to the new commit.
- Reuse the `created` timestamp from the existing repository manifest so an unchanged plugin without Git metadata still produces a stable artifact digest.
- Before planning or publishing, block files with credential-bearing names or content patterns (private-key headers, common provider tokens, and secret-style assignments). Error messages identify paths only and never echo matched values.
- A configured Share action starts publishing immediately. The first-time setup ends with an explicit **Save and share** action.
- Keep the existing CLI pack/inspect/verify and receiver-side install flow. Keep the current digest confirmation in the backend by recomputing the plan immediately before publishing.

## Constraints

- Never return GitHub credentials to the browser or write them to plugin-share settings.
- Require an authenticated GitHub identity and repository push permission before upload.
- Preserve a no-op for identical content; update the existing release/tag only when the packaged tree differs.
- Stop publication when the local secret scan finds likely credentials.
- Only publish files included by the existing safe packer plus the generated root `plugin-share.json` and release `.tgz`.
- Preserve the existing Share-result copy action and unrelated working-tree changes.

## Success criteria

- An author can connect from the guided panel, register a manually created repository URL, and publish without Git remotes or `git push`.
- A Share action is rendered in the plugin detail action row next to the enable switch.
- The finished panel exposes a Japanese inspect-first message that can be copied, with a manual-copy fallback.
- Tests cover auth status, URL and permission validation, API commit/release/upload, release conflicts, and the client flow.
