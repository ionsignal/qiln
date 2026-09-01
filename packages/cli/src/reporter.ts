import * as readline from 'node:readline'
import { styleText } from 'node:util'
import { QilnInstallerError } from './error'

const STATUS_WIDTH = 14
const LABEL_WIDTH = 18
const MAX_VALUE_LENGTH = 800
const MAX_LABEL_LENGTH = 18
const TERMINAL_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g
const TEMPORARY_PATH_PATTERN = /(^|[\s"'`(])(?:\/tmp|\/var\/tmp|\/private\/tmp)(?:\/[^\s"'`)]+)?/g

export type ColorMode = 'auto' | 'always' | 'never'
export type Outcome = 'verified' | 'created' | 'reused' | 'imported' | 'transferred'

type Output = NodeJS.WriteStream
type Style = Parameters<typeof styleText>[0]

export interface ReporterOptions {
  color?: ColorMode
  stdout?: Output
  stderr?: Output
}

const OUTCOME_STYLES: Record<Outcome, Style> = {
  verified: ['green', 'bold'],
  created: ['green', 'bold'],
  reused: ['cyan', 'bold'],
  imported: ['magenta', 'bold'],
  transferred: ['blue', 'bold'],
}

const OUTCOME_GLYPHS: Record<Outcome, string> = {
  verified: '✓',
  created: '✓',
  reused: '✓',
  imported: '✓',
  transferred: '✓',
}

function sanitize(value: string, maximumLength = MAX_VALUE_LENGTH): string {
  const normalized = value
    .replace(TERMINAL_CONTROL_PATTERN, ' ')
    .replace(TEMPORARY_PATH_PATTERN, (_match: string, prefix: string) => `${prefix}<temporary-path>`)
    .replace(/\s+/g, ' ')
    .trim()
  if (normalized === '') {
    return 'Not available.'
  }
  if (normalized.length <= maximumLength) {
    return normalized
  }
  return `${normalized.slice(0, Math.max(0, maximumLength - 3))}...`
}

function ascii(value: string): string {
  return value
    .replace(/\u00b7/g, '/')
    .replace(/[\u2013\u2014\u2212]/g, '-')
    .replace(/[^\x20-\x7e]/g, '?')
}

export class Reporter {
  private readonly color: ColorMode
  private readonly stdout: Output
  private readonly stderr: Output
  private stdoutWritten = false

  constructor(options: ReporterOptions = {}) {
    this.color = options.color ?? 'auto'
    this.stdout = options.stdout ?? process.stdout
    this.stderr = options.stderr ?? process.stderr
  }

  public header(command: string, description: string): void {
    const separator = this.interactive(this.stdout) ? ' — ' : ' - '
    const title = `qiln ${this.value(this.stdout, command, 80)}${separator}${this.value(this.stdout, description, 160)}`
    if (this.interactive(this.stdout)) {
      this.write(
        this.stdout,
        `${this.paint(this.stdout, ['cyan', 'bold'], '●')} ${this.paint(this.stdout, 'bold', title)}`,
      )
    } else {
      this.write(this.stdout, title)
    }
    this.stdoutWritten = true
  }

  public section(name: string): void {
    if (this.stdoutWritten) {
      this.write(this.stdout, '')
    }
    const title = this.value(this.stdout, name, 80)
    this.write(this.stdout, this.interactive(this.stdout) ? `  ${this.paint(this.stdout, 'bold', title)}` : title)
    this.stdoutWritten = true
  }

  public row(outcome: Outcome, label: string, detail: string): void {
    const name = this.value(this.stdout, label, MAX_LABEL_LENGTH).padEnd(LABEL_WIDTH)
    const value = this.value(this.stdout, detail)
    if (this.interactive(this.stdout)) {
      const status = `${OUTCOME_GLYPHS[outcome]} ${outcome}`.padEnd(STATUS_WIDTH)
      this.write(
        this.stdout,
        `  ${this.paint(this.stdout, OUTCOME_STYLES[outcome], status)} ${this.paint(this.stdout, 'bold', name)} ${value}`,
      )
    } else {
      const status = `[${outcome}]`.padEnd(STATUS_WIDTH)
      this.write(this.stdout, `${status} ${name} ${value}`)
    }
    this.stdoutWritten = true
  }

  public notice(message: string): void {
    const detail = this.value(this.stdout, message)
    if (this.interactive(this.stdout)) {
      const status = '! notice'.padEnd(STATUS_WIDTH)
      this.write(
        this.stdout,
        `  ${this.paint(this.stdout, ['yellow', 'bold'], status)} ${this.paint(this.stdout, 'bold', ''.padEnd(LABEL_WIDTH))} ${detail}`,
      )
    } else {
      this.write(this.stdout, `[notice] ${detail}`)
    }
    this.stdoutWritten = true
  }

  public summary(message: string): void {
    if (this.stdoutWritten) {
      this.write(this.stdout, '')
    }
    const detail = this.value(this.stdout, message)
    if (this.interactive(this.stdout)) {
      this.write(
        this.stdout,
        `${this.paint(this.stdout, ['cyan', 'bold'], '●')} ${this.paint(this.stdout, 'bold', detail)}`,
      )
    } else {
      this.write(this.stdout, detail)
    }
    this.stdoutWritten = true
  }

  public help(lines: readonly string[]): void {
    for (const line of lines) {
      this.write(this.stdout, this.value(this.stdout, line))
    }
    this.stdoutWritten = lines.length > 0
  }

  public version(version: string): void {
    this.write(this.stdout, `qiln ${this.value(this.stdout, version, 80)}`)
    this.stdoutWritten = true
  }

  public failure(error: unknown): void {
    const details =
      error instanceof QilnInstallerError
        ? [
            ['Code', error.code],
            ['Check', error.check],
            ['Observed', error.observed],
            ['Why Qiln cannot proceed', error.reason],
            ['Operator action', error.operatorAction],
            ['Rerun', error.rerun],
          ]
        : [
            ['Code', 'INTERNAL_ERROR'],
            ['Check', 'internal installer execution'],
            ['Observed', 'The installer encountered an unexpected error.'],
            [
              'Why Qiln cannot proceed',
              'Continuing after an unclassified failure could produce an unsafe or misleading installation result.',
            ],
            [
              'Operator action',
              'Review the local Qiln installer version and rerun the diagnostic command. No successful installation should be inferred from this failure.',
            ],
            ['Rerun', 'qiln doctor'],
          ]
    const summary = error instanceof QilnInstallerError ? error.message : 'Unexpected installer failure.'
    if (this.interactive(this.stderr)) {
      this.write(
        this.stderr,
        `${this.paint(this.stderr, ['red', 'bold'], '✗ failed')} ${this.paint(this.stderr, 'bold', 'qiln:')} ${this.value(this.stderr, summary)}`,
      )
      for (const [label, value] of details) {
        const name = this.value(this.stderr, label, 24).padEnd(24)
        this.write(this.stderr, `  ${this.paint(this.stderr, 'bold', name)} ${this.value(this.stderr, value)}`)
      }
      return
    }
    this.write(this.stderr, `[failed] qiln: ${this.value(this.stderr, summary)}`)
    for (const [label, value] of details) {
      this.write(this.stderr, `${this.value(this.stderr, label, 80)}: ${this.value(this.stderr, value)}`)
    }
  }

  private interactive(stream: Output): boolean {
    return stream.isTTY === true
  }

  private colors(stream: Output): boolean {
    if (process.env.NO_COLOR !== undefined || this.color === 'never') {
      return false
    }
    if (this.color === 'always') {
      return true
    }
    return this.interactive(stream)
  }

  private paint(stream: Output, format: Style, value: string): string {
    if (!this.colors(stream)) {
      return value
    }
    return styleText(format, value, {
      stream,
      validateStream: this.color !== 'always',
    })
  }

  private value(stream: Output, value: string, maximumLength = MAX_VALUE_LENGTH): string {
    const normalized = sanitize(value, maximumLength)
    return this.interactive(stream) ? normalized : ascii(normalized)
  }

  private write(stream: Output, value: string): void {
    if (this.interactive(stream)) {
      readline.cursorTo(stream, 0)
    }
    stream.write(`${value}\n`)
  }
}
