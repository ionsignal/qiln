import { AgentGetContextInputSchema, type AgentGetContext } from '@qiln/core/client'
import { QilnAgentClient, QilnAgentClientError } from './client'
import { QilnAgentConfigError, readConfig } from './config'
import { getTool, qilnGetContextTool } from './tools'

const MAX_ERROR_MESSAGE_LENGTH = 500

type Command =
  | {
      kind: 'help'
    }
  | {
      kind: 'get-context'
      selector: AgentGetContext
    }

class QilnAgentCliError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QilnAgentCliError'
  }
}

function usage(): string {
  return [
    'Usage:',
    '  qiln get-context [--branch-id <uuid> | --branch-name <name>]',
    '',
    'Required environment:',
    '  QILN_AGENT_URL   Qiln host origin, such as https://qiln.example.com',
    '  QILN_AGENT_KEY   Agent API key',
    '',
    'The API key is read only from QILN_AGENT_KEY and is never accepted as a CLI argument.',
  ].join('\n')
}

function optionValue(argumentsList: readonly string[], index: number, option: string): string {
  const value = argumentsList[index + 1]
  if (value === undefined || value === '' || value.startsWith('-')) {
    throw new QilnAgentCliError(`${option} requires a value.`)
  }
  return value
}

function parseContext(argumentsList: readonly string[]): Command {
  let branchId: string | undefined
  let branchName: string | undefined
  for (let index = 0; index < argumentsList.length; index++) {
    const argument = argumentsList[index]
    if (argument === '--help' || argument === '-h') {
      return {
        kind: 'help',
      }
    }
    if (argument === '--branch-id') {
      if (branchId !== undefined) {
        throw new QilnAgentCliError('--branch-id may be supplied only once.')
      }
      branchId = optionValue(argumentsList, index, argument)
      index++
      continue
    }
    if (argument === '--branch-name') {
      if (branchName !== undefined) {
        throw new QilnAgentCliError('--branch-name may be supplied only once.')
      }
      branchName = optionValue(argumentsList, index, argument)
      index++
      continue
    }
    throw new QilnAgentCliError(`Unknown get-context argument '${argument}'.`)
  }
  const selector = AgentGetContextInputSchema.safeParse({
    ...(branchId === undefined ? {} : { branchId }),
    ...(branchName === undefined ? {} : { branchName }),
  })
  if (!selector.success) {
    throw new QilnAgentCliError('Specify at most one valid branch selector.')
  }
  return {
    kind: 'get-context',
    selector: selector.data,
  }
}

function parse(argumentsList: readonly string[]): Command {
  if (argumentsList.length === 0 || argumentsList[0] === '--help' || argumentsList[0] === '-h') {
    return {
      kind: 'help',
    }
  }
  if (argumentsList[0] !== 'get-context') {
    throw new QilnAgentCliError(`Unknown command '${argumentsList[0]}'.`)
  }
  return parseContext(argumentsList.slice(1))
}

function formatError(error: unknown): string {
  const message =
    error instanceof QilnAgentCliError || error instanceof QilnAgentConfigError || error instanceof QilnAgentClientError
      ? error.message
      : 'Unexpected Qiln agent CLI failure.'
  const normalized = message
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return normalized.slice(0, MAX_ERROR_MESSAGE_LENGTH) || 'Unexpected Qiln agent CLI failure.'
}

export async function run(argumentsList: readonly string[]): Promise<number> {
  try {
    const command = parse(argumentsList)
    if (command.kind === 'help') {
      process.stdout.write(`${usage()}\n`)
      return 0
    }
    const config = readConfig()
    const client = new QilnAgentClient(config)
    const tool = getTool(qilnGetContextTool.name)
    if (!tool) {
      throw new QilnAgentCliError('qiln_get_context is not enabled.')
    }
    const context = await tool.execute(client, command.selector)
    process.stdout.write(`${JSON.stringify(context, null, 2)}\n`)
    return 0
  } catch (error: unknown) {
    process.stderr.write(`qiln: ${formatError(error)}\n`)
    return 1
  }
}

async function main(): Promise<void> {
  process.exitCode = await run(process.argv.slice(2))
}

void main()
