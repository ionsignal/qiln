import path from 'node:path'
import { IncusError } from '../errors'
import type { HostDbContract } from '../db'
import type { IncusClient } from '../incus/client/index'
import type { IncusFilePushOptions } from '../incus/client/types'
import type { ProjectService } from './project'

export class FileService {
  private readonly CHROOT_BASE = '/opt/minecraft'

  constructor(
    private readonly db: HostDbContract,
    private readonly incus: IncusClient,
    private readonly project: ProjectService,
  ) {}

  /**
   * Strictly resolves and validates a user-provided path against the chroot jail.
   * Prevents directory traversal attacks (e.g., ../../../etc/shadow).
   */
  private resolveSafePath(userPath: string): string {
    const normalized = path.posix.normalize(userPath)
    const resolved = path.posix.join(this.CHROOT_BASE, normalized)
    if (!resolved.startsWith(this.CHROOT_BASE)) {
      throw new IncusError('Path traversal detected. Access denied.', 'FORBIDDEN')
    }
    return resolved
  }

  /**
   * Verifies the user owns the instance before allowing file operations.
   */
  private async verifyOwnership(ownerId: string, instanceName: string): Promise<void> {
    const instance = await this.db.query.instances.findFirst({
      where: { name: instanceName, ownerId },
      columns: { id: true },
    })
    if (!instance) {
      throw new IncusError('Instance not found or access denied.', 'NOT_FOUND')
    }
  }

  /**
   * Reads a file from the container disk.
   */
  public async read(ownerId: string, instanceName: string, filePath: string): Promise<Uint8Array> {
    await this.verifyOwnership(ownerId, instanceName)
    const safePath = this.resolveSafePath(filePath)
    const namespace = this.project.getNamespace(ownerId)
    const project = this.incus.UseProject(namespace)
    const { data } = await project.files.read(instanceName, safePath)
    return data
  }

  /**
   * Writes a file to the container disk with enforced unprivileged ownership.
   */
  public async write(
    ownerId: string,
    instanceName: string,
    filePath: string,
    content: Uint8Array | string,
    options?: IncusFilePushOptions,
  ): Promise<void> {
    await this.verifyOwnership(ownerId, instanceName)
    const safePath = this.resolveSafePath(filePath)
    // Enforce unprivileged user ownership by default (UID 1000, GID 1000)
    const safeOptions: IncusFilePushOptions = {
      uid: 1000,
      gid: 1000,
      mode: '0600',
      ...options,
    }
    const namespace = this.project.getNamespace(ownerId)
    const project = this.incus.UseProject(namespace)
    await project.files.write(instanceName, safePath, content, safeOptions)
  }

  /**
   * Deletes a file from the container disk.
   */
  public async delete(ownerId: string, instanceName: string, filePath: string): Promise<void> {
    await this.verifyOwnership(ownerId, instanceName)
    const safePath = this.resolveSafePath(filePath)
    const namespace = this.project.getNamespace(ownerId)
    const project = this.incus.UseProject(namespace)
    await project.files.delete(instanceName, safePath)
  }
}
