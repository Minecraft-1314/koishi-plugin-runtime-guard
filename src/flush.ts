import { Context } from 'koishi'
import { GuardLog, GuardResult, GuardStatus } from './log'
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
  const pending = new Set<() => void>()
  let target: object | null = null
  let installed = false
  let disposed = false
  let status: GuardStatus = 'pending'
  let reason = `waiting for ${describeRequirement('flush')}`
  const state: FlushState = { pending, isDisposed: () => disposed }

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
        return runWithRetry(state, name, () => original.apply(this, args), config, log)
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
      disposed = true
      // Release any in-flight backoff wait, otherwise runWithRetry would stay
      // suspended on a promise that can never settle. The disposed flag stops
      // the loop from arming another wait on the way out.
      for (const resume of [...pending]) resume()
      pending.clear()
      disposeInject()
      for (const fn of [...restore].reverse()) fn()
      if (installed && target) clearInstalled(protoOf(target), INSTALLED)
      log.debug('flush guard disposed')
    },
  }
}

interface FlushState {
  pending: Set<() => void>
  isDisposed(): boolean
}

async function runWithRetry(
  state: FlushState,
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
      if (state.isDisposed()) break
      log.debug('%s failed (attempt %d/%d), retrying', name, attempt + 1, config.retries + 1)
      await wait(state.pending, config.retryDelay * (attempt + 1))
      if (state.isDisposed()) break
    }
  }

  if (state.isDisposed()) return
  if (config.throwOnFailure) throw lastError
  log.error(
    '%s failed after %d attempt(s), the pending change was dropped: %s',
    name,
    config.retries + 1,
    describe(lastError),
  )
}

function wait(pending: Set<() => void>, ms: number): Promise<void> {
  if (!(ms > 0)) return Promise.resolve()
  return new Promise((resolve) => {
    const resume = () => {
      clearTimeout(timer)
      pending.delete(resume)
      resolve()
    }
    const timer = setTimeout(resume, ms)
    pending.add(resume)
  })
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
