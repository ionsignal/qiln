import { InstallerError } from '../diagnostic/error'

interface PasswordContext {
  accountId: string
  operatorName: string
}

export function requireTerminal(): void {
  if (!process.stdout.isTTY) {
    throw new InstallerError({
      code: 'INTERACTIVE_TERMINAL_REQUIRED',
      retry: 'qiln aws connect',
    })
  }
}

/**
 * Call only from the isolated password process. JavaScript strings cannot be
 * reliably erased; process termination is the lifetime boundary.
 */
export async function reveal(password: string, context: PasswordContext): Promise<void> {
  requireTerminal()
  if (!/^[\x21-\x7e]{8,128}$/.test(password)) {
    throw new InstallerError({
      code: 'AWS_BOOTSTRAP_PASSWORD_UNAVAILABLE',
    })
  }
  try {
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(
        `\nInitial operator password (shown once)\nAWS account: ${context.accountId}\nOperator: ${context.operatorName}\n\n${password}\n\nCopy this password now and replace it in the AWS browser.\nQiln does not store this password and will not display it again.\n\n`,
        error => {
          if (error) {
            reject(error)
          } else {
            resolve()
          }
        },
      )
    })
  } catch {
    throw new InstallerError({
      code: 'AWS_BOOTSTRAP_PASSWORD_UNAVAILABLE',
    })
  }
}
