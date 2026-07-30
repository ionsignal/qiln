import {
  CapsuleRouteAliasListOutputSchema,
  CapsuleSnapshotLimitationsSchema,
  createCapsuleBlueprintReference,
  createCapsuleRouteApplicationPin,
  createCapsuleRouteMatcherPin,
  createCapsuleRouteTargetReference,
  verifyCapsuleBlueprintPin,
  verifyCapsuleRouteEvidencePin,
  verifyCapsuleRouteTargetPin,
  type CapsuleRouteAliasListOutput,
} from '@qiln/core/server'
import { IncusError } from '../../../errors'
import { toIsoTimestamp } from '../operations/shared'
import type { CommittedRouteStore } from './store'
import type { CommittedRouteRecord, HeadedRouteRecord } from './types'

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false
  }
  const leftValues = [...left].sort()
  const rightValues = [...right].sort()
  return leftValues.every((value, index) => value === rightValues[index])
}

/**
 * Maps PostgreSQL-authoritative, integrity-checked alias graphs into
 * client-safe committed route state.
 */
export class CommittedRouteService {
  constructor(private readonly routes: CommittedRouteStore) {}

  public async list(ownerId: string, capsuleId: string): Promise<CapsuleRouteAliasListOutput> {
    const records = await this.routes.list(ownerId, capsuleId)
    return CapsuleRouteAliasListOutputSchema.parse(records.map(record => this.summary(record)))
  }

  private summary(record: CommittedRouteRecord) {
    const matcher = createCapsuleRouteMatcherPin({
      host: record.alias.host,
      path: record.alias.path,
      methods: record.alias.methods,
    })
    if (matcher.digest !== record.alias.matcherDigest) {
      throw new IncusError('Committed route alias matcher does not match its durable digest.', 'API_ERROR', {
        aliasId: record.alias.id,
        expectedDigest: record.alias.matcherDigest,
        actualDigest: matcher.digest,
      })
    }
    return {
      id: record.alias.id,
      capsuleId: record.alias.capsuleId,
      name: record.alias.name,
      exposure: record.alias.exposure,
      matcher,
      status: record.alias.status,
      current: record.head === null ? null : this.revision(record),
      createdAt: toIsoTimestamp(record.alias.createdAt, 'createdAt', {
        entity: 'route alias',
        entityId: record.alias.id,
      }),
      updatedAt: toIsoTimestamp(record.alias.updatedAt, 'updatedAt', {
        entity: 'route alias',
        entityId: record.alias.id,
      }),
    }
  }

  private revision(record: HeadedRouteRecord) {
    const revision = record.revision
    const snapshot = record.snapshot
    if (snapshot.capsuleId !== record.alias.capsuleId || revision.snapshotId !== snapshot.id) {
      throw new IncusError('Committed route revision target belongs to another capsule snapshot.', 'API_ERROR', {
        aliasId: record.alias.id,
        revisionId: revision.id,
        snapshotId: snapshot.id,
        aliasCapsuleId: record.alias.capsuleId,
        snapshotCapsuleId: snapshot.capsuleId,
      })
    }
    const blueprint = verifyCapsuleBlueprintPin(snapshot.blueprintPin)
    if (
      blueprint.blueprint.schema_version !== snapshot.blueprintSchemaVersion ||
      blueprint.name !== snapshot.blueprintName ||
      blueprint.digest !== snapshot.blueprintDigest
    ) {
      throw new IncusError('Committed route snapshot Blueprint evidence is internally inconsistent.', 'API_ERROR', {
        aliasId: record.alias.id,
        revisionId: revision.id,
        snapshotId: snapshot.id,
      })
    }
    const target = verifyCapsuleRouteTargetPin(revision.targetPin)
    const evidence = verifyCapsuleRouteEvidencePin(revision.evidencePin)
    const limitations = CapsuleSnapshotLimitationsSchema.parse(snapshot.limitations)
    if (
      target.snapshotId !== snapshot.id ||
      target.application.blueprint.name !== blueprint.name ||
      target.application.blueprint.digest !== blueprint.digest ||
      target.assurance.mode !== snapshot.mode ||
      !sameStrings(target.assurance.limitations, limitations)
    ) {
      throw new IncusError('Committed route target does not match its immutable snapshot evidence.', 'API_ERROR', {
        aliasId: record.alias.id,
        revisionId: revision.id,
        snapshotId: snapshot.id,
      })
    }
    const application = blueprint.blueprint.applications.find(
      candidate => candidate.name === target.application.application.name,
    )
    if (!application) {
      throw new IncusError(
        'Committed route target references an unknown historical Blueprint application.',
        'API_ERROR',
        {
          aliasId: record.alias.id,
          revisionId: revision.id,
          applicationName: target.application.application.name,
        },
      )
    }
    const expectedApplication = createCapsuleRouteApplicationPin({
      schemaVersion: target.application.schemaVersion,
      blueprint: createCapsuleBlueprintReference(blueprint),
      application,
    })
    if (expectedApplication.digest !== target.application.digest) {
      throw new IncusError('Committed route application pin does not match the historical Blueprint.', 'API_ERROR', {
        aliasId: record.alias.id,
        revisionId: revision.id,
        applicationName: application.name,
        expectedDigest: expectedApplication.digest,
        actualDigest: target.application.digest,
      })
    }
    return {
      id: revision.id,
      number: revision.number,
      action: revision.action,
      previousRevisionId: revision.previousRevisionId,
      rollbackSourceRevisionId: revision.rollbackSourceRevisionId,
      target: createCapsuleRouteTargetReference(target),
      evidence: {
        schemaVersion: evidence.schemaVersion,
        policyVersion: evidence.policyVersion,
        digest: evidence.digest,
        goldenTestStatus: evidence.goldenTest.status,
        diffReviewStatus: evidence.diffReview.status,
      },
      operationId: revision.operationId,
      committedAt: toIsoTimestamp(revision.committedAt, 'committedAt', {
        entity: 'route revision',
        entityId: revision.id,
      }),
    }
  }
}
