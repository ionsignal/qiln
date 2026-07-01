import { provideCapsules, useCapsuleContext, type CapsuleBranchClient, type CapsuleContext } from './useCapsules'
import type { Ref } from 'vue'
import type { CapsuleBranchItem } from '../types'

export type HostInstanceClient = CapsuleBranchClient

export interface UseInstancesOptions {
  client: CapsuleBranchClient
  instances: Ref<CapsuleBranchItem[]>
  onError?: (err: Error) => void
  onEventStream: (handler: (rawEvent: unknown) => void) => { unsubscribe: () => void }
}

export type InstanceContext = CapsuleContext

/**
 * Compatibility wrapper for legacy pages/components during the capsule API migration.
 *
 * New code should call `provideCapsules()` directly.
 */
export function provideInstances(options: UseInstancesOptions): InstanceContext {
  return provideCapsules({
    client: options.client,
    branches: options.instances,
    onError: options.onError,
    onEventStream: options.onEventStream,
  })
}

/**
 * Compatibility wrapper for legacy components during the capsule API migration.
 *
 * New code should call `useCapsuleContext()` directly.
 */
export function useInstanceContext(): InstanceContext {
  return useCapsuleContext()
}
