type AnyFn = (...args: any[]) => any

export type Proto = Record<PropertyKey, unknown>

export function protoOf(service: object): Proto {
  return Object.getPrototypeOf(service) as Proto
}

export function toDisposer(value: unknown): () => void {
  if (typeof value !== 'function') return () => {}
  const fn = value as () => void
  return () => {
    try {
      fn()
    } catch {}
  }
}

export function patchMethod(
  target: object,
  key: PropertyKey,
  factory: (original: AnyFn) => AnyFn,
  restore: Array<() => void>,
): boolean {
  const holder = target as Record<PropertyKey, unknown>
  const original = holder[key]
  if (typeof original !== 'function') return false
  holder[key] = factory(original as AnyFn)
  restore.push(() => {
    holder[key] = original
  })
  return true
}

export function markInstalled(target: object, flag: symbol): void {
  ;(target as Record<PropertyKey, unknown>)[flag] = true
}

export function isInstalled(target: object, flag: symbol): boolean {
  return (target as Record<PropertyKey, unknown>)[flag] === true
}

export function clearInstalled(target: object, flag: symbol): void {
  delete (target as Record<PropertyKey, unknown>)[flag]
}
