import { IncusError } from '../errors'
import type { IncusClient } from '../incus/client/index'

export class ProjectService {
  constructor(private readonly incus: IncusClient) {}

  /**
   * Helper to compute the strict user namespace
   */
  public getNamespace(ownerId: string): string {
    return `user-${ownerId}`
  }

  /**
   * Ensures the user project exists before provisioning, enforcing strict feature flags
   * to prevent storage bloat and ensure isolation.
   */
  public async ensureNamespace(ownerId: string): Promise<void> {
    const namespace = this.getNamespace(ownerId)
    try {
      await this.incus.projects.get(namespace)
      return // Project exists, we are good to go
    } catch (err: unknown) {
      if (err instanceof IncusError && err.code === 'NOT_FOUND') {
        // Expected path for new tenants; proceed to creation
      } else {
        // Rethrow critical transport or auth errors
        throw err
      }
    }
    try {
      await this.incus.projects.create({
        name: namespace,
        description: `Isolated namespace for user ${ownerId}`,
        config: {
          'features.storage.volumes': 'true', // Allow custom ZFS volumes for world/plugins
          'features.images': 'false', // Share the host's image cache to save NVMe space
          'features.profiles': 'false', // Prevent tenant-specific profiles; use global
          'features.networks': 'false', // Prevent tenant-specific networks; use incusbr0
        },
      })
    } catch (err: unknown) {
      if (
        err instanceof IncusError &&
        (err.code === 'CONFLICT' || err.details?.code === 400 || err.details?.code === 409 || err.message.includes('exists'))
      ) {
        return
      }
      throw err
    }
  }
}
