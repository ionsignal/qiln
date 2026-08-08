import type { ZodType } from 'zod'
import type { QilnAgentClient } from '../client'

/**
 * One Qiln-owned external-agent capability.
 *
 * The registry exposes Core-owned schemas as metadata so local adapters can
 * validate and describe the exact same contracts without copying authority or
 * transport behavior into another package.
 */
export interface QilnAgentTool<TInput, TOutput> {
  readonly name: string
  readonly description: string
  readonly inputSchema: ZodType<TInput>
  readonly outputSchema: ZodType<TOutput>
  execute(client: QilnAgentClient, input: TInput): Promise<TOutput>
}
