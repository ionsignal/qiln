import { z, type ZodError } from 'zod'
import { GlobalError, GlobalErrorCode } from '../errors'
import {
  CapsuleRouteMatcherDigestSchema,
  CapsuleRouteMatcherPinSchema,
  CapsuleRouteMatcherSchema,
  type CapsuleRouteMatcher,
  type CapsuleRouteMatcherDigest,
  type CapsuleRouteMatcherPin,
} from '../schemas/capsule/routing/alias'
import {
  CapsuleRouteEvidenceDigestSchema,
  CapsuleRouteEvidencePinBodySchema,
  CapsuleRouteEvidencePinSchema,
  type CapsuleRouteEvidenceDigest,
  type CapsuleRouteEvidencePin,
  type CapsuleRouteEvidencePinBody,
} from '../schemas/capsule/routing/evidence'
import {
  CapsuleRouteConfigurationDigestSchema,
  type CapsuleRouteConfigurationDigest,
} from '../schemas/capsule/routing/provider'
import {
  CapsuleRouteApplicationDigestSchema,
  CapsuleRouteApplicationPinBodySchema,
  CapsuleRouteApplicationPinSchema,
  CapsuleRouteTargetDigestSchema,
  CapsuleRouteTargetPinBodySchema,
  CapsuleRouteTargetPinSchema,
  CapsuleRouteTargetReferenceSchema,
  type CapsuleRouteApplicationDigest,
  type CapsuleRouteApplicationPin,
  type CapsuleRouteApplicationPinBody,
  type CapsuleRouteTargetDigest,
  type CapsuleRouteTargetPin,
  type CapsuleRouteTargetPinBody,
  type CapsuleRouteTargetReference,
} from '../schemas/capsule/routing/target'
import { CapsuleBlueprintApplicationSchema, type CapsuleBlueprintApplication } from '../schemas/blueprint/application'
import { digestCanonicalJsonValue } from './canonical'

function validationDetails(error: ZodError): Record<string, unknown> {
  return {
    validation: z.treeifyError(error),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

function compareActors(
  left: CapsuleRouteEvidencePinBody['authors'][number],
  right: CapsuleRouteEvidencePinBody['authors'][number],
): number {
  const type = compareStableString(left.type, right.type)
  return type === 0 ? compareStableString(left.id, right.id) : type
}

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

function digestRouteValue<TDigest extends string>(
  value: unknown,
  schema: z.ZodType<TDigest>,
  context: string,
): TDigest {
  const digest = digestCanonicalJsonValue(value, {
    context,
  })
  const parsed = schema.safeParse(digest)
  if (!parsed.success) {
    throw new GlobalError(
      `Generated ${context} digest failed validation.`,
      GlobalErrorCode.INTERNAL_ERROR,
      validationDetails(parsed.error),
    )
  }
  return parsed.data
}

function normalizeApplication(value: unknown): CapsuleBlueprintApplication {
  const parsed = CapsuleBlueprintApplicationSchema.safeParse(value)
  if (!parsed.success) {
    throw new GlobalError(
      'Capsule route application failed validation.',
      GlobalErrorCode.BAD_REQUEST,
      validationDetails(parsed.error),
    )
  }
  const normalized = {
    name: parsed.data.name,
    port: parsed.data.port,
    protocol: parsed.data.protocol,
    entrypoint: parsed.data.entrypoint,
    exposure: parsed.data.exposure,
    endpoint: {
      mode: parsed.data.endpoint.mode,
    },
    verification: {
      method: parsed.data.verification.method,
      path: parsed.data.verification.path,
      expected_statuses: [...parsed.data.verification.expected_statuses].sort((left, right) => left - right),
    },
  }
  const validated = CapsuleBlueprintApplicationSchema.safeParse(normalized)
  if (!validated.success) {
    throw new GlobalError(
      'Normalized capsule route application failed validation.',
      GlobalErrorCode.INTERNAL_ERROR,
      validationDetails(validated.error),
    )
  }
  return validated.data
}

function normalizeEvidence(body: CapsuleRouteEvidencePinBody): CapsuleRouteEvidencePinBody {
  const normalized = {
    schemaVersion: body.schemaVersion,
    policyVersion: body.policyVersion,
    authors: [...body.authors].sort(compareActors),
    reviewers: [...body.reviewers].sort(compareActors),
    approvers: [...body.approvers].sort(compareActors),
    goldenTest: body.goldenTest,
    diffReview: body.diffReview,
    risk: {
      actor: body.risk.actor,
      acknowledgedAt: body.risk.acknowledgedAt,
      acceptedLimitations: [...body.risk.acceptedLimitations].sort(compareStableString),
    },
  }
  const parsed = CapsuleRouteEvidencePinBodySchema.safeParse(normalized)

  if (!parsed.success) {
    throw new GlobalError(
      'Normalized capsule route evidence failed validation.',
      GlobalErrorCode.INTERNAL_ERROR,
      validationDetails(parsed.error),
    )
  }

  return parsed.data
}

function applicationBody(pin: CapsuleRouteApplicationPin): CapsuleRouteApplicationPinBody {
  return {
    schemaVersion: pin.schemaVersion,
    blueprint: pin.blueprint,
    application: pin.application,
  }
}

function targetBody(pin: CapsuleRouteTargetPin): CapsuleRouteTargetPinBody {
  return {
    schemaVersion: pin.schemaVersion,
    snapshotId: pin.snapshotId,
    application: pin.application,
    assurance: pin.assurance,
  }
}

function evidenceBody(pin: CapsuleRouteEvidencePin): CapsuleRouteEvidencePinBody {
  return {
    schemaVersion: pin.schemaVersion,
    policyVersion: pin.policyVersion,
    authors: pin.authors,
    reviewers: pin.reviewers,
    approvers: pin.approvers,
    goldenTest: pin.goldenTest,
    diffReview: pin.diffReview,
    risk: pin.risk,
  }
}

export function digestCapsuleRouteConfiguration(value: unknown): CapsuleRouteConfigurationDigest {
  return digestRouteValue<CapsuleRouteConfigurationDigest>(
    value,
    CapsuleRouteConfigurationDigestSchema,
    'capsule route provider configuration',
  )
}

export function createCapsuleRouteMatcherPin(value: unknown): CapsuleRouteMatcherPin {
  const matcher = CapsuleRouteMatcherSchema.safeParse(value)
  if (!matcher.success) {
    throw new GlobalError(
      'Capsule route matcher failed validation.',
      GlobalErrorCode.BAD_REQUEST,
      validationDetails(matcher.error),
    )
  }
  const normalized: CapsuleRouteMatcher = {
    host: matcher.data.host,
    path: matcher.data.path,
    methods: [...matcher.data.methods].sort(compareStableString),
  }
  const pin = CapsuleRouteMatcherPinSchema.safeParse({
    ...normalized,
    digest: digestRouteValue<CapsuleRouteMatcherDigest>(
      normalized,
      CapsuleRouteMatcherDigestSchema,
      'capsule route matcher',
    ),
  })
  if (!pin.success) {
    throw new GlobalError(
      'Generated capsule route matcher pin failed validation.',
      GlobalErrorCode.INTERNAL_ERROR,
      validationDetails(pin.error),
    )
  }
  return deepFreeze(pin.data)
}

export function createCapsuleRouteApplicationPin(value: unknown): CapsuleRouteApplicationPin {
  const body = CapsuleRouteApplicationPinBodySchema.safeParse(value)
  if (!body.success) {
    throw new GlobalError(
      'Capsule route application pin body failed validation.',
      GlobalErrorCode.BAD_REQUEST,
      validationDetails(body.error),
    )
  }
  const normalized: CapsuleRouteApplicationPinBody = {
    schemaVersion: body.data.schemaVersion,
    blueprint: body.data.blueprint,
    application: normalizeApplication(body.data.application),
  }
  const pin = CapsuleRouteApplicationPinSchema.safeParse({
    ...normalized,
    digest: digestRouteValue<CapsuleRouteApplicationDigest>(
      normalized,
      CapsuleRouteApplicationDigestSchema,
      'capsule route application',
    ),
  })
  if (!pin.success) {
    throw new GlobalError(
      'Generated capsule route application pin failed validation.',
      GlobalErrorCode.INTERNAL_ERROR,
      validationDetails(pin.error),
    )
  }
  return deepFreeze(pin.data)
}

export function verifyCapsuleRouteApplicationPin(value: unknown): CapsuleRouteApplicationPin {
  const pin = CapsuleRouteApplicationPinSchema.safeParse(value)
  if (!pin.success) {
    throw new GlobalError(
      'Capsule route application pin failed validation.',
      GlobalErrorCode.BAD_REQUEST,
      validationDetails(pin.error),
    )
  }
  const canonical = createCapsuleRouteApplicationPin(applicationBody(pin.data))
  if (canonical.digest !== pin.data.digest) {
    throw new GlobalError(
      'Capsule route application pin does not match its canonical digest.',
      GlobalErrorCode.CONFLICT,
      {
        expectedDigest: pin.data.digest,
        actualDigest: canonical.digest,
      },
    )
  }
  return canonical
}

export function createCapsuleRouteTargetPin(value: unknown): CapsuleRouteTargetPin {
  const body = CapsuleRouteTargetPinBodySchema.safeParse(value)
  if (!body.success) {
    throw new GlobalError(
      'Capsule route target pin body failed validation.',
      GlobalErrorCode.BAD_REQUEST,
      validationDetails(body.error),
    )
  }
  const application = verifyCapsuleRouteApplicationPin(body.data.application)
  const normalized: CapsuleRouteTargetPinBody = {
    schemaVersion: body.data.schemaVersion,
    snapshotId: body.data.snapshotId,
    application,
    assurance: {
      mode: body.data.assurance.mode,
      limitations: [...body.data.assurance.limitations].sort(compareStableString),
    },
  }
  const pin = CapsuleRouteTargetPinSchema.safeParse({
    ...normalized,
    digest: digestRouteValue<CapsuleRouteTargetDigest>(
      normalized,
      CapsuleRouteTargetDigestSchema,
      'capsule route target',
    ),
  })
  if (!pin.success) {
    throw new GlobalError(
      'Generated capsule route target pin failed validation.',
      GlobalErrorCode.INTERNAL_ERROR,
      validationDetails(pin.error),
    )
  }
  return deepFreeze(pin.data)
}

export function verifyCapsuleRouteTargetPin(value: unknown): CapsuleRouteTargetPin {
  const pin = CapsuleRouteTargetPinSchema.safeParse(value)
  if (!pin.success) {
    throw new GlobalError(
      'Capsule route target pin failed validation.',
      GlobalErrorCode.BAD_REQUEST,
      validationDetails(pin.error),
    )
  }
  const canonical = createCapsuleRouteTargetPin(targetBody(pin.data))
  if (canonical.digest !== pin.data.digest) {
    throw new GlobalError('Capsule route target pin does not match its canonical digest.', GlobalErrorCode.CONFLICT, {
      expectedDigest: pin.data.digest,
      actualDigest: canonical.digest,
    })
  }
  return canonical
}

export function createCapsuleRouteEvidencePin(value: unknown): CapsuleRouteEvidencePin {
  const body = CapsuleRouteEvidencePinBodySchema.safeParse(value)
  if (!body.success) {
    throw new GlobalError(
      'Capsule route evidence pin body failed validation.',
      GlobalErrorCode.BAD_REQUEST,
      validationDetails(body.error),
    )
  }
  const normalized = normalizeEvidence(body.data)
  const pin = CapsuleRouteEvidencePinSchema.safeParse({
    ...normalized,
    digest: digestRouteValue<CapsuleRouteEvidenceDigest>(
      normalized,
      CapsuleRouteEvidenceDigestSchema,
      'capsule route evidence',
    ),
  })
  if (!pin.success) {
    throw new GlobalError(
      'Generated capsule route evidence pin failed validation.',
      GlobalErrorCode.INTERNAL_ERROR,
      validationDetails(pin.error),
    )
  }
  return deepFreeze(pin.data)
}

export function verifyCapsuleRouteEvidencePin(value: unknown): CapsuleRouteEvidencePin {
  const pin = CapsuleRouteEvidencePinSchema.safeParse(value)
  if (!pin.success) {
    throw new GlobalError(
      'Capsule route evidence pin failed validation.',
      GlobalErrorCode.BAD_REQUEST,
      validationDetails(pin.error),
    )
  }
  const canonical = createCapsuleRouteEvidencePin(evidenceBody(pin.data))
  if (canonical.digest !== pin.data.digest) {
    throw new GlobalError('Capsule route evidence pin does not match its canonical digest.', GlobalErrorCode.CONFLICT, {
      expectedDigest: pin.data.digest,
      actualDigest: canonical.digest,
    })
  }
  return canonical
}

export function createCapsuleRouteTargetReference(value: unknown): CapsuleRouteTargetReference {
  const target = verifyCapsuleRouteTargetPin(value)
  const reference = CapsuleRouteTargetReferenceSchema.safeParse({
    schemaVersion: target.schemaVersion,
    digest: target.digest,
    snapshotId: target.snapshotId,
    blueprint: target.application.blueprint,
    applicationName: target.application.application.name,
    assurance: target.assurance,
  })
  if (!reference.success) {
    throw new GlobalError(
      'Generated capsule route target reference failed validation.',
      GlobalErrorCode.INTERNAL_ERROR,
      validationDetails(reference.error),
    )
  }
  return deepFreeze(reference.data)
}
