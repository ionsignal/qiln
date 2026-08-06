import { z } from 'zod'
import {
  CAPSULE_ROOTFS_IMAGE_PIN_SCHEMA_VERSION,
  CapsuleRootfsImageAliasSchema,
  CapsuleRootfsImagePinSchema,
  CapsuleRootfsImageProjectSchema,
  CapsuleRootfsImageProvider,
  type CapsuleRootfsImagePin,
} from '@qiln/core/server'
import { IncusError } from '../../errors'
import { IncusImageAliasSchema, IncusImageSchema } from './schemas/image'
import type { IncusImage, IncusImageAlias } from './schemas/image'
import type { IIncusTransport } from './types'

export const DEFAULT_INCUS_IMAGE_PROJECT = 'default'

/**
 * Resolves mutable Incus image aliases into immutable rootfs reconstruction
 * pins and verifies exact persisted fingerprints without consulting aliases.
 */
export class IncusImagesClient {
  constructor(private readonly transport: IIncusTransport) {}

  /**
   * Resolves one configured Blueprint image alias at create acceptance.
   *
   * The resulting fingerprint, not the alias, becomes durable rootfs authority
   * for create execution, Snapshot Capture, committed snapshots, and forks.
   */
  public async resolve(alias: string, project: string = DEFAULT_INCUS_IMAGE_PROJECT): Promise<CapsuleRootfsImagePin> {
    const sourceAlias = this.parseAlias(alias)
    const sourceProject = this.parseProject(project)
    const aliasRecord = await this.readAlias(sourceProject, sourceAlias)
    const image = await this.readImage(sourceProject, aliasRecord.target)
    if (image.fingerprint !== aliasRecord.target) {
      throw new IncusError(
        'Incus alias target does not match the fingerprint returned by the resolved image.',
        'CONFLICT',
        {
          project: sourceProject,
          alias: sourceAlias,
          expectedFingerprint: aliasRecord.target,
          actualFingerprint: image.fingerprint,
        },
      )
    }
    return this.parsePin(
      {
        schemaVersion: CAPSULE_ROOTFS_IMAGE_PIN_SCHEMA_VERSION,
        provider: CapsuleRootfsImageProvider.INCUS,
        project: sourceProject,
        fingerprint: image.fingerprint,
        sourceAlias,
      },
      'resolved Incus rootfs image pin',
    )
  }

  /**
   * Positively verifies that one persisted exact image identity remains
   * available. This method never falls back to the pin's historical alias.
   */
  public async verify(value: unknown): Promise<CapsuleRootfsImagePin> {
    const pin = this.parsePin(value, 'persisted Incus rootfs image pin')
    const image = await this.readImage(pin.project, pin.fingerprint)
    if (image.fingerprint !== pin.fingerprint) {
      throw new IncusError(
        'Incus returned an image whose fingerprint does not match the persisted rootfs pin.',
        'CONFLICT',
        {
          project: pin.project,
          expectedFingerprint: pin.fingerprint,
          actualFingerprint: image.fingerprint,
        },
      )
    }
    return pin
  }

  private async readAlias(project: string, alias: string): Promise<IncusImageAlias> {
    const { data } = await this.transport.read(`/images/aliases/${encodeURIComponent(alias)}`, 'GET', {
      project,
    })
    const parsed = IncusImageAliasSchema.safeParse(data)
    if (!parsed.success) {
      throw new IncusError('Failed to parse Incus image alias metadata.', 'VALIDATION_ERROR', {
        project,
        alias,
        validation: z.treeifyError(parsed.error),
      })
    }
    return parsed.data
  }

  private async readImage(project: string, fingerprint: string): Promise<IncusImage> {
    const { data } = await this.transport.read(`/images/${encodeURIComponent(fingerprint)}`, 'GET', {
      project,
    })
    const parsed = IncusImageSchema.safeParse(data)
    if (!parsed.success) {
      throw new IncusError('Failed to parse Incus image metadata.', 'VALIDATION_ERROR', {
        project,
        fingerprint,
        validation: z.treeifyError(parsed.error),
      })
    }
    return parsed.data
  }

  private parseAlias(value: string): string {
    const parsed = CapsuleRootfsImageAliasSchema.safeParse(value)
    if (!parsed.success) {
      throw new IncusError('Invalid Incus rootfs image alias.', 'VALIDATION_ERROR', {
        validation: z.treeifyError(parsed.error),
      })
    }
    return parsed.data
  }

  private parseProject(value: string): string {
    const parsed = CapsuleRootfsImageProjectSchema.safeParse(value)
    if (!parsed.success) {
      throw new IncusError('Invalid Incus rootfs image project.', 'VALIDATION_ERROR', {
        validation: z.treeifyError(parsed.error),
      })
    }
    return parsed.data
  }

  private parsePin(value: unknown, context: string): CapsuleRootfsImagePin {
    const parsed = CapsuleRootfsImagePinSchema.safeParse(value)
    if (!parsed.success) {
      throw new IncusError(`Invalid ${context}.`, 'VALIDATION_ERROR', {
        validation: z.treeifyError(parsed.error),
      })
    }
    return parsed.data
  }
}
