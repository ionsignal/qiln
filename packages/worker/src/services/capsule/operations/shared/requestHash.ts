import {
  CapsuleOperationRequestHashSchema,
  digestCanonicalJsonValue,
  type CapsuleOperationRequestHash,
} from '@qiln/core/server'

/**
 * Creates and validates a deterministic operation request hash.
 *
 * Callers must provide the complete operation-specific request identity. This
 * helper does not infer command fields or encode aggregate transition policy.
 */
export function createOperationRequestHash(
  value: Record<string, unknown>,
  context: string,
): CapsuleOperationRequestHash {
  const digest = digestCanonicalJsonValue(value, {
    context,
  })
  return CapsuleOperationRequestHashSchema.parse(digest)
}
