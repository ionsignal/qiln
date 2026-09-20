import type { CapsuleTables } from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

export type ReadTransaction<TDatabase extends PostgresJsDatabase> = Parameters<
  Parameters<TDatabase['transaction']>[0]
>[0]

export type CapsuleRow = CapsuleTables['capsules']['$inferSelect']
export type BranchRow = CapsuleTables['capsuleBranches']['$inferSelect']
export type OperationRow = CapsuleTables['capsuleOperations']['$inferSelect']
export type PreviewRow = CapsuleTables['capsuleBranchPreviews']['$inferSelect']

/**
 * Internal rows stay inside the Worker. Public projections explicitly select
 * safe fields rather than spreading persistence records.
 */
export interface CapsuleReadScope {
  capsule: CapsuleRow
  root: BranchRow
  branch: BranchRow
  operation: OperationRow | null
  previews: PreviewRow[]
}
