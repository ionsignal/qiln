import { stripVTControlCharacters, styleText } from 'node:util'
import { catalog } from '../diagnostic/catalog'
import { InstallerError } from '../diagnostic/error'

const LABEL_WIDTH = 18
const BADGE_WIDTH = 13
const FACT_WIDTH = 20
const MAX_VALUE_LENGTH = 2_000
const MAX_LABEL_LENGTH = 40

const TERMINAL_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g
const HELP_CONTROL_PATTERN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g
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

function sanitize(value: string, maximumLength = MAX_VALUE_LENGTH): string {
  const normalized = stripVTControlCharacters(value)
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
    .replace(/\u2192/g, '->')
    .replace(/[\u2013\u2014\u2212]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[^\x20-\x7e\t]/g, '?')
}

function wrap(value: string, width: number): string[] {
  const lines: string[] = []
  let line = ''

  for (const word of value.split(' ')) {
    if (line !== '' && line.length + word.length + 1 > width) {
      lines.push(line)
      line = word
    } else {
      line = line === '' ? word : `${line} ${word}`
    }
  }
  if (line !== '') {
    lines.push(line)
  }
  return lines
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
    const interactive = this.interactive(this.stdout)
    const separator = interactive ? ' — ' : ' - '
    const title = `qiln ${this.value(this.stdout, command, 80)}${separator}${this.value(this.stdout, description, 160)}`

    this.write(
      this.stdout,
      interactive
        ? `${this.paint(this.stdout, ['cyan', 'bold'], '●')} ${this.paint(this.stdout, 'bold', title)}`
        : title,
    )
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
    const name = this.value(this.stdout, label, LABEL_WIDTH).padEnd(LABEL_WIDTH)
    const badge = `[${outcome}]`.padEnd(BADGE_WIDTH)
    const value = this.value(this.stdout, detail)

    if (this.interactive(this.stdout)) {
      this.write(
        this.stdout,
        `  ${this.paint(this.stdout, OUTCOME_STYLES[outcome], '✓')} ${this.paint(this.stdout, 'bold', name)} ${this.paint(this.stdout, OUTCOME_STYLES[outcome], badge)} ${value}`,
      )
    } else {
      this.write(this.stdout, `+ ${name} ${badge} ${value}`)
    }
    this.stdoutWritten = true
  }

  public notice(message: string): void {
    const label = 'Notice'.padEnd(LABEL_WIDTH)
    const detail = this.value(this.stdout, message)

    if (this.interactive(this.stdout)) {
      this.write(
        this.stdout,
        `  ${this.paint(this.stdout, ['yellow', 'bold'], '!')} ${this.paint(this.stdout, 'bold', label)} ${''.padEnd(BADGE_WIDTH)} ${detail}`,
      )
    } else {
      this.write(this.stdout, `! ${label} ${''.padEnd(BADGE_WIDTH)} ${detail}`)
    }
    this.stdoutWritten = true
  }

  public summary(message: string): void {
    if (this.stdoutWritten) {
      this.write(this.stdout, '')
    }
    const detail = this.value(this.stdout, message)

    this.write(
      this.stdout,
      this.interactive(this.stdout)
        ? `${this.paint(this.stdout, ['cyan', 'bold'], '●')} ${this.paint(this.stdout, 'bold', detail)}`
        : detail,
    )
    this.stdoutWritten = true
  }

  /**
   * Commander owns help wrapping and columns. Preserve its whitespace instead
   * of applying the single-line diagnostic normalizer.
   */
  public help(lines: readonly string[]): void {
    for (const line of lines) {
      const sanitized = stripVTControlCharacters(line).replace(HELP_CONTROL_PATTERN, ' ')
      this.write(this.stdout, this.interactive(this.stdout) ? sanitized : ascii(sanitized))
    }
    this.stdoutWritten = lines.length > 0
  }

  public version(version: string): void {
    this.write(this.stdout, `qiln ${this.value(this.stdout, version, 80)}`)
    this.stdoutWritten = true
  }

  public failure(error: unknown): void {
    const diagnostic =
      error instanceof InstallerError
        ? error
        : new InstallerError({
            code: 'INTERNAL_ERROR',
            retry: 'qiln doctor',
          })

    const definition = catalog[diagnostic.code]
    const interactive = this.interactive(this.stderr)
    const title = this.value(this.stderr, definition.title)

    this.write(
      this.stderr,
      interactive
        ? `${this.paint(this.stderr, ['red', 'bold'], '✗')} ${this.paint(this.stderr, 'bold', title)}`
        : `[failed] ${title}`,
    )
    this.write(this.stderr, '')
    this.fact('Code', diagnostic.code)

    for (const [label, value] of diagnostic.facts) {
      this.fact(label, value)
    }

    this.write(this.stderr, '')
    this.paragraph(definition.explanation)

    if (definition.steps.length > 0) {
      this.write(this.stderr, '')
      this.heading('Next steps')
      for (const step of definition.steps) {
        this.paragraph(step, interactive ? '  • ' : '  - ')
      }
    }

    if (diagnostic.retry !== undefined) {
      this.write(this.stderr, '')
      this.heading('Retry')
      // Commands and identifiers are not reflowed or truncated.
      const retry = this.value(this.stderr, diagnostic.retry, Number.POSITIVE_INFINITY)
      this.write(this.stderr, `  $ ${this.paint(this.stderr, 'cyan', retry)}`)
    }
  }

  private fact(label: string, value: string): void {
    const name = this.value(this.stderr, label, MAX_LABEL_LENGTH).padEnd(FACT_WIDTH)
    this.write(
      this.stderr,
      `  ${this.paint(this.stderr, 'bold', name)} ${this.value(this.stderr, value)}`,
    )
  }

  private heading(value: string): void {
    this.write(this.stderr, `  ${this.paint(this.stderr, 'bold', value)}`)
  }

  private paragraph(value: string, prefix = '  '): void {
    const text = this.value(this.stderr, value)

    if (!this.interactive(this.stderr)) {
      this.write(this.stderr, `${prefix}${text}`)
      return
    }

    const width = Math.max(20, Math.min(this.stderr.columns || 80, 120) - prefix.length)
    const continuation = ' '.repeat(prefix.length)

    for (const [index, line] of wrap(text, width).entries()) {
      this.write(this.stderr, `${index === 0 ? prefix : continuation}${line}`)
    }
  }

  private interactive(stream: Output): boolean {
    return stream.isTTY === true
  }

  private paint(stream: Output, format: Style, value: string): string {
    if (!this.interactive(stream) || process.env.NO_COLOR !== undefined || this.color === 'never') {
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
    stream.write(`${value}\n`)
  }
}
