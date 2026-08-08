import { QilnAgentConfigError } from '@qiln/agent'
import { start } from './server'

const MAX_ERROR_MESSAGE_LENGTH = 500

function formatError(error: unknown): string {
  const message = error instanceof QilnAgentConfigError ? error.message : 'Failed to start the Qiln MCP server.'
  const normalized = message
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return normalized.slice(0, MAX_ERROR_MESSAGE_LENGTH) || 'Failed to start the Qiln MCP server.'
}

export async function run(): Promise<number> {
  try {
    await start()
    return 0
  } catch (error: unknown) {
    process.stderr.write(`qiln-mcp: ${formatError(error)}\n`)
    return 1
  }
}

async function main(): Promise<void> {
  process.exitCode = await run()
}

void main()
