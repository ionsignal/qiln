import { eq, and, inArray } from 'drizzle-orm'
import { extractIpv4 } from '../incus/utils'
import { librarySchema, type HostDbContract } from '../db'
import { IncusError, isUniqueConstraintViolation } from '../errors'
import { HostEventType } from '../schemas/constants'
import { interpolate } from '../utils/template'
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
   * Helper to safely strip the 'B' from 'GB'/'MB' to prevent JVM crashes.
   */
  private formatJavaMemory(memory: string): string {
    return memory.replace(/B$/i, '')
  }

  /**
   * Helper to safely transition an instance's state.
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
    definition: string = 'papermc',
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
    try {
      await this.project.ensureNamespace(ownerId)
      const dynamicDevices: IncusDeviceMap = {}
      for (const vol of blueprint.provisioning.volumes) {
        const volName = `${name}-${vol.name}`
        const config: Record<string, string> = {}
        if (vol.shifted) {
          config['security.shifted'] = 'true'
        }
        if (vol.type === 'clone') {
          if (!vol.source_vault) throw new IncusError(`Volume clone requires 'source_vault'`, 'VALIDATION_ERROR')
          await project.storage.clone(vol.pool, vol.source_vault, volName, config, SOURCE_PROJECT)
        } else if (vol.type === 'empty') {
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
        }
      }
      const env: Record<string, string> = {
        ...blueprint.instance_template.config,
        'environment.QILN_TENANT_ID': name,
        'limits.cpu': cpu,
        'limits.memory': memory,
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
            java: this.formatJavaMemory(memory),
          },
        },
      }
      for (const file of blueprint.provisioning.files) {
        const content = interpolate(file.content, context)
        await project.files.write(name, file.path, content, {
          uid: file.uid,
          gid: file.gid,
          mode: file.mode,
        })
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
