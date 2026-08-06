import { qilnGetContextTool } from './context'
import { qilnReadTool } from './read'

export * from './context'
export * from './read'
export * from './tool'

export const tools = Object.freeze([qilnGetContextTool, qilnReadTool])

export type QilnAgentToolName = (typeof tools)[number]['name']
export type RegisteredQilnAgentTool = (typeof tools)[number]

/**
 * Resolves only enabled Qiln-provided tools. Future broker integrations must
 * use this registry rather than granting an agent ambient process authority.
 */
export function getTool<TName extends QilnAgentToolName>(
  name: TName,
): Extract<RegisteredQilnAgentTool, { readonly name: TName }> | undefined
export function getTool(name: string): RegisteredQilnAgentTool | undefined
export function getTool(name: string): RegisteredQilnAgentTool | undefined {
  return tools.find(tool => tool.name === name)
}
