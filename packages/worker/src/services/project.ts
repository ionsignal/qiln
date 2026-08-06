import { IncusError } from '../errors'
import type { IncusClient, IncusProject } from '../incus/client'

const REQUIRED_OWNER_PROJECT_CONFIG: Record<string, string> = {
  'features.storage.volumes': 'true',
  'features.images': 'false',
  'features.profiles': 'false',
  'features.networks': 'false',
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
   * Ensures the owner project exists before provisioning, enforcing strict
   * feature flags to prevent storage bloat and preserve capsule branch
   * isolation.
   */
  public async ensureNamespace(ownerId: string): Promise<void> {
    const namespace = this.getNamespace(ownerId)
    const exists = await this.findNamespace(namespace)
    if (exists) {
      this.assertNamespaceConfiguration(namespace, exists)
      return
    }
    try {
      await this.incus.projects.create({
        name: namespace,
        description: `Isolated capsule namespace for owner ${ownerId}`,
        config: REQUIRED_OWNER_PROJECT_CONFIG,
      })
      return
    } catch (error: unknown) {
      if (!(error instanceof IncusError && error.code === 'CONFLICT')) {
        throw error
      }
    }
    const reconciled = await this.findNamespace(namespace)
    if (!reconciled) {
      throw new IncusError('Owner namespace was not found after conflict reconciliation.', 'CONFLICT', {
        namespace,
      })
    }
    this.assertNamespaceConfiguration(namespace, reconciled)
  }

  private async findNamespace(namespace: string): Promise<IncusProject | null> {
    try {
      const { data } = await this.incus.projects.get(namespace)
      return data
    } catch (error: unknown) {
      if (error instanceof IncusError && error.code === 'NOT_FOUND') {
        return null
      }
      throw error
    }
  }

  private assertNamespaceConfiguration(namespace: string, project: IncusProject): void {
    if (project.name !== namespace) {
      throw new IncusError('Incus returned an owner namespace with an unexpected project identity.', 'CONFLICT', {
        expectedNamespace: namespace,
        actualNamespace: project.name,
      })
    }
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

    /*
     * TODO(owner-project-provenance): Configuration validation prevents a
     * same-name project with incorrect isolation settings from receiving
     * capsule resources, but it cannot prove that an otherwise matching
     * project was created and remains managed by Qiln. Add and verify a
     * Qiln-owned project marker before treating an existing project as owned.
     */
    throw new IncusError('Owner namespace does not satisfy Qiln required isolation configuration.', 'CONFLICT', {
      namespace,
      mismatches,
    })
  }
}
