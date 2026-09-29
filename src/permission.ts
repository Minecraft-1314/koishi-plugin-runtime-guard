import { Permissions } from 'koishi'
import { GuardLog, GuardResult } from './log'
import { clearInstalled, isInstalled, markInstalled, patchMethod } from './patch'

const INSTALLED = Symbol.for('koishi.guard.permission.installed')

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
  const memoized = new WeakSet<object>()

  const ok = patchMethod(proto, 'check', (original) => function (this: Permissions, ...args: unknown[]) {
    for (const entry of this.store) memoizeEntry(entry, config, memoized, restore)
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
      clearInstalled(proto, INSTALLED)
      log.debug('permission guard disposed')
    },
  }
}

function memoizeEntry(
  entry: Permissions.Entry,
  config: PermissionConfig,
  memoized: WeakSet<object>,
  restore: Array<() => void>,
): void {
  if (memoized.has(entry)) return
  if (typeof entry.match !== 'function') return

  const original = entry.match
  const cache = new Map<string, unknown>()

  entry.match = ((value: string) => {
    if (cache.size >= config.matchCacheSize) cache.clear()
    if (cache.has(value)) return cache.get(value)
    const result = original(value)
    cache.set(value, result)
    return result
  }) as Permissions.Entry['match']

  memoized.add(entry)
  restore.push(() => {
    if (entry.match !== original) entry.match = original
  })
}
