import { InstallerError } from '../../diagnostic/error'
import { sendEvidence } from '../child/evidence'
import { hasKeys, isRecord } from '../../guards'
import { isOperationId } from '../types'
import { isPasswordReceipt, type PasswordReceipt } from './types'

export interface PasswordEvidence {
  kind: 'password-created'
  operationId: string
  mutationId: string
  receipt: PasswordReceipt
}

export interface PasswordAcknowledgment {
  kind: 'password-retained'
  operationId: string
  mutationId: string
}

export function isPasswordEvidence(value: unknown): value is PasswordEvidence {
  return (
    isRecord(value) &&
    hasKeys(value, ['kind', 'operationId', 'mutationId', 'receipt']) &&
    value.kind === 'password-created' &&
    isOperationId(value.operationId) &&
    isOperationId(value.mutationId) &&
    isPasswordReceipt(value.receipt) &&
    value.receipt.delivered === false
  )
}

function isAcknowledgment(value: unknown, evidence: PasswordEvidence): value is PasswordAcknowledgment {
  return (
    isRecord(value) &&
    hasKeys(value, ['kind', 'operationId', 'mutationId']) &&
    value.kind === 'password-retained' &&
    value.operationId === evidence.operationId &&
    value.mutationId === evidence.mutationId
  )
}

/**
 * The password remains in this child. Only the creation receipt crosses IPC,
 * and terminal delivery starts after the parent confirms durable retention.
 */
export async function retainPassword(
  operationId: string,
  mutationId: string,
  receipt: PasswordReceipt,
  signal: AbortSignal,
): Promise<void> {
  const evidence: PasswordEvidence = {
    kind: 'password-created',
    operationId,
    mutationId,
    receipt,
  }
  if (!isPasswordEvidence(evidence)) {
    throw new InstallerError({
      code: 'AWS_BOOTSTRAP_PASSWORD_UNAVAILABLE',
    })
  }
  await sendEvidence(
    evidence,
    message => isAcknowledgment(message, evidence),
    signal,
    'AWS_BOOTSTRAP_PASSWORD_UNAVAILABLE',
  )
}
