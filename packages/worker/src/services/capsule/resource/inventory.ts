import {
  CapsuleBlueprintIdentifierSchema,
  CapsuleBranchResourceInventoryDigestSchema,
  CapsuleBranchResourceType,
  digestCanonicalJsonValue,
  type CapsuleBlueprintIdentifier,
  type CapsuleBranchResourceCleanupPolicyValue,
  type CapsuleBranchResourceInventoryDigest,
  type CapsuleBranchResourceTypeValue,
} from '@qiln/core/server'
import { IncusError } from '../../../errors'

const RESOURCE_INVENTORY_SCHEMA_VERSION = 1

export interface CapsuleBranchResourceInventoryEntry {
  provider: string
  resourceType: CapsuleBranchResourceTypeValue
  resourceKey: string
  blueprintVolumeName: CapsuleBlueprintIdentifier | null
  cleanupPolicy: CapsuleBranchResourceCleanupPolicyValue
  metadata: unknown
}

interface CanonicalCapsuleBranchResourceInventoryEntry {
  provider: string
  resourceType: CapsuleBranchResourceTypeValue
  resourceKey: string
  blueprintVolumeName: CapsuleBlueprintIdentifier | null
  cleanupPolicy: CapsuleBranchResourceCleanupPolicyValue
  metadata: Record<string, unknown>
}

interface CanonicalCapsuleBranchResourceInventory {
  schemaVersion: typeof RESOURCE_INVENTORY_SCHEMA_VERSION
  resources: CanonicalCapsuleBranchResourceInventoryEntry[]
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function compareStableString(left: string, right: string): number {
  if (left < right) {
    return -1
  }
  if (left > right) {
    return 1
  }
  return 0
}

function createInventoryValidationError(
  message: string,
  context: string,
  details: Record<string, unknown>,
): IncusError {
  return new IncusError(message, 'VALIDATION_ERROR', {
    context,
    ...details,
  })
}

function normalizeBlueprintVolumeName(
  entry: CapsuleBranchResourceInventoryEntry,
  context: string,
): CapsuleBlueprintIdentifier | null {
  const requiresBlueprintVolumeName =
    entry.resourceType === CapsuleBranchResourceType.ZFS_VOLUME ||
    entry.resourceType === CapsuleBranchResourceType.BIND_MOUNT
  if (!requiresBlueprintVolumeName) {
    if (entry.blueprintVolumeName !== null) {
      throw createInventoryValidationError(
        'Capsule branch resource type cannot retain a blueprint volume identity.',
        context,
        {
          resourceType: entry.resourceType,
          resourceKey: entry.resourceKey,
          blueprintVolumeName: entry.blueprintVolumeName,
        },
      )
    }
    return null
  }
  const parsed = CapsuleBlueprintIdentifierSchema.safeParse(entry.blueprintVolumeName)
  if (!parsed.success) {
    throw createInventoryValidationError(
      'Managed volume and bind-mount resources require a valid blueprint volume identity.',
      context,
      {
        resourceType: entry.resourceType,
        resourceKey: entry.resourceKey,
        blueprintVolumeName: entry.blueprintVolumeName,
      },
    )
  }
  return parsed.data
}

function normalizeInventoryEntries(
  entries: readonly CapsuleBranchResourceInventoryEntry[],
  context: string,
): CanonicalCapsuleBranchResourceInventoryEntry[] {
  const identities = new Set<string>()
  const normalized = entries.map((entry, index) => {
    const entryContext = `${context}.resources[${index}]`
    if (entry.provider.trim() === '') {
      throw createInventoryValidationError(
        'Capsule branch resource inventory provider cannot be empty.',
        entryContext,
        {
          resourceKey: entry.resourceKey,
        },
      )
    }
    if (entry.resourceKey.trim() === '') {
      throw createInventoryValidationError('Capsule branch resource inventory key cannot be empty.', entryContext, {
        provider: entry.provider,
      })
    }
    if (!isPlainRecord(entry.metadata)) {
      throw createInventoryValidationError(
        'Capsule branch resource inventory metadata must be a plain JSON object.',
        entryContext,
        {
          provider: entry.provider,
          resourceKey: entry.resourceKey,
        },
      )
    }
    const blueprintVolumeName = normalizeBlueprintVolumeName(entry, entryContext)
    const identity = `${entry.provider}\u0000${entry.resourceKey}`
    if (identities.has(identity)) {
      throw createInventoryValidationError(
        'Capsule branch resource inventory contains a duplicate resource identity.',
        entryContext,
        {
          provider: entry.provider,
          resourceKey: entry.resourceKey,
        },
      )
    }
    identities.add(identity)
    return {
      identity,
      entry: {
        provider: entry.provider,
        resourceType: entry.resourceType,
        resourceKey: entry.resourceKey,
        blueprintVolumeName,
        cleanupPolicy: entry.cleanupPolicy,
        metadata: entry.metadata,
      },
    }
  })
  normalized.sort((left, right) => compareStableString(left.identity, right.identity))
  return normalized.map(item => item.entry)
}

/**
 * Produces the immutable identity digest for all resources planned for one
 * capsule branch. Mutable runtime state is deliberately excluded so normal
 * resource status transitions do not invalidate the creation-time proof.
 *
 * Blueprint volume identity is included because it is capture-policy evidence,
 * not mutable provider progress. Changing or removing it invalidates the
 * creation-time ownership proof.
 */
export function createCapsuleBranchResourceInventoryDigest(
  entries: readonly CapsuleBranchResourceInventoryEntry[],
  context: string,
): CapsuleBranchResourceInventoryDigest {
  const inventory: CanonicalCapsuleBranchResourceInventory = {
    schemaVersion: RESOURCE_INVENTORY_SCHEMA_VERSION,
    resources: normalizeInventoryEntries(entries, context),
  }
  const digest = digestCanonicalJsonValue(inventory, {
    context,
  })
  const parsedDigest = CapsuleBranchResourceInventoryDigestSchema.safeParse(digest)
  if (!parsedDigest.success) {
    throw createInventoryValidationError(
      'Generated capsule branch resource inventory digest failed validation.',
      context,
      {
        digest,
      },
    )
  }
  return parsedDigest.data
}

/**
 * Verifies that a branch's current durable resource ledger exactly matches the
 * resource inventory planned before its first provider mutation. A mismatch is
 * uncertain ownership, not a reason to inspect live Incus state.
 */
export function assertCapsuleBranchResourceInventoryMatches(
  expectedDigest: string,
  entries: readonly CapsuleBranchResourceInventoryEntry[],
): CapsuleBranchResourceInventoryDigest {
  const parsedExpectedDigest = CapsuleBranchResourceInventoryDigestSchema.safeParse(expectedDigest)
  if (!parsedExpectedDigest.success) {
    throw new IncusError('Capsule branch resource inventory proof is invalid. Manual review is required.', 'CONFLICT', {
      expectedDigest,
    })
  }
  let actualDigest: CapsuleBranchResourceInventoryDigest
  try {
    actualDigest = createCapsuleBranchResourceInventoryDigest(entries, 'capsule branch durable resource inventory')
  } catch (error: unknown) {
    throw new IncusError(
      'Capsule branch durable resource inventory is invalid. Manual review is required.',
      'CONFLICT',
      {
        expectedDigest: parsedExpectedDigest.data,
        resourceCount: entries.length,
        reason: error instanceof Error ? error.message : 'Unknown inventory normalization failure.',
      },
    )
  }
  if (actualDigest !== parsedExpectedDigest.data) {
    throw new IncusError(
      'Capsule branch durable resource inventory does not match its recorded creation plan. Manual review is required.',
      'CONFLICT',
      {
        expectedDigest: parsedExpectedDigest.data,
        actualDigest,
        resourceCount: entries.length,
      },
    )
  }
  return actualDigest
}
