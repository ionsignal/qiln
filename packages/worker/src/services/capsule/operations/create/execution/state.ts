import type { CreatePhase } from './phases'
import type { CreateCapsuleVolumeResource } from '../types'

export interface CreateCapsuleVolumeCompensationTarget {
  kind: 'volume'
  resourceId: string
  resourceKey: string
  pool: string
  volumeName: string
}

export interface CreateCapsuleInstanceCompensationTarget {
  kind: 'instance'
  resourceId: string
  resourceKey: string
  instanceName: string
}

export type CreateCapsuleCompensationTarget =
  CreateCapsuleVolumeCompensationTarget | CreateCapsuleInstanceCompensationTarget

export interface CreateCapsuleDerivedProvisioningFile {
  resourceId: string
  resourceKey: string
  backingResourceId: string
}

function volumeIdentity(pool: string, volumeName: string): string {
  return `${pool}\u0000${volumeName}`
}

/**
 * Same-process compensation scope containing only direct resources whose
 * successful provider creation has also been durably recorded.
 */
export class CreateCapsuleCompensationScope {
  private readonly directTargets: CreateCapsuleCompensationTarget[] = []
  private readonly derivedFiles: CreateCapsuleDerivedProvisioningFile[] = []
  private readonly createdVolumeResourceIds = new Map<string, string>()
  private createdInstanceResourceId: string | null = null

  public recordCreatedVolume(resourceId: string, volume: CreateCapsuleVolumeResource): void {
    this.createdVolumeResourceIds.set(volumeIdentity(volume.pool, volume.volumeName), resourceId)
    this.directTargets.push({
      kind: 'volume',
      resourceId,
      resourceKey: volume.resourceKey,
      pool: volume.pool,
      volumeName: volume.volumeName,
    })
  }

  public recordCreatedInstance(resourceId: string, resourceKey: string, instanceName: string): void {
    this.createdInstanceResourceId = resourceId
    this.directTargets.push({
      kind: 'instance',
      resourceId,
      resourceKey,
      instanceName,
    })
  }

  public recordDerivedProvisioningFile(file: CreateCapsuleDerivedProvisioningFile): void {
    this.derivedFiles.push(file)
  }

  public getCreatedInstanceResourceId(): string | null {
    return this.createdInstanceResourceId
  }

  public getCreatedVolumeResourceId(pool: string, volumeName: string): string | undefined {
    return this.createdVolumeResourceIds.get(volumeIdentity(pool, volumeName))
  }

  public listDirectTargetsInCompensationOrder(): readonly CreateCapsuleCompensationTarget[] {
    return [...this.directTargets].reverse()
  }

  public listDerivedProvisioningFiles(): readonly CreateCapsuleDerivedProvisioningFile[] {
    return [...this.derivedFiles]
  }
}

/**
 * Ephemeral execution facts for one process-local create attempt.
 *
 * This state has no serialization, recovery, replay, or resume behavior.
 * PostgreSQL remains the durable source of truth.
 */
export interface CreateCapsuleExecutionState {
  readonly compensation: CreateCapsuleCompensationScope
  phase: CreatePhase
  providerIntentConfirmed: boolean
  providerOwnershipUncertain: boolean
  completionAttempted: boolean
  completionConfirmed: boolean
}
