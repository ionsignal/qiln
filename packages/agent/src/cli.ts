import {
  AgentGetContextInputSchema,
  AgentSnapshotReadInputSchema,
  type AgentGetContext,
  type AgentSnapshotRead,
} from '@qiln/core/client'
import { QilnAgentClient, QilnAgentClientError } from './client'
import { QilnAgentConfigError, readConfig } from './config'
import { getTool, qilnGetContextTool, qilnReadTool } from './tools'

const MAX_ERROR_MESSAGE_LENGTH = 500

type Command =
  | {
      kind: 'help'
    }
  | {
      kind: 'get-context'
      selector: AgentGetContext
    }
  | {
      kind: 'read'
      input: AgentSnapshotRead
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
    '  qiln read manifest --snapshot-id <uuid> [--root-id <root-id>] [--after-root-id <root-id>]',
    '  qiln read manifest --snapshot-id <uuid> --root-id <root-id> [--after-logical-path <path>] [--limit <1-100>]',
    '  qiln read content --snapshot-id <uuid> --root-id <root-id> --logical-path <path>',
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

function parseReadOptions(argumentsList: readonly string[], allowed: readonly string[]): Map<string, string> | null {
  const options = new Map<string, string>()
  for (let index = 0; index < argumentsList.length; index++) {
    const argument = argumentsList[index]
    if (argument === '--help' || argument === '-h') {
      return null
    }
    if (!allowed.includes(argument)) {
      throw new QilnAgentCliError(`Unknown read argument '${argument}'.`)
    }
    if (options.has(argument)) {
      throw new QilnAgentCliError(`${argument} may be supplied only once.`)
    }
    options.set(argument, optionValue(argumentsList, index, argument))
    index++
  }
  return options
}

function requiredOption(options: ReadonlyMap<string, string>, name: string): string {
  const value = options.get(name)
  if (value === undefined) {
    throw new QilnAgentCliError(`${name} is required.`)
  }
  return value
}

function parseLimit(value: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new QilnAgentCliError('--limit must be a positive integer.')
  }
  const limit = Number(value)
  if (!Number.isSafeInteger(limit)) {
    throw new QilnAgentCliError('--limit must be a safe integer.')
  }
  return limit
}

function parseSnapshotRead(input: unknown, message: string): AgentSnapshotRead {
  const parsed = AgentSnapshotReadInputSchema.safeParse(input)
  if (!parsed.success) {
    throw new QilnAgentCliError(message)
  }
  return parsed.data
}

function parseManifest(argumentsList: readonly string[]): Command {
  const options = parseReadOptions(argumentsList, [
    '--snapshot-id',
    '--root-id',
    '--after-root-id',
    '--after-logical-path',
    '--limit',
  ])
  if (options === null) {
    return {
      kind: 'help',
    }
  }
  const snapshotId = requiredOption(options, '--snapshot-id')
  const rootId = options.get('--root-id')
  const limit = options.get('--limit')
  if (rootId === undefined) {
    if (options.has('--after-logical-path')) {
      throw new QilnAgentCliError('--after-logical-path requires --root-id.')
    }
    return {
      kind: 'read',
      input: parseSnapshotRead(
        {
          mode: 'manifest',
          snapshotId,
          ...(options.has('--after-root-id') ? { afterRootId: options.get('--after-root-id') } : {}),
          ...(limit === undefined ? {} : { limit: parseLimit(limit) }),
        },
        'Invalid snapshot manifest root request.',
      ),
    }
  }
  if (options.has('--after-root-id')) {
    throw new QilnAgentCliError('--after-root-id cannot be used with --root-id.')
  }
  return {
    kind: 'read',
    input: parseSnapshotRead(
      {
        mode: 'manifest',
        snapshotId,
        rootId,
        ...(options.has('--after-logical-path') ? { afterLogicalPath: options.get('--after-logical-path') } : {}),
        ...(limit === undefined ? {} : { limit: parseLimit(limit) }),
      },
      'Invalid snapshot manifest entry request.',
    ),
  }
}

function parseContent(argumentsList: readonly string[]): Command {
  const options = parseReadOptions(argumentsList, ['--snapshot-id', '--root-id', '--logical-path'])
  if (options === null) {
    return {
      kind: 'help',
    }
  }
  return {
    kind: 'read',
    input: parseSnapshotRead(
      {
        mode: 'content',
        snapshotId: requiredOption(options, '--snapshot-id'),
        rootId: requiredOption(options, '--root-id'),
        logicalPath: requiredOption(options, '--logical-path'),
      },
      'Invalid snapshot artifact content request.',
    ),
  }
}

function parseRead(argumentsList: readonly string[]): Command {
  const mode = argumentsList[0]
  if (mode === undefined) {
    throw new QilnAgentCliError('read requires either manifest or content.')
  }
  if (mode === '--help' || mode === '-h') {
    return {
      kind: 'help',
    }
  }
  if (mode === 'manifest') {
    return parseManifest(argumentsList.slice(1))
  }
  if (mode === 'content') {
    return parseContent(argumentsList.slice(1))
  }
  throw new QilnAgentCliError(`Unknown read mode '${mode}'.`)
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
  if (argumentsList[0] === 'get-context') {
    return parseContext(argumentsList.slice(1))
  }
  if (argumentsList[0] === 'read') {
    return parseRead(argumentsList.slice(1))
  }
  throw new QilnAgentCliError(`Unknown command '${argumentsList[0]}'.`)
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
    if (command.kind === 'get-context') {
      const tool = getTool(qilnGetContextTool.name)
      if (!tool) {
        throw new QilnAgentCliError('qiln_get_context is not enabled.')
      }
      const context = await tool.execute(client, command.selector)
      process.stdout.write(`${JSON.stringify(context, null, 2)}\n`)
      return 0
    }
    const tool = getTool(qilnReadTool.name)
    if (!tool) {
      throw new QilnAgentCliError('qiln_read is not enabled.')
    }
    const result = await tool.execute(client, command.input)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
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
