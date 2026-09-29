import { Context } from 'koishi'
import { promises as fsp } from 'fs'
import { resolve } from 'path'
import { GuardLog, GuardResult, GuardStatus } from './log'
import { clearInstalled, isInstalled, markInstalled, patchMethod, protoOf, toDisposer } from './patch'
import { describeRequirement } from './requirements'

const INSTALLED = Symbol.for('koishi.guard.installer.installed')

export interface InstallerConfig {
  enabled: boolean
  timeout: number
  rollback: boolean
}

interface InstallerService {
  cwd: string
  install(...args: unknown[]): Promise<number>
  exec(args: string[]): Promise<number>
}

export default function createInstallerGuard(ctx: Context, config: InstallerConfig, log: GuardLog): GuardResult {
  const restore: Array<() => void> = []
  const pending = new Set<() => void>()
  let target: object | null = null
  let installed = false
  let timedOut = false
  let disposed = false
  let status: GuardStatus = 'pending'
  let reason = `waiting for ${describeRequirement('installer')}`

  const disposeInject = toDisposer(ctx.inject({ installer: { required: true } }, () => {
    const service = ctx.get('installer') as InstallerService | undefined
    if (!service) {
      status = 'skipped'
      reason = 'service "installer" is not registered'
      return
    }

    const proto = protoOf(service)
    if (typeof proto.install !== 'function') {
      status = 'skipped'
      reason = 'installer service exposes no install method'
      return
    }
    if (isInstalled(proto, INSTALLED)) {
      status = 'skipped'
      reason = 'another build already patched this installer prototype'
      return
    }

    target = service

    patchMethod(proto, 'exec', (original) => function (this: InstallerService, ...args: unknown[]) {
      // After dispose the prototype is restored, so a late call would bypass
      // the timeout entirely and could block the caller indefinitely.
      if (disposed) {
        log.warn('ignored an exec request because the guard is being disposed')
        return Promise.resolve(-1)
      }
      return withTimeout(original, this, args, config, pending, log, () => {
        timedOut = true
      })
    }, restore)

    patchMethod(proto, 'install', (original) => async function (this: InstallerService, ...args: unknown[]) {
      if (disposed) {
        log.warn('ignored an install request because the guard is being disposed')
        return -1
      }
      // Upstream already serialises installs through its own lock, so a second
      // request queues rather than being rejected here. Forward every argument
      // so callbacks such as beforeReload still run.
      const filename = resolveManifest(this, log)
      const backup = config.rollback && filename ? await snapshot(filename, log) : null
      if (disposed) return -1
      timedOut = false
      try {
        const code = await original.apply(this, args)
        if (code === 0) return code
        await reportFailure(filename, backup, `code ${code}`, timedOut, log)
        return code
      } catch (error) {
        await reportFailure(filename, backup, describe(error), timedOut, log)
        throw error
      } finally {
        timedOut = false
      }
    }, restore)

    markInstalled(proto, INSTALLED)
    installed = true
    status = 'active'
    reason = ''
    log.debug('patched Installer.install and Installer.exec')
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
      // Release in-flight waits, otherwise a pending install or exec would
      // stay suspended on a promise that can never settle.
      for (const cancel of [...pending]) cancel()
      pending.clear()
      disposeInject()
      for (const fn of [...restore].reverse()) fn()
      if (installed && target) clearInstalled(protoOf(target), INSTALLED)
      log.debug('installer guard disposed')
    },
  }
}

async function snapshot(filename: string, log: GuardLog): Promise<string | null> {
  try {
    return await fsp.readFile(filename, 'utf8')
  } catch (error) {
    log.warn('failed to snapshot package.json, rollback is disabled: %s', describe(error))
    return null
  }
}

function resolveManifest(service: InstallerService, log: GuardLog): string | null {
  if (typeof service?.cwd !== 'string' || !service.cwd) {
    log.warn('installer service exposes no working directory, rollback is disabled')
    return null
  }
  return resolve(service.cwd, 'package.json')
}

async function reportFailure(
  filename: string | null,
  backup: string | null,
  reason: string,
  timedOut: boolean,
  log: GuardLog,
): Promise<void> {
  if (timedOut) {
    log.error(
      'install did not finish in time (%s); the package manager may still be writing package.json, so rollback was skipped',
      reason,
    )
    return
  }
  if (filename === null || backup === null) {
    log.error('install failed (%s), package.json may be left in a broken state', reason)
    return
  }
  try {
    await fsp.writeFile(filename, backup)
    log.error('install failed (%s), package.json has been restored', reason)
  } catch (error) {
    log.error('install failed (%s) and package.json could not be restored: %s', reason, describe(error))
  }
}

function withTimeout(
  run: (...args: unknown[]) => unknown,
  receiver: InstallerService,
  args: unknown[],
  config: InstallerConfig,
  pending: Set<() => void>,
  log: GuardLog,
  onTimeout: () => void,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false

    const finish = (handler: (value: any) => void) => (value: any) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      pending.delete(cancel)
      handler(value)
    }

    const cancel = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      pending.delete(cancel)
      log.warn('stopped waiting for the package manager because the guard is being disposed')
      resolve(-1)
    }

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      pending.delete(cancel)
      onTimeout()
      log.error(
        'the package manager did not finish within %d ms, stopped waiting; the child process may still be running',
        config.timeout,
      )
      resolve(-1)
    }, config.timeout)
    pending.add(cancel)

    let result: unknown
    try {
      result = run.apply(receiver, args)
    } catch (error) {
      finish(reject)(error)
      return
    }

    Promise.resolve(result).then(finish(resolve), finish(reject))
  })
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
