import { z } from 'zod'
import { AWS_RECORD_VERSION, AWS_SPEC } from '../spec'
import { isInstallerErrorCode, type InstallerErrorCode } from '../../diagnostic/error'
import { operationId, timestamp } from '../../journal/step'
import { sameJson } from '../../json'
import { operatorArn } from '../operator'
import { policyArn } from '../permission/policy'
import { count } from '../primitives'
import { isFingerprint } from '../../transport/ssh/key'
import {
  accountIdSchema,
  identitySchema,
  nameSchema,
  permissionMetadataSchema,
  policyBindingSchema,
  regionSchema,
} from '../types'
import { contains, validCidr, validSource } from './cidr'
import {
  directionOf,
  isAction,
  isKind,
  KIND_IDS,
  receiptPattern,
  resourceCount,
  slotCount,
  type Action,
  type Kind,
} from './graph'
import { shapeOf } from './topology'
import { hostKeySchema } from './ssh/hostkey'
import { hostPlanSchema } from './host/types'
import { ingressSchema, tagsSchema, zoneSchema, type Zone } from './layout'

export type { Ingress, Placement, Tag, Zone } from './layout'

const FAILURE_OUTCOMES = ['unattempted', 'rejected', 'blocked', 'uncertain'] as const
const MAXIMUM_OBSERVED = resourceCount({ zones: AWS_SPEC.deployment.maximumZones, ingress: 0 })

export function requiredTags(operator: string, deploymentId: string) {
  return [
    { Key: 'qiln:operator', Value: operator },
    { Key: 'qiln:deployment', Value: deploymentId },
    { Key: 'qiln:managed-by', Value: 'qiln-cli' },
  ]
}

export function hostKeyName(deploymentId: string): string {
  return `qiln-${deploymentId}`
}

export function isReceipt(action: Action, resourceId: unknown): boolean {
  const pattern = receiptPattern(action)
  return pattern === null ? resourceId === null : typeof resourceId === 'string' && pattern.test(resourceId)
}

const terminationSchema = z.enum(['confirmed', 'unconfirmed'])
const actionSchema = z.custom<Action>(isAction)
const kindSchema = z.custom<Kind>(isKind)

/**
 * Zones are judged structurally: ascending unique placements whose subnets
 * lie inside the VPC network. The subnet prefix policy is deliberately not
 * consulted, so it can change without making stored records unreadable.
 */
function areZonesValid(zones: readonly Zone[], cidr: string): boolean {
  return (
    new Set(zones.map(zone => zone.cidr)).size === zones.length &&
    zones.every((zone, index) => contains(cidr, zone.cidr) && (index === 0 || zone.id > zones[index - 1].id))
  )
}

/**
 * The first rule is the administrator's network and is never the whole
 * internet. Which ports are opened is not judged against today's policy.
 */
function isAdministratorFirst(ingress: readonly { cidr: string }[]): boolean {
  return validSource(ingress[0].cidr)
}

/**
 * Identity of the locally generated administrative key. The fingerprint is the
 * canonical SHA-256 form of the public key. It is the only key evidence that AWS
 * observation compares against, so local key files are never needed to observe
 * or remove AWS resources.
 */
const adminKeySchema = z.strictObject({
  algorithm: z.literal('ed25519'),
  fingerprint: z.string().refine(isFingerprint, 'Expected an unpadded SHA-256 fingerprint.'),
  generatedAt: timestamp,
})

const failureSchema = z.strictObject({
  outcome: z.enum(FAILURE_OUTCOMES),
  code: z.custom<InstallerErrorCode>(isInstallerErrorCode),
  termination: terminationSchema,
  recordedAt: timestamp,
})

const returnedSchema = z.strictObject({
  returnedAt: timestamp,
  resourceId: z.string().nullable(),
})

/**
 * One fenced provider call. The ledger is append-only: `returned`, `failure`,
 * and `verifiedAt` are each set once and never rewritten.
 */
const stepSchema = z
  .strictObject({
    id: operationId,
    action: actionSchema,
    slot: count,
    removal: count.nullable(),
    fencedAt: timestamp,
    returned: returnedSchema.nullable(),
    failure: failureSchema.nullable(),
    verifiedAt: timestamp.nullable(),
  })
  .refine(
    step =>
      (step.removal === null) === (directionOf(step.action) === 'creation') &&
      (step.returned === null || isReceipt(step.action, step.returned.resourceId)) &&
      (step.failure === null || step.failure.outcome !== 'blocked' || directionOf(step.action) === 'removal') &&
      (step.returned === null || step.failure === null) &&
      (step.verifiedAt === null || step.returned !== null),
    'Expected a consistent step.',
  )

/**
 * The root volume and primary interface that AWS created with the instance.
 * No mutation response names them, so they are observation evidence.
 */
const implicitSchema = z.strictObject({
  rootVolumeId: z.string().regex(KIND_IDS.volume),
  interfaceId: z.string().regex(KIND_IDS.interface),
})

const implicitEvidenceSchema = z.strictObject({
  ...implicitSchema.shape,
  observedAt: timestamp,
})

const observedResourceSchema = z
  .strictObject({
    kind: kindSchema,
    id: z.string(),
    state: z.enum(['present', 'absent', 'changed']),
  })
  .refine(({ kind, id }) => KIND_IDS[kind].test(id), 'Expected an ID of the resource kind.')

/**
 * `implicit` is the relationship the instance reported when it was observed
 * present, and null when no single root volume and interface were reported.
 */
export const observationSchema = z.strictObject({
  observedAt: timestamp,
  resources: z.array(observedResourceSchema).max(MAXIMUM_OBSERVED),
  implicit: implicitSchema.nullable(),
})

export const observationsSchema = z.array(observationSchema)

/**
 * Point-in-time AWS status evidence for the recorded instance. Only a passing
 * read is ever retained, so the schema accepts nothing but these literals. It
 * says nothing about reachability, SSH access, or guest state.
 */
export const healthSchema = z.strictObject({
  instanceId: z.string().regex(KIND_IDS.instance),
  checkedAt: timestamp,
  instanceState: z.literal('running'),
  system: z.literal('ok'),
  instance: z.literal('ok'),
  attachedEbs: z.literal('ok'),
})

const removalSchema = z.strictObject({
  approvedAt: timestamp,
  observation: observationSchema,
})

/**
 * The retained data volume of this deployment now belongs to a later
 * deployment, which answers for it. Historical removal evidence is untouched.
 */
const handoffSchema = z.strictObject({
  to: operationId,
  at: timestamp,
})

/**
 * Where the data volume comes from. A new volume is created under an
 * idempotency token. A reused volume is the retained volume of a previous
 * deployment, recorded by identity and by the tags it already carries. This
 * deployment never creates it, so no creation receipt exists for it. Its tags
 * are recorded verbatim, because they are the original creator's and may
 * differ from this deployment's.
 */
const volumeSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('new'),
    token: operationId,
  }),
  z.strictObject({
    kind: z.literal('reuse'),
    from: operationId,
    volumeId: z.string().regex(KIND_IDS.volume),
    tags: tagsSchema,
  }),
])

/**
 * The plan is judged structurally here, and the approval then requires it to
 * agree with its own fields. It is never rebuilt from today's constants. Tokens
 * are UUIDs, well inside the 64-character ClientToken limit. `launchTokens`
 * holds one distinct idempotency token per launch candidate, in the order of
 * the plan's `hostSlots`, and none is shared with a new volume's creation. A
 * reused volume fixes the zone, so it allows exactly one candidate. Each token
 * is sent only with its own attempt.
 */
const hostIntentSchema = z
  .strictObject({
    plan: hostPlanSchema,
    keyName: z.string(),
    launchTokens: z.array(operationId),
    volume: volumeSourceSchema,
  })
  .refine(
    ({ plan, launchTokens, volume }) =>
      launchTokens.length === plan.hostSlots.length &&
      new Set(launchTokens).size === launchTokens.length &&
      (volume.kind === 'reuse' ? launchTokens.length === 1 : !launchTokens.includes(volume.token)),
    'Expected one distinct launch token per launch candidate.',
  )

const approvalSchema = z
  .strictObject({
    approvedAt: timestamp,
    approvedBy: identitySchema,
    cidr: z.string().refine(validCidr, 'Expected a private network CIDR.'),
    tenancy: z.literal('default'),
    zones: z.array(zoneSchema).min(1).max(AWS_SPEC.deployment.maximumZones),
    ingress: z.array(ingressSchema).min(1),
    tags: tagsSchema,
    permission: permissionMetadataSchema,
    host: hostIntentSchema,
  })
  .refine(
    ({ cidr, zones, ingress, host }) =>
      areZonesValid(zones, cidr) &&
      isAdministratorFirst(ingress) &&
      host.plan.cidr === cidr &&
      sameJson(host.plan.zones, zones) &&
      sameJson(host.plan.ingress, ingress),
    'Expected zones, ingress, and the host plan to agree.',
  )

const deploymentBindingSchema = z.strictObject({
  accountId: accountIdSchema,
  operator: identitySchema,
  creationId: operationId,
  foundation: policyBindingSchema,
  region: regionSchema,
})

/**
 * Accounting and recovery evidence, not a resumable checkpoint. Phases,
 * effects, and plans are derived from these facts and never stored. The alias
 * is local metadata and never an AWS tag. `previous` is the immutable ID of the
 * deployment whose alias this one takes over; it is set at approval and never
 * rewritten. `implicit` is set once, by the observation that verifies the
 * launch, and never rewritten. `adminKey` is set once, before any step, and
 * never rewritten or regenerated. `health` is set once, after every creation
 * step is verified and before any removal, in a write that changes nothing
 * else. `hostKey` is set once in the same way, as the server's pinned SSH host
 * key. It is AWS-reported console evidence, not guest attestation, and it is
 * distinct from `adminKey`. `handoff` is set once, in a write that changes
 * nothing else, after removal left the data volume retained and a later
 * deployment took it over.
 *
 * The `version` covers every constant, format rule, and graph declaration
 * order that the schemas and the audit consult, such as the zone limit, tag and
 * key-name formats, the lifecycle invariants of the host plan, the
 * administrative key binding, the health evidence, the host-key pin, and the
 * creation and removal order. Version 1 is the baseline of a one-time
 * disposable development reset, before any release, so no earlier layout has a
 * reader. From the first release, changing any of them needs a version bump
 * and an explicit versioned reader. Records are never migrated silently, and a
 * stored launch plan is judged structurally, never rebuilt from today's
 * compute constants or checked against today's permission ceilings.
 */
export const deploymentSchema = z
  .strictObject({
    version: z.literal(AWS_RECORD_VERSION.deployment),
    id: operationId,
    alias: nameSchema,
    previous: operationId.nullable(),
    connection: nameSchema,
    binding: deploymentBindingSchema,
    approval: approvalSchema,
    adminKey: adminKeySchema.nullable(),
    hostKey: hostKeySchema.nullable(),
    termination: terminationSchema,
    steps: z.array(stepSchema).max(AWS_SPEC.deployment.maximumSteps),
    removals: z.array(removalSchema).max(AWS_SPEC.deployment.maximumSteps),
    implicit: implicitEvidenceSchema.nullable(),
    latest: observationSchema.nullable(),
    health: healthSchema.nullable(),
    handoff: handoffSchema.nullable(),
    createdAt: timestamp,
  })
  .refine(({ id, previous, connection, binding, approval }) => {
    const { host } = approval
    return (
      binding.operator.accountId === binding.accountId &&
      binding.operator.arn === operatorArn(binding.accountId, connection) &&
      binding.foundation.arn === policyArn(binding.accountId, connection, 'foundation') &&
      sameJson(approval.approvedBy, binding.operator) &&
      sameJson(approval.tags, requiredTags(binding.operator.arn, id)) &&
      host.keyName === hostKeyName(id) &&
      host.plan.region === binding.region &&
      previous !== id &&
      (host.volume.kind !== 'reuse' || host.volume.from === previous)
    )
  }, 'Expected evidence bound to its connection and deployment identity.')
  .refine(({ approval, steps, removals }) => {
    const shape = shapeOf(approval)
    return steps.every(
      step => step.slot < slotCount(step.action, shape) && (step.removal === null || step.removal < removals.length),
    )
  }, 'Expected steps within the approved plan.')

export type FailureOutcome = (typeof FAILURE_OUTCOMES)[number]
export type Failure = z.infer<typeof failureSchema>
export type AdminKey = z.infer<typeof adminKeySchema>
export type Step = z.infer<typeof stepSchema>
export type Removal = z.infer<typeof removalSchema>
export type ObservedResource = z.infer<typeof observedResourceSchema>
export type ObservedState = ObservedResource['state']
export type Implicit = z.infer<typeof implicitSchema>
export type ImplicitEvidence = z.infer<typeof implicitEvidenceSchema>
export type Observation = z.infer<typeof observationSchema>
export type Health = z.infer<typeof healthSchema>
export type Handoff = z.infer<typeof handoffSchema>
export type VolumeSource = z.infer<typeof volumeSourceSchema>
export type HostIntent = z.infer<typeof hostIntentSchema>
export type Approval = z.infer<typeof approvalSchema>
export type DeploymentBinding = z.infer<typeof deploymentBindingSchema>
export type Deployment = z.infer<typeof deploymentSchema>
