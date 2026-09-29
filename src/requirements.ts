export interface GuardRequirement {
  services: string[]
  providers: string[]
}

export const REQUIREMENTS: Record<string, GuardRequirement> = {
  queue: { services: ['koishi'], providers: [] },
  observe: { services: ['koishi'], providers: [] },
  permission: { services: [], providers: [] },
  flush: { services: ['database'], providers: ['@koishijs/plugin-database-*'] },
  console: { services: ['console', 'notifier'], providers: ['@koishijs/plugin-console', '@koishijs/plugin-notifier'] },
  installer: { services: ['installer'], providers: ['@koishijs/plugin-market', 'koishi-plugin-market-next'] },
}

export function describeRequirement(name: string): string {
  const requirement = REQUIREMENTS[name]
  if (!requirement) return ''
  if (!requirement.providers.length) return `service ${quote(requirement.services)}`
  if (!requirement.services.length) return `plugin ${quote(requirement.providers)}`
  return `plugin ${quote(requirement.providers)} (provides service ${quote(requirement.services)})`
}

function quote(items: string[]): string {
  return items.map((item) => `"${item}"`).join(' or ')
}
