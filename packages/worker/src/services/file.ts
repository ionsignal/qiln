import path from 'node:path'
import { IncusError } from '../errors'
import type { CapsuleBranchHostDbContract } from '@qiln/core/server'
import type { IncusClient } from '../incus/client/index'
import type { IncusFilePushOptions } from '../incus/client/types'
import type { ProjectService } from './project'

export class FileService {
  private readonly CHROOT_BASE = '/workspace'

  constructor(
    private readonly db: CapsuleBranchHostDbContract,
    private readonly incus: IncusClient,
    private readonly project: ProjectService,
  ) {}

  /**
   * Strictly resolves and validates a user-provided path against the capsule
   * workspace root. This prevents traversal attacks such as `../../../etc/shadow`.
   */
  private resolveSafePath(userPath: string): string {
    const normalized = path.posix.normalize(userPath)
    const resolved = path.posix.join(this.CHROOT_BASE, normalized)
    const relative = path.posix.relative(this.CHROOT_BASE, resolved)
    if (relative.startsWith('..') || path.posix.isAbsolute(relative)) {
      throw new IncusError('Path traversal detected. Access denied.', 'FORBIDDEN')
    }
    return resolved
  }

  /**
   * Verifies the owner controls the capsule branch before allowing file operations.
   */
  private async verifyOwnership(ownerId: string, branchName: string): Promise<void> {
    const branch = await this.db.query.capsuleBranches.findFirst({
      where: { name: branchName, ownerId },
      columns: { id: true },
    })
    if (!branch) {
      throw new IncusError('Capsule branch not found or access denied.', 'NOT_FOUND')
    }
  }

  /**
   * Reads a file from the capsule branch container disk.
   */
  public async read(ownerId: string, branchName: string, filePath: string): Promise<Uint8Array> {
    await this.verifyOwnership(ownerId, branchName)
    const safePath = this.resolveSafePath(filePath)
    const namespace = this.project.getNamespace(ownerId)
    const project = this.incus.UseProject(namespace)
    const { data } = await project.files.read(branchName, safePath)
    return data
  }

  /**
   * Writes a file to the capsule branch container disk with enforced unprivileged ownership.
   */
  public async write(
    ownerId: string,
    branchName: string,
    filePath: string,
    content: Uint8Array | string,
    options?: IncusFilePushOptions,
  ): Promise<void> {
    await this.verifyOwnership(ownerId, branchName)
    const safePath = this.resolveSafePath(filePath)
    const safeOptions: IncusFilePushOptions = {
      uid: 1000,
      gid: 1000,
      mode: '0600',
      ...options,
    }
    const namespace = this.project.getNamespace(ownerId)
    const project = this.incus.UseProject(namespace)
    await project.files.write(branchName, safePath, content, safeOptions)
  }

  /**
   * Deletes a file from the capsule branch container disk.
   */
  public async delete(ownerId: string, branchName: string, filePath: string): Promise<void> {
    await this.verifyOwnership(ownerId, branchName)
    const safePath = this.resolveSafePath(filePath)
    const namespace = this.project.getNamespace(ownerId)
    const project = this.incus.UseProject(namespace)
    await project.files.delete(branchName, safePath)
  }
}
