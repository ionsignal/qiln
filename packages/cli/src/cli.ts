import { diagnostic as awsDiagnostic, isCancellation } from './aws/errors'
import { CommanderError } from 'commander'
import { doctor } from './commands/doctor'
import { up } from './commands/up'
import { InstallerError } from './diagnostic/error'
import { ProcessExecutionError } from './process'
import { createProgram, parserFailure, type GlobalOptions } from './program'
import { Reporter, type OutputStream } from './terminal/reporter'
import * as aws from './commands/aws'

type OperationalCommand = 'doctor' | 'up' | 'aws'

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
      retry: 'qiln doctor',
    })
  }
  if (process.getuid() === 0 || process.geteuid() === 0) {
    throw new InstallerError({
      code: 'ROOT_EXECUTION_REFUSED',
      facts: [
        ['User ID', String(process.getuid())],
        ['Effective user ID', String(process.geteuid())],
      ],
      retry: 'qiln doctor',
    })
  }
}

function rerun(command: OperationalCommand | undefined): string {
  if (command === 'aws') {
    return 'qiln aws connect'
  }
  return command === 'up'
    ? 'qiln up --source <checkout> --image <alias-or-fingerprint> [--authorized-keys <roster>]'
    : 'qiln doctor'
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
  const program = createProgram(
    {
      async doctor(color) {
        command = 'doctor'
        reporter = new Reporter({ color })
        assertUnprivilegedInvocation()
        reporter.header('doctor', 'read-only preflight')
        await doctor(reporter)
      },
      async up(options, color) {
        command = 'up'
        reporter = new Reporter({ color })
        assertUnprivilegedInvocation()
        reporter.header('up', 'stopped installation convergence')
        await up(options, reporter)
      },
      aws: {
        async connect(options, color) {
          command = 'aws'
          reporter = new Reporter({ color })
          assertUnprivilegedInvocation()
          reporter.header('aws connect', 'guided AWS sign-in')
          await aws.connect(options, reporter)
        },
        async status(options, color) {
          command = 'aws'
          reporter = new Reporter({ color })
          assertUnprivilegedInvocation()
          reporter.header('aws status', 'operator identity verification')
          await aws.status(options, reporter)
        },
        async disconnect(options, color) {
          command = 'aws'
          reporter = new Reporter({ color })
          assertUnprivilegedInvocation()
          reporter.header('aws disconnect', 'local connection removal')
          await aws.disconnect(options, reporter)
        },
        deployment: {
          async create(options, color) {
            command = 'aws'
            reporter = new Reporter({ color })
            assertUnprivilegedInvocation()
            reporter.header('aws deployment create', 'approved host creation')
            await aws.deployment.create(options, reporter)
          },
          async status(options, color) {
            command = 'aws'
            reporter = new Reporter({ color })
            assertUnprivilegedInvocation()
            reporter.header('aws deployment status', 'local deployment evidence')
            await aws.deployment.status(options, reporter)
          },
          async list(color) {
            command = 'aws'
            reporter = new Reporter({ color })
            assertUnprivilegedInvocation()
            reporter.header('aws deployment list', 'retained deployments')
            await aws.deployment.list(reporter)
          },
          async inspect(options, color) {
            command = 'aws'
            reporter = new Reporter({ color })
            assertUnprivilegedInvocation()
            reporter.header('aws deployment inspect', 'fresh deployment observation')
            await aws.deployment.inspect(options, reporter)
          },
          async verify(options, color) {
            command = 'aws'
            reporter = new Reporter({ color })
            assertUnprivilegedInvocation()
            reporter.header('aws deployment verify', 'read-only guest baseline')
            await aws.deployment.verify(options, reporter)
          },
          async prepare(options, color) {
            command = 'aws'
            reporter = new Reporter({ color })
            assertUnprivilegedInvocation()
            reporter.header('aws deployment prepare', 'approved ZFS prerequisites')
            await aws.deployment.prepare(options, reporter)
          },
          async push(options, color) {
            command = 'aws'
            reporter = new Reporter({ color })
            assertUnprivilegedInvocation()
            reporter.header('aws deployment push', 'local source delivery')
            await aws.deployment.push(options, reporter)
          },
          ssh(_options, color) {
            command = 'aws'
            reporter = new Reporter({ color })
            assertUnprivilegedInvocation()
            reporter.header('aws deployment ssh', 'interactive session (unavailable)')
            aws.deployment.ssh()
          },
          async remove(options, color) {
            command = 'aws'
            reporter = new Reporter({ color })
            assertUnprivilegedInvocation()
            reporter.header('aws deployment remove', 'approved deployment removal')
            await aws.deployment.remove(options, reporter)
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
