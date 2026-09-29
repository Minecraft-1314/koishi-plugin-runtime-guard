import { Context } from 'koishi'
import { GuardLog, GuardResult, skipped } from './log'
import { patchMethod, protoOf } from './patch'
import { describeRequirement } from './requirements'

const CONFLICT = /unresolved diff key/
const MAX_RECOVERY = 1

const TARGETS: Array<[method: string, keys: Array<'user' | 'channel' | 'guild'>]> = [
  ['observeUser', ['user']],
  ['observeChannel', ['channel', 'guild']],
]

export interface ObserveConfig {
  enabled: boolean
  recoverMergeConflict: boolean
}

interface Observable {
  $update?(): unknown
  [key: string]: unknown
}

interface ObserveSession {
  user?: Observable
  channel?: Observable
  guild?: Observable
  [key: string]: unknown
}

export default function createObserveGuard(ctx: Context, config: ObserveConfig, log: GuardLog): GuardResult {
  if (!config.recoverMergeConflict) {
    return skipped(log, 'recoverMergeConflict is disabled')
  }

  const service = ctx.get('koishi')?.session as object | undefined
  if (!service) return skipped(log, `${describeRequirement('observe')} is not available`)

  const proto = protoOf(service)
  const restore: Array<() => void> = []
  let patched = 0

  for (const [method, keys] of TARGETS) {
    const ok = patchMethod(proto, method, (original) => function (this: ObserveSession, fields: Iterable<string>) {
      return recover(original, this, fields, method, keys, log)
    }, restore)
    if (ok) patched++
  }

  if (!patched) {
    for (const fn of [...restore].reverse()) fn()
    return skipped(log, 'session prototype exposes neither observeUser nor observeChannel')
  }

  log.debug('patched %d session observation method(s)', patched)

  return {
    status: 'active',
    dispose() {
      for (const fn of [...restore].reverse()) fn()
      log.debug('observe guard disposed')
    },
  }
}

async function recover(
  original: (...args: any[]) => any,
  session: ObserveSession,
  fields: Iterable<string>,
  method: string,
  keys: Array<'user' | 'channel' | 'guild'>,
  log: GuardLog,
): Promise<any> {
  // A retry must not consume a one-shot iterator, so materialise the fields once.
  const requested = [...fields]
  let attempt = 0
  while (true) {
    try {
      return await original.call(session, requested)
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      if (attempt >= MAX_RECOVERY || !CONFLICT.test(message)) throw error
      attempt++
      log.debug('%s hit an unresolved diff, flushing pending changes and rebuilding the cache', method)
      for (const key of keys) {
        const cache = session[key]
        if (cache && typeof cache.$update === 'function') {
          try {
            await cache.$update()
          } catch (flushError) {
            log.error('failed to flush pending diff for %s: %s', key, describe(flushError))
          }
        }
        session[key] = undefined
      }
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
