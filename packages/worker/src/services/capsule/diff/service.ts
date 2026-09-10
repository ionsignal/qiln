import { z } from 'zod'
import { DiffUnavailableReason, type DiffInput, type DiffResult } from './types'

const DiffInputSchema = z
  .object({
    ownerId: z.uuid(),
    capsuleId: z.uuid(),
    branchId: z.uuid(),
    baselineSnapshotId: z.uuid().nullable(),
  })
  .strict()

/**
 * Internal advisory Diff boundary.
 *
 * The MVP deliberately has no database, provider, filesystem, Git, or hashing
 * dependencies. Supplying an ID does not prove a valid baseline or authorize
 * access to either side of a future comparison.
 */
export class DiffService {
  public async compare(input: DiffInput): Promise<DiffResult> {
    const request = DiffInputSchema.parse(input)
    const missingBaseline = request.baselineSnapshotId === null
    return {
      status: 'unavailable',
      consistency: 'unavailable',
      baselineSnapshotId: request.baselineSnapshotId,
      branchId: request.branchId,
      reason: missingBaseline ? DiffUnavailableReason.BASELINE_REQUIRED : DiffUnavailableReason.PROVIDER_UNAVAILABLE,
      message: missingBaseline
        ? 'Diff requires one exact earlier committed snapshot baseline.'
        : 'Provider-native diffing is unavailable. Exact baseline and live ZFS dataset mappings are not implemented.',
      volumes: [],
      incomplete: true,
      truncated: false,
    }
  }
}
