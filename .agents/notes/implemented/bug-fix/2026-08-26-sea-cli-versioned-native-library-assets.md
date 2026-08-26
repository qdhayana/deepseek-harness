# Agent Note: SEA CLI executable freezes versioned native shared libraries

Status: implemented

English | [中文](2026-08-26-sea-cli-versioned-native-library-assets.zh.md)

## Problem

The packaged CLI executable built by `scripts/build-exe-cli.ts` failed to boot the web profile at plugin import time:

```text
failed to import loader entry attachment-local (@deepseek-ai/dsh-attachment-local): Could not load the "sharp" module using the linux-x64 runtime
ERR_DLOPEN_FAILED: libvips-cpp.so.8.18.3: cannot open shared object file: No such file or directory
```

The asset glob list froze `node_modules/**/*.so` into the SEA snapshot, but sharp's bundled libvips ships under a versioned soname (`libvips-cpp.so.8.18.3`) that does not match `*.so`, so the 18 MB library was absent from the frozen blob.

The failure surfaces at first use rather than build time because of how pkg loads native addons: its dlopen patch copies a `.node` file's owning scope directory out of the snapshot virtual FS into `~/.cache/pkg/<sha256(.node)>/`, and that copy can only materialize files present in the frozen blob. A missing dependency then appears as an ordinary dlopen error when the addon first loads, with no build-time diagnostic naming it.

## Decision

`scripts/build-exe-cli.ts` freezes native shared libraries under three glob forms: `node_modules/**/*.so`, `node_modules/**/*.so.*` for versioned sonames such as `libvips-cpp.so.8.18.3`, and `node_modules/**/*.dylib` for macOS. The `.node` file's shipped RPATH (`$ORIGIN/../../sharp-libvips-linux-x64/lib`) resolves inside the extracted scope directory, so no loader environment variable is needed at runtime.

## Verification

A dry run of the staging globs against `dist-exe/cli-staging/node_modules` matches exactly one file for `node_modules/**/*.so.*` — `@img/sharp-libvips-linux-x64/lib/libvips-cpp.so.8.18.3` — and none for `node_modules/**/*.so`. The rebuilt executable (208 MB, up from 191 MB) boots with zero dlopen errors: the web profile serves its index page and a hashed CSS asset over HTTP from a fresh `DSH_HOME`, and headless boot reaches credential resolution. The LLM-path retest requires `DEEPSEEK_API_KEY` and is outside the keyless smoke tests.

## Alternatives considered

**Keep only `node_modules/**/*.so`.** Rejected because versioned sonames do not end in `.so`; that pattern matched zero files in the staging tree while sharp's libvips — the only native shared library it depends on — went unfrozen, which is exactly how this defect shipped.

**Enumerate per-package globs for `@img/sharp-libvips-*`.** Rejected because it pins the build script to one package's layout; any later native dependency shipping a versioned soname would silently drop out again. The three platform-generic forms cover Linux and macOS conventions without touching the script per dependency.

## Consequences

The executable grows from 191 MB to 208 MB for the libvips library, and every future native dependency with a versioned soname is frozen automatically. A new shared-library filename form (for example a static archive or a platform-specific name) still fails at first use rather than build time; when that happens, extend the glob list in `scripts/build-exe-cli.ts` and re-run the staging dry run. The macOS `.dylib` pattern is validated by convention only: the linux-x64 staging tree contains no dylibs to exercise it, so a darwin host must confirm the first macOS build.
