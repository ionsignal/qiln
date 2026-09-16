export const DestroyStepKey = {
  PLAN_DESTROY: 'plan_destroy',
  REVOKE_SSH_ACCESS: 'revoke_ssh_access',
  WITHDRAW_ROUTES: 'withdraw_routes',
  DELETE_BRANCH_INSTANCES: 'delete_branch_instances',
  DELETE_MANAGED_STORAGE: 'delete_managed_storage',
  VERIFY_TERMINAL_RESOURCE_OUTCOMES: 'verify_terminal_resource_outcomes',
} as const

export type DestroyStepKey = (typeof DestroyStepKey)[keyof typeof DestroyStepKey]

/**
 * Inspection records only. Target outcomes and access evidence, not completed
 * step rows, authorize aggregate completion.
 */
export const DestroyStepKeys = [
  DestroyStepKey.PLAN_DESTROY,
  DestroyStepKey.REVOKE_SSH_ACCESS,
  DestroyStepKey.WITHDRAW_ROUTES,
  DestroyStepKey.DELETE_BRANCH_INSTANCES,
  DestroyStepKey.DELETE_MANAGED_STORAGE,
  DestroyStepKey.VERIFY_TERMINAL_RESOURCE_OUTCOMES,
] as const satisfies readonly DestroyStepKey[]
