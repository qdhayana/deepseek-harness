# PROGRESS

Working log for the AYANA productization effort. Decisions live in [AYANA.md](AYANA.md); this file tracks where the work stands.

## Done

- **Repo assessment** — mapped the fork-relevant seams: release machinery (`scripts/release/`, npm-family versioning, GitHub Actions publish), packaging (pkg/SEA pipeline exists for the python-sdk runtime only, linux/macos-arm64, no Windows, no installers), branding surface (~8 runtime files need in-place edits, rest is docs), extension seams (bundles/presets/profiles/credentials/Auth0-free), no existing update-check or self-update.
- **Decisions recorded** in `AYANA.md`: additive minimal-diff fork; product version decoupled from package versions; SEA exe + thin installers + update manifest + self-update; plugins baked in as defaults; Auth0-gated login; provider/model lock as backlog (3 tiers); sync at upstream `dsh-v*` tags fortnightly.
- **Dev environment working** — `corepack pnpm install && corepack pnpm run build` verified from clean checkout; `pnpm dsh web` serves on 127.0.0.1:3080. Dev loop: `pnpm run dev:web` for hot browser reload (never concurrently with `pnpm run build`).
- **Remote access settled** — SSH tunnel (`ssh -L 3080:localhost:3080`), confirmed working from MacBook. tailscale serve + `--trusted-host <machine>.<tailnet>.ts.net` documented as the persistent-share alternative. Direct `0.0.0.0` bind is a hard refusal in code (`packages/bundle/web-app/src/startup.ts:75`) by design; fence is reachability-only, no auth — no tailnet sharing before the Auth0 gate.
- **SEA CLI exe spike complete** — `apps/cli-pkg` deploy root + `scripts/build-exe-cli.ts` produce `dist-exe/ayana-linux-x64` (208 MB) + `-rg` sidecar via pnpm deploy → `@yao-pkg/pkg --sea` (node24); smoke: `--version`=0.1.0-rc.8, `--help` exit 0, `--profile web` from a fresh `DSH_HOME` serves index (200) + a hashed css asset (200) over curl. Found and fixed a native-asset gap: `node_modules/**/*.so` never matches versioned sonames, leaving sharp's 18 MB `libvips-cpp.so.8.18.3` out of the frozen blob and failing web-profile boot with `ERR_DLOPEN_FAILED`; added `*.so.*`/`*.dylib` globs (191→208 MB, zero dlopen errors, boot reaches credential resolution). LLM-path retest pending a `DEEPSEEK_API_KEY` in this environment.
- **macOS `.app` decided (per user, 2026-08-26)** — thin native launcher wrapping the `ayana-macos-arm64` exe (no embedded web engine; Dock icon + browser handoff); recorded as AYANA.md decision 9, new backlog item `apps/desktop-app`, gated on the signing-infra item. Update interplay recorded there too: `.app` updates come from the installer channel until a re-notarize-on-update path exists.

## In progress

### Identity spike (line-by-line outcomes from AYANA.md's registry)

- [x] **`apps/cli/package.json`** — bin `dsh` → `ayana`, description prefix adjusted; package name/version kept (no rescope per decision 1); repository URL left for the fork-hosting decision (user: decide later).
- [x] **`apps/cli/src/args.ts`** — commander name/description/help examples → `ayana`; verified by `apps/cli/tests/args.spec.ts` (6/6 pass; parser pins nothing identity-shaped, `built-bin.e2e.ts` invokes `lib/bin.js` by path).
- [ ] **`packages/llm/llm/src/attribution.ts`** — deferred by user until release-phase branding: couples to `llm/tests/attribution.spec.ts` (3 assertions pin product+URL) and awaits the same URL answer.
- [ ] **`scripts/client-build-environment.ts`** — no edit needed: `resolveClientBuildEnvironment` passes inherited `DSH_CLIENT_*` through when no profile is selected, so a fork build sets `DSH_CLIENT_TITLE=AYANA` outside the registry file.
- [ ] **`apps/web/public/manifest.webmanifest`** — small static edit when web-UI identity lands.
- [ ] **`packages/boot/app-boot/src/profile.ts`** — blocked until the `@ayana/*` bundle package exists.
- [ ] **`packages/util/home-paths/src/index.ts`** — blocked on env-compat decision; rename would diverge ~8 coupled test files (`vi.stubEnv('DSH_HOME', …)`, shell-env key assertions) that triage needs to stay clean of.
- [ ] **`.github/workflows/`** — release-phase work.

## Next up (from AYANA.md)

1. Commit this update (git mutations approved by user).
2. Update check + self-update (needs hosting decision: GitHub Releases vs S3+CDN vs BFF).
3. Windows build via GitHub Actions `windows-2025` runner (can't cross-compile node-pty from Linux).
4. macOS `.app` launcher — after the signing-infra item; mech verified end-to-end on a darwin host.
5. Auth0 gate plugin (needs tenant domain + client ID + flow choice from user).
6. AYANA bundle package, then registry lines 6/7/5/3 behind their decisions.

## Open questions for the user

- Update/artifact hosting: GitHub Releases (private repo → updater needs a token) or S3+CDN?
- Auth0 tenant domain / client ID, and PKCE-localhost vs device-flow preference.
- Fork repository URL (feeds `apps/cli/package.json` repository metadata, `APP_IDENTITY.url`) and the release-phase branding expectation for the User-Agent product token.
- Home-dir compat: read legacy `$DSH_HOME`/`~/.dsh` for employees during rollout, or clean break? Also whether a `DSH_*` → `AYANA_*` compatibility shim is in scope.
