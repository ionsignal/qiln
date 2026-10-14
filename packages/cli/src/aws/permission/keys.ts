/**
 * Import-free leaf so record types can name policies without importing the
 * modules that build them. Declaration order is execution order: a policy is
 * reconciled only after every earlier policy is verified. The list is
 * append-only and `foundation` stays first. Durable records tolerate later
 * keys, and appending keeps a narrowing repartition ahead of the policy that
 * gains authority.
 */
export const POLICY_KEYS = ['foundation', 'compute'] as const
export const POLICY_PATH = '/qiln/policies/'

export type PolicyKey = (typeof POLICY_KEYS)[number]
export type PolicyMap<T> = Record<PolicyKey, T>
export type PolicyBindings<T> = Pick<PolicyMap<T>, 'foundation'> & Partial<PolicyMap<T>>

export function isPolicyKey(value: unknown): value is PolicyKey {
  return POLICY_KEYS.some(key => key === value)
}

export function policyMap<T>(build: (key: PolicyKey) => T): PolicyMap<T> {
  return Object.fromEntries(POLICY_KEYS.map(key => [key, build(key)])) as PolicyMap<T>
}

export async function policyMapAsync<T>(build: (key: PolicyKey) => Promise<T>): Promise<PolicyMap<T>> {
  const entries: [PolicyKey, T][] = []
  for (const key of POLICY_KEYS) {
    entries.push([key, await build(key)])
  }
  return Object.fromEntries(entries) as PolicyMap<T>
}

export function bindingEntries<T>(bindings: PolicyBindings<T>): [PolicyKey, T][] {
  return POLICY_KEYS.flatMap((key): [PolicyKey, T][] => {
    const entry = bindings[key]
    return entry === undefined ? [] : [[key, entry]]
  })
}

export function enrolledKeys<T>(bindings: PolicyBindings<T>): PolicyKey[] {
  return bindingEntries(bindings).map(([key]) => key)
}
