import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import {
  QilnAgentClient,
  QilnAgentClientError,
  readConfig,
  tools,
  type QilnAgentTool,
  type RegisteredQilnAgentTool,
} from '@qiln/agent'

export const QILN_MCP_VERSION = '0.1.2'

type Tool = QilnAgentTool<unknown, unknown>

function adapt(tool: RegisteredQilnAgentTool): Tool {
  /**
   * Registry iteration widens the heterogeneous tool tuple. Each tool retains
   * its exact runtime Zod schemas, which McpServer validates before invocation
   * and against successful structured output.
   */
  return tool as unknown as Tool
}

function failure(message: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text: message,
      },
    ],
    isError: true,
  }
}

function serialize(value: unknown): string | null {
  try {
    const text = JSON.stringify(value)
    return typeof text === 'string' ? text : null
  } catch {
    return null
  }
}

function success(value: unknown) {
  const text = serialize(value)
  if (text === null) {
    return failure('The Qiln tool could not encode this result.')
  }
  return {
    content: [
      {
        type: 'text' as const,
        text,
      },
    ],
    structuredContent: value,
  }
}

function clientFailure(error: QilnAgentClientError) {
  switch (error.code) {
    case 'artifact_content_denied':
      return failure('Artifact content is not available for this snapshot.')
    case 'not_found':
      return failure('The requested Qiln resource was not found.')
    case 'bad_request':
      return failure('The Qiln host rejected the tool request.')
    case 'snapshot_unavailable':
      return failure('Committed snapshot artifact evidence is unavailable.')
    case 'upstream_timeout':
      return failure('The Qiln host timed out while processing the tool request.')
    case 'upstream_unavailable':
      return failure('The Qiln host is temporarily unavailable.')
    default:
      return failure('The Qiln host could not complete this tool request.')
  }
}

function register(server: McpServer, client: QilnAgentClient, tool: Tool): void {
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
    },
    async input => {
      try {
        return success(await tool.execute(client, input))
      } catch (error: unknown) {
        if (error instanceof QilnAgentClientError) {
          return clientFailure(error)
        }
        return failure('The Qiln tool could not complete this request.')
      }
    },
  )
}

/**
 * Creates one fresh local MCP server backed exclusively by Qiln's closed agent
 * tool registry. The adapter owns no capsule authority or infrastructure
 * access.
 */
export function createServer(client: QilnAgentClient): McpServer {
  const server = new McpServer({
    name: 'qiln-mcp',
    version: QILN_MCP_VERSION,
  })
  for (const tool of tools) {
    register(server, client, adapt(tool))
  }
  return server
}

/**
 * Starts the local stdio MCP adapter using only environment-derived Host
 * connection settings. The SDK owns stdio transport and protocol negotiation.
 */
export async function start(): Promise<void> {
  const client = new QilnAgentClient(readConfig())
  serveStdio(() => createServer(client), {
    legacy: 'reject',
  })
}
