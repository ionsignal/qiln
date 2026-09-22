import { IncusError } from '../errors'
import { isObservedTerminalProviderFailure } from '../incus/client/transport/response'
import type { IncusClient, IncusProject } from '../incus/client'

const REQUIRED_OWNER_PROJECT_CONFIG: Record<string, string> = {
  'features.storage.volumes': 'true',
  'features.images': 'false',
  'features.profiles': 'false',
  'features.networks': 'false',
}

const OWNER_PROJECT_MARKER_VERSION = '1'

function ownershipMarkers(ownerId: string): Record<string, string> {
  return {
    'user.qiln.managed': 'true',
    'user.qiln.owner_id': ownerId,
    'user.qiln.marker_version': OWNER_PROJECT_MARKER_VERSION,
  }
}

export class ProjectService {
  constructor(private readonly incus: IncusClient) {}

  /**
   * Helper to compute the strict owner namespace.
   */
  public getNamespace(ownerId: string): string {
    return `user-${ownerId}`
  }

  /**
   * Proves the exact namespace's current ownership markers.
   *
   * Null requires a validated Incus resource-not-found response. Configuration
   * drift unrelated to ownership is not a reason to reject deletion proof.
   * These markers rely on the privileged Incus control-plane trust boundary.
   */
  public async verify(ownerId: string): Promise<IncusProject | null> {
    const namespace = this.getNamespace(ownerId)
    const project = await this.findNamespace(namespace)
    if (project === null) {
      return null
    }
    this.assertOwnership(namespace, ownerId, project)
    return project
  }

  /**
   * Ensures the owner project exists before provisioning, enforcing strict
   * feature flags to prevent storage bloat and preserve capsule branch
   * isolation.
   */
  public async ensureNamespace(ownerId: string): Promise<void> {
    const namespace = this.getNamespace(ownerId)
    const existing = await this.verify(ownerId)
    if (existing) {
      this.assertNamespaceConfiguration(namespace, existing)
      return
    }
    try {
      await this.incus.projects.create({
        name: namespace,
        description: `Isolated capsule namespace for owner ${ownerId}`,
        config: {
          ...REQUIRED_OWNER_PROJECT_CONFIG,
          ...ownershipMarkers(ownerId),
        },
      })
    } catch (error: unknown) {
      if (!isObservedTerminalProviderFailure(error) || error.code !== 'CONFLICT') {
        throw error
      }
    }
    const confirmed = await this.verify(ownerId)
    if (!confirmed) {
      throw new IncusError('Owner namespace was not found after creation or conflict reconciliation.', 'CONFLICT', {
        namespace,
      })
    }
    this.assertNamespaceConfiguration(namespace, confirmed)
  }

  private async findNamespace(namespace: string): Promise<IncusProject | null> {
    try {
      const { data } = await this.incus.projects.get(namespace)
      return data
    } catch (error: unknown) {
      if (isObservedTerminalProviderFailure(error) && error.code === 'NOT_FOUND') {
        return null
      }
      throw error
    }
  }

  private assertOwnership(namespace: string, ownerId: string, project: IncusProject): void {
    if (project.name !== namespace) {
      throw new IncusError('Incus returned an owner namespace with an unexpected project identity.', 'CONFLICT', {
        expectedNamespace: namespace,
        actualNamespace: project.name,
      })
    }
    const config = project.config ?? {}
    const missingOrMismatched = Object.entries(ownershipMarkers(ownerId))
      .filter(([key, expected]) => config[key] !== expected)
      .map(([key]) => key)
    if (missingOrMismatched.length > 0) {
      throw new IncusError(
        'Owner namespace lacks matching Qiln ownership markers. Operator verification is required.',
        'CONFLICT',
        {
          namespace,
          ownerId,
          markerKeys: missingOrMismatched,
          policy: 'never_silently_adopt_unmarked_owner_namespace',
        },
      )
    }
  }

  private assertNamespaceConfiguration(namespace: string, project: IncusProject): void {
    const config = project.config ?? {}
    const mismatches = Object.entries(REQUIRED_OWNER_PROJECT_CONFIG).flatMap(([key, expected]) => {
      const actual = config[key]
      return actual === expected
        ? []
        : [
            {
              key,
              expected,
              actual: actual ?? null,
            },
          ]
    })
    if (mismatches.length === 0) {
      return
    }
    throw new IncusError('Owner namespace does not satisfy Qiln required isolation configuration.', 'CONFLICT', {
      namespace,
      mismatches,
    })
  }
}
