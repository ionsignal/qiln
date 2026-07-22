import { IncusError, readIncusErrorDetailCode } from '../errors'
import type { IncusClient } from '../incus/client/index'

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
    try {
      await this.incus.projects.get(namespace)
      return
    } catch (err: unknown) {
      if (err instanceof IncusError && err.code === 'NOT_FOUND') {
        // Expected path for new owners; proceed to creation.
      } else {
        throw err
      }
    }
    try {
      await this.incus.projects.create({
        name: namespace,
        description: `Isolated capsule namespace for owner ${ownerId}`,
        config: {
          'features.storage.volumes': 'true',
          'features.images': 'false',
          'features.profiles': 'false',
          'features.networks': 'false',
        },
      })
    } catch (err: unknown) {
      const detailCode = err instanceof IncusError ? readIncusErrorDetailCode(err) : undefined
      if (
        err instanceof IncusError &&
        (err.code === 'CONFLICT' || detailCode === 400 || detailCode === 409 || err.message.includes('exists'))
      ) {
        return
      }
      throw err
    }
  }
}
