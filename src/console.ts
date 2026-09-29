import { Context } from 'koishi'
import { GuardLog, GuardResult, GuardStatus } from './log'
import { toDisposer } from './patch'

const MAX_TRACKED_ACTIONS = 4096

export interface ConsoleConfig {
  enabled: boolean
  guardNotifier: boolean
  notifierRateLimit: number
  notifierRateWindow: number
  maxPayloadSize: number
}

interface ConsoleSocket {
  addEventListener(type: string, handler: (event: any) => void): void
  removeEventListener(type: string, handler: (event: any) => void): void
}

interface ConsoleClient {
  id: string
  socket: ConsoleSocket
  receive(event: any): Promise<unknown>
}

interface NotifierService {
  actions: Record<string, () => void>
}

export default function createConsoleGuard(ctx: Context, config: ConsoleConfig, log: GuardLog): GuardResult {
  const restore: Array<() => void> = []
  const guarded = new WeakSet<object>()

  const wantsNotifier = config.guardNotifier
  let consoleWaiting = true
  let notifierWaiting = wantsNotifier
  let consoleAttached = false
  let notifierAttached = false

  const settle = (): GuardStatus => {
    if (consoleAttached || notifierAttached) return 'active'
    if (consoleWaiting || notifierWaiting) return 'pending'
    return 'skipped'
  }

  const reason = (): string => {
    const parts: string[] = []
    if (!consoleAttached) {
      parts.push(consoleWaiting
        ? 'waiting for plugin "@koishijs/plugin-console"'
        : 'plugin "@koishijs/plugin-console" is unavailable')
    }
    if (wantsNotifier && !notifierAttached) {
      parts.push(notifierWaiting
        ? 'waiting for plugin "@koishijs/plugin-notifier"'
        : 'plugin "@koishijs/plugin-notifier" is unavailable')
    }
    return parts.join('; ')
  }

  if (wantsNotifier) {
    const disposeNotifier = toDisposer(ctx.inject({ notifier: { required: true } }, () => {
      notifierWaiting = false
      const service = ctx.get('notifier') as NotifierService | undefined
      if (!service?.actions) {
        log.debug('notifier actions unavailable, notifier part stays idle')
        return
      }

      const target = service.actions
      const hits = new Map<string, number[]>()

      service.actions = new Proxy(target, {
        get(store, key) {
          if (typeof key === 'symbol') return Reflect.get(store, key)
          const action = Reflect.get(store, key) as unknown
          if (typeof action !== 'function') {
            log.debug('notifier action "%s" does not exist, ignoring the request', String(key))
            return () => {}
          }
          return (...args: unknown[]) => {
            if (!allowAction(hits, String(key), config, log)) return
            try {
              return (action as (...a: unknown[]) => unknown)(...args)
            } catch (error) {
              log.error('notifier action "%s" failed: %s', String(key), describe(error))
            }
          }
        },
      })

      restore.push(() => {
        service.actions = target
      })
      notifierAttached = true
      log.debug('notifier actions are validated and rate limited')
    }))
    restore.unshift(disposeNotifier)
  }

  const disposeClient = toDisposer(ctx.inject({ console: { required: true } }, () => {
    consoleWaiting = false
    const service = ctx.get('console')
    if (!service) {
      log.debug('console service unavailable, payload validation stays idle')
      return
    }

    const listen = service.on.bind(service) as unknown as (name: string, listener: (client: unknown) => void) => unknown
    restore.push(toDisposer(listen('console/connection', (client) => {
      guardClient(client as ConsoleClient, config, guarded, restore, log)
    })))
    consoleAttached = true
    log.debug('console payloads will be validated before dispatch')
  }))
  restore.unshift(disposeClient)

  return {
    get status() {
      return settle()
    },
    get reason() {
      return reason()
    },
    dispose() {
      for (const fn of [...restore].reverse()) {
        if (typeof fn === 'function') fn()
      }
      log.debug('console guard disposed')
    },
  }
}

function guardClient(
  client: ConsoleClient,
  config: ConsoleConfig,
  guarded: WeakSet<object>,
  restore: Array<() => void>,
  log: GuardLog,
): boolean {
  if (!client?.socket || guarded.has(client)) return false
  const original = client.receive
  if (typeof original !== 'function') return false

  const wrapped = async (event: any): Promise<unknown> => {
    let raw: string
    try {
      raw = event?.data?.toString?.() ?? ''
    } catch (error) {
      log.debug('failed to read a console payload: %s', describe(error))
      return
    }

    if (raw.length > config.maxPayloadSize) {
      log.debug('rejected an oversized console payload (%d bytes)', raw.length)
      return
    }

    let parsed: any
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      log.debug('rejected a malformed console payload: %s', describe(error))
      return
    }

    if (!parsed || typeof parsed.type !== 'string' || !Array.isArray(parsed.args)) {
      log.debug('rejected a console payload with an invalid shape')
      return
    }

    try {
      return await original.call(client, { data: raw })
    } catch (error) {
      log.error('console message "%s" failed: %s', parsed.type, describe(error))
    }
  }

  try {
    client.socket.removeEventListener('message', original)
    client.socket.addEventListener('message', wrapped)
    client.receive = wrapped
    guarded.add(client)
  } catch (error) {
    log.debug('failed to rebind the console message listener: %s', describe(error))
    return false
  }

  restore.push(() => {
    try {
      client.socket.removeEventListener('message', wrapped)
      client.socket.addEventListener('message', original)
    } catch {}
    client.receive = original
  })

  return true
}

function allowAction(hits: Map<string, number[]>, key: string, config: ConsoleConfig, log: GuardLog): boolean {
  if (hits.size > MAX_TRACKED_ACTIONS) hits.clear()

  const now = Date.now()
  const recent = (hits.get(key) ?? []).filter((time) => now - time < config.notifierRateWindow)

  if (recent.length >= config.notifierRateLimit) {
    log.warn('notifier action "%s" exceeded the rate limit, blocking the request', key)
    return false
  }

  recent.push(now)
  hits.set(key, recent)
  return true
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
