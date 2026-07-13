import type { BootstrapStepKey } from './stepKeys'
import type { BootstrapFailurePhase } from './failureContext'
import type { BootstrapVolumeResource } from './types'

export interface BootstrapVolumeCompensationTarget {
  kind: 'volume'
  resourceId: string
  resourceKey: string
  pool: string
  volumeName: string
}

export interface BootstrapInstanceCompensationTarget {
  kind: 'instance'
  resourceId: string
  resourceKey: string
  instanceName: string
}

export type BootstrapCompensationTarget = BootstrapVolumeCompensationTarget | BootstrapInstanceCompensationTarget

export interface BootstrapDerivedProvisioningFile {
  resourceId: string
  resourceKey: string
  backingResourceId: string
}

function createVolumeIdentity(pool: string, volumeName: string): string {
  return `${pool}\u0000${volumeName}`
}

/**
 * Tracks only the resources for which the current process has durable ownership proof sufficient to
 * attempt bootstrap compensation.
 *
 * This scope is in-memory operation state, not a second resource ledger. The database remains
 * authoritative for creation and deletion intent/outcome fences, and this scope must never be
 * persisted or used to resume an operation.
 */
export class BootstrapCompensationScope {
  private readonly directTargets: BootstrapCompensationTarget[] = []
  private readonly derivedProvisioningFiles: BootstrapDerivedProvisioningFile[] = []
  private readonly createdVolumeResourceIds = new Map<string, string>()
  private createdInstanceResourceId: string | null = null

  public recordCreatedVolume(resourceId: string, volume: BootstrapVolumeResource): void {
    this.createdVolumeResourceIds.set(createVolumeIdentity(volume.pool, volume.volumeName), resourceId)
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

  public recordDerivedProvisioningFile(file: BootstrapDerivedProvisioningFile): void {
    this.derivedProvisioningFiles.push(file)
  }

  public getCreatedInstanceResourceId(): string | null {
    return this.createdInstanceResourceId
  }

  public getCreatedVolumeResourceId(pool: string, volumeName: string): string | undefined {
    return this.createdVolumeResourceIds.get(createVolumeIdentity(pool, volumeName))
  }

  /**
   * Direct resources are compensated in reverse creation order. For the current
   * bootstrap plan this removes the instance before its managed volumes.
   */
  public listDirectTargetsInCompensationOrder(): readonly BootstrapCompensationTarget[] {
    return [...this.directTargets].reverse()
  }

  public listDerivedProvisioningFiles(): readonly BootstrapDerivedProvisioningFile[] {
    return [...this.derivedProvisioningFiles]
  }
}

/**
 * Ephemeral progress and safety facts for one inline bootstrap execution.
 *
 * Durable operation, step, branch, and resource records remain the source of
 * truth. This state deliberately has no serialization, hydration, retry, skip,
 * checkpoint, or resume behavior.
 */
export class BootstrapExecutionState {
  public readonly compensation = new BootstrapCompensationScope()

  private activeFailurePhase: BootstrapFailurePhase
  private activeStepKey: BootstrapStepKey | null = null
  private offlineBranchFinalized = false
  private providerOwnershipUncertain = false

  constructor(initialPhase: BootstrapFailurePhase) {
    this.activeFailurePhase = initialPhase
  }

  public beginStep(stepKey: BootstrapStepKey): void {
    this.activeFailurePhase = stepKey
    this.activeStepKey = stepKey
  }

  public beginTerminalPhase(phase: BootstrapFailurePhase): void {
    this.activeFailurePhase = phase
    this.activeStepKey = null
  }

  public markOfflineBranchFinalized(): void {
    this.offlineBranchFinalized = true
  }

  public markProviderOwnershipUncertain(): void {
    this.providerOwnershipUncertain = true
  }

  public get currentFailurePhase(): BootstrapFailurePhase {
    return this.activeFailurePhase
  }

  public get currentStepKey(): BootstrapStepKey | null {
    return this.activeStepKey
  }

  public get branchFinalizedOffline(): boolean {
    return this.offlineBranchFinalized
  }

  public get directProviderOwnershipUncertain(): boolean {
    return this.providerOwnershipUncertain
  }
}
