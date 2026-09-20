import { CommanderError } from 'commander'
import { doctor } from './commands/doctor'
import { up } from './commands/up'
import { InstallerError } from './diagnostic/error'
import { ProcessExecutionError } from './process'
import { createProgram, parserFailure, type GlobalOptions } from './program'
import { Reporter } from './terminal/reporter'

type OperationalCommand = 'doctor' | 'up'

function assertUnprivilegedInvocation(): void {
  if (typeof process.geteuid !== 'function' || typeof process.getuid !== 'function') {
    throw new InstallerError({
      code: 'UNSUPPORTED_PLATFORM',
      facts: [['Observed', `Node platform '${process.platform}' does not expose process.getuid() and process.geteuid().`]],
      retry: 'qiln doctor',
    })
  }
  if (process.getuid() === 0 || process.geteuid() === 0) {
    throw new InstallerError({
      code: 'ROOT_EXECUTION_REFUSED',
      facts: [['User ID', String(process.getuid())], ['Effective user ID', String(process.geteuid())]],
      retry: 'qiln doctor',
    })
  }
}

function rerun(command: OperationalCommand | undefined): string {
  return command === 'up'
    ? 'qiln up --source <checkout> --image <alias-or-fingerprint> [--authorized-keys <roster>]'
    : 'qiln doctor'
}

function processFailure(error: ProcessExecutionError, command: OperationalCommand | undefined): InstallerError {
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
  const output: string[] = []
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
    },
    {
      write(text) {
        output.push(text)
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
        // Commander owns help spacing and wrapping; preserve its blank lines.
        reporter.help(output.join('').replace(/\n$/, '').split('\n'))
        return error.exitCode
      }
      if (error.code === 'commander.version') {
        reporter.version(output.join('').trim())
        return error.exitCode
      }
      reporter.failure(parserFailure(error))
      return 1
    }
    reporter.failure(error instanceof ProcessExecutionError ? processFailure(error, command) : error)
    return 1
  }
}

async function main(): Promise<void> {
  process.exitCode = await run(process.argv.slice(2))
}

void main()
