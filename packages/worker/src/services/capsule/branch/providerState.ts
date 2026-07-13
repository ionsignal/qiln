import { extractIpv4 } from '../../../incus/utils'
import type { IncusClient } from '../../../incus/client/index'
import type { ProjectService } from '../../project'

export type ConfirmedCapsuleBranchRuntimeState =
  | {
      kind: 'confirmed'
      status: 'online'
      runtimeIp: string | null
      providerStatus: 'Running'
    }
  | {
      kind: 'confirmed'
      status: 'offline'
      runtimeIp: null
      providerStatus: 'Stopped'
    }

export interface MissingCapsuleBranchRuntimeState {
  kind: 'missing'
}

export interface UnsupportedCapsuleBranchRuntimeState {
  kind: 'unsupported'
  providerStatus: string
}

export interface UnavailableCapsuleBranchRuntimeState {
  kind: 'unavailable'
  error: unknown
}

export type CapsuleBranchRuntimeObservation =
  | ConfirmedCapsuleBranchRuntimeState
  | MissingCapsuleBranchRuntimeState
  | UnsupportedCapsuleBranchRuntimeState
  | UnavailableCapsuleBranchRuntimeState

/**
 * Reads one branch's live Incus state without mutating either Incus or the
 * durable branch record.
 *
 * Incus-specific status interpretation belongs here so the branch runtime
 * service can operate on a small, explicit provider-observation vocabulary.
 */
export class CapsuleBranchRuntimeObserver {
  constructor(
    private readonly incus: IncusClient,
    private readonly project: ProjectService,
  ) {}

  public async observe(ownerId: string, branchName: string): Promise<CapsuleBranchRuntimeObservation> {
    const namespace = this.project.getNamespace(ownerId)
    const project = this.incus.UseProject(namespace)
    try {
      const { data } = await project.instances.state(branchName)

      if (data.status === 'Running') {
        return {
          kind: 'confirmed',
          status: 'online',
          runtimeIp: extractIpv4(data.network),
          providerStatus: 'Running',
        }
      }
      if (data.status === 'Stopped') {
        return {
          kind: 'confirmed',
          status: 'offline',
          runtimeIp: null,
          providerStatus: 'Stopped',
        }
      }
      return {
        kind: 'unsupported',
        providerStatus: data.status,
      }
    } catch (error: unknown) {
      if (this.isNotFound(error)) {
        return {
          kind: 'missing',
        }
      }
      return {
        kind: 'unavailable',
        error,
      }
    }
  }

  private isNotFound(error: unknown): boolean {
    if (typeof error !== 'object' || error === null || !('code' in error)) {
      return false
    }
    return error.code === 'NOT_FOUND'
  }
}
