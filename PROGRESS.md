# PROGRESS

Working log for the AYANA productization effort. Decisions live in [AYANA.md](AYANA.md); this file tracks where the work stands.

## Done

- **Repo assessment** — mapped the fork-relevant seams: release machinery (`scripts/release/`, npm-family versioning, GitHub Actions publish), packaging (pkg/SEA pipeline exists for the python-sdk runtime only, linux/macos-arm64, no Windows, no installers), branding surface (~8 runtime files need in-place edits, rest is docs), extension seams (bundles/presets/profiles/credentials/Auth0-free), no existing update-check or self-update.
- **Decisions recorded** in `AYANA.md`: additive minimal-diff fork; product version decoupled from package versions; SEA exe + thin installers + update manifest + self-update; plugins baked in as defaults; Auth0-gated login; provider/model lock as backlog (3 tiers); sync at upstream `dsh-v*` tags fortnightly.
- **Dev environment working** — `corepack pnpm install && corepack pnpm run build` verified from clean checkout; `pnpm dsh web` serves on 127.0.0.1:3080. Dev loop: `pnpm run dev:web` for hot browser reload (never concurrently with `pnpm run build`).
- **Remote access settled** — SSH tunnel (`ssh -L 3080:localhost:3080`), confirmed working from MacBook. tailscale serve + `--trusted-host <machine>.<tailnet>.ts.net` documented as the persistent-share alternative. Direct `0.0.0.0` bind is a hard refusal in code (`packages/bundle/web-app/src/startup.ts:75`) by design; fence is reachability-only, no auth — no tailnet sharing before the Auth0 gate.

## In progress

### Spike: SEA executable for the CLI (build-exe-cli)

Goal: `dist-exe/ayana-linux-x64` that boots itself (no Node/pnpm needed), verified by the smoke tests below.

- [x] Deploy root created: `apps/cli-pkg/package.json` (private, depends only on `@deepseek-ai/dsh`; `apps/*` already a workspace glob — zero upstream edits).
- [x] `scripts/build-exe-cli.ts` — adapted from `scripts/build-exe-for-python-sdk.ts` (deploy staging → pkg `--sea`, target node24-linux-x64, `-rg` sidecar + node-pty staging via `resolveLinuxNodePtyAddon`, python sync/verify-closure dropped, asset globs widened with css/html/yml/yaml/fonts/webmanifest/svg/png plus native shared libraries, entry `node_modules/@deepseek-ai/dsh/lib/bin.js`, staging at `dist-exe/cli-staging`). Product: `dist-exe/ayana-linux-x64` (208 MB).
- [x] Smoke tests pass on the packaged exe: `--version` prints 0.1.0-rc.8; `--help` exits 0; `DSH_HOME=/tmp/ayana-exe-test ... --profile web --port 3180 --no-open` serves index (200) + hashed css asset `/assets/vendor-CjyC-hUb.css` (200, text/css) over curl.
- [x] Known packaging risks validated: ESM entry boots under SEA; profile fallback works with a fresh `DSH_HOME` (web profile booted from an empty home).
- [x] **sharp/libvips dlopen fix** — first web-profile boot failed at plugin import: `ERR_DLOPEN_FAILED: libvips-cpp.so.8.18.3`. Root cause: the asset glob `node_modules/**/*.so` never matches versioned sonames (`libvips-cpp.so.8.18.3` does not end in `.so`), so the 18 MB libvips was absent from the frozen blob; pkg's dlopen patch copies a package's scope dir from the snapshot to `~/.cache/pkg/<sha256(.node)>/` on first load, but can only materialize files that were frozen. Fix: added `node_modules/**/*.so.*` and `node_modules/**/*.dylib` (macOS) globs in `build-exe-cli.ts`. Verified: exe size 191→208 MB, zero dlopen errors, boot reaches credential resolution. Full LLM-path retest pending a `DEEPSEEK_API_KEY` in this environment.

## Next up (from AYANA.md)

1. Finish this spike.
2. Fork hygiene: upstream remote, fork branch, commit `AYANA.md` + this file (needs user OK — git mutations).
3. Identity spike: the 8-file edit registry in `AYANA.md` (bin name `ayana`, help text, User-Agent, profile template, home dir).
4. Update check + self-update (needs hosting decision: GitHub Releases vs S3+CDN vs BFF).
5. Windows build via GitHub Actions `windows-2025` runner (can't cross-compile node-pty from Linux).
6. Auth0 gate plugin (needs tenant domain + client ID + flow choice from user).

## Open questions for the user

- Git mutations OK? (branch + commit of AYANA.md/PROGRESS.md/new spike files)
- Update/artifact hosting: GitHub Releases (private repo → updater needs a token) or S3+CDN?
- Auth0 tenant domain / client ID, and PKCE-localhost vs device-flow preference.
