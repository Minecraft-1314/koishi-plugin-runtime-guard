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
  install(deps: Record<string, string>, forced?: boolean): Promise<number>
  exec(args: string[]): Promise<number>
}

export default function createInstallerGuard(ctx: Context, config: InstallerConfig, log: GuardLog): GuardResult {
  const restore: Array<() => void> = []
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let target: object | null = null
  let installed = false
  let locked = false
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
      return withTimeout(original, this, args as unknown[][], config, timers, log)
    }, restore)

    patchMethod(proto, 'install', (original) => async function (this: InstallerService, deps: Record<string, string>, forced?: boolean) {
      if (locked) {
        log.warn('rejected a concurrent install request, another one is still running')
        return -1
      }

      locked = true
      try {
        const filename = resolve(this.cwd, 'package.json')
        const backup = config.rollback ? await snapshot(filename, log) : null
        const code = await original.call(this, deps, forced)
        if (code === 0) return code
        await reportFailure(filename, backup, code, log)
        return code
      } finally {
        locked = false
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
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
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

async function reportFailure(filename: string, backup: string | null, code: number, log: GuardLog): Promise<void> {
  if (backup === null) {
    log.error('install failed with code %s, package.json may be left in a broken state', code)
    return
  }
  try {
    await fsp.writeFile(filename, backup)
    log.error('install failed with code %s, package.json has been restored', code)
  } catch (error) {
    log.error('install failed with code %s and package.json could not be restored: %s', code, describe(error))
  }
}

function withTimeout(
  run: (...args: unknown[]) => unknown,
  receiver: InstallerService,
  args: unknown[][],
  config: InstallerConfig,
  timers: Set<ReturnType<typeof setTimeout>>,
  log: GuardLog,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false

    const timer = setTimeout(() => {
      timers.delete(timer)
      if (settled) return
      settled = true
      log.error(
        'the package manager did not finish within %d ms, stopped waiting; the child process may still be running',
        config.timeout,
      )
      resolve(-1)
    }, config.timeout)
    timers.add(timer)

    const finish = (handler: (value: any) => void) => (value: any) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      timers.delete(timer)
      handler(value)
    }

    let pending: unknown
    try {
      pending = run.apply(receiver, args)
    } catch (error) {
      finish(reject)(error)
      return
    }

    Promise.resolve(pending).then(finish(resolve), finish(reject))
  })
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
