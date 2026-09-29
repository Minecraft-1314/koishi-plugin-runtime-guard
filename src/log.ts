import { Logger } from 'koishi'

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

export function createGuardLog(scope: string, debug: boolean): GuardLog {
  const logger = new Logger(`guard:${scope}`)
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
