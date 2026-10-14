import type { Tag as ProviderTag } from '@aws-sdk/client-ec2'
import { InstallerError } from '../../../diagnostic/error'
import type { Expected } from '../../deployment/expect'
import type { Kind } from '../../deployment/graph'
import {
  requiredTags,
  type Deployment,
  type ObservedResource,
  type ObservedState,
  type Tag,
} from '../../deployment/types'
import { AWS_SPEC } from '../../spec'

export type Of<K extends Kind> = Extract<Expected, { kind: K }>

export interface Candidate {
  kind: Kind
  id: string | undefined
  state: ObservedState
}

export const PAGES = {
  maxPages: AWS_SPEC.deployment.maximumPages,
  code: 'AWS_DEPLOYMENT_VERIFICATION_FAILED',
} as const

export function unverified(): never {
  throw new InstallerError({
    code: 'AWS_DEPLOYMENT_VERIFICATION_FAILED',
  })
}

export function listed<T>(items: readonly T[] | undefined, next: string | undefined): readonly T[] {
  return next === undefined ? (items ?? []) : unverified()
}

export function byId(name: string, wanted: readonly { id: string }[]) {
  return [{ Name: name, Values: wanted.map(item => item.id) }]
}

export function tagFilters(record: Deployment) {
  return requiredTags(record.binding.operator.arn, record.id).map(tag => ({
    Name: `tag:${tag.Key}`,
    Values: [tag.Value],
  }))
}

export function tagged(actual: readonly ProviderTag[] | undefined, expected: readonly Tag[]): boolean {
  return expected.every(tag => (actual ?? []).some(entry => entry.Key === tag.Key && entry.Value === tag.Value))
}

/**
 * Absent optional fields are never read as success. A resource expected to be
 * gone is `present` while it exists at all, so deletion is only observed once
 * the provider stops listing it. `gone` marks listings that still appear but
 * are terminal, such as a terminated instance, and counts them as absent.
 */
export function judge<E extends { id: string; present: boolean }, T>(
  kind: Kind,
  wanted: readonly E[],
  found: readonly T[],
  idOf: (item: T) => string | undefined,
  fits: (expected: E, actual: T) => boolean,
  gone?: (actual: T) => boolean,
): ObservedResource[] {
  const byIdentity = new Map(found.map(item => [idOf(item), item] as const))
  return wanted.map((item): ObservedResource => {
    const actual = byIdentity.get(item.id)
    if (actual === undefined || gone?.(actual)) {
      return { kind, id: item.id, state: 'absent' }
    }
    return { kind, id: item.id, state: !item.present || fits(item, actual) ? 'present' : 'changed' }
  })
}
