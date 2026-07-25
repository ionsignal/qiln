import { z } from 'zod'
import { IncusError } from '../../errors'
import {
  IncusInstanceSchema,
  IncusInstanceCreatePayloadSchema,
  IncusInstancePutSchema,
  IncusInstanceFullSchema,
  type IncusInstance,
  type IncusInstanceCreatePayload,
  type IncusInstancePut,
  type IncusInstanceFull,
} from './schemas/instance'
import { IncusStateSchema, type IncusState } from './schemas/state'
import type { IIncusTransport, IncusListOptions } from './types'

export class IncusInstancesClient {
  constructor(private readonly transport: IIncusTransport) {}

  /**
   * Fetches the current state of a specific instance.
   */
  public async state(name: string): Promise<{ data: IncusState; etag?: string }> {
    const { data, etag } = await this.transport.request(`/instances/${encodeURIComponent(name)}/state`, 'GET')
    const parsed = IncusStateSchema.safeParse(data)
    if (!parsed.success) {
      throw new IncusError('Failed to parse Incus state metadata', 'VALIDATION_ERROR', z.treeifyError(parsed.error))
    }
    return { data: parsed.data, etag }
  }

  /**
   * Fetches the full definition of an instance. Required to safely mutate
   * device maps with ETags.
   */
  public async get(name: string): Promise<{ data: IncusInstanceFull; etag?: string }> {
    const { data, etag } = await this.transport.request(`/instances/${encodeURIComponent(name)}`, 'GET')
    const parsed = IncusInstanceFullSchema.safeParse(data)
    if (!parsed.success) {
      throw new IncusError(
        'Failed to parse Incus instance full metadata',
        'VALIDATION_ERROR',
        z.treeifyError(parsed.error),
      )
    }
    return { data: parsed.data, etag }
  }

  /**
   * Updates the instance definition (e.g., attaching new devices). Strictly
   * requires an ETag to prevent concurrent state mutation.
   */
  public async update(name: string, state: IncusInstancePut, etag: string): Promise<void> {
    const parsed = IncusInstancePutSchema.safeParse(state)
    if (!parsed.success) {
      throw new IncusError('Invalid Incus Instance Put Payload', 'VALIDATION_ERROR', z.treeifyError(parsed.error))
    }
    await this.transport.operation(`/instances/${encodeURIComponent(name)}`, 'PUT', { body: parsed.data, etag })
  }

  /**
   * Provision a new container by cloning a source image.
   */
  public async create(payload: IncusInstanceCreatePayload): Promise<void> {
    const parsed = IncusInstanceCreatePayloadSchema.safeParse(payload)
    if (!parsed.success) {
      throw new IncusError('Invalid Incus Instance Create Payload', 'VALIDATION_ERROR', z.treeifyError(parsed.error))
    }
    await this.transport.operation('/instances', 'POST', { body: parsed.data })
  }

  /**
   * Powers on an existing container.
   */
  public async start(name: string): Promise<void> {
    await this.transport.operation(`/instances/${encodeURIComponent(name)}/state`, 'PUT', { body: { action: 'start' } })
  }

  /**
   * Forces a container to power off.
   */
  public async stop(name: string): Promise<void> {
    await this.transport.operation(`/instances/${encodeURIComponent(name)}/state`, 'PUT', {
      body: { action: 'stop', force: true },
    })
  }

  /**
   * Deletes an existing container.
   */
  public async delete(name: string): Promise<void> {
    await this.transport.operation(`/instances/${encodeURIComponent(name)}`, 'DELETE')
  }

  /**
   * Fetches all instances (used for boot-time reconciliation).
   */
  public async list(options?: IncusListOptions): Promise<{ data: IncusInstance[]; etag?: string }> {
    const params = new URLSearchParams()
    params.append('recursion', '1')
    if (options?.filter) {
      params.append('filter', options.filter)
    }
    const { data, etag } = await this.transport.request(`/instances?${params.toString()}`, 'GET')
    const parsed = z.array(IncusInstanceSchema).safeParse(data)
    if (!parsed.success) {
      throw new IncusError('Failed to parse Incus instance list', 'VALIDATION_ERROR', z.treeifyError(parsed.error))
    }
    return { data: parsed.data, etag }
  }
}
