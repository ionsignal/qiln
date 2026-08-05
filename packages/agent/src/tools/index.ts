import { qilnGetContextTool } from './context'

export * from './context'

export const tools = Object.freeze([qilnGetContextTool])

export type QilnAgentToolName = (typeof tools)[number]['name']
export type RegisteredQilnAgentTool = (typeof tools)[number]

/**
 * Resolves only enabled Qiln-provided tools. Future broker integrations must
 * use this registry rather than granting an agent ambient process authority.
 */
export function getTool(name: string): RegisteredQilnAgentTool | undefined {
  return tools.find(tool => tool.name === name)
}
