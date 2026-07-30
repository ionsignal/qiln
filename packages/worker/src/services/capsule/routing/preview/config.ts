import { z } from 'zod'
import { CapsuleRouteHostSchema } from '@qiln/core/server'
import { parseRoutingIngressEndpoint } from '../../../../endpoint'
import { IncusError } from '../../../../errors'
import type { WorkerRoutingConfig } from '../../../../types'

function assertPositiveSafeInteger(value: number | undefined, field: string): void {
  if (value === undefined) {
    return
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new IncusError(`Preview routing '${field}' must be a positive safe integer.`, 'VALIDATION_ERROR', {
      field,
      value,
    })
  }
}

/**
 * Validates Worker-owned preview routing configuration before Caddy preview
 * reconciliation can start. Preview host allocation and ingress verification
 * must not fail for the first time after a branch becomes online.
 */
export function validatePreviewConfig(config: WorkerRoutingConfig): void {
  const baseDomain = CapsuleRouteHostSchema.safeParse(config.baseDomain)
  if (!baseDomain.success) {
    throw new IncusError('Preview routing base domain is invalid.', 'VALIDATION_ERROR', {
      validation: z.treeifyError(baseDomain.error),
    })
  }

  try {
    parseRoutingIngressEndpoint(config.ingressEndpoint)
  } catch (error: unknown) {
    throw new IncusError(
      error instanceof Error ? error.message : 'Preview routing ingress endpoint is invalid.',
      'VALIDATION_ERROR',
      {
        ingressEndpoint: config.ingressEndpoint,
      },
    )
  }

  assertPositiveSafeInteger(config.reconcileIntervalMs, 'reconcileIntervalMs')
  assertPositiveSafeInteger(config.verificationTimeoutMs, 'verificationTimeoutMs')
}
