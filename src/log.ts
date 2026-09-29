import { Context } from 'koishi'

export const LOG_KEY = 'runtime-guard'

export interface GuardLog {
  debug(message: string, ...params: any[]): void
  info(message: string, ...params: any[]): void
  warn(message: string, ...params: any[]): void
  error(message: string, ...params: any[]): void
}

export type GuardStatus = 'active' | 'pending' | 'skipped'

export interface GuardResult {
  status: GuardStatus
  reason?: string
  dispose(): void
}

export type GuardFactory<C = any> = (ctx: any, config: C, log: GuardLog) => GuardResult

// A context-bound logger (ctx.logger) rather than `new Logger(...)`: the
// detached form is not tied to the app that owns the plugin, so its output
// depends on whichever handler happened to attach first.
export function createGuardLog(ctx: Context, scope: string, debug: boolean): GuardLog {
  const logger = ctx.logger(`${LOG_KEY}:${scope}`)
  return {
    debug(message, ...params) {
      if (debug) logger.info(message, ...params)
    },
    info(message, ...params) {
      logger.info(message, ...params)
    },
    warn(message, ...params) {
      logger.warn(message, ...params)
    },
    error(message, ...params) {
      logger.error(message, ...params)
    },
  }
}

export function skipped(log: GuardLog, reason: string): GuardResult {
  log.debug('skipped: %s', reason)
  return { status: 'skipped', reason, dispose: () => {} }
}
