import { z, type ZodError } from 'zod'
import { GlobalError, GlobalErrorCode } from '../errors'
import { verifyCapsuleBlueprintPin } from './blueprint'
import { digestCanonicalJsonValue } from './canonical'
import { classifyAbsolutePosixPathRelationship, joinAbsoluteAndRelativePosixPath } from '../schemas/posix'
import {
  CapsuleSnapshotCapturePolicyDigestSchema,
  CapsuleSnapshotCapturePolicyPinBodySchema,
  CapsuleSnapshotCapturePolicyPinSchema,
  CapsuleSnapshotCapturePolicyReferenceSchema,
  type CapsuleSnapshotCapturePolicyArtifactRoot,
  type CapsuleSnapshotCapturePolicyDigest,
  type CapsuleSnapshotCapturePolicyExternalMount,
  type CapsuleSnapshotCapturePolicyGitRepository,
  type CapsuleSnapshotCapturePolicyPin,
  type CapsuleSnapshotCapturePolicyPinBody,
  type CapsuleSnapshotCapturePolicyReference,
} from '../schemas/capsule/snapshot/policy'
import type {
  CapsuleBlueprintArtifactExclusion,
  CapsuleBlueprintArtifactRequiredPath,
  CapsuleBlueprintSnapshotCaptureApplicationCapability,
} from '../schemas/blueprint/capture'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validationDetails(error: ZodError): Record<string, unknown> {
  return {
    validation: z.treeifyError(error),
  }
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

function compareBoolean(left: boolean, right: boolean): number {
  if (left === right) {
    return 0
  }
  return left ? 1 : -1
}

function compareRequiredPaths(
  left: CapsuleBlueprintArtifactRequiredPath,
  right: CapsuleBlueprintArtifactRequiredPath,
): number {
  const pathComparison = compareStableString(left.path, right.path)
  return pathComparison === 0 ? compareStableString(left.type, right.type) : pathComparison
}

function compareExclusions(left: CapsuleBlueprintArtifactExclusion, right: CapsuleBlueprintArtifactExclusion): number {
  const pathComparison = compareStableString(left.path, right.path)
  if (pathComparison !== 0) {
    return pathComparison
  }

  const typeComparison = compareStableString(left.type, right.type)
  if (typeComparison !== 0) {
    return typeComparison
  }

  const reasonComparison = compareStableString(left.reason, right.reason)
  if (reasonComparison !== 0) {
    return reasonComparison
  }

  return compareBoolean(left.required, right.required)
}

function compareArtifactRoots(
  left: CapsuleSnapshotCapturePolicyArtifactRoot,
  right: CapsuleSnapshotCapturePolicyArtifactRoot,
): number {
  return compareStableString(left.id, right.id)
}

function compareExternalMounts(
  left: CapsuleSnapshotCapturePolicyExternalMount,
  right: CapsuleSnapshotCapturePolicyExternalMount,
): number {
  return compareStableString(left.blueprintVolumeName, right.blueprintVolumeName)
}

function compareGitRepositories(
  left: CapsuleSnapshotCapturePolicyGitRepository,
  right: CapsuleSnapshotCapturePolicyGitRepository,
): number {
  return compareStableString(left.id, right.id)
}

function compareApplicationCapabilities(
  left: CapsuleBlueprintSnapshotCaptureApplicationCapability,
  right: CapsuleBlueprintSnapshotCaptureApplicationCapability,
): number {
  return compareStableString(left.application, right.application)
}

/**
 * Recursively freezes validated JSON-compatible capture-policy output.
 *
 * Policy pins become durable immutable evidence. Freezing returned values
 * prevents callers from mutating a verified body after its digest has been
 * checked.
 */
function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item)
    }
    Object.freeze(value)
    return value
  }
  if (isRecord(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child)
    }
    Object.freeze(value)
  }
  return value
}

/**
 * Produces the one canonical ordering for a complete validated capture-policy
 * body. Construction and verification must use this same normalizer so
 * persisted policy evidence has one accepted representation and one accepted
 * digest.
 */
function normalizePolicyBody(body: CapsuleSnapshotCapturePolicyPinBody): CapsuleSnapshotCapturePolicyPinBody {
  const normalized = {
    schemaVersion: body.schemaVersion,
    blueprintName: body.blueprintName,
    blueprintDigest: body.blueprintDigest,
    policyVersion: body.policyVersion,
    artifactRoots: body.artifactRoots
      .map(root => ({
        id: root.id,
        blueprintVolumeName: root.blueprintVolumeName,
        logicalPath: root.logicalPath,
        required: root.required,
        requiredPaths: [...root.requiredPaths].sort(compareRequiredPaths),
        exclusions: [...root.exclusions].sort(compareExclusions),
      }))
      .sort(compareArtifactRoots),
    externalMounts: body.externalMounts
      .map(mount => ({
        blueprintVolumeName: mount.blueprintVolumeName,
        artifactRootId: mount.artifactRootId,
        logicalPath: mount.logicalPath,
        required: mount.required,
        dependency: {
          kind: mount.dependency.kind,
          logicalId: mount.dependency.logicalId,
        },
      }))
      .sort(compareExternalMounts),
    gitRepositories: body.gitRepositories
      .map(repository => ({
        id: repository.id,
        artifactRootId: repository.artifactRootId,
        path: repository.path,
        logicalPath: repository.logicalPath,
        required: repository.required,
      }))
      .sort(compareGitRepositories),
    applicationCapabilities: body.applicationCapabilities
      .map(capability => ({
        application: capability.application,
        support: capability.support,
      }))
      .sort(compareApplicationCapabilities),
  }
  const parsed = CapsuleSnapshotCapturePolicyPinBodySchema.safeParse(normalized)
  if (!parsed.success) {
    throw new GlobalError(
      'Normalized snapshot capture-policy pin body failed validation.',
      GlobalErrorCode.INTERNAL_ERROR,
      validationDetails(parsed.error),
    )
  }
  return parsed.data
}

function digestPolicyBody(body: CapsuleSnapshotCapturePolicyPinBody): CapsuleSnapshotCapturePolicyDigest {
  const digest = digestCanonicalJsonValue(body, {
    context: 'capsule snapshot capture-policy pin',
  })
  const parsed = CapsuleSnapshotCapturePolicyDigestSchema.safeParse(digest)
  if (!parsed.success) {
    throw new GlobalError(
      'Generated snapshot capture-policy digest failed validation.',
      GlobalErrorCode.INTERNAL_ERROR,
      validationDetails(parsed.error),
    )
  }
  return parsed.data
}

function bodyFromPin(pin: CapsuleSnapshotCapturePolicyPin): CapsuleSnapshotCapturePolicyPinBody {
  return {
    schemaVersion: pin.schemaVersion,
    blueprintName: pin.blueprintName,
    blueprintDigest: pin.blueprintDigest,
    policyVersion: pin.policyVersion,
    artifactRoots: pin.artifactRoots,
    externalMounts: pin.externalMounts,
    gitRepositories: pin.gitRepositories,
    applicationCapabilities: pin.applicationCapabilities,
  }
}

/**
 * Derives an immutable, self-contained capture-policy pin from a validated
 * historical capsule blueprint pin.
 *
 * Current registry state is never consulted. Provisioning volume references are
 * resolved to logical paths here so future capture execution can reload all
 * policy input exclusively from PostgreSQL.
 */
export function createCapsuleSnapshotCapturePolicyPin(value: unknown): CapsuleSnapshotCapturePolicyPin {
  const blueprintPin = verifyCapsuleBlueprintPin(value)

  const volumesByName = new Map(
    blueprintPin.blueprint.provisioning.volumes.map(volume => [volume.name, volume] as const),
  )
  const resolvedRoots = blueprintPin.blueprint.snapshot_capture.artifact_roots.map(root => {
    const volume = volumesByName.get(root.volume)
    if (!volume || volume.type === 'bind') {
      throw new GlobalError(
        `Snapshot capture-policy root '${root.id}' could not resolve its managed blueprint volume.`,
        GlobalErrorCode.INTERNAL_ERROR,
        {
          blueprintName: blueprintPin.name,
          artifactRootId: root.id,
          blueprintVolumeName: root.volume,
        },
      )
    }
    return {
      source: root,
      logicalPath: volume.mount_path,
    }
  })
  const artifactRoots = resolvedRoots.map(({ source, logicalPath }) => ({
    id: source.id,
    blueprintVolumeName: source.volume,
    logicalPath,
    required: source.required,
    requiredPaths: source.required_paths,
    exclusions: source.exclusions,
  }))
  const externalMounts = blueprintPin.blueprint.snapshot_capture.external_mounts.map(mount => {
    const volume = volumesByName.get(mount.volume)
    if (!volume || volume.type !== 'bind') {
      throw new GlobalError(
        `Snapshot capture-policy external mount '${mount.volume}' could not resolve its bind volume.`,
        GlobalErrorCode.INTERNAL_ERROR,
        {
          blueprintName: blueprintPin.name,
          blueprintVolumeName: mount.volume,
        },
      )
    }
    const containingRoots = resolvedRoots.filter(
      root => classifyAbsolutePosixPathRelationship(volume.mount_path, root.logicalPath) === 'descendant',
    )
    if (containingRoots.length !== 1) {
      throw new GlobalError(
        `Snapshot capture-policy external mount '${mount.volume}' could not resolve exactly one artifact root.`,
        GlobalErrorCode.INTERNAL_ERROR,
        {
          blueprintName: blueprintPin.name,
          blueprintVolumeName: mount.volume,
          logicalPath: volume.mount_path,
          containingArtifactRootIds: containingRoots.map(root => root.source.id),
        },
      )
    }
    const containingRoot = containingRoots[0]!
    return {
      blueprintVolumeName: mount.volume,
      artifactRootId: containingRoot.source.id,
      logicalPath: volume.mount_path,
      required: mount.required,
      dependency: {
        kind: mount.dependency.kind,
        logicalId: mount.dependency.logical_id,
      },
    }
  })
  const gitRepositories = blueprintPin.blueprint.snapshot_capture.git_repositories.map(repository => {
    const root = artifactRoots.find(candidate => candidate.id === repository.artifact_root_id)
    if (!root) {
      throw new GlobalError(
        `Snapshot capture-policy Git repository '${repository.id}' could not resolve its artifact root.`,
        GlobalErrorCode.INTERNAL_ERROR,
        {
          blueprintName: blueprintPin.name,
          repositoryId: repository.id,
          artifactRootId: repository.artifact_root_id,
        },
      )
    }
    return {
      id: repository.id,
      artifactRootId: repository.artifact_root_id,
      path: repository.path,
      logicalPath: joinAbsoluteAndRelativePosixPath(root.logicalPath, repository.path),
      required: repository.required,
    }
  })
  const rawBody = {
    schemaVersion: 1,
    blueprintName: blueprintPin.name,
    blueprintDigest: blueprintPin.digest,
    policyVersion: blueprintPin.blueprint.snapshot_capture.policy_version,
    artifactRoots,
    externalMounts,
    gitRepositories,
    applicationCapabilities: blueprintPin.blueprint.snapshot_capture.application_capabilities,
  }
  const parsedBody = CapsuleSnapshotCapturePolicyPinBodySchema.safeParse(rawBody)
  if (!parsedBody.success) {
    throw new GlobalError(
      'Generated snapshot capture-policy pin body failed validation.',
      GlobalErrorCode.INTERNAL_ERROR,
      validationDetails(parsedBody.error),
    )
  }
  const normalizedBody = normalizePolicyBody(parsedBody.data)
  const pin = {
    ...normalizedBody,
    digest: digestPolicyBody(normalizedBody),
  }
  const parsedPin = CapsuleSnapshotCapturePolicyPinSchema.safeParse(pin)
  if (!parsedPin.success) {
    throw new GlobalError(
      'Generated snapshot capture-policy pin failed validation.',
      GlobalErrorCode.INTERNAL_ERROR,
      validationDetails(parsedPin.error),
    )
  }
  return deepFreeze(parsedPin.data)
}

/**
 * Validates a persisted capture-policy pin and proves all of the following:
 *
 * - The complete pin satisfies its self-contained semantic contract;
 * - Its body is already in the canonical persisted order;
 * - Its canonical body matches its stored digest.
 *
 * Verification rejects noncanonical evidence rather than silently rewriting it.
 */
export function verifyCapsuleSnapshotCapturePolicyPin(value: unknown): CapsuleSnapshotCapturePolicyPin {
  const parsedPin = CapsuleSnapshotCapturePolicyPinSchema.safeParse(value)
  if (!parsedPin.success) {
    throw new GlobalError(
      'Snapshot capture-policy pin failed validation.',
      GlobalErrorCode.BAD_REQUEST,
      validationDetails(parsedPin.error),
    )
  }
  const parsedBody = CapsuleSnapshotCapturePolicyPinBodySchema.safeParse(bodyFromPin(parsedPin.data))
  if (!parsedBody.success) {
    throw new GlobalError(
      'Snapshot capture-policy pin body failed validation.',
      GlobalErrorCode.BAD_REQUEST,
      validationDetails(parsedBody.error),
    )
  }
  const normalizedBody = normalizePolicyBody(parsedBody.data)
  const suppliedBodyDigest = digestPolicyBody(parsedBody.data)
  const canonicalBodyDigest = digestPolicyBody(normalizedBody)
  if (suppliedBodyDigest !== canonicalBodyDigest) {
    throw new GlobalError('Snapshot capture-policy pin body is not in canonical order.', GlobalErrorCode.CONFLICT, {
      suppliedBodyDigest,
      canonicalBodyDigest,
    })
  }
  if (canonicalBodyDigest !== parsedPin.data.digest) {
    throw new GlobalError(
      'Snapshot capture-policy pin does not match its canonical digest.',
      GlobalErrorCode.CONFLICT,
      {
        expectedDigest: parsedPin.data.digest,
        actualDigest: canonicalBodyDigest,
      },
    )
  }
  const canonicalPin = CapsuleSnapshotCapturePolicyPinSchema.safeParse({
    ...normalizedBody,
    digest: canonicalBodyDigest,
  })
  if (!canonicalPin.success) {
    throw new GlobalError(
      'Verified snapshot capture-policy pin failed canonical validation.',
      GlobalErrorCode.INTERNAL_ERROR,
      validationDetails(canonicalPin.error),
    )
  }
  return deepFreeze(canonicalPin.data)
}

/**
 * Produces the client-safe reference after validating the full server-side pin.
 */
export function createCapsuleSnapshotCapturePolicyReference(value: unknown): CapsuleSnapshotCapturePolicyReference {
  const pin = verifyCapsuleSnapshotCapturePolicyPin(value)
  const reference = CapsuleSnapshotCapturePolicyReferenceSchema.safeParse({
    schemaVersion: pin.schemaVersion,
    digest: pin.digest,
  })
  if (!reference.success) {
    throw new GlobalError(
      'Generated snapshot capture-policy reference failed validation.',
      GlobalErrorCode.INTERNAL_ERROR,
      validationDetails(reference.error),
    )
  }
  return deepFreeze(reference.data)
}
