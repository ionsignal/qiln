import { Buffer } from 'node:buffer'
import { and, eq } from 'drizzle-orm'
import {
  digestSshAuthorizedKeysBytes,
  encodeSshAuthorizedKeys,
  parseSshAuthorizedKeysSyncRequest,
  type CapsulePersistence,
  type CapsuleTables,
  type SshAuthorizedKeysSyncAck,
  type SshAuthorizedKeysSyncRequest,
} from '@qiln/core/server'
import { IncusError } from '../../errors'
import { branchInstanceName } from '../capsule/resource/identity'
import type { IncusInstanceFileMetadata } from '../../incus/client/files'
import type { IncusClient } from '../../incus/client'
import type { ProjectService } from '../project'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

const SSH_AUTHORIZED_KEYS_DIRECTORY = '/etc/ssh/qiln'
const SSH_AUTHORIZED_KEYS_FILE = '/etc/ssh/qiln/authorized_keys'

interface BranchSshRuntimeIdentity {
  branchId: string
  capsuleId: string
  ownerId: string
  instanceName: string
  namespace: string
}

/**
 * Worker-local, non-authoritative branch authorized-key writer.
 *
 * Host grants, keys, fences, tickets, redemption, and relay state remain the
 * only authorization authority. This service only maintains the branch-local
 * defense-in-depth file and stores no synchronization state.
 */
export class SshAuthorizedKeysSyncService<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  private readonly branchWrites = new Map<string, Promise<void>>()

  constructor(
    private readonly persistence: CapsulePersistence<TDatabase, TTables>,
    private readonly incus: IncusClient,
    private readonly projects: ProjectService,
  ) {}

  /**
   * Serializes writes for one branch within this Worker process.
   *
   * A failed predecessor does not prevent a later independently delivered
   * request from running. No retry, reconciliation, or durable ordering state
   * is introduced.
   */
  public async synchronize(requestValue: SshAuthorizedKeysSyncRequest): Promise<SshAuthorizedKeysSyncAck> {
    const request = parseSshAuthorizedKeysSyncRequest(requestValue)
    const predecessor = this.branchWrites.get(request.branchId) ?? Promise.resolve()
    const execution = predecessor
      .catch(() => undefined)
      .then(async () => {
        await this.synchronizeBranch(request)
      })
    let trackedExecution: Promise<void>
    trackedExecution = execution.finally(() => {
      if (this.branchWrites.get(request.branchId) === trackedExecution) {
        this.branchWrites.delete(request.branchId)
      }
    })
    this.branchWrites.set(request.branchId, trackedExecution)
    await trackedExecution
    return {
      ok: true,
    }
  }

  private async synchronizeBranch(request: SshAuthorizedKeysSyncRequest): Promise<void> {
    const branch = await this.resolveBranchRuntimeIdentity(request)
    const encoded = encodeSshAuthorizedKeys(request.keyLines)
    if (encoded.digest !== request.digest) {
      throw new IncusError('SSH authorized-key synchronization digest failed Worker verification.', 'CONFLICT', {
        ownerId: request.ownerId,
        capsuleId: request.capsuleId,
        branchId: request.branchId,
      })
    }
    const project = this.incus.project(branch.namespace)
    await this.preflightStaticSubstrate(project.files, branch)
    await project.files.write(branch.instanceName, SSH_AUTHORIZED_KEYS_FILE, encoded.bytes, {
      uid: 0,
      gid: 0,
      mode: '0600',
      type: 'file',
      write: 'overwrite',
    })
    const readback = await project.files.read(branch.instanceName, SSH_AUTHORIZED_KEYS_FILE)
    this.assertMetadata(readback.metadata, {
      ownerId: branch.ownerId,
      capsuleId: branch.capsuleId,
      branchId: branch.branchId,
      path: SSH_AUTHORIZED_KEYS_FILE,
      expectedType: 'file',
      expectedMode: '0600',
    })
    if (!Buffer.from(readback.data).equals(Buffer.from(encoded.bytes))) {
      throw new IncusError('Branch SSH authorized-key readback did not match the requested bytes.', 'CONFLICT', {
        ownerId: branch.ownerId,
        capsuleId: branch.capsuleId,
        branchId: branch.branchId,
      })
    }
    const readbackDigest = digestSshAuthorizedKeysBytes(readback.data)
    if (readbackDigest !== request.digest) {
      throw new IncusError('Branch SSH authorized-key readback digest verification failed.', 'CONFLICT', {
        ownerId: branch.ownerId,
        capsuleId: branch.capsuleId,
        branchId: branch.branchId,
      })
    }
  }

  private async preflightStaticSubstrate(
    files: ReturnType<IncusClient['project']>['files'],
    branch: BranchSshRuntimeIdentity,
  ): Promise<void> {
    const directory = await files.get(branch.instanceName, SSH_AUTHORIZED_KEYS_DIRECTORY)
    if (directory.type !== 'directory') {
      throw new IncusError('Branch SSH authorized-key directory is not a regular directory.', 'CONFLICT', {
        ownerId: branch.ownerId,
        capsuleId: branch.capsuleId,
        branchId: branch.branchId,
        path: SSH_AUTHORIZED_KEYS_DIRECTORY,
        providerType: directory.type === 'unsupported' ? directory.providerType : directory.type,
      })
    }
    this.assertMetadata(directory.metadata, {
      ownerId: branch.ownerId,
      capsuleId: branch.capsuleId,
      branchId: branch.branchId,
      path: SSH_AUTHORIZED_KEYS_DIRECTORY,
      expectedType: 'directory',
      expectedMode: '0700',
    })
    const authorizedKeys = await files.read(branch.instanceName, SSH_AUTHORIZED_KEYS_FILE)
    this.assertMetadata(authorizedKeys.metadata, {
      ownerId: branch.ownerId,
      capsuleId: branch.capsuleId,
      branchId: branch.branchId,
      path: SSH_AUTHORIZED_KEYS_FILE,
      expectedType: 'file',
      expectedMode: '0600',
    })
  }

  private assertMetadata(
    metadata: IncusInstanceFileMetadata,
    context: {
      ownerId: string
      capsuleId: string
      branchId: string
      path: string
      expectedType: 'file' | 'directory'
      expectedMode: '0600' | '0700'
    },
  ): void {
    if (metadata.uid !== 0 || metadata.gid !== 0 || metadata.mode !== context.expectedMode) {
      throw new IncusError(
        `Branch SSH ${context.expectedType} does not satisfy required root ownership and mode.`,
        'CONFLICT',
        {
          ownerId: context.ownerId,
          capsuleId: context.capsuleId,
          branchId: context.branchId,
          path: context.path,
          expectedUid: 0,
          actualUid: metadata.uid,
          expectedGid: 0,
          actualGid: metadata.gid,
          expectedMode: context.expectedMode,
          actualMode: metadata.mode,
        },
      )
    }
  }

  private async resolveBranchRuntimeIdentity(request: SshAuthorizedKeysSyncRequest): Promise<BranchSshRuntimeIdentity> {
    const { capsules, capsuleBranches } = this.persistence.tables
    const records = await this.persistence.db
      .select({
        branchId: capsuleBranches.id,
        branchOwnerId: capsuleBranches.ownerId,
        branchCapsuleId: capsuleBranches.capsuleId,
        capsuleOwnerId: capsules.ownerId,
      })
      .from(capsuleBranches)
      .innerJoin(capsules, eq(capsules.id, capsuleBranches.capsuleId))
      .where(
        and(
          eq(capsuleBranches.id, request.branchId),
          eq(capsuleBranches.ownerId, request.ownerId),
          eq(capsuleBranches.capsuleId, request.capsuleId),
          eq(capsules.id, request.capsuleId),
          eq(capsules.ownerId, request.ownerId),
        ),
      )
      .limit(2)
    if (records.length !== 1) {
      throw new IncusError('Capsule branch was not found for SSH authorized-key synchronization.', 'NOT_FOUND', {
        ownerId: request.ownerId,
        capsuleId: request.capsuleId,
        branchId: request.branchId,
      })
    }
    const record = records[0]!
    if (
      record.branchOwnerId !== record.capsuleOwnerId ||
      record.branchOwnerId !== request.ownerId ||
      record.branchCapsuleId !== request.capsuleId
    ) {
      throw new IncusError('Capsule branch SSH synchronization identity is inconsistent.', 'CONFLICT', {
        ownerId: request.ownerId,
        capsuleId: request.capsuleId,
        branchId: request.branchId,
      })
    }
    return {
      ownerId: request.ownerId,
      capsuleId: request.capsuleId,
      branchId: request.branchId,
      namespace: this.projects.getNamespace(request.ownerId),
      instanceName: branchInstanceName(request.branchId),
    }
  }
}
