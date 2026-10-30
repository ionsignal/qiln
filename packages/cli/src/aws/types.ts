import { z } from 'zod'
import { AWS_RECORD_VERSION } from './spec'
import { operationId, timestamp } from '../journal/step'
import { POLICY_PATH, bindingEntries, enrolledKeys, type PolicyKey } from './permission/keys'

export type LoginFlow = 'browser' | 'remote'

export function validName(value: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,47}$/.test(value)
}

export function validRegion(value: string): boolean {
  return /^(af|ap|ca|eu|il|me|mx|sa|us)-[a-z]+-[1-9][0-9]*$/.test(value)
}

export function isAccountId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9]{12}$/.test(value)
}

/**
 * Identity inputs abort further validation, so cross-field refinements that
 * derive ARNs from them never run on an invalid account or name.
 */
export const accountIdSchema = z.string().refine(isAccountId, { message: 'Expected an account ID.', abort: true })
export const nameSchema = z.string().refine(validName, { message: 'Expected a name.', abort: true })
export const regionSchema = z.string().refine(validRegion, 'Expected a region.')

export const identitySchema = z
  .strictObject({
    accountId: accountIdSchema,
    arn: z.string(),
    userId: z.string().regex(/^[A-Za-z0-9]{1,128}$/),
  })
  .refine(
    ({ accountId, arn }) => /^arn:aws:iam::([0-9]{12}):user\/[A-Za-z0-9+=,.@_/-]+$/.exec(arn)?.[1] === accountId,
    'Expected a user ARN in the account.',
  )

export const authenticationSchema = z.strictObject({
  identity: identitySchema,
  expiresAt: timestamp,
})

export const policyBindingSchema = z.strictObject({
  arn: z.string().regex(/^arn:aws:iam::[0-9]{12}:policy\/[A-Za-z0-9+=,.@_/-]+$/),
  id: z.string().regex(/^[A-Za-z0-9]{1,128}$/),
})

const policyVerificationSchema = z.strictObject({
  policyVersion: z.string().regex(/^v[1-9][0-9]{0,9}$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
})

/**
 * Durable records tolerate key-set growth: `foundation` is required, and any
 * other present key must be a known one.
 */
function policyBindingsSchemaOf<Entry extends z.ZodType>(entry: Entry) {
  return z.strictObject({
    foundation: entry,
    compute: entry.optional(),
  } satisfies Record<PolicyKey, z.ZodType>)
}

/**
 * Last verification remains readable when permission requirements or tooling
 * pins change. It is metadata, not a reconstruction of historical authority.
 */
export const permissionMetadataSchema = z.strictObject({
  version: z.int().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  policies: policyBindingsSchemaOf(policyVerificationSchema),
  verifiedAt: timestamp,
})

export const managedOperatorSchema = z
  .strictObject({
    creationId: operationId,
    deploymentRegion: regionSchema,
    policies: policyBindingsSchemaOf(policyBindingSchema),
    verified: permissionMetadataSchema,
  })
  .refine(
    ({ policies, verified }) => enrolledKeys(policies).join() === enrolledKeys(verified.policies).join(),
    'Expected the verification to cover the enrolled policies.',
  )

/**
 * The ARN checks apply only to managed connections, so an unmanaged connection
 * keeps its identity unchecked here.
 */
export const connectionSchema = z
  .strictObject({
    version: z.literal(AWS_RECORD_VERSION.connection),
    name: nameSchema,
    region: regionSchema,
    identity: identitySchema,
    createdAt: timestamp,
    managed: managedOperatorSchema.nullable(),
  })
  .refine(({ name, identity, managed }) => {
    if (managed === null) {
      return true
    }
    const operatorName = `qiln-${name}`
    return (
      identity.arn === `arn:aws:iam::${identity.accountId}:user/qiln/operators/${operatorName}` &&
      bindingEntries(managed.policies).every(
        ([key, policy]) => policy.arn === `arn:aws:iam::${identity.accountId}:policy${POLICY_PATH}${operatorName}-${key}`,
      )
    )
  }, 'Expected Qiln-owned operator and policy ARNs.')

export type AwsIdentity = z.infer<typeof identitySchema>
export type AwsAuthentication = z.infer<typeof authenticationSchema>
export type PolicyBinding = z.infer<typeof policyBindingSchema>
export type PolicyVerification = z.infer<typeof policyVerificationSchema>

/**
 * `sha256` is the digest of the complete verified set. Each policy keeps its own
 * verified default version and document digest beside it. Keys added after a
 * verification are absent until a later verification enrolls them.
 */
export type PermissionMetadata = z.infer<typeof permissionMetadataSchema>

/**
 * `deploymentRegion` is the immutable concrete deployment target. It is
 * independent of the editable login default in `AwsConnection.region`.
 */
export type ManagedOperator = z.infer<typeof managedOperatorSchema>
export type AwsConnection = z.infer<typeof connectionSchema>
