import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm'
import {
  CapsuleArtifactEntryType,
  CapsuleArtifactManifestSchema,
  CapsuleOperationStatus,
  CapsuleOperationType,
  CapsuleSnapshotLimitationsSchema,
  CapsuleSnapshotMode,
  ExperimentalCapsuleSnapshotLimitations,
  capsuleArtifactEntriesTable,
  capsuleArtifactManifestRootsTable,
  capsuleArtifactManifestsTable,
  capsuleBranchesTable,
  capsuleOperationsTable,
  capsuleSnapshotCaptureOperationsTable,
  capsuleSnapshotCaptureResourcesTable,
  capsuleSnapshotResourceReferencesTable,
  capsuleSnapshotsTable,
  capsulesTable,
  digestCapsuleArtifactManifest,
  normalizeCapsuleArtifactManifest,
  verifyCapsuleSnapshotCapturePolicyPin,
  type CapsuleArtifactManifest,
  type CapsuleHostDbContract,
  type CapsuleSnapshotLimitationValue,
} from '@qiln/core/server'
import { IncusError } from '../../../../../errors'
import { toCapsuleLifecycleState, toCapsuleOperationTransition } from '../../shared'
import type { CaptureCommitResult, CaptureResourceRecord, CommitCaptureInput } from '../types'

type CaptureTransaction = Parameters<Parameters<CapsuleHostDbContract['transaction']>[0]>[0]

function compareStableString(left: string, right: string): number {
  if (left < right) {
    return -1
  }
  if (left > right) {
    return 1
  }
  return 0
}

function entryIdentity(rootId: string, logicalPath: string): string {
  return `${rootId}\u0000${logicalPath}`
}

function isPathAtOrBelow(candidate: string, parent: string): boolean {
  if (candidate === parent) {
    return true
  }
  if (parent === '/') {
    return candidate.startsWith('/')
  }
  return candidate.startsWith(`${parent}/`)
}

function absolutePath(rootPath: string, relativePath: string): string {
  if (relativePath === '.') {
    return rootPath
  }
  return rootPath === '/' ? `/${relativePath}` : `${rootPath}/${relativePath}`
}

function sameLimitations(
  left: readonly CapsuleSnapshotLimitationValue[],
  right: readonly CapsuleSnapshotLimitationValue[],
): boolean {
  if (left.length !== right.length) {
    return false
  }
  const leftValues = [...left].sort(compareStableString)
  const rightValues = [...right].sort(compareStableString)
  return leftValues.every((value, index) => value === rightValues[index])
}

/**
 * Atomically commits one complete experimental Snapshot Capture result.
 *
 * Operation-scoped provider resources remain execution accounting. This
 * transaction copies only positively confirmed provider identities into
 * immutable committed snapshot references.
 */
export class CaptureCommitPersistence {
  constructor(private readonly db: CapsuleHostDbContract) {}

  public async commit(input: CommitCaptureInput): Promise<CaptureCommitResult> {
    const manifest = normalizeCapsuleArtifactManifest(input.collection.manifest)
    const manifestDigest = digestCapsuleArtifactManifest(manifest)

    if (manifestDigest !== input.collection.digest) {
      throw new IncusError('Snapshot Capture artifact manifest digest does not match collected evidence.', 'CONFLICT', {
        operationId: input.execution.operationId,
        expectedDigest: input.collection.digest,
        actualDigest: manifestDigest,
      })
    }

    if (input.git.repositories.length !== 0) {
      throw new IncusError('Experimental Snapshot Capture cannot commit Git repository evidence yet.', 'CONFLICT', {
        operationId: input.execution.operationId,
        repositoryCount: input.git.repositories.length,
      })
    }

    const limitations = CapsuleSnapshotLimitationsSchema.parse([
      ...new Set([...input.collection.limitations, ...input.git.limitations]),
    ])

    this.assertManifest(input, manifest)
    this.assertExperimentalLimitations(input.execution.operationId, limitations)

    return await this.db.transaction(async tx => {
      const operation = await this.lockOperation(tx, input.execution.operationId)

      if (
        operation.ownerId !== input.execution.ownerId ||
        operation.capsuleId !== input.execution.capsuleId ||
        operation.status !== CapsuleOperationStatus.RUNNING ||
        operation.providerMutationStartedAt === null
      ) {
        throw new IncusError('Snapshot Capture operation is not eligible for atomic commit.', 'CONFLICT', {
          operationId: operation.id,
          operationOwnerId: operation.ownerId,
          expectedOwnerId: input.execution.ownerId,
          operationCapsuleId: operation.capsuleId,
          expectedCapsuleId: input.execution.capsuleId,
          operationStatus: operation.status,
          providerIntentCommitted: operation.providerMutationStartedAt !== null,
        })
      }

      const extension = await this.lockExtension(tx, operation.id)
      if (
        extension.snapshotId !== null ||
        extension.sourceBranchId !== input.execution.sourceBranchId ||
        extension.sourceBranchName !== input.execution.sourceBranchName ||
        extension.sourceBranchResourceInventoryDigest !== input.execution.sourceBranchResourceInventoryDigest ||
        extension.requestedMode !== CapsuleSnapshotMode.EXPERIMENTAL
      ) {
        throw new IncusError('Snapshot Capture extension does not match immutable execution input.', 'CONFLICT', {
          operationId: operation.id,
          snapshotId: extension.snapshotId,
          sourceBranchId: extension.sourceBranchId,
          expectedSourceBranchId: input.execution.sourceBranchId,
          requestedMode: extension.requestedMode,
        })
      }

      const policy = verifyCapsuleSnapshotCapturePolicyPin(extension.capturePolicyPin)
      if (
        policy.schemaVersion !== extension.capturePolicySchemaVersion ||
        policy.digest !== extension.capturePolicyDigest ||
        policy.digest !== input.execution.capturePolicy.digest
      ) {
        throw new IncusError('Snapshot Capture policy evidence changed before atomic commit.', 'CONFLICT', {
          operationId: operation.id,
          persistedDigest: extension.capturePolicyDigest,
          executionDigest: input.execution.capturePolicy.digest,
          verifiedDigest: policy.digest,
        })
      }

      const capsule = await this.lockCapsule(tx, operation.ownerId, operation.capsuleId)
      if (capsule.lifecycleStatus !== 'active' || capsule.archivedAt !== null) {
        throw new IncusError('Snapshot Capture capsule is no longer active and unarchived.', 'CONFLICT', {
          operationId: operation.id,
          capsuleId: operation.capsuleId,
          lifecycleStatus: capsule.lifecycleStatus,
          archived: capsule.archivedAt !== null,
        })
      }

      const branch = await this.lockBranch(tx, operation.ownerId, operation.capsuleId, extension.sourceBranchId)
      if (
        branch.status !== 'capturing' ||
        branch.name !== extension.sourceBranchName ||
        branch.resourceInventoryDigest !== extension.sourceBranchResourceInventoryDigest
      ) {
        throw new IncusError(
          'Snapshot Capture source branch no longer matches its durable capture fence.',
          'CONFLICT',
          {
            operationId: operation.id,
            sourceBranchId: extension.sourceBranchId,
            branchStatus: branch.status,
            branchName: branch.name,
            expectedBranchName: extension.sourceBranchName,
            inventoryDigest: branch.resourceInventoryDigest,
            expectedInventoryDigest: extension.sourceBranchResourceInventoryDigest,
          },
        )
      }

      const resources = await this.lockResources(tx, operation.id)
      this.assertResources(input, resources)

      const now = new Date()
      const [snapshot] = await tx
        .insert(capsuleSnapshotsTable)
        .values({
          capsuleId: operation.capsuleId,
          sourceBranchId: branch.id,
          sourceBranchName: branch.name,
          sourceBranchResourceInventoryDigest: extension.sourceBranchResourceInventoryDigest,
          capturePolicySchemaVersion: extension.capturePolicySchemaVersion,
          capturePolicyDigest: extension.capturePolicyDigest,
          capturePolicyPin: policy,
          mode: CapsuleSnapshotMode.EXPERIMENTAL,
          limitations: [...limitations],
          createdAt: now,
          archivedAt: null,
        })
        .returning({
          id: capsuleSnapshotsTable.id,
        })

      if (!snapshot) {
        throw new IncusError('Failed to insert committed experimental capsule snapshot.', 'API_ERROR', {
          operationId: operation.id,
          capsuleId: operation.capsuleId,
        })
      }

      const [manifestRecord] = await tx
        .insert(capsuleArtifactManifestsTable)
        .values({
          snapshotId: snapshot.id,
          schemaVersion: manifest.schemaVersion,
          digest: manifestDigest,
          createdAt: now,
        })
        .returning({
          id: capsuleArtifactManifestsTable.id,
        })

      if (!manifestRecord) {
        throw new IncusError('Failed to insert committed capsule artifact manifest.', 'API_ERROR', {
          operationId: operation.id,
          snapshotId: snapshot.id,
        })
      }

      const insertedRoots = await tx
        .insert(capsuleArtifactManifestRootsTable)
        .values(
          manifest.roots.map(root => ({
            manifestId: manifestRecord.id,
            rootId: root.id,
            logicalPath: root.logicalPath,
          })),
        )
        .returning({
          id: capsuleArtifactManifestRootsTable.id,
          rootId: capsuleArtifactManifestRootsTable.rootId,
          logicalPath: capsuleArtifactManifestRootsTable.logicalPath,
        })

      if (insertedRoots.length !== manifest.roots.length) {
        throw new IncusError('Failed to insert every committed artifact manifest root.', 'API_ERROR', {
          operationId: operation.id,
          snapshotId: snapshot.id,
          expectedRootCount: manifest.roots.length,
          insertedRootCount: insertedRoots.length,
        })
      }

      const rootsById = new Map(insertedRoots.map(root => [root.rootId, root] as const))
      const entryValues = manifest.entries.map(entry => {
        const root = rootsById.get(entry.rootId)
        if (!root) {
          throw new IncusError('Artifact entry references a root that was not inserted.', 'API_ERROR', {
            operationId: operation.id,
            snapshotId: snapshot.id,
            rootId: entry.rootId,
            logicalPath: entry.logicalPath,
          })
        }

        return {
          manifestRootId: root.id,
          logicalPath: entry.logicalPath,
          type: entry.type,
          mode: entry.mode,
          uid: entry.uid,
          gid: entry.gid,
          modifiedAt: new Date(entry.modifiedAt),
          size: entry.type === CapsuleArtifactEntryType.FILE ? entry.size : null,
          contentDigest: entry.type === CapsuleArtifactEntryType.FILE ? entry.contentDigest : null,
        }
      })

      const insertedEntries = await tx.insert(capsuleArtifactEntriesTable).values(entryValues).returning({
        id: capsuleArtifactEntriesTable.id,
      })

      if (insertedEntries.length !== manifest.entries.length) {
        throw new IncusError('Failed to insert every committed artifact manifest entry.', 'API_ERROR', {
          operationId: operation.id,
          snapshotId: snapshot.id,
          expectedEntryCount: manifest.entries.length,
          insertedEntryCount: insertedEntries.length,
        })
      }

      const resourceReferences = resources.map(resource => {
        const root = rootsById.get(resource.artifactRootId)
        if (!root) {
          throw new IncusError('Provider snapshot resource cannot resolve its committed manifest root.', 'CONFLICT', {
            operationId: operation.id,
            snapshotId: snapshot.id,
            resourceId: resource.id,
            artifactRootId: resource.artifactRootId,
          })
        }

        return {
          snapshotId: snapshot.id,
          manifestRootId: root.id,
          sourceBranchResourceId: resource.sourceBranchResourceId,
          provider: resource.provider,
          kind: resource.kind,
          blueprintVolumeName: resource.blueprintVolumeName,
          project: resource.project,
          pool: resource.pool,
          sourceVolume: resource.sourceVolume,
          snapshotName: resource.snapshotName,
        }
      })

      const insertedReferences = await tx
        .insert(capsuleSnapshotResourceReferencesTable)
        .values(resourceReferences)
        .returning({
          id: capsuleSnapshotResourceReferencesTable.id,
        })

      if (insertedReferences.length !== resourceReferences.length) {
        throw new IncusError('Failed to insert every committed provider snapshot reference.', 'API_ERROR', {
          operationId: operation.id,
          snapshotId: snapshot.id,
          expectedReferenceCount: resourceReferences.length,
          insertedReferenceCount: insertedReferences.length,
        })
      }

      const [linkedExtension] = await tx
        .update(capsuleSnapshotCaptureOperationsTable)
        .set({
          snapshotId: snapshot.id,
        })
        .where(
          and(
            eq(capsuleSnapshotCaptureOperationsTable.operationId, operation.id),
            isNull(capsuleSnapshotCaptureOperationsTable.snapshotId),
          ),
        )
        .returning({
          operationId: capsuleSnapshotCaptureOperationsTable.operationId,
        })

      const [completedOperation] = await tx
        .update(capsuleOperationsTable)
        .set({
          status: CapsuleOperationStatus.COMPLETED,
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(capsuleOperationsTable.id, operation.id),
            eq(capsuleOperationsTable.type, CapsuleOperationType.SNAPSHOT_CAPTURE),
            eq(capsuleOperationsTable.status, CapsuleOperationStatus.RUNNING),
            isNotNull(capsuleOperationsTable.providerMutationStartedAt),
          ),
        )
        .returning({
          id: capsuleOperationsTable.id,
        })

      const [offlineBranch] = await tx
        .update(capsuleBranchesTable)
        .set({
          status: 'offline',
          runtimeIp: null,
          runtimeErrorCode: null,
          runtimeErrorMessage: null,
          runtimeErrorDetails: null,
          runtimeErrorAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(capsuleBranchesTable.id, branch.id),
            eq(capsuleBranchesTable.ownerId, operation.ownerId),
            eq(capsuleBranchesTable.capsuleId, operation.capsuleId),
            eq(capsuleBranchesTable.status, 'capturing'),
          ),
        )
        .returning({
          id: capsuleBranchesTable.id,
          capsuleId: capsuleBranchesTable.capsuleId,
          name: capsuleBranchesTable.name,
          status: capsuleBranchesTable.status,
        })

      if (!linkedExtension || !completedOperation || !offlineBranch) {
        throw new IncusError('Failed to atomically finalize experimental Snapshot Capture.', 'CONFLICT', {
          operationId: operation.id,
          snapshotId: snapshot.id,
          extensionLinked: linkedExtension !== undefined,
          operationCompleted: completedOperation !== undefined,
          branchRestored: offlineBranch !== undefined,
        })
      }

      return {
        snapshotId: snapshot.id,
        operation: toCapsuleOperationTransition({
          ownerId: operation.ownerId,
          operationId: operation.id,
          operationType: CapsuleOperationType.SNAPSHOT_CAPTURE,
          operationStatus: CapsuleOperationStatus.COMPLETED,
          capsuleId: operation.capsuleId,
        }),
        capsule: toCapsuleLifecycleState({
          capsuleId: operation.capsuleId,
          lifecycleStatus: capsule.lifecycleStatus,
          archivedAt: capsule.archivedAt,
          destroyedAt: capsule.destroyedAt,
        }),
        branches: [offlineBranch],
      }
    })
  }

  private assertManifest(input: CommitCaptureInput, manifest: CapsuleArtifactManifest): void {
    const parsed = CapsuleArtifactManifestSchema.safeParse(manifest)
    if (!parsed.success) {
      throw new IncusError('Snapshot Capture cannot commit an invalid artifact manifest.', 'VALIDATION_ERROR', {
        operationId: input.execution.operationId,
        validation: parsed.error,
      })
    }

    const policyRoots = [...input.execution.capturePolicy.artifactRoots].sort((left, right) =>
      compareStableString(left.id, right.id),
    )
    const manifestRoots = [...manifest.roots].sort((left, right) => compareStableString(left.id, right.id))

    if (
      policyRoots.length !== manifestRoots.length ||
      policyRoots.some(
        (root, index) => root.id !== manifestRoots[index]?.id || root.logicalPath !== manifestRoots[index]?.logicalPath,
      )
    ) {
      throw new IncusError('Snapshot Capture manifest roots do not exactly match the historical policy.', 'CONFLICT', {
        operationId: input.execution.operationId,
        policyRoots: policyRoots.map(root => ({
          id: root.id,
          logicalPath: root.logicalPath,
        })),
        manifestRoots,
      })
    }

    const entriesByIdentity = new Map(
      manifest.entries.map(entry => [entryIdentity(entry.rootId, entry.logicalPath), entry] as const),
    )

    for (const root of policyRoots) {
      for (const required of root.requiredPaths) {
        const logicalPath = absolutePath(root.logicalPath, required.path)
        const entry = entriesByIdentity.get(entryIdentity(root.id, logicalPath))
        if (!entry || entry.type !== required.type) {
          throw new IncusError('Snapshot Capture manifest does not satisfy a required artifact path.', 'CONFLICT', {
            operationId: input.execution.operationId,
            artifactRootId: root.id,
            logicalPath,
            requiredType: required.type,
            actualType: entry?.type ?? null,
          })
        }
      }

      for (const exclusion of root.exclusions) {
        const excludedPath = absolutePath(root.logicalPath, exclusion.path)
        const included = manifest.entries.find(
          entry => entry.rootId === root.id && isPathAtOrBelow(entry.logicalPath, excludedPath),
        )
        if (included) {
          throw new IncusError('Snapshot Capture manifest contains an excluded artifact path.', 'CONFLICT', {
            operationId: input.execution.operationId,
            artifactRootId: root.id,
            exclusionPath: excludedPath,
            includedPath: included.logicalPath,
          })
        }
      }

      const externalMounts = input.execution.capturePolicy.externalMounts.filter(
        mount => mount.artifactRootId === root.id,
      )
      for (const mount of externalMounts) {
        const included = manifest.entries.find(
          entry => entry.rootId === root.id && isPathAtOrBelow(entry.logicalPath, mount.logicalPath),
        )
        if (included) {
          throw new IncusError('Snapshot Capture manifest traversed an external dependency boundary.', 'CONFLICT', {
            operationId: input.execution.operationId,
            artifactRootId: root.id,
            blueprintVolumeName: mount.blueprintVolumeName,
            boundaryPath: mount.logicalPath,
            includedPath: included.logicalPath,
          })
        }
      }
    }
  }

  private assertExperimentalLimitations(
    operationId: string,
    limitations: readonly CapsuleSnapshotLimitationValue[],
  ): void {
    if (!sameLimitations(limitations, ExperimentalCapsuleSnapshotLimitations)) {
      throw new IncusError(
        'Experimental Snapshot Capture must commit the complete Worker-owned limitation set.',
        'CONFLICT',
        {
          operationId,
          expectedLimitations: ExperimentalCapsuleSnapshotLimitations,
          actualLimitations: limitations,
        },
      )
    }
  }

  private assertResources(input: CommitCaptureInput, resources: readonly CaptureResourceRecord[]): void {
    if (resources.length !== input.execution.plan.roots.length) {
      throw new IncusError('Snapshot Capture provider references do not cover every planned root.', 'CONFLICT', {
        operationId: input.execution.operationId,
        expectedResourceCount: input.execution.plan.roots.length,
        actualResourceCount: resources.length,
      })
    }

    const resourcesByRoot = new Map(resources.map(resource => [resource.artifactRootId, resource] as const))

    for (const root of input.execution.plan.roots) {
      const resource = resourcesByRoot.get(root.artifactRootId)
      if (
        !resource ||
        resource.operationId !== input.execution.operationId ||
        resource.sourceBranchResourceId !== root.sourceBranchResourceId ||
        resource.blueprintVolumeName !== root.blueprintVolumeName ||
        resource.provider !== root.provider ||
        resource.kind !== root.kind ||
        resource.project !== root.project ||
        resource.pool !== root.pool ||
        resource.sourceVolume !== root.sourceVolume ||
        resource.snapshotName !== root.snapshotName ||
        resource.status !== 'created' ||
        resource.snapshotIntentAt === null ||
        resource.snapshotCreatedAt === null ||
        resource.cleanupIntentAt !== null ||
        resource.cleanupCompletedAt !== null ||
        resource.failureCode !== null ||
        resource.failureMessage !== null ||
        resource.failureDetails !== null ||
        resource.failureAt !== null
      ) {
        throw new IncusError(
          `Snapshot Capture provider evidence for artifact root '${root.artifactRootId}' is not commit-ready.`,
          'CONFLICT',
          {
            operationId: input.execution.operationId,
            artifactRootId: root.artifactRootId,
            resourceId: resource?.id ?? null,
            resourceStatus: resource?.status ?? null,
          },
        )
      }
    }
  }

  private async lockOperation(tx: CaptureTransaction, operationId: string) {
    const [operation] = await tx
      .select()
      .from(capsuleOperationsTable)
      .where(
        and(
          eq(capsuleOperationsTable.id, operationId),
          eq(capsuleOperationsTable.type, CapsuleOperationType.SNAPSHOT_CAPTURE),
        ),
      )
      .for('update')
      .limit(1)

    if (!operation) {
      throw new IncusError('Snapshot Capture operation was not found.', 'NOT_FOUND', {
        operationId,
      })
    }

    return operation
  }

  private async lockExtension(tx: CaptureTransaction, operationId: string) {
    const [extension] = await tx
      .select()
      .from(capsuleSnapshotCaptureOperationsTable)
      .where(eq(capsuleSnapshotCaptureOperationsTable.operationId, operationId))
      .for('update')
      .limit(1)

    if (!extension) {
      throw new IncusError('Snapshot Capture operation extension was not found.', 'NOT_FOUND', {
        operationId,
      })
    }

    return extension
  }

  private async lockCapsule(tx: CaptureTransaction, ownerId: string, capsuleId: string) {
    const [capsule] = await tx
      .select()
      .from(capsulesTable)
      .where(and(eq(capsulesTable.id, capsuleId), eq(capsulesTable.ownerId, ownerId)))
      .for('update')
      .limit(1)

    if (!capsule) {
      throw new IncusError('Snapshot Capture capsule was not found.', 'NOT_FOUND', {
        ownerId,
        capsuleId,
      })
    }

    return capsule
  }

  private async lockBranch(tx: CaptureTransaction, ownerId: string, capsuleId: string, branchId: string) {
    const [branch] = await tx
      .select()
      .from(capsuleBranchesTable)
      .where(
        and(
          eq(capsuleBranchesTable.id, branchId),
          eq(capsuleBranchesTable.ownerId, ownerId),
          eq(capsuleBranchesTable.capsuleId, capsuleId),
        ),
      )
      .for('update')
      .limit(1)

    if (!branch) {
      throw new IncusError('Snapshot Capture source branch was not found.', 'NOT_FOUND', {
        ownerId,
        capsuleId,
        sourceBranchId: branchId,
      })
    }

    return branch
  }

  private async lockResources(tx: CaptureTransaction, operationId: string): Promise<CaptureResourceRecord[]> {
    return await tx
      .select({
        id: capsuleSnapshotCaptureResourcesTable.id,
        operationId: capsuleSnapshotCaptureResourcesTable.operationId,
        sourceBranchResourceId: capsuleSnapshotCaptureResourcesTable.sourceBranchResourceId,
        artifactRootId: capsuleSnapshotCaptureResourcesTable.artifactRootId,
        blueprintVolumeName: capsuleSnapshotCaptureResourcesTable.blueprintVolumeName,
        provider: capsuleSnapshotCaptureResourcesTable.provider,
        kind: capsuleSnapshotCaptureResourcesTable.kind,
        project: capsuleSnapshotCaptureResourcesTable.project,
        pool: capsuleSnapshotCaptureResourcesTable.pool,
        sourceVolume: capsuleSnapshotCaptureResourcesTable.sourceVolume,
        snapshotName: capsuleSnapshotCaptureResourcesTable.snapshotName,
        status: capsuleSnapshotCaptureResourcesTable.status,
        snapshotIntentAt: capsuleSnapshotCaptureResourcesTable.snapshotIntentAt,
        snapshotCreatedAt: capsuleSnapshotCaptureResourcesTable.snapshotCreatedAt,
        cleanupIntentAt: capsuleSnapshotCaptureResourcesTable.cleanupIntentAt,
        cleanupCompletedAt: capsuleSnapshotCaptureResourcesTable.cleanupCompletedAt,
        failureCode: capsuleSnapshotCaptureResourcesTable.failureCode,
        failureMessage: capsuleSnapshotCaptureResourcesTable.failureMessage,
        failureDetails: capsuleSnapshotCaptureResourcesTable.failureDetails,
        failureAt: capsuleSnapshotCaptureResourcesTable.failureAt,
      })
      .from(capsuleSnapshotCaptureResourcesTable)
      .where(eq(capsuleSnapshotCaptureResourcesTable.operationId, operationId))
      .orderBy(asc(capsuleSnapshotCaptureResourcesTable.artifactRootId), asc(capsuleSnapshotCaptureResourcesTable.id))
      .for('update')
  }
}
