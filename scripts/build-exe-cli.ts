/**
 * Build the AYANA CLI single-file executables. This adapts the
 * `@yao-pkg/pkg --sea` route, deploy flags, and artifact layout of
 * scripts/build-exe-for-python-sdk.ts (whose decisions are owned by
 * .agents/notes/implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md)
 * to the dsh CLI closure; the AYANA packaging strategy is owned by AYANA.md.
 * The staged closure is symlink-free, and whole-tree assets cover Cordis's
 * runtime imports that pkg cannot discover statically. The executable entry
 * is the fork-owned apps/cli-pkg/exe-entry.mjs: it registers a resolve hook
 * that retries bare imports failing from real-filesystem profile directories
 * against the in-process snapshot mount, then runs the upstream CLI bin.
 */

import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { chmod, copyFile, cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { resolveLinuxNodePtyAddon } from './build-exe-for-python-sdk-native-pty.ts'

const root = resolve(import.meta.dirname, '..')

/** The closure manifest whose dependencies define the executable. */
const DEPLOY_ROOT_PACKAGE = 'dsh-cli-pkg'
/** The executable entry, copied into the staging root at build time. */
const ENTRY_BIN = 'exe-entry.mjs'
/** Fork-owned entry source: snapshot-fallback resolve hook plus upstream bin import. */
const ENTRY_SOURCE = join(root, 'apps', 'cli-pkg', 'exe-entry.mjs')
/** The upstream CLI bin the staged entry imports by relative path. */
const UPSTREAM_BIN = 'node_modules/@deepseek-ai/dsh/lib/bin.js'
const OUTPUT_BASENAME = 'ayana'
/** Default Node major; SEA mode requires at least Node 22. */
const DEFAULT_NODE_RANGE = 'node24'
/** Pinned for reproducible builds. */
const PKG_SPEC = '@yao-pkg/pkg@6.21.0'
const OUT_DIR = 'dist-exe'
/** The deployed closure staging tree; pkg consumes it in place. */
const STAGING_DIR = 'dist-exe/cli-staging'
/** Legacy deploy may hoist peer-specialized workspace packages back here. */
const DEPLOY_SOURCE_NODE_MODULES = 'apps/cli-pkg/node_modules'

/**
 * Whole-tree assets cover Cordis's runtime bare-package imports, which pkg's
 * static analysis cannot see. Package manifests are explicit because bare-name
 * resolution depends on them. Beyond the SDK runtime's module set, the CLI
 * closure carries the browser dist (css/html/webmanifest/svg/png plus fonts),
 * every bundle's cordis.patch.yml, and the shipped agent presets (yml/md).
 */
const ASSET_GLOBS = [
  'package.json',
  'exe-entry.mjs',
  'node_modules/**/*.js',
  'node_modules/**/*.cjs',
  'node_modules/**/*.mjs',
  'node_modules/**/package.json',
  'node_modules/**/*.json',
  'node_modules/**/*.node',
  'node_modules/**/*.so',
  // Versioned sonames (libvips-cpp.so.8.18.3) and macOS dylibs do not match `*.so`.
  'node_modules/**/*.so.*',
  'node_modules/**/*.dylib',
  'node_modules/**/*.wasm',
  'node_modules/**/*.css',
  'node_modules/**/*.html',
  'node_modules/**/*.webmanifest',
  'node_modules/**/*.svg',
  'node_modules/**/*.png',
  'node_modules/**/*.ttf',
  'node_modules/**/*.woff',
  'node_modules/**/*.woff2',
  'node_modules/**/*.yml',
  'node_modules/**/*.yaml',
  'node_modules/**/*.md',
]

const PLATFORMS = ['linux', 'macos'] as const
const ARCHES = ['x64', 'arm64'] as const
type Platform = (typeof PLATFORMS)[number]
type Arch = (typeof ARCHES)[number]

function isPlatform(value: string): value is Platform {
  return (PLATFORMS as readonly string[]).includes(value)
}

function isArch(value: string): value is Arch {
  return (ARCHES as readonly string[]).includes(value)
}

/**
 * A parsed pkg target triple, constructed from `--targets` or the host.
 */
class Target {
  private constructor(
    /** pkg Node range (`node<major>`). */
    readonly nodeRange: string,
    /**
     * pkg platform tag. Windows targets are the AYANA.md backlog; this builder
     * validates linux/macos only, matching the current node-pty staging path.
     */
    readonly platform: Platform,
    /** pkg CPU tag. */
    readonly arch: Arch,
  ) {}

  /** The pkg `--targets` spec string `<nodeRange>-<platform>-<arch>`. */
  get spec(): string {
    return `${this.nodeRange}-${this.platform}-${this.arch}`
  }

  /**
   * Parse one target spec, rejecting malformed triples and unsupported platform or architecture.
   * @param spec - the raw triple, e.g. `node24-linux-x64`.
   * @returns the parsed target.
   */
  static parse(spec: string): Target {
    const parts = spec.split('-')
    const [nodeRange, platform, arch] = parts
    if (parts.length !== 3 || nodeRange === undefined || platform === undefined || arch === undefined) {
      throw new Error(`build-exe-cli: target ${JSON.stringify(spec)} must be <nodeRange>-<platform>-<arch>, e.g. node24-linux-x64.`)
    }
    if (!/^node\d+$/.test(nodeRange)) {
      throw new Error(`build-exe-cli: target ${JSON.stringify(spec)}: node range must look like node24, got ${JSON.stringify(nodeRange)}.`)
    }
    if (!isPlatform(platform)) {
      throw new Error(`build-exe-cli: target ${JSON.stringify(spec)}: platform must be one of ${PLATFORMS.join(', ')}, got ${JSON.stringify(platform)}.`)
    }
    if (!isArch(arch)) {
      throw new Error(`build-exe-cli: target ${JSON.stringify(spec)}: arch must be one of ${ARCHES.join(', ')}, got ${JSON.stringify(arch)}.`)
    }
    return new Target(nodeRange, platform, arch)
  }

  /**
   * Resolve the host-platform default on Node 24.
   * @returns the host target; throws on an unsupported host platform or arch.
   */
  static host(): Target {
    const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'linux' ? 'linux' : undefined
    if (platform === undefined) {
      throw new Error(`build-exe-cli: unsupported host platform ${process.platform}; pass --targets explicitly.`)
    }
    const arch = process.arch === 'x64' || process.arch === 'arm64' ? process.arch : undefined
    if (arch === undefined) {
      throw new Error(`build-exe-cli: unsupported host arch ${process.arch}; pass --targets explicitly.`)
    }
    return new Target(DEFAULT_NODE_RANGE, platform, arch)
  }
}

/**
 * Validated CLI configuration; construction owns help and parse-error exits.
 */
class BuildCli {
  private constructor(
    /** Build targets; defaults to the host platform only. */
    readonly targets: readonly Target[],
    /** Skip step 1 (`pnpm run build`); lib/ artifacts must already exist. */
    readonly skipBuild: boolean,
    /** Print every command and config patch instead of executing. */
    readonly dryRun: boolean,
  ) {}

  /**
   * Parse argv. Help exits 0; malformed flags exit 1; invalid or colliding
   * targets throw.
   * @param argv - the raw arguments (`process.argv.slice(2)`).
   * @returns the parsed, validated configuration.
   */
  static parse(argv: string[]): BuildCli {
    let values: ReturnType<typeof BuildCli.parseRaw>
    try {
      values = BuildCli.parseRaw(argv)
    } catch (error) {
      console.error(`build-exe-cli: ${error instanceof Error ? error.message : String(error)}\n`)
      console.error(BuildCli.usage())
      process.exit(1)
    }
    if (values.help) {
      console.log(BuildCli.usage())
      process.exit(0)
    }
    const targets = values.targets === undefined
      ? [Target.host()]
      : values.targets.split(',').map(part => part.trim()).filter(part => part !== '').map(spec => Target.parse(spec))
    if (targets.length === 0) throw new Error('build-exe-cli: --targets is empty.')
    const seen = new Set<string>()
    for (const target of targets) {
      const key = `${target.platform}-${target.arch}`
      if (seen.has(key)) {
        throw new Error(`build-exe-cli: duplicate platform-arch ${key} in --targets; canonical product names would collide.`)
      }
      seen.add(key)
    }
    return new BuildCli(targets, values['skip-build'], values['dry-run'])
  }

  private static parseRaw(argv: string[]) {
    return parseArgs({
      args: argv,
      options: {
        'targets': { type: 'string' },
        'skip-build': { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        'help': { type: 'boolean', default: false },
      },
    }).values
  }

  private static usage(): string {
    return [
      'Usage: pnpm exec tsx scripts/build-exe-cli.ts [flags]',
      '',
      '  --targets=<t1,t2,...>  pkg targets, e.g. node24-linux-x64,node24-linux-arm64,node24-macos-arm64.',
      '                         Default: the host platform only (on node24).',
      '  --skip-build           skip `pnpm run build` (lib/ artifacts must already exist).',
      '  --dry-run              print every command and config patch without executing.',
      '  --help                 print this help.',
      '',
      `Build route: ${PKG_SPEC} --sea; see .agents/notes/implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md.`,
      `Stages the deployed closure at ${STAGING_DIR} and writes executables to ${OUT_DIR}/.`,
    ].join('\n')
  }
}

/**
 * The pinned pnpm, reached through corepack so the repository's
 * `packageManager` version (not whatever pnpm a developer's PATH resolves)
 * services deploy and dlx; `pnpm deploy --legacy` exists only on the pinned
 * major.
 * @returns the executable and the leading arguments that select pnpm.
 */
function pnpmBin(): { command: string; prefix: string[] } {
  const command = process.platform === 'win32' ? 'corepack.cmd' : 'corepack'
  return { command, prefix: ['pnpm'] }
}

/**
 * Render a command for logs and errors, quoting arguments with spaces.
 * @param command - the executable.
 * @param args - its arguments.
 * @returns the printable command line.
 */
function formatCommand(command: string, args: string[]): string {
  return [command, ...args].map(part => (part.includes(' ') ? JSON.stringify(part) : part)).join(' ')
}

/**
 * Sequential build pipeline. Subprocesses inherit stdio and errors include
 * the command; dry runs print commands and filesystem changes.
 */
class CliExeBuild {
  /** The cleared deploy target and pkg input. */
  readonly staging = resolve(root, STAGING_DIR)
  private readonly outDir = resolve(root, OUT_DIR)

  constructor(private readonly cli: BuildCli) {}

  /** Build all package artifacts unless `--skip-build` was passed. */
  async build(): Promise<void> {
    if (this.cli.skipBuild) {
      console.log('build-exe-cli: skipping pnpm run build (--skip-build)')
      return
    }
    await this.run('build', pnpmBin().command, [...pnpmBin().prefix, 'run', 'build'])
  }

  /** Clear and deploy the CLI closure into the staging tree. */
  async deployStaging(): Promise<void> {
    if (this.staging === root || root.startsWith(this.staging + sep)) {
      throw new Error(`build-exe-cli: refusing to clear staging dir ${this.staging}: it contains the repo root.`)
    }
    if (this.cli.dryRun) console.log(`build-exe-cli: [dry-run] rm -rf ${this.staging}`)
    else await rm(this.staging, { recursive: true, force: true })
    await this.run('deploy', pnpmBin().command, [
      ...pnpmBin().prefix,
      '--filter',
      DEPLOY_ROOT_PACKAGE,
      'deploy',
      '--legacy',
      '--prod',
      '--config.node-linker=hoisted',
      '--config.auto-install-peers=false',
      '--config.link-workspace-packages=true',
      this.staging,
    ])
    await this.restoreLegacyHoists()
    await this.materializeStagedLinks()
  }

  /**
   * Restore direct packages that pnpm's legacy hoister places beside the deploy
   * source instead of in the target. The runtime manifest supplies every peer,
   * so package-local node_modules trees are omitted to preserve one flat Cordis
   * instance and a symlink-free packaged payload.
   */
  private async restoreLegacyHoists(): Promise<void> {
    if (this.cli.dryRun) {
      console.log('build-exe-cli: [dry-run] restore direct dependencies omitted by legacy deploy')
      return
    }
    const manifestPath = join(this.staging, 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      dependencies?: Record<string, string>
    }
    const sourceNodeModules = resolve(root, DEPLOY_SOURCE_NODE_MODULES)
    const restored: string[] = []
    for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
      const destination = join(this.staging, 'node_modules', dependency)
      if (existsSync(destination)) continue
      const source = join(sourceNodeModules, dependency)
      if (!existsSync(source)) {
        throw new Error(
          `build-exe-cli: deployed dependency ${dependency} is absent from both ${destination} and ${source}.`,
        )
      }
      await mkdir(dirname(destination), { recursive: true })
      const nestedNodeModules = join(source, 'node_modules')
      await cp(source, destination, {
        recursive: true,
        dereference: true,
        filter: path => path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep),
      })
      restored.push(dependency)
    }
    const stillMissing = Object.keys(manifest.dependencies ?? {})
      .filter(dependency => !existsSync(join(this.staging, 'node_modules', dependency)))
    if (stillMissing.length > 0) {
      throw new Error(`build-exe-cli: staged dependencies remain missing: ${stillMissing.join(', ')}.`)
    }
    if (restored.length > 0) {
      console.log(`build-exe-cli: restored legacy deploy hoists: ${restored.join(', ')}`)
    }
  }

  /** Replace deploy-time package links with files and reject any remaining link. */
  private async materializeStagedLinks(): Promise<void> {
    if (this.cli.dryRun) {
      console.log('build-exe-cli: [dry-run] materialize staged package links')
      return
    }
    const nodeModules = join(this.staging, 'node_modules')
    let remaining = await this.findSymlink(nodeModules)
    while (remaining !== undefined) {
      const segments = remaining.slice(nodeModules.length + 1).split(sep)
      const binIndex = segments.lastIndexOf('.bin')
      if (binIndex >= 0) {
        await rm(join(nodeModules, ...segments.slice(0, binIndex + 1)), { recursive: true, force: true })
        remaining = await this.findSymlink(nodeModules)
        continue
      }
      const destination = remaining
      const source = await realpath(destination)
      const nestedNodeModules = join(source, 'node_modules')
      await rm(destination, { recursive: true, force: true })
      await cp(source, destination, {
        recursive: true,
        dereference: true,
        filter: path => path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep),
      })
      remaining = await this.findSymlink(nodeModules)
    }
  }

  /** Return the first symbolic link below a directory, if one exists. */
  private async findSymlink(directory: string): Promise<string | undefined> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const metadata = await lstat(path)
      if (metadata.isSymbolicLink()) return path
      if (metadata.isDirectory()) {
        const nested = await this.findSymlink(path)
        if (nested !== undefined) return nested
      }
    }
    return undefined
  }

  /** Stage the fork-owned executable entry and add pkg assets to the staged manifest. */
  async injectPkgConfig(): Promise<void> {
    const patch = { bin: ENTRY_BIN, pkg: { assets: ASSET_GLOBS } }
    const manifestPath = join(this.staging, 'package.json')
    if (this.cli.dryRun) {
      console.log(`build-exe-cli: [dry-run] cp ${ENTRY_SOURCE} ${join(this.staging, ENTRY_BIN)}`)
      console.log(`build-exe-cli: [dry-run] patch ${manifestPath} with ${JSON.stringify(patch)}`)
      return
    }
    if (!existsSync(manifestPath)) {
      throw new Error(`build-exe-cli: ${manifestPath} missing — pnpm deploy did not produce a staged package.`)
    }
    if (!existsSync(join(this.staging, UPSTREAM_BIN))) {
      throw new Error(`build-exe-cli: ${join(this.staging, UPSTREAM_BIN)} missing — run without --skip-build so lib/ artifacts exist.`)
    }
    await copyFile(ENTRY_SOURCE, join(this.staging, ENTRY_BIN))
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    await writeFile(manifestPath, `${JSON.stringify({ ...manifest, ...patch }, null, 2)}\n`)
    console.log(`build-exe-cli: injected pkg config into ${manifestPath}`)
  }

  /**
   * Package one target; SEA mode accepts one target per invocation.
   * @param target - the pkg target triple to build.
   * @returns the executable and ripgrep sidecar paths, plus the macOS spawn helper path when required.
   */
  async pack(target: Target): Promise<string[]> {
    const product = join(this.outDir, `${OUTPUT_BASENAME}-${target.platform}-${target.arch}`)
    await this.prepareNativePty(target)
    if (!this.cli.dryRun) await mkdir(this.outDir, { recursive: true })
    await this.run(`pkg ${target.spec}`, pnpmBin().command, [
      ...pnpmBin().prefix,
      'dlx',
      PKG_SPEC,
      this.staging,
      '--sea',
      '--targets',
      target.spec,
      '--output',
      product,
    ])
    if (!this.cli.dryRun && !existsSync(product)) {
      throw new Error(`build-exe-cli: product ${product} is missing after the pkg run; inspect ${this.outDir}.`)
    }
    const ripgrep = await this.copyRipgrepSidecar(target, product)
    if (target.platform !== 'macos') return [product, ripgrep]
    const spawnHelper = `${product}-spawn-helper`
    const source = join(this.staging, 'node_modules', 'node-pty', 'prebuilds', `darwin-${target.arch}`, 'spawn-helper')
    if (this.cli.dryRun) {
      console.log(`build-exe-cli: [dry-run] cp ${source} ${spawnHelper}`)
    } else {
      await copyFile(source, spawnHelper)
      await chmod(spawnHelper, 0o755)
    }
    return [product, ripgrep, spawnHelper]
  }

  /** Copy the target ripgrep binary beside the executable so Node can spawn it outside pkg's virtual filesystem. */
  private async copyRipgrepSidecar(target: Target, product: string): Promise<string> {
    const platform = target.platform === 'macos' ? 'darwin' : target.platform
    const source = join(
      this.staging,
      'node_modules',
      '@vscode',
      `ripgrep-${platform}-${target.arch}`,
      'bin',
      'rg',
    )
    const destination = `${product}-rg`
    if (this.cli.dryRun) {
      console.log(`build-exe-cli: [dry-run] cp ${source} ${destination}`)
      return destination
    }
    if (!existsSync(source)) {
      throw new Error(`build-exe-cli: target ripgrep binary is missing at ${source}.`)
    }
    await copyFile(source, destination)
    await chmod(destination, 0o755)
    return destination
  }

  /**
   * Put the target node-pty addon in the staged closure. The release workflow
   * provides a manylinux build; ordinary installs use node-pty's target prebuild.
   * @param target - the pkg target whose native addon is being staged.
   */
  private async prepareNativePty(target: Target): Promise<void> {
    const stagedBuild = join(this.staging, 'node_modules', 'node-pty', 'build')
    if (this.cli.dryRun) console.log(`build-exe-cli: [dry-run] rm -rf ${stagedBuild}`)
    else await rm(stagedBuild, { recursive: true, force: true })
    if (target.platform !== 'linux') return
    const packageDirectory = join(
      root,
      'packages',
      'subprocess',
      'subprocess-local',
      'node_modules',
      'node-pty',
    )
    const destination = join(stagedBuild, 'Release', 'pty.node')
    const source = resolveLinuxNodePtyAddon(packageDirectory, target.arch)
    if (this.cli.dryRun) {
      console.log(`build-exe-cli: [dry-run] cp ${source} ${destination}`)
      return
    }
    const host = Target.host()
    if (target.platform !== host.platform || target.arch !== host.arch) {
      throw new Error(
        'build-exe-cli: build the Linux runtime on its target architecture; '
        + `target ${target.platform}-${target.arch} does not match host ${host.platform}-${host.arch}.`,
      )
    }
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(source, destination)
  }

  /**
   * Print each product path and, outside dry-run mode, its size.
   * @param products - the product paths returned by {@link pack}.
   */
  printProducts(products: string[]): void {
    console.log(this.cli.dryRun ? 'build-exe-cli: [dry-run] would produce:' : 'build-exe-cli: products:')
    for (const path of products) {
      if (this.cli.dryRun) {
        console.log(`  ${path}`)
        continue
      }
      const megabytes = statSync(path).size / (1024 * 1024)
      console.log(`  ${path}  (${megabytes.toFixed(1)} MB)`)
    }
  }

  /**
   * Run one subprocess with inherited stdio. Spawn and non-zero-exit errors
   * include the command; dry runs only print it.
   * @param label - the step name used in logs and error messages.
   * @param command - the executable.
   * @param args - its arguments.
   */
  private async run(label: string, command: string, args: string[]): Promise<void> {
    const printable = formatCommand(command, args)
    if (this.cli.dryRun) {
      console.log(`build-exe-cli: [dry-run] ${printable}`)
      return
    }
    console.log(`build-exe-cli: ${label}: ${printable}`)
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn(command, args, {
        cwd: root,
        stdio: 'inherit',
        // Artifact builds must not mutate or validate a developer's Git hooks.
        env: { ...process.env, CI: 'true' },
      })
      child.once('error', (error) => {
        reject(new Error(`build-exe-cli: ${label} failed to spawn: ${error.message} (${printable})`))
      })
      child.once('exit', (code, signal) => {
        if (code === 0) {
          resolvePromise()
          return
        }
        const cause = code === null ? `signal ${signal ?? 'unknown'}` : `exit code ${code}`
        reject(new Error(`build-exe-cli: ${label} failed (${cause}): ${printable}`))
      })
    })
  }
}

async function main(): Promise<void> {
  const cli = BuildCli.parse(process.argv.slice(2))
  const pipeline = new CliExeBuild(cli)
  console.log(`build-exe-cli: targets: ${cli.targets.map(target => target.spec).join(', ')}`)
  console.log(`build-exe-cli: staging: ${pipeline.staging}`)
  await pipeline.build()
  await pipeline.deployStaging()
  await pipeline.injectPkgConfig()
  const products: string[] = []
  for (const target of cli.targets) products.push(...await pipeline.pack(target))
  pipeline.printProducts(products)
}

await main()
