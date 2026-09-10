import { z } from 'zod'

export const CAPSULE_SNAPSHOT_POLICY_VERSION = 1 as const

export const CapsuleBlueprintInstanceRootfsMode = {
  REBUILDABLE: 'rebuildable',
} as const

export type CapsuleBlueprintInstanceRootfsMode =
  (typeof CapsuleBlueprintInstanceRootfsMode)[keyof typeof CapsuleBlueprintInstanceRootfsMode]

export const CapsuleBlueprintInstanceRootfsModeValues = [CapsuleBlueprintInstanceRootfsMode.REBUILDABLE] as const
export const CapsuleBlueprintInstanceRootfsModeSchema = z.enum(CapsuleBlueprintInstanceRootfsModeValues)

/**
 * Declares the rootfs reconstruction boundary.
 *
 * A fork recreates the instance from the exact rootfs image pin and historical
 * Blueprint configuration. Mutable rootfs changes are not preserved; durable
 * branch state must live in Qiln-managed volumes.
 */
export const CapsuleBlueprintInstanceRootfsSchema = z
  .object({
    mode: z.literal(CapsuleBlueprintInstanceRootfsMode.REBUILDABLE),
  })
  .strict()

/**
 * Minimal Blueprint configuration for Create Snapshot.
 *
 * Every managed clone or empty volume is implicitly included. Bind mounts
 * remain unversioned external configuration and are reattached during fork
 * without claiming historical contents or availability.
 *
 * This configuration remains inside the complete historical Blueprint pin.
 * There is no separate snapshot-policy pin or digest.
 */
export const CapsuleBlueprintSnapshotSchema = z
  .object({
    policy_version: z.literal(CAPSULE_SNAPSHOT_POLICY_VERSION),
    instance_rootfs: CapsuleBlueprintInstanceRootfsSchema,
  })
  .strict()

export type CapsuleBlueprintInstanceRootfs = z.infer<typeof CapsuleBlueprintInstanceRootfsSchema>
export type CapsuleBlueprintSnapshot = z.infer<typeof CapsuleBlueprintSnapshotSchema>
