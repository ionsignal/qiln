import path from 'node:path'
import { parseDocument, isMap, isSeq, isScalar, YAMLMap, YAMLSeq } from 'yaml'
import { and, eq, inArray } from 'drizzle-orm'
import {
  CapsuleBranchEventName,
  DEFAULT_CAPSULE_BLUEPRINT_NAME,
  TargetType,
  capsuleBranchesTable,
  type CapsuleBlueprintRegistry,
  type CapsuleBranchStatus,
  type CapsuleChannel,
  type CapsuleCommandAck,
  type CapsuleBranchHostDbContract,
  type TargetOwner,
} from '@qiln/core/server'
import { extractIpv4 } from '../../incus/utils'
import { IncusError, isUniqueConstraintViolation, readIncusErrorDetailCode } from '../../errors'
import { interpolate } from '../../utils/template'
import type { Node, ParsedNode } from 'yaml'
import type { IncusClient } from '../../incus/client/index'
import type { IncusDeviceMap } from '../../schemas/incus'
import type { ProjectService } from '../project'

const SOURCE_PROJECT = 'default'

interface ManagedVolume {
  pool: string
  volumeName: string
  mountPath: string
}

interface ReconcileBranch {
  name: string
  status: CapsuleBranchStatus
}

/**
 * Privileged worker service for capsule branch runtime mutations.
 *
 * Incus still calls these resources "instances", but the persistence boundary
 * now uses capsule branch terminology. This service owns the translation between
 * Qiln capsule branch semantics and privileged Incus/ZFS side effects.
 */
export class CapsuleBranchRuntimeService {
  constructor(
    private readonly db: CapsuleBranchHostDbContract,
    private readonly incus: IncusClient,
    private readonly channel: CapsuleChannel,
    private readonly project: ProjectService,
    private readonly blueprints: CapsuleBlueprintRegistry,
  ) {}

  /**
   * Fetches the list of capsule branches for a specific owner.
   */
  public async list(ownerId: string) {
    return await this.db.query.capsuleBranches.findMany({
      where: { ownerId },
      orderBy: (capsuleBranches, { desc }) => [desc(capsuleBranches.createdAt)],
    })
  }

  /**
   * Fetches the database state of a capsule branch and opportunistically
   * enriches it with the live Incus IPv4 address when the branch is active.
   */
  public async state(ownerId: string, name: string) {
    const branch = await this.db.query.capsuleBranches.findFirst({
      where: { name, ownerId },
    })
    if (!branch) {
      return null
    }
    let ip = branch.runtimeIp
    if (branch.status === 'online' || branch.status === 'starting') {
      try {
        const namespace = this.project.getNamespace(ownerId)
        const project = this.incus.UseProject(namespace)
        const { data: runtime } = await project.instances.state(name)
        ip = extractIpv4(runtime.network) || ip
      } catch {
        console.warn(`[CapsuleBranchRuntimeService] Could not fetch live Incus state for branch '${name}'. Degrading gracefully.`)
      }
    }
    return { ...branch, runtimeIp: ip }
  }

  /**
   * Provisions a new capsule branch using the existing Incus/ZFS saga.
   */
  public async create(
    ownerId: string,
    name: string,
    blueprintName: string = DEFAULT_CAPSULE_BLUEPRINT_NAME,
    cpu: string = '4',
    memory: string = '4GB',
  ): Promise<CapsuleCommandAck> {
    const blueprint = this.blueprints.get(blueprintName)
    if (!blueprint) {
      throw new IncusError(`Capsule blueprint '${blueprintName}' not found.`, 'NOT_FOUND')
    }
    try {
      await this.db.insert(capsuleBranchesTable).values({
        ownerId,
        name,
        blueprintName,
        cpu,
        memory,
        status: 'provisioning',
      })
    } catch (err: unknown) {
      if (isUniqueConstraintViolation(err)) {
        throw new IncusError(`Capsule branch '${name}' already exists.`, 'CONFLICT')
      }
      throw err
    }
    const namespace = this.project.getNamespace(ownerId)
    const project = this.incus.UseProject(namespace)
    const rollbackStack: Array<() => Promise<void>> = []
    const managedVolumes: ManagedVolume[] = []
    try {
      await this.project.ensureNamespace(ownerId)
      this.publishStateChanged(ownerId, name, 'provisioning')

      const dynamicDevices: IncusDeviceMap = {}

      for (const volume of blueprint.provisioning.volumes) {
        const volumeName = `${name}-${volume.name}`

        switch (volume.type) {
          case 'bind':
            dynamicDevices[volume.name] = {
              type: 'disk',
              source: volume.host_path,
              path: volume.mount_path,
              readonly: volume.readonly ? 'true' : 'false',
              shift: volume.shifted ? 'true' : 'false',
            }
            break
          case 'empty':
          case 'clone': {
            const config: Record<string, string> = {}
            if (volume.shifted) {
              config['security.shifted'] = 'true'
            }
            if (volume.type === 'clone') {
              await project.storage.clone(volume.pool, volume.source_volume, volumeName, config, SOURCE_PROJECT)
            } else {
              await project.storage.create(volume.pool, volumeName, config)
            }
            rollbackStack.push(async () => {
              await project.storage.delete(volume.pool, volumeName)
            })
            dynamicDevices[volume.name] = {
              type: 'disk',
              pool: volume.pool,
              source: volumeName,
              path: volume.mount_path,
              readonly: volume.readonly ? 'true' : 'false',
            }
            managedVolumes.push({
              pool: volume.pool,
              volumeName,
              mountPath: volume.mount_path,
            })
            break
          }
        }
      }

      managedVolumes.sort((a, b) => b.mountPath.length - a.mountPath.length)

      const env: Record<string, string> = {
        ...blueprint.instance_template.config,
        'environment.QILN_TENANT_ID': name,
        'limits.cpu': cpu,
        'limits.memory': memory,
      }

      if (managedVolumes.length > 0) {
        const chownCommands = managedVolumes.map(volume => ['chown', '1000:1000', volume.mountPath])
        env['user.vendor-data'] = this.mergeCloudInit(env['user.vendor-data'], chownCommands)
      }

      const devices: IncusDeviceMap = {
        ...blueprint.instance_template.devices,
        ...dynamicDevices,
      }

      await project.instances.create({
        name,
        source: { type: 'image', alias: blueprint.image_alias },
        config: env,
        devices,
      })

      rollbackStack.push(async () => {
        await project.instances.delete(name)
      })

      const interpolationContext = {
        name,
        env,
        limits: {
          cpu,
          memory: {
            raw: memory,
          },
        },
      }

      for (const file of blueprint.provisioning.files) {
        const content = file.content === undefined ? '' : interpolate(file.content, interpolationContext)
        const route = this.resolveFileTarget(file.path, managedVolumes)
        const pushOptions = {
          uid: file.uid,
          gid: file.gid,
          mode: file.mode,
          type: file.type,
        }

        if (route.target === 'volume') {
          await project.storage.files.write(route.pool, route.volumeName, route.internalPath, content, pushOptions)
        } else {
          await project.files.write(name, file.path, content, pushOptions)
        }
      }

      await this.transitionState(ownerId, name, 'offline')
      return { ok: true }
    } catch (error: unknown) {
      console.error(`[CapsuleBranchRuntimeService] Provisioning failed for branch '${name}'. Initiating rollback...`, error)

      while (rollbackStack.length > 0) {
        const rollbackFn = rollbackStack.pop()

        if (!rollbackFn) {
          continue
        }

        try {
          await rollbackFn()
        } catch (rollbackErr: unknown) {
          if (rollbackErr instanceof IncusError && rollbackErr.code === 'NOT_FOUND') {
            continue
          }

          console.error(`[CRITICAL] Zombie Resource Detected: Failed during rollback for branch '${name}':`, rollbackErr)
        }
      }

      try {
        await this.db.delete(capsuleBranchesTable).where(and(eq(capsuleBranchesTable.ownerId, ownerId), eq(capsuleBranchesTable.name, name)))
      } catch (dbErr: unknown) {
        console.error(`[CRITICAL] Ghost Record Detected: Failed to remove DB provisioning lock for branch '${name}':`, dbErr)
      }

      throw error
    }
  }

  /**
   * Starts an existing offline capsule branch.
   */
  public async start(ownerId: string, name: string): Promise<CapsuleCommandAck> {
    const branch = await this.db.query.capsuleBranches.findFirst({
      where: { name, ownerId },
    })

    if (!branch) {
      throw new IncusError('Capsule branch not found or access denied.', 'NOT_FOUND')
    }

    const transitioned = await this.transitionStateWhereStatus(ownerId, name, 'starting', ['offline'])

    if (!transitioned) {
      throw new IncusError('Capsule branch can only be started from the offline state.', 'CONFLICT')
    }

    const namespace = this.project.getNamespace(ownerId)
    const project = this.incus.UseProject(namespace)

    try {
      await project.instances.start(name)

      let ip: string | null = null

      try {
        const { data: state } = await project.instances.state(name)
        ip = extractIpv4(state.network)
      } catch {
        console.warn(
          `[CapsuleBranchRuntimeService] Failed to extract IP for branch '${name}' immediately after start. Will rely on heartbeat/backfill.`,
        )
      }

      await this.transitionState(ownerId, name, 'online', ip)
      return { ok: true }
    } catch (error: unknown) {
      await this.transitionState(ownerId, name, 'offline')
      throw error
    }
  }

  /**
   * Stops an active capsule branch.
   */
  public async stop(ownerId: string, name: string): Promise<CapsuleCommandAck> {
    const branch = await this.db.query.capsuleBranches.findFirst({
      where: { name, ownerId },
    })

    if (!branch) {
      throw new IncusError('Capsule branch not found or access denied.', 'NOT_FOUND')
    }

    const previousStatus = branch.status
    const transitioned = await this.transitionStateWhereStatus(ownerId, name, 'stopping', ['online', 'starting'])

    if (!transitioned) {
      throw new IncusError('Capsule branch can only be stopped while online or starting.', 'CONFLICT')
    }

    const namespace = this.project.getNamespace(ownerId)
    const project = this.incus.UseProject(namespace)

    try {
      await project.instances.stop(name)
      await this.transitionState(ownerId, name, 'offline', null)
      return { ok: true }
    } catch (error: unknown) {
      await this.transitionState(ownerId, name, previousStatus)
      throw error
    }
  }

  /**
   * Permanently deletes a capsule branch and all associated managed ZFS volumes.
   */
  public async delete(ownerId: string, name: string): Promise<CapsuleCommandAck> {
    const branch = await this.db.query.capsuleBranches.findFirst({
      where: { name, ownerId },
    })

    if (!branch) {
      throw new IncusError('Capsule branch not found or access denied.', 'NOT_FOUND')
    }

    if (branch.status === 'provisioning') {
      throw new IncusError('Cannot delete a capsule branch while it is provisioning.', 'CONFLICT')
    }

    const namespace = this.project.getNamespace(ownerId)
    const project = this.incus.UseProject(namespace)
    const volumesToDelete: { pool: string; source: string }[] = []

    await this.transitionState(ownerId, name, 'stopping')

    try {
      const { data } = await project.instances.get(name)

      if (data.devices) {
        for (const device of Object.values(data.devices)) {
          if (device.type === 'disk' && device.path !== '/' && typeof device.source === 'string' && typeof device.pool === 'string') {
            volumesToDelete.push({ pool: device.pool, source: device.source })
          }
        }
      }
    } catch (err: unknown) {
      await this.transitionState(ownerId, name, 'error')

      if (err instanceof IncusError && err.code === 'NOT_FOUND') {
        throw new IncusError('Capsule branch container is missing on the host. Marked for admin review.', 'CONFLICT')
      }

      throw err
    }
    try {
      await project.instances.stop(name)
    } catch (err: unknown) {
      const detailCode = err instanceof IncusError ? readIncusErrorDetailCode(err) : undefined
      if (!(err instanceof IncusError && (err.code === 'NOT_FOUND' || detailCode === 400))) {
        await this.transitionState(ownerId, name, 'error')
        throw err
      }
    }
    try {
      await project.instances.delete(name)
    } catch (err: unknown) {
      if (!(err instanceof IncusError && err.code === 'NOT_FOUND')) {
        await this.transitionState(ownerId, name, 'error')
        throw err
      }
    }
    for (const volume of volumesToDelete) {
      try {
        await project.storage.delete(volume.pool, volume.source)
      } catch (err: unknown) {
        if (!(err instanceof IncusError && err.code === 'NOT_FOUND')) {
          await this.transitionState(ownerId, name, 'error')
          throw err
        }
      }
    }
    await this.db.delete(capsuleBranchesTable).where(and(eq(capsuleBranchesTable.ownerId, ownerId), eq(capsuleBranchesTable.name, name)))
    this.publishDeleted(ownerId, name)
    return { ok: true }
  }

  /**
   * Boot-time self-healing to align Postgres with true Incus state.
   */
  public async reconcile(): Promise<void> {
    const dbBranches = await this.db.query.capsuleBranches.findMany({
      columns: { name: true, ownerId: true, status: true },
    })

    const activeBranches = dbBranches.filter(branch => branch.status !== 'provisioning' && branch.status !== 'error')
    const ownerMap = new Map<string, { ownerId: string; branches: ReconcileBranch[] }>()

    for (const branch of activeBranches) {
      const namespace = this.project.getNamespace(branch.ownerId)
      const entry = ownerMap.get(namespace) ?? {
        ownerId: branch.ownerId,
        branches: [],
      }

      entry.branches.push({
        name: branch.name,
        status: branch.status,
      })

      ownerMap.set(namespace, entry)
    }

    for (const [namespace, entry] of ownerMap.entries()) {
      const project = this.incus.UseProject(namespace)

      try {
        const { data: instances } = await project.instances.list()
        const dbBranchByName = new Map(entry.branches.map(branch => [branch.name, branch]))
        const trackedNames = new Set(entry.branches.map(branch => branch.name))

        const onlineNames = instances.filter(instance => instance.status === 'Running').map(instance => instance.name)
        const offlineNames = instances.filter(instance => instance.status === 'Stopped').map(instance => instance.name)

        for (const onlineName of onlineNames) {
          if (!trackedNames.has(onlineName)) {
            continue
          }

          const current = dbBranchByName.get(onlineName)

          if (current && current.status !== 'online') {
            await this.transitionState(entry.ownerId, onlineName, 'online')
          }
        }

        for (const offlineName of offlineNames) {
          if (!trackedNames.has(offlineName)) {
            continue
          }

          const current = dbBranchByName.get(offlineName)

          if (current && current.status !== 'offline') {
            await this.transitionState(entry.ownerId, offlineName, 'offline', null)
          }
        }
      } catch (err: unknown) {
        console.warn(`[CapsuleBranchRuntimeService] Failed to reconcile owner namespace '${namespace}':`, err)
      }
    }
  }

  private ownerTarget(ownerId: string): TargetOwner {
    return {
      type: TargetType.OWNER,
      id: ownerId,
    }
  }

  private async transitionState(ownerId: string, name: string, status: CapsuleBranchStatus, ip?: string | null): Promise<void> {
    const updateData: {
      status: CapsuleBranchStatus
      runtimeIp?: string | null
      updatedAt: Date
    } = {
      status,
      updatedAt: new Date(),
    }

    if (ip !== undefined) {
      updateData.runtimeIp = ip
    }

    await this.db
      .update(capsuleBranchesTable)
      .set(updateData)
      .where(and(eq(capsuleBranchesTable.ownerId, ownerId), eq(capsuleBranchesTable.name, name)))

    this.publishStateChanged(ownerId, name, status)
  }

  private async transitionStateWhereStatus(
    ownerId: string,
    name: string,
    status: CapsuleBranchStatus,
    allowedStatuses: CapsuleBranchStatus[],
  ): Promise<boolean> {
    if (allowedStatuses.length === 0) {
      return false
    }

    const result = await this.db
      .update(capsuleBranchesTable)
      .set({
        status,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(capsuleBranchesTable.ownerId, ownerId),
          eq(capsuleBranchesTable.name, name),
          inArray(capsuleBranchesTable.status, allowedStatuses),
        ),
      )
      .returning({ id: capsuleBranchesTable.id })

    if (result.length === 0) {
      return false
    }

    this.publishStateChanged(ownerId, name, status)
    return true
  }

  private publishStateChanged(ownerId: string, name: string, status: CapsuleBranchStatus): void {
    void this.channel
      .publish(CapsuleBranchEventName.BRANCH_STATE_CHANGED, {
        type: CapsuleBranchEventName.BRANCH_STATE_CHANGED,
        target: this.ownerTarget(ownerId),
        name,
        status,
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'Unknown event publishing error'
        console.warn(`[CapsuleBranchRuntimeService] Failed to publish state '${status}' for branch '${name}':`, message)
      })
  }

  private publishDeleted(ownerId: string, name: string): void {
    void this.channel
      .publish(CapsuleBranchEventName.BRANCH_DELETED, {
        type: CapsuleBranchEventName.BRANCH_DELETED,
        target: this.ownerTarget(ownerId),
        name,
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'Unknown event publishing error'
        console.warn(`[CapsuleBranchRuntimeService] Failed to publish deletion event for branch '${name}':`, message)
      })
  }

  /**
   * Evaluates a file path against a sorted list of managed volumes to determine
   * if the file should be routed to an offline ZFS volume instead of the rootfs.
   */
  private resolveFileTarget(
    filePath: string,
    managedVolumes: ManagedVolume[],
  ): { target: 'volume'; pool: string; volumeName: string; internalPath: string } | { target: 'instance' } {
    const normalizedFilePath = path.posix.normalize(filePath)

    for (const volume of managedVolumes) {
      const normalizedMountPath = path.posix.normalize(volume.mountPath)
      const relativePath = path.posix.relative(normalizedMountPath, normalizedFilePath)

      if (relativePath === '' || (!relativePath.startsWith('..') && !path.posix.isAbsolute(relativePath))) {
        return {
          target: 'volume',
          pool: volume.pool,
          volumeName: volume.volumeName,
          internalPath: path.posix.join('/', relativePath),
        }
      }
    }

    return { target: 'instance' }
  }

  /**
   * Safely merges new commands into the cloud-init bootcmd array using the YAML AST.
   * This preserves user comments, formatting, and surrounding structure.
   */
  private mergeCloudInit(existingData: string | undefined, commands: string[][]): string {
    if (existingData?.trimStart().startsWith('#!')) {
      throw new IncusError('Cannot merge cloud-init commands into a raw shell script.', 'VALIDATION_ERROR')
    }

    const cleanYaml = existingData ? existingData.replace(/^#cloud-config\s*\n/, '') : ''
    const doc = parseDocument(cleanYaml)

    if (!doc.contents || !isMap(doc.contents)) {
      doc.contents = doc.createNode({}) as unknown as ParsedNode
    }

    const rootMap = doc.contents as YAMLMap<unknown, unknown>

    if (isMap(rootMap)) {
      const rawBootcmd = rootMap.get('bootcmd', true)
      let seqNode: YAMLSeq<Node>

      if (!rawBootcmd) {
        seqNode = doc.createNode([]) as YAMLSeq<Node>
        rootMap.set('bootcmd', seqNode)
      } else if (isScalar(rawBootcmd)) {
        seqNode = doc.createNode([rawBootcmd.value]) as YAMLSeq<Node>
        rootMap.set('bootcmd', seqNode)
      } else if (isSeq(rawBootcmd)) {
        seqNode = rawBootcmd as YAMLSeq<Node>
      } else {
        seqNode = doc.createNode([]) as YAMLSeq<Node>
        rootMap.set('bootcmd', seqNode)
      }

      for (const command of commands) {
        seqNode.items.push(doc.createNode(command) as Node)
      }
    }

    return `#cloud-config\n${String(doc)}`
  }
}
