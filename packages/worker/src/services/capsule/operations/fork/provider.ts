import { IncusError } from '../../../../errors'
import type { IncusClient } from '../../../../incus/client'
import type { ProjectService } from '../../../project'
import type { CapsuleBranchResourceStore } from '../../resource'
import type { CapsuleResourceDriver } from '../../resource/driver'
import type { ForkExecution } from './types'

export interface ForkProviderDependencies {
  incus: IncusClient
  project: ProjectService
  resources: CapsuleBranchResourceStore
  driver: CapsuleResourceDriver
}

/**
 * Fork provider execution remains unavailable while fork accounting is being
 * reworked to match the current create and destroy evidence model.
 */
export class ForkProvider {
  constructor(_dependencies: ForkProviderDependencies) {}

  public async rootfs(_input: ForkExecution): Promise<void> {
    this.unavailable()
  }

  public async project(_input: ForkExecution): Promise<void> {
    this.unavailable()
  }

  public async binds(_input: ForkExecution): Promise<void> {
    this.unavailable()
  }

  public async volumes(_input: ForkExecution): Promise<void> {
    this.unavailable()
  }

  public async instance(_input: ForkExecution): Promise<void> {
    this.unavailable()
  }

  public async files(_input: ForkExecution): Promise<void> {
    this.unavailable()
  }

  public async verify(_input: ForkExecution): Promise<void> {
    this.unavailable()
  }

  private unavailable(): never {
    throw new IncusError('Capsule forks are temporarily unavailable.', 'CONFLICT')
  }
}
