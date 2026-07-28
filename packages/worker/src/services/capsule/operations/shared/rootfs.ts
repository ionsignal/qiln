import { z } from 'zod'
import { CapsuleRootfsImagePinSchema, type CapsuleRootfsImagePin } from '@qiln/core/server'
import { IncusError } from '../../../../errors'

/**
 * Validates durable rootfs reconstruction evidence and proves that its
 * historical selector still agrees with the Blueprint that declared it.
 */
export function readRootfs(
  value: unknown,
  imageAlias: string,
  context: Record<string, unknown>,
): CapsuleRootfsImagePin {
  const parsed = CapsuleRootfsImagePinSchema.safeParse(value)
  if (!parsed.success) {
    throw new IncusError('Capsule rootfs image pin is invalid.', 'CONFLICT', {
      ...context,
      validation: z.treeifyError(parsed.error),
    })
  }
  if (parsed.data.sourceAlias !== imageAlias) {
    throw new IncusError('Capsule rootfs image pin does not match its historical Blueprint image alias.', 'CONFLICT', {
      ...context,
      expectedSourceAlias: imageAlias,
      actualSourceAlias: parsed.data.sourceAlias,
    })
  }
  return parsed.data
}

export function sameRootfs(left: CapsuleRootfsImagePin, right: CapsuleRootfsImagePin): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.provider === right.provider &&
    left.project === right.project &&
    left.fingerprint === right.fingerprint &&
    left.sourceAlias === right.sourceAlias
  )
}
