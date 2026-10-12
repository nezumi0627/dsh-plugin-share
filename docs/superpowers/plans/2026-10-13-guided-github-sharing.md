# Guided GitHub Sharing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an author connect GitHub, register a manually created repository, and share a plugin through the GitHub API from its DSH action row.

**Architecture:** Host routes own GitHub CLI authentication, repository validation, settings persistence, and Git Database/release API calls. The client presents setup only when needed, then runs a one-click share job and exposes a copyable recipient prompt.

**Tech Stack:** Node.js 22+ ESM, built-in child_process/fs/fetch, React supplied by DSH, `node --test`.

**Spec:** `docs/superpowers/specs/2026-10-13-guided-github-sharing-design.md`

## Global Constraints

- Keep zero runtime dependencies.
- Never return or persist GitHub tokens in plugin-share settings or browser state.
- Keep all plugin-owned state inside `$DSH_HOME/plugin-share/`.
- Use the safe packer and GitHub API; do not push via git.
- Preserve existing CLI and receiver-install behavior.

## Review Focus

- GitHub CLI missing or logged out: return a short setup instruction without leaking process output.
- Malformed URL, inaccessible repo, or no push permission: refuse before writing files.
- An identical published tree produces no GitHub writes; a changed tree updates the existing release with a hash-named asset.
- API failure mid-upload leaves a retryable draft or existing release; do not expose credentials.
- Secret-like local files block planning and uploading before any GitHub write.
- Repository contains existing files/default branch: preserve them when adding plugin files.
- Private destination: disclose that friends need repository access in the completion/setup UI.

### Task 1: GitHub connection, repo targets, and API publisher

**Files:** Create `lib/github.js`, `test/github.test.mjs`; modify `lib/publish.js` only if a shared packing helper is needed.

- [ ] Test the strict repository URL parser and GitHub CLI account lookup.
- [ ] Test repo permission validation, identical-tree no-op, changed-tree release update, Git tree/commit/ref writes, draft release, asset upload, and release publication with a fake fetch.
- [ ] Implement Host-only token lookup, GitHub API requests, and the publisher; include source files from the safe packer and the generated manifest.
- [ ] Run the focused tests.

### Task 2: Persist setup and expose Host routes

**Files:** Create `lib/repositories.js`, `test/repositories.test.mjs`; modify `lib/webui.js`, `index.js`, `test/webui.test.mjs`.

- [ ] Test package-to-repository persistence under the plugin-share store root.
- [ ] Add setup/status, GitHub device-login start/status, repository validation/save, and one-click share routes.
- [ ] Keep existing token gate and job progress behavior; never include the GitHub token in a response.
- [ ] Run focused route and storage tests.

### Task 3: Guided client flow and row action

**Files:** Modify `client.js`, `test/client.test.mjs`.

- [ ] Test the setup wizard, connected-account display, repo URL save, immediate publish for configured targets, progress, and recipient-message copy/fallback.
- [ ] Render the Share action in the same detail action row as the enable switch.
- [ ] Show steps: connect GitHub, create/paste repository URL, then save and share; configured bundles publish on one Share press.
- [ ] Keep the Japanese inspect-first recipient message and copy confirmation from the existing work.
- [ ] Run focused client tests.

### Task 4: Documentation and verification

**Files:** Modify `README.md`, `docs/verification.md`.

- [ ] Replace the old `git push`/auto-create author workflow with GitHub connection, manual repository creation, API upload, and recipient-copy steps.
- [ ] Document that private repositories require granting the recipient access.
- [ ] Run `node --test` and `git diff --check`; report that live GitHub publishing needs a real user-created repository and is not performed by the test suite.

## Follow-up: idempotent updates and credential screening

- Identical files should preserve the existing artifact URL and avoid a new commit/release write.
- Changed files update the current version's branch/tag and add a content-addressed release asset.
- The scanner should refuse likely secrets before packing/uploading, disclose only filenames, and be covered for sensitive paths, token signatures, and assignment-style credentials.
