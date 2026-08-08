import {
  MAX_AGENT_SNAPSHOT_MANIFEST_ITEMS,
  type AgentGetContext,
  type AgentSnapshotArtifactContentRequest,
  type AgentSnapshotManifestEntries,
  type AgentSnapshotManifestRoots,
} from '@qiln/core/client'
import { QilnAgentClient, QilnAgentClientError } from './client'
import { QilnAgentConfigError, readConfig } from './config'
import {
  getTool,
  qilnGetContextTool,
  qilnReadArtifactContentTool,
  qilnReadManifestEntriesTool,
  qilnReadManifestRootsTool,
} from './tools'

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
      kind: 'manifest-roots'
      input: AgentSnapshotManifestRoots
    }
  | {
      kind: 'manifest-entries'
      input: AgentSnapshotManifestEntries
    }
  | {
      kind: 'artifact-content'
      input: AgentSnapshotArtifactContentRequest
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
    '  qiln read-manifest-roots --snapshot-id <uuid> [--after-root-id <root-id>] [--limit <1-100>]',
    '  qiln read-manifest-entries --snapshot-id <uuid> --root-id <root-id> [--after-logical-path <path>] [--limit <1-100>]',
    '  qiln read-artifact-content --snapshot-id <uuid> --root-id <root-id> --logical-path <path>',
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

function parseOptions(argumentsList: readonly string[], allowed: readonly string[]): Map<string, string> | null {
  const options = new Map<string, string>()
  for (let index = 0; index < argumentsList.length; index++) {
    const argument = argumentsList[index]
    if (argument === '--help' || argument === '-h') {
      return null
    }
    if (!allowed.includes(argument)) {
      throw new QilnAgentCliError(`Unknown argument '${argument}'.`)
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
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new QilnAgentCliError('--limit must be a positive integer.')
  }
  const limit = Number(value)
  if (!Number.isSafeInteger(limit) || limit > MAX_AGENT_SNAPSHOT_MANIFEST_ITEMS) {
    throw new QilnAgentCliError(`--limit must be an integer from 1 to ${MAX_AGENT_SNAPSHOT_MANIFEST_ITEMS}.`)
  }
  return limit
}

function parseRootsInput(value: unknown): AgentSnapshotManifestRoots {
  const parsed = qilnReadManifestRootsTool.inputSchema.safeParse(value)
  if (!parsed.success) {
    throw new QilnAgentCliError('Invalid snapshot manifest root request.')
  }
  return parsed.data
}

function parseEntriesInput(value: unknown): AgentSnapshotManifestEntries {
  const parsed = qilnReadManifestEntriesTool.inputSchema.safeParse(value)
  if (!parsed.success) {
    throw new QilnAgentCliError('Invalid snapshot manifest entry request.')
  }
  return parsed.data
}

function parseContentInput(value: unknown): AgentSnapshotArtifactContentRequest {
  const parsed = qilnReadArtifactContentTool.inputSchema.safeParse(value)
  if (!parsed.success) {
    throw new QilnAgentCliError('Invalid snapshot artifact content request.')
  }
  return parsed.data
}

function parseManifestRoots(argumentsList: readonly string[]): Command {
  const options = parseOptions(argumentsList, ['--snapshot-id', '--after-root-id', '--limit'])
  if (options === null) {
    return {
      kind: 'help',
    }
  }
  const afterRootId = options.get('--after-root-id')
  const limit = options.get('--limit')
  return {
    kind: 'manifest-roots',
    input: parseRootsInput({
      snapshotId: requiredOption(options, '--snapshot-id'),
      ...(afterRootId === undefined ? {} : { afterRootId }),
      ...(limit === undefined ? {} : { limit: parseLimit(limit) }),
    }),
  }
}

function parseManifestEntries(argumentsList: readonly string[]): Command {
  const options = parseOptions(argumentsList, ['--snapshot-id', '--root-id', '--after-logical-path', '--limit'])
  if (options === null) {
    return {
      kind: 'help',
    }
  }
  const afterLogicalPath = options.get('--after-logical-path')
  const limit = options.get('--limit')
  return {
    kind: 'manifest-entries',
    input: parseEntriesInput({
      snapshotId: requiredOption(options, '--snapshot-id'),
      rootId: requiredOption(options, '--root-id'),
      ...(afterLogicalPath === undefined ? {} : { afterLogicalPath }),
      ...(limit === undefined ? {} : { limit: parseLimit(limit) }),
    }),
  }
}

function parseArtifactContent(argumentsList: readonly string[]): Command {
  const options = parseOptions(argumentsList, ['--snapshot-id', '--root-id', '--logical-path'])
  if (options === null) {
    return {
      kind: 'help',
    }
  }
  return {
    kind: 'artifact-content',
    input: parseContentInput({
      snapshotId: requiredOption(options, '--snapshot-id'),
      rootId: requiredOption(options, '--root-id'),
      logicalPath: requiredOption(options, '--logical-path'),
    }),
  }
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
  const selector = qilnGetContextTool.inputSchema.safeParse({
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
  switch (argumentsList[0]) {
    case 'get-context':
      return parseContext(argumentsList.slice(1))
    case 'read-manifest-roots':
      return parseManifestRoots(argumentsList.slice(1))
    case 'read-manifest-entries':
      return parseManifestEntries(argumentsList.slice(1))
    case 'read-artifact-content':
      return parseArtifactContent(argumentsList.slice(1))
    default:
      throw new QilnAgentCliError(`Unknown command '${argumentsList[0]}'.`)
  }
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

function writeResult(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

export async function run(argumentsList: readonly string[]): Promise<number> {
  try {
    const command = parse(argumentsList)
    if (command.kind === 'help') {
      process.stdout.write(`${usage()}\n`)
      return 0
    }
    const client = new QilnAgentClient(readConfig())
    if (command.kind === 'get-context') {
      const tool = getTool(qilnGetContextTool.name)
      if (!tool) {
        throw new QilnAgentCliError('qiln_get_context is not enabled.')
      }
      writeResult(await tool.execute(client, command.selector))
      return 0
    }
    if (command.kind === 'manifest-roots') {
      const tool = getTool(qilnReadManifestRootsTool.name)
      if (!tool) {
        throw new QilnAgentCliError('qiln_read_manifest_roots is not enabled.')
      }
      writeResult(await tool.execute(client, command.input))
      return 0
    }
    if (command.kind === 'manifest-entries') {
      const tool = getTool(qilnReadManifestEntriesTool.name)
      if (!tool) {
        throw new QilnAgentCliError('qiln_read_manifest_entries is not enabled.')
      }
      writeResult(await tool.execute(client, command.input))
      return 0
    }
    const tool = getTool(qilnReadArtifactContentTool.name)
    if (!tool) {
      throw new QilnAgentCliError('qiln_read_artifact_content is not enabled.')
    }
    writeResult(await tool.execute(client, command.input))
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
