import { diagnostic as awsDiagnostic, isCancellation } from './aws/errors'
import { CommanderError } from 'commander'
import { InstallerError } from './diagnostic/error'
import { ProcessExecutionError } from './process'
import { createProgram, parserFailure, type GlobalOptions } from './program'
import { Reporter, type ColorMode, type OutputStream } from './terminal/reporter'
import * as aws from './commands/aws'
import * as installation from './commands/installation'

type OperationalCommand = 'installation' | 'aws'

interface OutputChunk {
  text: string
  stream: OutputStream
}

function assertUnprivilegedInvocation(): void {
  if (typeof process.geteuid !== 'function' || typeof process.getuid !== 'function') {
    throw new InstallerError({
      code: 'UNSUPPORTED_PLATFORM',
      facts: [
        ['Observed', `Node platform '${process.platform}' does not expose process.getuid() and process.geteuid().`],
      ],
      retry: 'qiln --help',
    })
  }
  if (process.getuid() === 0 || process.geteuid() === 0) {
    throw new InstallerError({
      code: 'ROOT_EXECUTION_REFUSED',
      facts: [
        ['User ID', String(process.getuid())],
        ['Effective user ID', String(process.geteuid())],
      ],
      retry: 'qiln --help',
    })
  }
}

function rerun(command: OperationalCommand | undefined): string {
  return command === 'aws' ? 'qiln aws connect' : 'qiln installation --help'
}

function processFailure(error: ProcessExecutionError, command: OperationalCommand | undefined): InstallerError {
  if (command === 'aws') {
    return awsDiagnostic(error)
  }
  const codes = {
    start: 'PREFLIGHT_PROCESS_START_FAILED',
    timeout: 'PREFLIGHT_PROCESS_TIMEOUT',
    output: 'PREFLIGHT_PROCESS_OUTPUT_LIMIT_EXCEEDED',
  } as const
  return new InstallerError({
    code: codes[error.kind],
    facts: [['Command', error.command]],
    retry: rerun(command),
  })
}

export async function run(argumentsList: readonly string[]): Promise<number> {
  let reporter = new Reporter()
  let command: OperationalCommand | undefined
  const output: OutputChunk[] = []

  /**
   * Every operational handler starts the same way: record the command kind,
   * bind a reporter to the color mode, refuse a privileged invocation, and
   * print the header.
   */
  function begin(kind: OperationalCommand, color: ColorMode, name: string, description: string): Reporter {
    command = kind
    reporter = new Reporter({ color })
    assertUnprivilegedInvocation()
    reporter.header(name, description)
    return reporter
  }

  const program = createProgram(
    {
      installation: {
        async list(color) {
          await installation.list(begin('installation', color, 'installation list', 'registered installations'))
        },
        async status(selector, color) {
          await installation.status(
            selector,
            begin('installation', color, 'installation status', 'local installation evidence'),
          )
        },
        async inspect(selector, color) {
          await installation.inspect(
            selector,
            begin('installation', color, 'installation inspect', 'read-only target preflight'),
          )
        },
        async configure(selector, options, color) {
          await installation.configure(
            selector,
            options,
            begin('installation', color, 'installation configure', 'stopped installation convergence'),
          )
        },
      },
      aws: {
        async connect(options, color) {
          await aws.connect(options, begin('aws', color, 'aws connect', 'guided AWS sign-in'))
        },
        async status(options, color) {
          await aws.status(options, begin('aws', color, 'aws status', 'operator identity verification'))
        },
        async disconnect(options, color) {
          await aws.disconnect(options, begin('aws', color, 'aws disconnect', 'local connection removal'))
        },
        deployment: {
          async create(options, color) {
            await aws.deployment.create(options, begin('aws', color, 'aws deployment create', 'approved host creation'))
          },
          async status(options, color) {
            await aws.deployment.status(
              options,
              begin('aws', color, 'aws deployment status', 'local deployment evidence'),
            )
          },
          async list(color) {
            await aws.deployment.list(begin('aws', color, 'aws deployment list', 'retained deployments'))
          },
          async inspect(options, color) {
            await aws.deployment.inspect(
              options,
              begin('aws', color, 'aws deployment inspect', 'fresh deployment observation'),
            )
          },
          async verify(options, color) {
            await aws.deployment.verify(
              options,
              begin('aws', color, 'aws deployment verify', 'read-only guest baseline'),
            )
          },
          async prepare(options, color) {
            await aws.deployment.prepare(
              options,
              begin('aws', color, 'aws deployment prepare', 'approved ZFS and Incus preparation'),
            )
          },
          ssh(_options, color) {
            begin('aws', color, 'aws deployment ssh', 'interactive session (unavailable)')
            aws.deployment.ssh()
          },
          async remove(options, color) {
            await aws.deployment.remove(
              options,
              begin('aws', color, 'aws deployment remove', 'approved deployment removal'),
            )
          },
        },
      },
    },
    {
      write(text, stream) {
        output.push({ text, stream })
      },
    },
  )
  try {
    await program.parseAsync([...argumentsList], {
      from: 'user',
    })
    return 0
  } catch (error: unknown) {
    reporter = new Reporter({
      color: program.opts<GlobalOptions>().color,
    })
    if (error instanceof CommanderError) {
      if (error.code === 'commander.helpDisplayed' || error.code === 'commander.help') {
        for (const chunk of output) {
          reporter.help(chunk.text, chunk.stream)
        }
        return error.exitCode
      }
      if (error.code === 'commander.version') {
        reporter.version(
          output
            .map(chunk => chunk.text)
            .join('')
            .trim(),
        )
        return error.exitCode
      }
      reporter.failure(parserFailure(error))
      return 1
    }
    reporter.failure(error instanceof ProcessExecutionError ? processFailure(error, command) : error)
    if (isCancellation(error)) {
      return 130
    }
    return 1
  }
}

async function main(): Promise<void> {
  process.exitCode = await run(process.argv.slice(2))
}

void main()
