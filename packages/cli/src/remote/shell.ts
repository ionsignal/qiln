const MAXIMUM_COMMAND_LENGTH = 100_000

export interface ShellOptions {
  privileged?: boolean
}

function quote(value: string): string {
  if (value.includes('\0')) {
    throw new RangeError('Shell arguments cannot contain NUL.')
  }
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * Encodes one authored script and its positional arguments as a single command
 * string, because the SSH transport has no argument vector and no stdin. The
 * script and every argument are quoted independently, so configuration values
 * never become shell source. `$0` is deliberately fixed.
 */
export function shellCommand(script: string, args: readonly string[] = [], options: ShellOptions = {}): string {
  const words = ['/bin/sh', '-c', quote(script), quote('qiln'), ...args.map(quote)]
  const command = `${options.privileged ? 'sudo -n ' : ''}${words.join(' ')}`
  if (Buffer.byteLength(command) > MAXIMUM_COMMAND_LENGTH) {
    throw new RangeError('The shell command exceeds the supported length.')
  }
  return command
}
