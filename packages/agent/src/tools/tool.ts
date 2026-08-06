import type { QilnAgentClient } from '../client'

export interface QilnAgentTool<TInput, TOutput> {
  readonly name: string
  execute(client: QilnAgentClient, input: TInput): Promise<TOutput>
}
