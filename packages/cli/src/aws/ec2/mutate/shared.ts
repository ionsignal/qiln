import type { ResourceType, TagSpecification } from '@aws-sdk/client-ec2'
import { InstallerError } from '../../../diagnostic/error'
import type { Action } from '../../deployment/graph'
import { resourceId } from '../../deployment/topology'
import { isReceipt, type Deployment } from '../../deployment/types'
import { notAttempted } from '../context'

export function unavailable(): never {
  throw new InstallerError({
    code: 'AWS_DEPLOYMENT_EVIDENCE_UNAVAILABLE',
  })
}

export function receipt(action: Action, id: unknown): string {
  if (typeof id !== 'string' || !isReceipt(action, id)) {
    return unavailable()
  }
  return id
}

export function need(record: Deployment, action: Action, slot = 0): string {
  return resourceId(record, action, slot) ?? notAttempted()
}

export function tags(record: Deployment, type: ResourceType): TagSpecification[] {
  return [{ ResourceType: type, Tags: record.approval.tags }]
}

export function contradicts(actual: string | undefined, expected: string): boolean {
  return actual !== undefined && actual !== expected
}
