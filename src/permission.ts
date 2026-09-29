import { Permissions } from 'koishi'
import { GuardLog, GuardResult } from './log'
import { clearInstalled, isInstalled, markInstalled, patchMethod } from './patch'

const INSTALLED = Symbol.for('koishi.guard.permission.installed')
const PRUNE_SLACK = 32

export interface PermissionConfig {
  enabled: boolean
  memoizeMatch: boolean
  matchCacheSize: number
}

export default function createPermissionGuard(
  _ctx: unknown,
  config: PermissionConfig,
  log: GuardLog,
): GuardResult {
  if (!config.memoizeMatch) {
    return { status: 'skipped', reason: 'memoizeMatch is disabled', dispose: () => {} }
  }

  if (typeof Permissions !== 'function') {
    return { status: 'skipped', reason: 'Permissions is not exported by this koishi build', dispose: () => {} }
  }

  const proto = Permissions.prototype as unknown as Record<PropertyKey, unknown>
  if (isInstalled(proto, INSTALLED)) {
    return { status: 'skipped', reason: 'another build already patched Permissions', dispose: () => {} }
  }

  const restore: Array<() => void> = []
  const memoized = new Map<Permissions.Entry, Permissions.Entry['match']>()
  // Permissions.prototype is patched globally, so a process may hold more than
  // one instance. Pruning must consider every store we have seen, otherwise it
  // would restore entries that merely belong to another instance.
  const stores = new Set<Permissions>()

  const ok = patchMethod(proto, 'check', (original) => function (this: Permissions, ...args: unknown[]) {
    stores.add(this)
    for (const entry of this.store) memoizeEntry(entry, config, memoized)
    pruneEntries(stores, memoized)
    return original.apply(this, args)
  }, restore)

  if (!ok) {
    return { status: 'skipped', reason: 'Permissions.check is unavailable', dispose: () => {} }
  }

  markInstalled(proto, INSTALLED)
  log.debug('patched Permissions.check with per-entry match memoization')

  return {
    status: 'active',
    dispose() {
      for (const fn of [...restore].reverse()) fn()
      for (const [entry, original] of memoized) entry.match = original
      memoized.clear()
      stores.clear()
      clearInstalled(proto, INSTALLED)
      log.debug('permission guard disposed')
    },
  }
}

function memoizeEntry(
  entry: Permissions.Entry,
  config: PermissionConfig,
  memoized: Map<Permissions.Entry, Permissions.Entry['match']>,
): void {
  if (memoized.has(entry)) return
  if (typeof entry.match !== 'function') return

  const original = entry.match
  const cache = new Map<string, unknown>()

  entry.match = ((value: string) => {
    if (config.matchCacheSize <= 0) return original(value)
    if (cache.size >= config.matchCacheSize) cache.clear()
    if (!cache.has(value)) cache.set(value, original(value))
    // Hand out a copy: check() receives this object and a plugin may mutate
    // it, which would otherwise poison every later cache hit.
    const cached = cache.get(value)
    return cached && typeof cached === 'object' ? { ...cached } : cached
  }) as Permissions.Entry['match']

  memoized.set(entry, original)
}

function pruneEntries(
  stores: Set<Permissions>,
  memoized: Map<Permissions.Entry, Permissions.Entry['match']>,
): void {
  let total = 0
  const live = new Set<Permissions.Entry>()
  for (const store of stores) {
    for (const entry of store.store) {
      live.add(entry)
      total++
    }
  }
  if (memoized.size <= total + PRUNE_SLACK) return
  for (const [entry, original] of memoized) {
    if (live.has(entry)) continue
    entry.match = original
    memoized.delete(entry)
  }
}
