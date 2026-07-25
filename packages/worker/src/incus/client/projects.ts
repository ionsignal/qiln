import { z } from 'zod'
import { IncusError } from '../../errors'
import {
  IncusProjectSchema,
  IncusProjectCreatePayloadSchema,
  type IncusProject,
  type IncusProjectCreatePayload,
} from './schemas/project'
import type { IIncusTransport } from './types'

/**
 * Client to interact with Incus Projects (User Namespaces).
 */
export class IncusProjectsClient {
  constructor(private readonly transport: IIncusTransport) {}

  /**
   * Fetches the list of all projects.
   */
  public async list(): Promise<{ data: IncusProject[]; etag?: string }> {
    const { data, etag } = await this.transport.read('/projects?recursion=1', 'GET')
    const parsed = z.array(IncusProjectSchema).safeParse(data)
    if (!parsed.success) {
      throw new IncusError('Failed to parse Incus project list', 'VALIDATION_ERROR', z.treeifyError(parsed.error))
    }
    return {
      data: parsed.data,
      etag,
    }
  }

  /**
   * Fetches a specific project by name.
   */
  public async get(name: string): Promise<{ data: IncusProject; etag?: string }> {
    const { data, etag } = await this.transport.read(`/projects/${encodeURIComponent(name)}`, 'GET')
    const parsed = IncusProjectSchema.safeParse(data)
    if (!parsed.success) {
      throw new IncusError('Failed to parse Incus project metadata', 'VALIDATION_ERROR', z.treeifyError(parsed.error))
    }
    return {
      data: parsed.data,
      etag,
    }
  }

  /**
   * Creates a new project namespace.
   *
   * Project creation currently expects a synchronous Incus response. A
   * malformed, asynchronous, unreadable, or transport-ambiguous response is
   * classified as an uncertain provider outcome.
   */
  public async create(payload: IncusProjectCreatePayload): Promise<void> {
    const parsed = IncusProjectCreatePayloadSchema.safeParse(payload)
    if (!parsed.success) {
      throw new IncusError('Invalid Incus Project Create Payload', 'VALIDATION_ERROR', z.treeifyError(parsed.error))
    }
    await this.transport.mutate('/projects', 'POST', {
      body: parsed.data,
    })
  }

  /**
   * Deletes a project.
   *
   * Project deletion currently expects a synchronous Incus response. A
   * malformed, asynchronous, unreadable, or transport-ambiguous response is
   * classified as an uncertain provider outcome.
   */
  public async delete(name: string, force: boolean = false): Promise<void> {
    const path = force ? `/projects/${encodeURIComponent(name)}?force=1` : `/projects/${encodeURIComponent(name)}`
    await this.transport.mutate(path, 'DELETE')
  }
}
