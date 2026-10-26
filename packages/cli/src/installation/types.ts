import type { Architecture } from './architecture'
import type { Layout } from './layout'

/**
 * Everything that varies between installations of the same workflow. The
 * checkout is the canonical path on the target, mounted writable at the
 * orchestrator's source path.
 */
export interface InstallationInputs {
  architecture: Architecture
  layout: Layout
  sourceRoot: string
}
