import { Writable } from 'node:stream'
import { createInterface } from 'node:readline/promises'
import { InstallerError } from '../diagnostic/error'
import type { PromptTone, Reporter } from './reporter'

export function checkCancellation(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new InstallerError({
      code: 'COMMAND_CANCELLED',
    })
  }
}

export function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true
}

export async function withCancellation<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const cancel = () => controller.abort()
  process.on('SIGINT', cancel)
  process.on('SIGTERM', cancel)
  try {
    return await run(controller.signal)
  } finally {
    process.off('SIGINT', cancel)
    process.off('SIGTERM', cancel)
  }
}

export class Prompts {
  /**
   * The retry command is supplied by the owning command so this class carries
   * no knowledge of any particular command family. The reporter is shared with
   * the command so both agree on where the output currently stands.
   */
  constructor(
    private readonly signal: AbortSignal,
    private readonly retry: string,
    private readonly reporter: Reporter,
  ) {}

  public async text(label: string, defaultValue?: string): Promise<string> {
    return await this.ask(label, defaultValue)
  }

  /**
   * The answer is never echoed and is returned exactly as typed.
   */
  public async secret(label: string): Promise<string> {
    return await this.ask(label, undefined, 'input', true)
  }

  public async select(label: string, choices: readonly string[]): Promise<number> {
    if (choices.length === 0) {
      throw new RangeError('A selection requires at least one choice.')
    }
    checkCancellation(this.signal)
    this.reporter.promptSelection(label, choices)
    while (true) {
      const answer = await this.ask('Selection', '1')
      const selection = Number(answer)
      if (/^[1-9][0-9]*$/.test(answer) && Number.isSafeInteger(selection) && selection <= choices.length) {
        return selection - 1
      }
      this.reporter.info('Select one of the listed numbers.')
    }
  }

  public async consent(label: string): Promise<boolean> {
    return await this.yes(label)
  }

  public async approve(label: string): Promise<void> {
    if (!(await this.yes(label))) {
      throw new InstallerError({
        code: 'COMMAND_CANCELLED',
      })
    }
  }

  /**
   * The question mark is added here, so every approval prompt reads the same.
   */
  private async yes(label: string): Promise<boolean> {
    const answer = (await this.ask(`${label}? [y/N]`, undefined, 'approval')).toLowerCase()
    return answer === 'y' || answer === 'yes'
  }

  /**
   * The reporter spaces the prompt from the output before it, and the next block
   * is spaced from the prompt.
   */
  private async ask(label: string, defaultValue?: string, tone: PromptTone = 'input', hidden = false): Promise<string> {
    checkCancellation(this.signal)
    if (!isInteractive()) {
      throw new InstallerError({
        code: 'INTERACTIVE_TERMINAL_REQUIRED',
        retry: this.retry,
      })
    }
    const promptController = new AbortController()
    const questionSignal = AbortSignal.any([this.signal, promptController.signal])
    const readline = createInterface({
      input: process.stdin,
      output: hidden ? new Writable({ write: (_chunk, _encoding, done) => done() }) : process.stdout,
      terminal: true,
    })
    const cancelPrompt = () => promptController.abort()
    readline.once('SIGINT', cancelPrompt)
    readline.once('close', cancelPrompt)
    try {
      const question = this.reporter.promptQuestion(label, defaultValue, tone)
      if (hidden) {
        process.stdout.write(question)
      }
      const answer = await readline.question(hidden ? '' : question, {
        signal: questionSignal,
      })
      checkCancellation(questionSignal)
      return hidden ? answer : answer.trim() || defaultValue || ''
    } catch (error: unknown) {
      if (questionSignal.aborted) {
        throw new InstallerError({
          code: 'COMMAND_CANCELLED',
        })
      }
      throw error
    } finally {
      if (hidden) {
        process.stdout.write('\n')
      }
      readline.off('SIGINT', cancelPrompt)
      readline.off('close', cancelPrompt)
      readline.close()
    }
  }
}
