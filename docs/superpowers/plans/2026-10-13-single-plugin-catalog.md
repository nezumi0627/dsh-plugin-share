# Single Repository Plugin Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish all eligible local DSH plugins through one manually-created GitHub catalog repository.

**Architecture:** Persist one shared repository target, publish each package with a collision-free namespaced release tag, and maintain a root README/catalog.json index. The existing release manifest and digest verification remain the receiver contract; the Share UI produces per-release instructions.

**Tech Stack:** Node.js 22+, ESM, built-in `node:test`, GitHub REST API via fetch and the existing `gh` auth boundary.

**Spec:** `docs/superpowers/specs/2026-10-13-single-plugin-catalog.md`

## Global Constraints

- Zero runtime dependencies; ESM only; Node 22 or newer.
- Never import DSH internals or write into a DSH profile/package manifest.
- Never publish without explicit panel confirmation and the exact digest shown by that panel.
- Keep credentials host-side; do not store GitHub tokens in repository settings or return them to the client.
- Refuse publication on secret findings and preserve receiver digest verification.
- Preserve standalone CLI behavior.

## Review Focus

- Two package names at the same version must not collide on a release tag.
- A missing/invalid catalog must not erase entries or publish a partial catalog.
- Empty newly-created repositories must initialize their default branch safely.
- Repeated unchanged shares must make no writes; changed content at the same package version updates the release asset and index.
- Private repositories must be identified in the confirmation/results so recipients know access is required.

---

### Task 1: Shared repository settings and unique release identity

**Files:**
- Modify: `lib/repositories.js`
- Modify: `lib/publish.js`
- Create: `lib/catalog.js`
- Test: `test/repositories.test.mjs`
- Test: `test/catalog.test.mjs`
- Test: `test/publish.test.mjs`

**Interfaces:**
- `getRepository(name, opts)` and `saveRepository(name, target, opts)` remain compatible with current routes but persist one canonical target.
- `catalogReleaseTag(name, version)` returns a validated deterministic tag unique to the package and version.

- [ ] Write tests for one shared setting across names, legacy ambiguity, and same-version package tag uniqueness.
- [ ] Run focused tests and observe expected failures.
- [ ] Implement canonical settings with safe legacy migration and release-tag generation.
- [ ] Run focused tests and confirm pass.

### Task 2: GitHub catalog publishing

**Files:**
- Modify: `lib/github.js`
- Create: `lib/catalog.js`
- Test: `test/github.test.mjs`
- Test: `test/catalog.test.mjs`

**Interfaces:**
- `publishToGitHub(plan, repository, {token, fetchImpl, onProgress, catalogMode})` retains standalone behavior; `catalogMode: true` upserts root `catalog.json` and `README.md` while preserving unrelated entries.
- Catalog records contain package name/version, summary, release tag/link, asset URL, SHA-256, bytes, and creation date; never tokens or source file contents.

- [ ] Write tests for empty repository initialization, catalog upsert/preservation, unchanged retry, changed asset, malformed catalog fail-closed, and same-version distinct packages.
- [ ] Run focused tests and observe expected failures.
- [ ] Implement transactional ordering: validate/scan, publish release asset, then atomically commit generated catalog files; report partial release success explicitly if catalog commit fails.
- [ ] Run focused tests and confirm pass.

### Task 3: One-time setup and per-plugin share instructions

**Files:**
- Modify: `lib/webui.js`
- Modify: `client.js`
- Modify: `test/webui.test.mjs`
- Modify: `test/client.test.mjs`

**Interfaces:**
- Setup and repository routes accept the existing request shape; every plugin resolves to the same repository.
- Share plans use namespaced tags and catalog mode; result includes release URL, asset URL, checksum, and catalog URL.

- [ ] Write tests for settings reuse across different package names, per-package release details, digest confirmation, and copied instructions.
- [ ] Run focused tests and observe expected failures.
- [ ] Implement single-repository UX, per-plugin release confirmation, and copyable inspect-first instructions.
- [ ] Run focused tests and confirm pass.

### Task 4: Documentation, full verification, and publish readiness

**Files:**
- Modify: `README.md`
- Modify: `docs/format.md` only if the direct release workflow needs clarification.
- Test: all `test/*.test.mjs`

- [ ] Document creating one empty catalog repository, setting its URL once, and sharing each plugin by its release link.
- [ ] Run the complete `node --test` suite and confirm every test passes.
- [ ] Scan every intended local plugin; explicitly exclude `dhs-remote` and its related package.
- [ ] Do not publish plugin contents outside the UI's digest confirmation flow.
