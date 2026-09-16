import { z } from 'zod'
import { IncusError } from '../../errors'
import { INCUS_FINAL, IncusOperationSchema } from './schemas/response'
import type { IIncusTransport } from './types'

const IncusOperationListSchema = z.record(z.string(), z.array(IncusOperationSchema))
const READ_TIMEOUT_MS = 15_000

/**
 * Observes provider activity without discovering deletion targets or adopting
 * operations for execution.
 *
 * An earlier timed-out create can still finish later. Current resource absence
 * is insufficient while the owner project contains unsettled provider work.
 */
export class IncusOperationsClient {
  constructor(private readonly transport: IIncusTransport) {}

  public async assertIdle(): Promise<void> {
    const { data } = await this.transport.read('/operations?recursion=1', 'GET', {
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    })
    const parsed = IncusOperationListSchema.safeParse(data)
    if (!parsed.success) {
      throw new IncusError('Incus operation activity could not be validated.', 'VALIDATION_ERROR')
    }
    const active = Object.values(parsed.data).flat().filter(operation => !INCUS_FINAL.has(operation.status_code))
    if (active.length > 0) {
      throw new IncusError('Owner project still contains unsettled Incus operations.', 'CONFLICT', {
        operationIds: active.map(operation => operation.id),
        policy: 'absence_does_not_prove_completion_while_provider_work_is_active',
      })
    }
  }
}
