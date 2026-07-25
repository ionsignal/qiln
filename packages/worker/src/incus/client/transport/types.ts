import type { IncusError } from '../../../errors'

export interface OperationDeadline {
  path: string
  deadlineAt: number
  controller: AbortController
  timer: ReturnType<typeof setTimeout> | null
  operationId: string | null
}

export type OperationSettlement =
  | {
      ok: true
    }
  | {
      ok: false
      error: IncusError
    }

/**
 * Process-local state for one registered asynchronous Incus operation.
 *
 * WebSocket events, HTTP probes, reconnect reconciliation, timeout expiry, and
 * transport shutdown all converge through the transport's guarded settlement
 * path. This state is private transport machinery and must not be used as
 * durable operation authority.
 */
export interface PendingOperation {
  resolve: () => void
  reject: (error: IncusError) => void
  deadlineAt: number
  deadlineTimer: ReturnType<typeof setTimeout>
  probeTimer: ReturnType<typeof setTimeout> | null
  probeInFlight: boolean
  settled: boolean
  abortController: AbortController
  project?: string
  lastProbeError?: string
}
