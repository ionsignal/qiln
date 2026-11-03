import type { HelpContent } from '../terminal/help'

export function root(awsAvailable: boolean): HelpContent {
  return {
    examples: ['qiln installation --help', ...(awsAvailable ? ['qiln aws --help'] : [])],
    safety: [
      'Operational commands use only the unprivileged developer’s existing authority on the machine where Qiln runs, and Qiln never invokes sudo or another privilege-escalation mechanism locally. Approved AWS host preparation is the one exception in kind: after separate approval of each plan, it runs reviewed scripts with sudo on the deployment host over the pinned SSH connection.',
      'Provider and host work runs as fenced steps that are never replayed, resumed, or rolled back, so a failed, cancelled, or unconfirmed step may already have taken effect. Recovery is forward-only and manual: inspect the retained evidence and the actual resources, and never edit or delete evidence or locks to bypass a refusal.',
      'Review command-specific help for side effects and authority.',
    ],
  }
}
