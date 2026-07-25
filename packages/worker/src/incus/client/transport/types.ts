import type { IncusError } from '../../../errors'
import type { IncusOperation } from '../schemas/response'

export interface IncusEndpoints {
  baseUrl: string
  eventUrl: string
  socketPath?: string
}

export interface OperationAttempt {
  path: string
  deadlineAt: number
  controller: AbortController
  timer: ReturnType<typeof setTimeout> | null
  operationId: string | null
}

export interface PendingOperation {
  attempt: OperationAttempt
  resolve: () => void
  reject: (error: IncusError) => void
  probeTimer: ReturnType<typeof setTimeout> | null
  probeInFlight: boolean
  settled: boolean
  project?: string
  lastProbeError?: string
}

export type OperationSettlement =
  | {
      ok: true
    }
  | {
      ok: false
      error: IncusError
    }

export type OperationProbe = (operationId: string, project: string | undefined, signal: AbortSignal) => Promise<unknown>
export type OperationObserver = (operation: IncusOperation) => void
