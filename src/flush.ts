import { Context } from 'koishi'
import { GuardLog, GuardResult, GuardStatus, skipped } from './log'
import { clearInstalled, isInstalled, markInstalled, patchMethod, protoOf, toDisposer } from './patch'
import { describeRequirement } from './requirements'

const INSTALLED = Symbol.for('koishi.guard.flush.installed')
const TARGETS = ['setUser', 'setChannel'] as const

export interface FlushConfig {
  enabled: boolean
  retries: number
  retryDelay: number
  throwOnFailure: boolean
}

export default function createFlushGuard(ctx: Context, config: FlushConfig, log: GuardLog): GuardResult {
  const restore: Array<() => void> = []
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let target: object | null = null
  let installed = false
  let status: GuardStatus = 'pending'
  let reason = `waiting for ${describeRequirement('flush')}`

  const disposeInject = toDisposer(ctx.inject({ database: { required: true } }, () => {
    const service = ctx.get('koishi')?.database as object | undefined
    if (!service) {
      status = 'skipped'
      reason = 'database mixin is not exposed by this koishi build'
      return
    }

    const proto = protoOf(service)
    if (isInstalled(proto, INSTALLED)) {
      status = 'skipped'
      reason = 'another build already patched this database prototype'
      return
    }

    target = service
    let patched = 0

    for (const name of TARGETS) {
      const ok = patchMethod(proto, name, (original) => function (this: unknown, ...args: unknown[]) {
        return runWithRetry(timers, name, () => original.apply(this, args), config, log)
      }, restore)
      if (ok) patched++
    }

    if (!patched) {
      status = 'skipped'
      reason = 'database prototype exposes neither setUser nor setChannel'
      return
    }

    markInstalled(proto, INSTALLED)
    installed = true
    status = 'active'
    reason = ''
    log.debug('patched %d database write method(s)', patched)
  }))

  return {
    get status() {
      return status
    },
    get reason() {
      return reason
    },
    dispose() {
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      disposeInject()
      for (const fn of [...restore].reverse()) fn()
      if (installed && target) clearInstalled(protoOf(target), INSTALLED)
      log.debug('flush guard disposed')
    },
  }
}

async function runWithRetry(
  timers: Set<ReturnType<typeof setTimeout>>,
  name: string,
  run: () => unknown,
  config: FlushConfig,
  log: GuardLog,
): Promise<unknown> {
  let lastError: unknown
  for (let attempt = 0; attempt <= config.retries; attempt++) {
    try {
      return await run()
    } catch (error) {
      lastError = error
      if (attempt >= config.retries) break
      log.debug('%s failed (attempt %d/%d), retrying', name, attempt + 1, config.retries + 1)
      await wait(timers, config.retryDelay * (attempt + 1))
    }
  }

  if (config.throwOnFailure) throw lastError
  log.error(
    '%s failed after %d attempt(s), the pending change was dropped: %s',
    name,
    config.retries + 1,
    describe(lastError),
  )
}

function wait(timers: Set<ReturnType<typeof setTimeout>>, ms: number): Promise<void> {
  if (!(ms > 0)) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      resolve()
    }, ms)
    timers.add(timer)
  })
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
