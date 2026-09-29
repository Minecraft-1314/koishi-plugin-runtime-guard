import { Context } from 'koishi'
import { GuardLog, GuardResult, skipped } from './log'
import { clearInstalled, isInstalled, markInstalled, patchMethod, protoOf } from './patch'
import { describeRequirement } from './requirements'

const DRAINING = Symbol.for('koishi.guard.queue.draining')
const INSTALLED = Symbol.for('koishi.guard.queue.installed')

const EMPTY: string[] = []

interface QueuedTask {
  delay: number
  content: unknown
  resolve(ids: string[]): void
  reject(reason: unknown): void
}

interface QueueSession {
  _queuedTasks?: QueuedTask[]
  _queuedTimeout?: unknown
  send(content: unknown): Promise<string[]>
  [key: string]: unknown
}

export interface QueueConfig {
  enabled: boolean
  sequential: boolean
}

export default function createQueueGuard(ctx: Context, config: QueueConfig, log: GuardLog): GuardResult {
  const service = ctx.get('koishi')?.session as object | undefined
  if (!service) return skipped(log, `${describeRequirement('queue')} is not available`)

  const proto = protoOf(service)
  if (isInstalled(proto, INSTALLED)) {
    return skipped(log, 'another build already patched this session prototype')
  }

  const restore: Array<() => void> = []

  patchMethod(proto, 'cancelQueued', (original) => function (this: QueueSession, delay?: number) {
    const tasks = this._queuedTasks
    if (tasks?.length) {
      for (const task of tasks) task.resolve(EMPTY)
      log.debug('settled %d cancelled queued message(s)', tasks.length)
    }
    return original.call(this, delay)
  }, restore)

  if (config.sequential) {
    patchMethod(proto, '_next', () => function (this: QueueSession) {
      const marked = this as unknown as Record<symbol, unknown>
      if (marked[DRAINING]) return
      marked[DRAINING] = true
      this._queuedTimeout = DRAINING
      void drain.call(this)
    }, restore)
  } else {
    log.debug('strict send ordering is off, messages may interleave on slow platforms')
  }

  async function drain(this: QueueSession): Promise<void> {
    const marked = this as unknown as Record<symbol, unknown>
    try {
      while (this._queuedTasks?.length) {
        const task = this._queuedTasks.shift()!
        let result = EMPTY
        try {
          result = (await this.send(task.content)) || EMPTY
        } catch (error) {
          log.warn('queued message failed: %s', describe(error))
        }
        task.resolve(result)
        if (!this._queuedTasks.length) break
        await wait(ctx, task.delay)
      }
    } finally {
      marked[DRAINING] = false
      if (this._queuedTimeout === DRAINING) this._queuedTimeout = null
      if (this._queuedTasks?.length && !this._queuedTimeout) (this as any)._next()
    }
  }

  markInstalled(proto, INSTALLED)
  log.debug('patched KoishiSession.cancelQueued%s', config.sequential ? ' and KoishiSession._next' : '')

  return {
    status: 'active',
    dispose() {
      for (const fn of [...restore].reverse()) fn()
      clearInstalled(proto, INSTALLED)
      log.debug('queue guard disposed')
    },
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function wait(ctx: Context, ms: number): Promise<void> {
  if (!(ms > 0)) return Promise.resolve()
  return new Promise((resolve) => {
    ctx.setTimeout(resolve, ms)
  })
}
