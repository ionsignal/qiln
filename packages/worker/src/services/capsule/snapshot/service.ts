import {
  CapsuleSnapshotListOutputSchema,
  createCapsuleBlueprintReference,
  type CapsuleSnapshotListOutput,
} from '@qiln/core/server'
import { toIsoTimestamp } from '../operations/shared/timestamps'
import type { CapsuleSnapshotStore } from './store'

/**
 * Projects committed restoration history without exposing provider topology.
 *
 * A successful history read proves the committed restoration graph, not
 * application correctness or a detailed explanation of branch changes.
 */
export class CapsuleSnapshotService {
  constructor(private readonly snapshots: CapsuleSnapshotStore) {}

  public async list(ownerId: string, capsuleId: string): Promise<CapsuleSnapshotListOutput> {
    const snapshots = await this.snapshots.list(ownerId, capsuleId)
    return CapsuleSnapshotListOutputSchema.parse(
      snapshots.map(snapshot => ({
        id: snapshot.id,
        capsuleId: snapshot.capsuleId,
        sourceBranchId: snapshot.sourceBranchId,
        sourceBranchName: snapshot.sourceBranchName,
        sourceBranchResourceInventoryDigest: snapshot.sourceBranchResourceInventoryDigest,
        blueprint: createCapsuleBlueprintReference(snapshot.blueprintPin),
        createdAt: toIsoTimestamp(snapshot.createdAt, 'createdAt', {
          entity: 'capsule snapshot',
          entityId: snapshot.id,
        }),
      })),
    )
  }
}
