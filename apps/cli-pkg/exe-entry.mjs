/**
 * AYANA executable entry (fork-owned; copied into the staged closure by
 * scripts/build-exe-cli.ts and pointed at by pkg's bin).
 *
 * Under pkg --sea the dependency closure lives in an in-memory virtual file
 * system that only this process can see, yet the profile launcher still
 * creates $DSH_HOME/profiles/node_modules symlinks pointing into it. Bare
 * imports from real-filesystem profile directories therefore fail with
 * ERR_MODULE_NOT_FOUND; this hook retries each such failure anchored inside
 * the snapshot, where Node's own resolver finds the frozen closure. Outside
 * an executable (e.g. running this file straight from a checkout) every
 * resolution already succeeds and the hook is inert.
 */

import { registerHooks } from 'node:module'

/** The dsh app manifest beside the staged node_modules: the retry anchor. */
const ANCHOR_URL = new URL('node_modules/@deepseek-ai/dsh/package.json', import.meta.url)

/** Whether a specifier is a bare package name (not relative, absolute, or scheme-prefixed). */
function isBareSpecifier(specifier) {
  return !specifier.startsWith('/') && !specifier.startsWith('./') && !specifier.startsWith('../')
    && !specifier.startsWith('node:') && !/^[a-z][a-z0-9+.-]*:/i.test(specifier)
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      const parent = context.parentURL ?? ''
      const outsideSnapshot = parent.startsWith('file://') && !parent.startsWith('file:///snapshot/')
      if (error.code !== 'ERR_MODULE_NOT_FOUND' || !isBareSpecifier(specifier) || !outsideSnapshot) {
        throw error
      }
      return nextResolve(specifier, { ...context, parentURL: ANCHOR_URL.href })
    }
  },
})

await import('./node_modules/@deepseek-ai/dsh/lib/bin.js')
