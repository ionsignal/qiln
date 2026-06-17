import path from 'node:path'
import { parseDocument, isMap, isSeq, isScalar, YAMLMap, YAMLSeq } from 'yaml'
import { eq, and, inArray } from 'drizzle-orm'
import { extractIpv4 } from '../incus/utils'
import { librarySchema, type HostDbContract } from '../db'
import { IncusError, isUniqueConstraintViolation } from '../errors'
import { HostEventType } from '../schemas/constants'
import { interpolate } from '../utils/template'
import type { Node, ParsedNode } from 'yaml'
import type { IncusClient } from '../incus/client/index'
import type { HostEventBroker } from '../types'
import type { IncusDeviceMap } from '../schemas/incus'
import type { ProjectService } from './project'
import type { DefinitionRegistryService } from './registry'

// Clone master project currently hardcoded to be `default`,
// we will eventually make this into a project-wide configuration
const SOURCE_PROJECT = 'default'

export class InstanceService {
  constructor(
    private readonly db: HostDbContract,
    private readonly incus: IncusClient,
    private readonly broker: HostEventBroker,
    private readonly project: ProjectService,
    private readonly registry: DefinitionRegistryService,
  ) {}

  /**
   * Helper to safely transition an instance's state.
   *
   * TODO: Look into potentially removing this, instance state should be requested directly from
   * incus using its event system and api, why are we persiting this into the database? Do we
   * really need to track this in the database?
   */
  private async transitionState(
    ownerId: string,
    name: string,
    status: 'provisioning' | 'offline' | 'starting' | 'online' | 'stopping' | 'archived' | 'error',
    ip?: string | null,
  ): Promise<void> {
    const updateData: { status: typeof status; ip?: string | null } = { status }
    if (ip !== undefined) {
      updateData.ip = ip
    }
    await this.db.update(librarySchema.instances).set(updateData).where(eq(librarySchema.instances.name, name))
    this.broker
      .publish(ownerId, {
        type: HostEventType.INSTANCE_STATE,
        ownerId,
        instance: name,
        status,
      })
      .catch(err => console.warn(`[InstanceService] Failed to publish state '${status}' for ${name}:`, err.message))
  }

  /**
   * Evaluates a file path against a sorted list of managed volumes to determine
   * if the file should be routed to an offline ZFS volume instead of the rootfs.
   */
  private resolveFileTarget(
    filePath: string,
    managedVolumes: { pool: string; volumeName: string; mountPath: string }[],
  ): { target: 'volume'; pool: string; volumeName: string; internalPath: string } | { target: 'instance' } {
    const normalizedFilePath = path.posix.normalize(filePath)
    for (const vol of managedVolumes) {
      const normalizedMountPath = path.posix.normalize(vol.mountPath)
      const rel = path.posix.relative(normalizedMountPath, normalizedFilePath)
      if (rel === '' || (!rel.startsWith('..') && !path.posix.isAbsolute(rel))) {
        return {
          target: 'volume',
          pool: vol.pool,
          volumeName: vol.volumeName,
          internalPath: path.posix.join('/', rel),
        }
      }
    }
    return { target: 'instance' }
  }

  /**
   * Safely merges new commands into the cloud-init bootcmd array using the YAML AST.
   * This preserves all user comments, formatting, and surrounding structure.
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
      for (const cmd of commands) {
        seqNode.items.push(doc.createNode(cmd) as Node)
      }
    }
    return `#cloud-config\n${String(doc)}`
  }

  /**
   * Fetches the list of instances for a specific user.
   */
  public async list(ownerId: string) {
    return await this.db.query.instances.findMany({
      where: { ownerId },
      orderBy: (instances, { desc }) => [desc(instances.createdAt)],
    })
  }

  /**
   * Fetches the database state of an instance.
   */
  public async state(ownerId: string, name: string) {
    const instance = await this.db.query.instances.findFirst({
      where: { name, ownerId },
    })
    if (!instance) return null
    let ip = instance.ip
    if (instance.status === 'online' || instance.status === 'starting') {
      try {
        const namespace = this.project.getNamespace(ownerId)
        const project = this.incus.UseProject(namespace)
        const { data: runtime } = await project.instances.state(name)
        ip = extractIpv4(runtime.network) || ip
      } catch (err) {
        console.warn(`[InstanceService] Could not fetch live Incus state for ${name}. Degrading gracefully.`)
      }
    }
    return { ...instance, ip }
  }

  /**
   * Provision a new Incus container using the CSI Saga Pattern.
   * Orchestrates ZFS volume creation, container attachment, and config injection.
   */
  public async create(
    ownerId: string,
    name: string,
    definition: string = 'qiln-n8n-comfyui',
    cpu: string = '4',
    memory: string = '4GB',
  ): Promise<{ success: boolean }> {
    const blueprint = this.registry.get(definition)
    if (!blueprint) {
      throw new IncusError(`App definition '${definition}' not found.`, 'NOT_FOUND')
    }
    try {
      await this.db.insert(librarySchema.instances).values({
        ownerId,
        name,
        definition,
        cpu,
        memory,
        status: 'provisioning',
      })
    } catch (err: unknown) {
      if (isUniqueConstraintViolation(err)) {
        return { success: false }
      }
      throw err
    }
    const namespace = this.project.getNamespace(ownerId)
    const project = this.incus.UseProject(namespace)
    const rollbackStack: Array<() => Promise<void>> = []
    const managedVolumes: { pool: string; volumeName: string; mountPath: string }[] = []
    try {
      await this.project.ensureNamespace(ownerId)
      const dynamicDevices: IncusDeviceMap = {}
      for (const vol of blueprint.provisioning.volumes) {
        const volName = `${name}-${vol.name}`
        switch (vol.type) {
          case 'bind':
            dynamicDevices[vol.name] = {
              type: 'disk',
              source: vol.host_path,
              path: vol.mount_path,
              readonly: vol.readonly ? 'true' : 'false',
              shift: vol.shifted ? 'true' : 'false',
            }
            break
          case 'empty':
          case 'clone': {
            const config: Record<string, string> = {}
            if (vol.shifted) {
              config['security.shifted'] = 'true'
            }
            if (vol.type === 'clone') {
              await project.storage.clone(vol.pool, vol.source_volume, volName, config, SOURCE_PROJECT)
            } else {
              await project.storage.create(vol.pool, volName, config)
            }
            rollbackStack.push(async () => {
              await project.storage.delete(vol.pool, volName)
            })
            dynamicDevices[vol.name] = {
              type: 'disk',
              pool: vol.pool,
              source: volName,
              path: vol.mount_path,
              readonly: vol.readonly ? 'true' : 'false',
            }
            managedVolumes.push({
              pool: vol.pool,
              volumeName: volName,
              mountPath: vol.mount_path,
            })
            break
          }
        }
      }

      // Sort managed volumes by mountPath length descending for Longest-Prefix Match
      managedVolumes.sort((a, b) => b.mountPath.length - a.mountPath.length)

      const env: Record<string, string> = {
        ...blueprint.instance_template.config,
        'environment.QILN_TENANT_ID': name,
        'limits.cpu': cpu,
        'limits.memory': memory,
      }

      if (managedVolumes.length > 0) {
        const chownCommands = managedVolumes.map(vol => ['chown', '1000:1000', vol.mountPath])
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
      const context = {
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
        let content = ''
        if (file.content !== undefined) {
          content = interpolate(file.content, context)
        }
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
      return { success: true }
    } catch (error) {
      console.error(`[InstanceService] Provisioning failed for ${name}. Initiating rollback...`, error)
      while (rollbackStack.length > 0) {
        const rollbackFn = rollbackStack.pop()
        if (rollbackFn) {
          try {
            await rollbackFn()
          } catch (rollbackErr: unknown) {
            if (rollbackErr instanceof IncusError && rollbackErr.code === 'NOT_FOUND') {
              continue // Safe to ignore: The resource was never created
            }
            console.error(`[CRITICAL] Zombie Resource Detected: Failed during rollback for ${name}:`, rollbackErr)
          }
        }
      }
      try {
        await this.db.delete(librarySchema.instances).where(eq(librarySchema.instances.name, name))
      } catch (dbErr) {
        console.error(`[CRITICAL] Ghost Record Detected: Failed to remove DB provisioning lock for ${name}:`, dbErr)
      }
      throw error
    }
  }

  /**
   * Starts an existing offline container.
   */
  public async start(ownerId: string, name: string): Promise<{ success: boolean; reason?: string }> {
    const instance = await this.db.query.instances.findFirst({
      where: { name, ownerId },
    })
    if (!instance) {
      throw new IncusError('Instance not found or access denied.', 'NOT_FOUND')
    }
    const result = await this.db
      .update(librarySchema.instances)
      .set({ status: 'starting' })
      .where(
        and(
          eq(librarySchema.instances.name, name),
          eq(librarySchema.instances.status, 'offline'),
          eq(librarySchema.instances.ownerId, ownerId),
        ),
      )
      .returning()
    if (result.length === 0) {
      return { success: false, reason: 'INVALID_STATE_TRANSITION' }
    }
    const namespace = this.project.getNamespace(ownerId)
    const project = this.incus.UseProject(namespace)
    try {
      await project.instances.start(name)
      let ip: string | null = null
      try {
        const { data: state } = await project.instances.state(name)
        ip = extractIpv4(state.network)
      } catch (e) {
        console.warn(`[InstanceService] Failed to extract IP for ${name} immediately after start. Will rely on heartbeat backfill.`)
      }
      await this.transitionState(ownerId, name, 'online', ip)
      return { success: true }
    } catch (error) {
      await this.transitionState(ownerId, name, 'offline')
      throw error
    }
  }

  /**
   * Stops an active container.
   */
  public async stop(ownerId: string, name: string): Promise<{ success: boolean; reason?: string }> {
    const instance = await this.db.query.instances.findFirst({
      where: { name, ownerId },
    })
    if (!instance) {
      throw new IncusError('Instance not found or access denied.', 'NOT_FOUND')
    }
    const result = await this.db
      .update(librarySchema.instances)
      .set({ status: 'stopping' })
      .where(
        and(
          eq(librarySchema.instances.name, name),
          inArray(librarySchema.instances.status, ['online', 'starting']),
          eq(librarySchema.instances.ownerId, ownerId),
        ),
      )
      .returning()
    if (result.length === 0) {
      return { success: false, reason: 'INVALID_STATE_TRANSITION' }
    }
    const namespace = this.project.getNamespace(ownerId)
    const project = this.incus.UseProject(namespace)
    try {
      await project.instances.stop(name)
      await this.transitionState(ownerId, name, 'offline', null)
      return { success: true }
    } catch (error) {
      await this.transitionState(ownerId, name, 'online')
      throw error
    }
  }

  /**
   * Permanently deletes an instance and all associated ZFS volumes (Full Destruction).
   */
  public async delete(ownerId: string, name: string): Promise<void> {
    const instance = await this.db.query.instances.findFirst({
      where: { name, ownerId },
    })
    if (!instance) {
      throw new IncusError('Instance not found or access denied.', 'NOT_FOUND')
    }
    if (instance.status === 'provisioning') {
      throw new IncusError('Cannot delete an instance while it is provisioning.', 'CONFLICT')
    }
    const namespace = this.project.getNamespace(ownerId)
    const project = this.incus.UseProject(namespace)
    let volumesToDelete: { pool: string; source: string }[] = []
    await this.transitionState(ownerId, name, 'stopping')
    try {
      const { data } = await project.instances.get(name)
      if (data.devices) {
        for (const device of Object.values(data.devices)) {
          if (
            device.type === 'disk' &&
            device.path !== '/' &&
            'source' in device &&
            typeof device.source === 'string' &&
            'pool' in device &&
            typeof device.pool === 'string'
          ) {
            volumesToDelete.push({ pool: device.pool, source: device.source })
          }
        }
      }
    } catch (err: unknown) {
      await this.transitionState(ownerId, name, 'error')
      if (err instanceof IncusError && err.code === 'NOT_FOUND') {
        throw new IncusError('Container missing on host. Marked for admin review.', 'CONFLICT')
      }
      throw err
    }
    try {
      await project.instances.stop(name)
    } catch (err: unknown) {
      if (!(err instanceof IncusError && (err.code === 'NOT_FOUND' || err.details?.code === 400))) {
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
    for (const vol of volumesToDelete) {
      try {
        await project.storage.delete(vol.pool, vol.source)
      } catch (err: unknown) {
        if (!(err instanceof IncusError && err.code === 'NOT_FOUND')) {
          await this.transitionState(ownerId, name, 'error')
          throw err
        }
      }
    }
    await this.db.delete(librarySchema.instances).where(eq(librarySchema.instances.name, name))
    this.broker
      .publish(ownerId, {
        type: HostEventType.INSTANCE_DELETED,
        ownerId,
        instance: name,
      })
      .catch(err => console.warn(`[InstanceService] Failed to publish deletion state for ${name}:`, err.message))
  }

  /**
   * Boot-time self-healing to align Postgres with true Incus state.
   */
  public async reconcile(): Promise<void> {
    const dbInstances = await this.db.query.instances.findMany({
      columns: { name: true, ownerId: true, status: true },
    })
    const activeInstances = dbInstances.filter(i => i.status !== 'provisioning' && i.status !== 'error')
    const userMap = new Map<string, string[]>()
    for (const inst of activeInstances) {
      const namespace = this.project.getNamespace(inst.ownerId)
      if (!userMap.has(namespace)) {
        userMap.set(namespace, [])
      }
      userMap.get(namespace)!.push(inst.name)
    }
    for (const [namespace, instanceNames] of userMap.entries()) {
      const project = this.incus.UseProject(namespace)
      try {
        const { data: instances } = await project.instances.list()
        const onlineNames = instances.filter(i => i.status === 'Running').map(i => i.name)
        const offlineNames = instances.filter(i => i.status === 'Stopped').map(i => i.name)
        const relevantOnline = onlineNames.filter(n => instanceNames.includes(n))
        const relevantOffline = offlineNames.filter(n => instanceNames.includes(n))
        if (relevantOnline.length > 0) {
          await this.db.update(librarySchema.instances).set({ status: 'online' }).where(inArray(librarySchema.instances.name, relevantOnline))
        }
        if (relevantOffline.length > 0) {
          await this.db
            .update(librarySchema.instances)
            .set({ status: 'offline' })
            .where(and(inArray(librarySchema.instances.name, relevantOffline), eq(librarySchema.instances.status, 'online')))
        }
      } catch (err) {
        console.warn(`[InstanceService] Failed to reconcile user ${namespace}:`, err)
      }
    }
  }
}
