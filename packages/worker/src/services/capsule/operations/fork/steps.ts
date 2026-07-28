export const ForkStep = {
  PLAN: 'plan_fork',
  ROOTFS: 'verify_rootfs_image',
  PROJECT: 'ensure_project',
  BINDS: 'record_bind_mounts',
  VOLUMES: 'clone_snapshot_volumes',
  INSTANCE: 'create_instance',
  FILES: 'restore_provisioning_files',
  VERIFY: 'verify_offline_runtime',
  COMPLETE: 'complete_fork',
} as const

export type ForkStep = (typeof ForkStep)[keyof typeof ForkStep]

/**
 * Fork steps are durable inspection records only.
 *
 * Provider intent is a base-operation fence rather than an accounting step.
 * Step rows never authorize an interrupted fork to resume or retry work.
 */
export const ForkSteps = [
  ForkStep.PLAN,
  ForkStep.ROOTFS,
  ForkStep.PROJECT,
  ForkStep.BINDS,
  ForkStep.VOLUMES,
  ForkStep.INSTANCE,
  ForkStep.FILES,
  ForkStep.VERIFY,
  ForkStep.COMPLETE,
] as const satisfies readonly ForkStep[]
