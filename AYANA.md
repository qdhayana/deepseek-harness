# AYANA productization plan

This fork ships DeepSeek Harness as the AYANA agent product to employees: own versioning, Windows/macOS installers, update check with self-update, pre-installed plugins, AYANA branding, Auth0-gated login, and regular sync with upstream (`deepseek-ai/deepseek-harness`). This file records the decisions, the exact fork-touch list, and the backlog; it is the single owning document for fork strategy. Upstream rules in `AGENTS.md` and `docs/AGENTS.md` still govern everything outside this file.

## Decisions

### 1. Fork strategy: additive, minimal-diff

Fork-owned code lives only in new files and new packages (own bundles, profile, plugins, updater). Upstream files are edited in place solely at the identity touch list in [In-place edit registry](#in-place-edit-registry); any merge conflict outside that list signals upstream renamed something the fork depends on. Do not rescope or rename upstream packages (`scripts/change-scope.ts` is a diff reporter, not a renaming tool; upstream repackages freely pre-release).

### 2. Versioning: product version decoupled from package versions

AYANA carries its own product version (`AYANA x.y.z`) on installers, the update manifest, and `--version`. Upstream package versions stay as synced; each AYANA release manifest records the upstream base SHA for traceability. If npm distribution is used, fork-owned packages publish as `@ayana/*` to GitHub Packages.

### 3. Installers, update check, self-update

Distribute as pkg `--sea` single executables per platform, extending the pattern in `scripts/build-exe-for-python-sdk.ts` (its platform targets and sidecar handling for `rg` and `spawn-helper`) to the CLI itself. Wrap the executable in thin installers: signed and notarized `.pkg` on macOS, MSI/NSIS or signed zip on Windows. Update check reads a versioned channel manifest JSON over HTTPS; self-update verifies integrity/signature and performs an atomic swap of the executable plus sidecars. A small launcher shim owns the swap so the running binary never overwrites itself (Windows file locking).

The update endpoint needs a decided host: S3+CDN, GitHub Releases, or the AYANA BFF — see [Backlog](#backlog). CLI-side, the update client is an additive plugin following the telemetry endpoint pattern (baked URL with env override, `packages/bundle/base/cordis.patch.yml`).

### 4. Default plugins: yes, baked in

Custom plugins ship pre-installed as fork-owned bundle packages — an npm package with `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` whose patch rows insert the AYANA plugin entries (`packages/bundle/README.md`). The AYANA profile lists these bundles, and the plugins are declared as npm dependencies of the product so the pnpm-deploy/SEA closure freezes them into the installer; users never run a package manager. First-boot or `pnpm`-based plugin install (`dsh plugin add`) is not used for the default set.

### 5. Branding

Overlay mechanisms cover most of it: system-prompt harness identity off + `persona` config, web brand via an own slot package replacing `packages/client/ui-brand-official` under a non-`official` build profile with `DSH_CLIENT_TITLE=AYANA`, the telemetry endpoint row repointed or disabled in the own bundle layer, and no shipping of `packages/skill/skill-badge`. The remaining strings need the in-place edits listed below. Docs and READMEs mentioning DeepSeek stay untouched — they document upstream.

### 6. Provider/model allowlist: backlog

Moved to [Backlog](#backlog) by decision.

### 7. Auth0 gating

Running the agent requires an Auth0 employee login. A fork-owned plugin adds the login command (PKCE with localhost redirect; Device Authorization Grant for headless/SSH), stores tokens through the credentials capability (`ctx.credentials`, mode-0600 store), and gates the agent loop: no valid token, no LLM turn. Token refresh and logout handled by the same plugin.

Phase 2 hardens the gate server-side together with the BFF-backed provider (backlog item): the BFF validates the Auth0 JWT and owns model policy, so a tampered local install gains nothing. Until then the local gate is a product-policy control, not a security boundary — acceptable for employees, stated here so nobody mistakes it for more. The web surface has no auth layer upstream and designates the `/api` FetchHandler interceptor as the extension point (`packages/client/connection/README.md`); AYANA web auth plugs in there.

### 8. Upstream sync

Add remote `upstream` → `deepseek-ai/deepseek-harness` and merge at `dsh-v*` release tags on a fortnightly cadence, never mid-PR-stream. Keep the fork CI = upstream gates (`.github/workflows/ci.yml`) with only the release workflow replaced. Expect upstream format breaks (`SESSION_FORMAT_VERSION`, repo's pre-release stance); call them out in AYANA release notes. Conflicts should concentrate in the edit registry below — investigate anything else.

### 9. macOS desktop `.app` for team installs

Ship a macOS `.app` as the primary desktop distribution for teams. The app tells teams "double-click and it opens in your browser" instead of teaching a CLI workflow: `Contents/MacOS/ayana` is a minimal native launcher that spawns the packaged `ayana-macos-arm64` exe from `Contents/Resources/` with the web profile, waits for the local port, opens the default browser, and owns lifecycle (Dock icon, Quit kills the child). No embedded web engine — the UI stays in the browser, so the wrapper adds megabytes, not hundreds of megabytes.

Two scoped risks this decision accepts up front:

- **Update path for `.app` installs is the installer, not self-update.** Swapping the exe inside an already-notarized bundle breaks notarization, so `.app` users take updates from the `.pkg` installer channel (decision 3) until a re-notarize-on-update path exists. Self-update as designed applies to headless and non-`.app` installs only.
- **The launcher is a fork-owned new package** (backlog: `apps/desktop-app`), so this decision adds an in-repo macOS build surface with its own host constraint (build on a darwin machine; same one that already owns node-pty staging there).

Alternatives recorded, not taken: **Tauri 2** (OS WebKit embedded window in a Rust shell; native-feeling dock/tray, ~15 MB shell) — defer until teams actually want an app window instead of a browser tab; **Electron** is rejected on size grounds alone. Standard distribution format for unsigned Apple Silicon builds is a signed disk image or zipped `.app`; unsigned-for-testing is fine, but employees never install an unnotarized build.

## In-place edit registry

The complete list of upstream files the fork modifies. Keep each edit small and grep-able.

| File | Edit |
|---|---|
| `apps/cli/package.json` | bin name `dsh` → `ayana`; package/repository metadata |
| `apps/cli/src/args.ts` | commander name, description, help examples |
| `packages/llm/llm/src/attribution.ts` | `APP_IDENTITY` product/URL (User-Agent) |
| `scripts/client-build-environment.ts` | `DSH_CLIENT_TITLE` (only if shipping the web UI) |
| `apps/web/public/manifest.webmanifest` | PWA name (only if shipping the web UI) |
| `packages/boot/app-boot/src/profile.ts` | `PROFILE_TEMPLATES` default bundles → AYANA bundle |
| `packages/util/home-paths/src/index.ts` | home dir `.dsh` → `.ayana`, `DSH_HOME` → `AYANA_HOME` (decide env-compat shim) |
| `.github/workflows/` | release workflows replaced for AYANA artifacts |

Everything else is additive: AYANA bundle(s), profile, plugins, updater, Auth0 plugin.

## Backlog

Ordered, unstarted. Each item links its seam when picked up.

- **Provider/model allowlist** (decision 6). Tier 1: bundle config pins `agent-default-model` and disables `llm-pi-ai` — offer-lock only. Tier 2: fork-owned guard plugin on the `llm/stream` waterfall rejecting non-allowlisted provider/model — hard, still additive. Tier 3: BFF-backed provider — no direct provider adapter ships; the AYANA BFF holds provider keys, validates Auth0 JWT, enforces model policy server-side (`packages/api/gateway`, `packages/client/connection` are the shipped remote seam). Tier 3 also removes API keys from laptops; pair with Auth0 phase 2.
- **Windows executable target** for the SEA pipeline: extend the platform list beyond `node24-linux-*/macos-arm64`, validate the node-pty winpty path (unexercised by the current exe build), spawn-helper equivalent, and the launcher-shim swap on Windows.
- **macOS `.app` launcher** (decision 9): fork-owned `apps/desktop-app` package — thin native launcher wrapping `ayana-macos-arm64` + `-rg`/`-spawn-helper` sidecars in `Contents/Resources/`, Info.plist with the AYANA icon, and a `.app` assembly step in the darwin build leg after the signing infra item lands.
- **Signing infrastructure**: Apple Developer ID + notarization flow, Windows code-signing certificate.
- **Update endpoint hosting** decision (S3+CDN vs GitHub Releases vs AYANA BFF) and channel manifest schema (`<product>-<platform>-<arch>` naming follows the existing exe pipeline).
- **Home-dir migration**: decide whether AYANA reads legacy `$DSH_HOME`/`~/.dsh` during employee rollout.

## Open risks

- Windows support is CI-tested upstream but the executable/installer path is new ground.
- Upstream pre-release stance permits sweeping renames; sync often, keep the edit registry current.
- AYANA web UI (if shipped) adds branding, auth-interceptor, and signing surface beyond the CLI.
