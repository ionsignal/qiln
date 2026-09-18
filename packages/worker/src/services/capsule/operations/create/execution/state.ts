import type { CapsuleCreatePhase } from './phases'
import type { CapsuleCreateResourceInput, CapsuleCreateVolumeResource } from '../resource/types'

export interface CapsuleCreateVolumeCompensationTarget {
  kind: 'volume'
  resourceId: string
  resourceKey: string
  resource: CapsuleCreateResourceInput
  pool: string
  volumeName: string
}

export interface CapsuleCreateInstanceCompensationTarget {
  kind: 'instance'
  resourceId: string
  resourceKey: string
  resource: CapsuleCreateResourceInput
  instanceName: string
}

export type CapsuleCreateCompensationTarget =
  | CapsuleCreateVolumeCompensationTarget
  | CapsuleCreateInstanceCompensationTarget

export interface CapsuleCreateDerivedProvisioningFile {
  resourceId: string
  resourceKey: string
  resource: CapsuleCreateResourceInput
  backingResourceId: string
}

function volumeIdentity(pool: string, volumeName: string): string {
  return `${pool}\u0000${volumeName}`
}

/**
 * Same-process compensation scope containing only direct resources whose
 * successful provider creation has also been durably recorded.
 */
export class CapsuleCreateCompensationScope {
  private readonly directTargets: CapsuleCreateCompensationTarget[] = []
  private readonly derivedFiles: CapsuleCreateDerivedProvisioningFile[] = []
  private readonly createdVolumeResourceIds = new Map<string, string>()
  private createdInstanceResourceId: string | null = null

  public recordCreatedVolume(
    resourceId: string,
    resource: CapsuleCreateResourceInput,
    volume: CapsuleCreateVolumeResource,
  ): void {
    this.createdVolumeResourceIds.set(volumeIdentity(volume.pool, volume.volumeName), resourceId)
    this.directTargets.push({
      kind: 'volume',
      resourceId,
      resourceKey: volume.resourceKey,
      resource,
      pool: volume.pool,
      volumeName: volume.volumeName,
    })
  }

  public recordCreatedInstance(resourceId: string, resource: CapsuleCreateResourceInput, instanceName: string): void {
    this.createdInstanceResourceId = resourceId
    this.directTargets.push({
      kind: 'instance',
      resourceId,
      resourceKey: resource.resourceKey,
      resource,
      instanceName,
    })
  }

  public recordDerivedProvisioningFile(file: CapsuleCreateDerivedProvisioningFile): void {
    this.derivedFiles.push(file)
  }

  public getCreatedInstanceResourceId(): string | null {
    return this.createdInstanceResourceId
  }

  public getCreatedVolumeResourceId(pool: string, volumeName: string): string | undefined {
    return this.createdVolumeResourceIds.get(volumeIdentity(pool, volumeName))
  }

  public listDirectTargetsInCompensationOrder(): readonly CapsuleCreateCompensationTarget[] {
    return [...this.directTargets].reverse()
  }

  public listDerivedProvisioningFiles(): readonly CapsuleCreateDerivedProvisioningFile[] {
    return [...this.derivedFiles]
  }
}

/**
 * Ephemeral execution facts for one process-local create attempt.
 *
 * This state has no serialization, recovery, replay, or resume behavior.
 * PostgreSQL remains the durable source of truth.
 */
export interface CapsuleCreateExecutionState {
  readonly compensation: CapsuleCreateCompensationScope
  phase: CapsuleCreatePhase
  providerIntentConfirmed: boolean
  providerOwnershipUncertain: boolean
  completionAttempted: boolean
  completionConfirmed: boolean
}
