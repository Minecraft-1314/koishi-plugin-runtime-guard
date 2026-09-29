import { Context, Schema, Time } from 'koishi'
import createConsoleGuard, { ConsoleConfig } from './console'
import createFlushGuard, { FlushConfig } from './flush'
import createInstallerGuard, { InstallerConfig } from './installer'
import { createGuardLog, GuardFactory, GuardLog, GuardResult, LOG_KEY } from './log'
import createObserveGuard, { ObserveConfig } from './observe'
import createPermissionGuard, { PermissionConfig } from './permission'
import createQueueGuard, { QueueConfig } from './queue'

const REPORT_DELAY = 1000
const MIN_POSITIVE = 1

// A non-positive value in these fields would silently disable the feature it
// belongs to (every payload rejected, every notifier button blocked, every
// install reported as timed out). Clamping to 1 would not help, so an invalid
// value falls back to the default instead.
const MINIMUMS: Partial<Record<keyof Omit<Config, 'debug'>, string[]>> = {
  console: ['notifierRateLimit', 'maxPayloadSize'],
  installer: ['timeout'],
}

export interface Config {
  debug: boolean
  queue: QueueConfig
  observe: ObserveConfig
  flush: FlushConfig
  console: ConsoleConfig
  installer: InstallerConfig
  permission: PermissionConfig
}

const GUARDS: Array<[keyof Omit<Config, 'debug'>, GuardFactory<any>]> = [
  ['queue', createQueueGuard],
  ['observe', createObserveGuard],
  ['flush', createFlushGuard],
  ['console', createConsoleGuard],
  ['installer', createInstallerGuard],
  ['permission', createPermissionGuard],
]

const DEFAULTS: Config = {
  debug: false,
  queue: { enabled: true, sequential: true },
  observe: { enabled: true, recoverMergeConflict: true },
  flush: { enabled: true, retries: 2, retryDelay: 200, throwOnFailure: false },
  console: { enabled: true, guardNotifier: true, notifierRateLimit: 10, notifierRateWindow: 10000, maxPayloadSize: 65536 },
  installer: { enabled: true, timeout: 300000, rollback: true },
  permission: { enabled: true, memoizeMatch: true, matchCacheSize: 1024 },
}

export const Config: Schema<Config> = Schema.object({
  debug: Schema.boolean().default(false).description('调试模式。开启后输出每个守护的安装详情、跳过原因与重试过程。'),
  queue: Schema.object({
    enabled: Schema.boolean().default(true).description('消息队列守护总开关。'),
    sequential: Schema.boolean().default(true).description('严格按队列顺序发送，每条发完再等待 delay 再发下一条。关闭则退回 Koishi 原有的并发发送行为。'),
  }).description('消息队列守护'),
  observe: Schema.object({
    enabled: Schema.boolean().default(true).description('数据观察守护总开关。'),
    recoverMergeConflict: Schema.boolean().default(true).description('observeUser / observeChannel 遇到未结算的 diff 时自动落盘并重建缓存，而不是抛错中断整条消息链。'),
  }).description('数据观察守护'),
  flush: Schema.object({
    enabled: Schema.boolean().default(true).description('数据库写入守护总开关。'),
    retries: Schema.natural().default(2).description('数据库写入失败时的重试次数。'),
    retryDelay: Schema.natural().role('ms').default(200).description('重试基础间隔，按次数线性退避。'),
    throwOnFailure: Schema.boolean().default(false).description('重试全部失败后是否继续抛出错误。默认吞掉并记日志，以保证后续 flush 不被中断。'),
  }).description('数据库写入守护（依赖 database 服务）'),
  console: Schema.object({
    enabled: Schema.boolean().default(true).description('控制台守护总开关。'),
    guardNotifier: Schema.boolean().default(true).description('是否为通知按钮加上存在性检查、异常吸收与限流（依赖 notifier 服务）。'),
    notifierRateLimit: Schema.natural().min(MIN_POSITIVE).default(10).description('单个通知按钮在窗口期内允许的最大点击次数。设为 0 会屏蔽全部按钮，故最小值为 1。'),
    notifierRateWindow: Schema.natural().role('ms').default(Time.second * 10).description('通知按钮限流窗口。'),
    maxPayloadSize: Schema.natural().min(MIN_POSITIVE).default(65536).description('单条控制台消息的字节上限，超出直接拒绝。设为 0 会拒绝全部消息，故最小值为 1。'),
  }).description('控制台守护（依赖 console / notifier 服务）'),
  installer: Schema.object({
    enabled: Schema.boolean().default(true).description('插件安装守护总开关。'),
    timeout: Schema.natural().min(MIN_POSITIVE).role('ms').default(Time.minute * 5).description('等待包管理器退出的最长时间。设为 0 会让每次安装都立即超时，故最小值为 1。'),
    rollback: Schema.boolean().default(true).description('安装失败时把 package.json 还原为安装前的快照。'),
  }).description('插件安装守护（依赖 market 的 installer 服务）'),
  permission: Schema.object({
    enabled: Schema.boolean().default(true).description('权限性能守护总开关。'),
    memoizeMatch: Schema.boolean().default(true).description('缓存权限模式的匹配结果，避免每条消息重复跑正则。'),
    matchCacheSize: Schema.natural().default(1024).description('单个权限条目的匹配缓存上限。'),
  }).description('权限性能守护'),
})

export function apply(ctx: Context, config: Partial<Config> = {}): () => void {
  const logger = ctx.logger(LOG_KEY)
  const debug = config.debug ?? DEFAULTS.debug
  const results: Array<[string, GuardResult]> = []

  for (const [name, create] of GUARDS) {
    const section = clampSection(logger, name, Object.assign({}, DEFAULTS[name], config[name]))
    const log = createGuardLog(ctx, name, debug)

    if (section.enabled === false) {
      log.debug('skipped: disabled by config')
      results.push([name, { status: 'skipped', reason: 'disabled by config', dispose: () => {} }])
      continue
    }

    try {
      results.push([name, create(ctx, section, log)])
    } catch (error) {
      log.error('failed to install: %s', describe(error))
      results.push([name, { status: 'skipped', reason: describe(error), dispose: () => {} }])
    }
  }

  const report = () => {
    const active = results.filter(([, r]) => r.status === 'active').map(([n]) => n)
    const waiting = results.filter(([, r]) => r.status === 'pending').map(([n]) => n)
    const skipped = results.filter(([, r]) => r.status === 'skipped').map(([n]) => n)

    if (active.length) logger.info('active: %s', active.join(', '))
    if (debug) {
      if (waiting.length) logger.info('waiting for optional plugins: %s', waiting.join(', '))
      if (skipped.length) logger.info('skipped: %s', skipped.join(', '))
      for (const [name, result] of results) {
        if (result.reason) logger.info('%s: %s', name, result.reason)
      }
    }
  }

  // Guards that attach through ctx.inject settle after this plugin returns,
  // so the summary is emitted once the rest of the startup has run.
  const timer = ctx.setTimeout(report, REPORT_DELAY)

  return () => {
    timer()
    for (const [name, result] of results) {
      try {
        result.dispose()
      } catch (error) {
        logger.warn('failed to dispose guard "%s": %s', name, describe(error))
      }
    }
    logger.info('all guards disposed')
  }
}

function clampSection<T>(logger: GuardLog, name: keyof Omit<Config, 'debug'>, section: T): T {
  const keys = MINIMUMS[name]
  if (!keys) return section
  const target = section as Record<string, unknown>
  const defaults = DEFAULTS[name] as unknown as Record<string, unknown>
  for (const key of keys) {
    const value = target[key]
    if (typeof value === 'number' && !(value >= MIN_POSITIVE)) {
      const fallback = defaults[key]
      logger.warn('%s.%s must be at least %d, got %s; falling back to %s', name, key, MIN_POSITIVE, String(value), String(fallback))
      target[key] = fallback
    }
  }
  return section
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
