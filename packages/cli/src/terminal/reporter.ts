import { stripVTControlCharacters, styleText } from 'node:util'
import { catalog } from '../diagnostic/catalog'
import { InstallerError } from '../diagnostic/error'

const LABEL_WIDTH = 18
const BADGE_WIDTH = 13
const MIN_FACT_VALUE_WIDTH = 24
const MAX_VALUE_LENGTH = 2_000
const MAX_LABEL_LENGTH = 50

const TERMINAL_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g
const HELP_CONTROL_PATTERN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g
const TEMPORARY_PATH_PATTERN = /(^|[\s"'`(])(?:\/tmp|\/var\/tmp|\/private\/tmp)(?:\/[^\s"'`)]+)?/g

export type ColorMode = 'auto' | 'always' | 'never'
export type OutputStream = 'stdout' | 'stderr'
export type Outcome = 'verified' | 'created' | 'reused' | 'imported' | 'transferred'
export type PromptTone = 'input' | 'approval'

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
    .replace(/[^\x20-\x7e\t\n]/g, '?')
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

  public width(destination: OutputStream): number {
    const stream = this.stream(destination)
    return this.interactive(stream) ? Math.max(20, Math.min(stream.columns || 80, 120)) : 80
  }

  public colors(destination: OutputStream): boolean {
    return this.canColor(this.stream(destination))
  }

  public fragment(value: string, destination: OutputStream = 'stdout'): string {
    const sanitized = stripVTControlCharacters(value).replace(HELP_CONTROL_PATTERN, ' ')
    return this.interactive(this.stream(destination)) ? sanitized : ascii(sanitized)
  }

  public style(format: Style, value: string, destination: OutputStream = 'stdout'): string {
    return this.paint(this.stream(destination), format, this.fragment(value, destination))
  }

  public header(command: string, description: string): void {
    const interactive = this.interactive(this.stdout)
    const separator = interactive ? ' — ' : ' - '
    const title = `qiln ${this.value(this.stdout, command, 80)}${separator}${this.value(this.stdout, description, 160)}`
    this.write(
      this.stdout,
      interactive
        ? `${this.paint(this.stdout, ['cyan', 'bold'], '●')} ${this.paint(this.stdout, 'bold', title)}`
        : this.paint(this.stdout, 'bold', title),
    )
    this.stdoutWritten = true
  }

  public promptSelection(label: string, choices: readonly string[]): void {
    if (this.stdoutWritten) {
      this.write(this.stdout, '')
    }
    const title = this.value(this.stdout, label, Number.POSITIVE_INFINITY)
    this.write(this.stdout, this.paint(this.stdout, 'bold', title))
    for (const [index, choice] of choices.entries()) {
      const number = this.paint(this.stdout, 'cyan', `${index + 1}.`)
      const description = this.value(this.stdout, choice, Number.POSITIVE_INFINITY)
      this.write(this.stdout, `  ${number} ${description}`)
    }
    this.write(this.stdout, '')
    this.stdoutWritten = true
  }

  /**
   * Readline owns question output and redraws. Returning styled text preserves
   * its input handling while sharing the reporter's output state.
   */
  public promptQuestion(label: string, defaultValue?: string, tone: PromptTone = 'input'): string {
    const format: Style = tone === 'approval' ? ['yellow', 'bold'] : ['cyan', 'bold']
    const promptLabel = this.value(this.stdout, label, Number.POSITIVE_INFINITY)
    const defaultHint =
      defaultValue === undefined
        ? ''
        : this.paint(this.stdout, 'dim', ` [${this.value(this.stdout, defaultValue, Number.POSITIVE_INFINITY)}]`)
    this.stdoutWritten = true
    return `${this.paint(this.stdout, format, promptLabel)}${defaultHint}: `
  }

  public section(name: string): void {
    if (this.stdoutWritten) {
      this.write(this.stdout, '')
    }
    const title = this.value(this.stdout, name, 80)
    this.write(
      this.stdout,
      this.interactive(this.stdout)
        ? `  ${this.paint(this.stdout, 'bold', title)}`
        : this.paint(this.stdout, 'bold', title),
    )
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
      this.write(
        this.stdout,
        `+ ${this.paint(this.stdout, 'bold', name)} ${this.paint(this.stdout, OUTCOME_STYLES[outcome], badge)} ${value}`,
      )
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
      this.write(
        this.stdout,
        `${this.paint(this.stdout, ['yellow', 'bold'], '!')} ${this.paint(this.stdout, 'bold', label)} ${''.padEnd(BADGE_WIDTH)} ${detail}`,
      )
    }
    this.stdoutWritten = true
  }

  public info(message: string): void {
    this.message('Info', message, 'cyan')
  }

  public action(message: string): void {
    this.message('Action required', message, ['yellow', 'bold'])
  }

  public line(value: string): void {
    this.write(this.stdout, this.value(this.stdout, value, Number.POSITIVE_INFINITY))
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
        : this.paint(this.stdout, 'bold', detail),
    )
    this.stdoutWritten = true
  }

  /**
   * Commander owns help wrapping and columns. Emit adapter-formatted chunks
   * unchanged so their whitespace, controlled ANSI, and destination survive.
   */
  public help(text: string, destination: OutputStream = 'stdout'): void {
    this.stream(destination).write(text)
    if (destination === 'stdout' && text.length > 0) {
      this.stdoutWritten = true
    }
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
    const codeLabel = `${diagnostic.code}`
    const codeLabelWidth = this.value(this.stderr, codeLabel, MAX_LABEL_LENGTH).length
    const factLabelWidth = Math.max(
      0,
      ...diagnostic.facts.map(([label]) => this.value(this.stderr, label, MAX_LABEL_LENGTH).length),
    )
    this.write(this.stderr, '')
    this.heading(title)
    this.fact(codeLabel, definition.explanation, codeLabelWidth, 'gray', 'red')
    for (const [label, value] of diagnostic.facts) {
      this.fact(label, value, factLabelWidth)
    }
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
      const retry = this.value(this.stderr, diagnostic.retry, Number.POSITIVE_INFINITY)
      this.write(this.stderr, `  $ ${this.paint(this.stderr, 'cyan', retry)}`)
    }
    this.write(this.stderr, '')
  }

  private message(label: string, message: string, format: Style): void {
    const prefix = `${this.interactive(this.stdout) ? '  ' : ''}${label}: `
    const continuation = ' '.repeat(prefix.length)
    const detail = this.value(this.stdout, message)
    const width = Math.max(1, this.width('stdout') - prefix.length)
    for (const [index, line] of wrap(detail, width).entries()) {
      this.write(this.stdout, `${index === 0 ? this.paint(this.stdout, format, prefix) : continuation}${line}`)
    }
    this.stdoutWritten = true
  }

  private fact(label: string, value: string, labelWidth: number, valueStyle?: Style, labelStyle: Style = 'dim'): void {
    const name = this.value(this.stderr, label, MAX_LABEL_LENGTH)
    const detail = this.value(this.stderr, value)
    const width = this.width('stderr')
    const valueColumn = 2 + labelWidth + 2
    const stacked = width - valueColumn < MIN_FACT_VALUE_WIDTH
    const indentation = stacked ? 4 : valueColumn
    if (stacked) {
      this.write(this.stderr, `  ${this.paint(this.stderr, labelStyle, name)}`)
    }
    for (const [index, line] of wrap(detail, Math.max(1, width - indentation)).entries()) {
      const prefix =
        !stacked && index === 0
          ? `  ${this.paint(this.stderr, labelStyle, name.padEnd(labelWidth))}  `
          : ' '.repeat(indentation)
      const valueText = valueStyle === undefined ? line : this.paint(this.stderr, valueStyle, line)
      this.write(this.stderr, `${prefix}${valueText}`)
    }
  }

  private heading(value: string): void {
    this.write(this.stderr, `  ${this.paint(this.stderr, 'bold', value)}`)
  }

  private paragraph(value: string, prefix = '  ', prefixStyle?: Style): void {
    const text = this.value(this.stderr, value)
    const width = Math.max(1, this.width('stderr') - prefix.length)
    const firstPrefix = prefixStyle === undefined ? prefix : this.paint(this.stderr, prefixStyle, prefix)
    const continuation = ' '.repeat(prefix.length)
    for (const [index, line] of wrap(text, width).entries()) {
      this.write(this.stderr, `${index === 0 ? firstPrefix : continuation}${line}`)
    }
  }

  private stream(destination: OutputStream): Output {
    return destination === 'stderr' ? this.stderr : this.stdout
  }

  private interactive(stream: Output): boolean {
    return stream.isTTY === true
  }

  private canColor(stream: Output): boolean {
    if (process.env.NO_COLOR !== undefined || this.color === 'never') {
      return false
    }
    return this.color === 'always' || (this.interactive(stream) && stream.hasColors?.() === true)
  }

  private paint(stream: Output, format: Style, value: string): string {
    if (!this.canColor(stream)) {
      return value
    }
    return styleText(format, value, {
      stream,
      validateStream: false,
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
