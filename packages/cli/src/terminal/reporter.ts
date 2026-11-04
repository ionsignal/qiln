import { clearLine, cursorTo } from 'node:readline'
import { stripVTControlCharacters, styleText } from 'node:util'
import { catalog } from '../diagnostic/catalog'
import { InstallerError, type DiagnosticFact } from '../diagnostic/error'

const LABEL_WIDTH = 26
const BADGE_WIDTH = 13
const ROW_DETAIL_COLUMN = 2 + LABEL_WIDTH + 1 + BADGE_WIDTH + 1
const MIN_FACT_VALUE_WIDTH = 24
const MAX_VALUE_LENGTH = 2_000
const MAX_LABEL_LENGTH = 50
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const FRAME_INTERVAL_MS = 200
const HEARTBEAT_INTERVAL_MS = 60_000
const ELAPSED_AFTER_SECONDS = 5

const TERMINAL_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g
const HELP_CONTROL_PATTERN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g
const TEMPORARY_PATH_PATTERN = /(^|[\s"'`(])(?:\/tmp|\/var\/tmp|\/private\/tmp)(?:\/[^\s"'`)]+)?/g

export type ColorMode = 'auto' | 'always' | 'never'
export type OutputStream = 'stdout' | 'stderr'
export type Outcome = 'verified' | 'created' | 'reused' | 'imported' | 'transferred' | 'pending'
export type PromptTone = 'input' | 'approval'
export type Tone = 'neutral' | 'success' | 'warning' | 'danger'
export type TableCell = string | { text: string; tone: Tone }

type Output = NodeJS.WriteStream
type Style = Parameters<typeof styleText>[0]

/**
 * The kind of the last block written. Spacing between blocks derives from it,
 * so callers never insert blank lines themselves.
 */
type BlockKind =
  | 'header'
  | 'section'
  | 'row'
  | 'table'
  | 'facts'
  | 'state'
  | 'list'
  | 'message'
  | 'prompt'
  | 'summary'
  | 'external'

export interface ReporterOptions {
  color?: ColorMode
  stdout?: Output
  stderr?: Output
}

/**
 * A transient activity row. It is never evidence: it ends in `finish`, `drop`,
 * or a thrown diagnostic, and only `finish` leaves a permanent row behind.
 */
export interface LiveRow {
  update(detail: string): void
  finish(outcome: Outcome, detail: string): void
  drop(): void
}

interface ActiveRow {
  label: string
  detail: string
  startedAt: number
  frame: number
  drawn: boolean
  timer: NodeJS.Timeout
}

const OUTCOME_STYLES: Record<Outcome, Style> = {
  pending: ['yellow', 'bold'],
  verified: ['green', 'bold'],
  created: ['green', 'bold'],
  reused: ['cyan', 'bold'],
  imported: ['magenta', 'bold'],
  transferred: ['blue', 'bold'],
}

const DONE_SYMBOL: readonly [string, string] = ['✓', '+']

const OUTCOME_SYMBOLS: Record<Outcome, readonly [string, string]> = {
  pending: ['○', '-'],
  verified: DONE_SYMBOL,
  created: DONE_SYMBOL,
  reused: DONE_SYMBOL,
  imported: DONE_SYMBOL,
  transferred: DONE_SYMBOL,
}

const TONE_STYLES: Record<Tone, Style> = {
  neutral: 'bold',
  success: ['green', 'bold'],
  warning: ['yellow', 'bold'],
  danger: ['red', 'bold'],
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

  private lastLineBlank = true
  private previous: BlockKind | null = null
  private active: ActiveRow | null = null
  private muted = 0

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
    this.begin('header')
    const interactive = this.interactive(this.stdout)
    const separator = interactive ? ' — ' : ' - '
    const title = `qiln ${this.value(this.stdout, command, 80)}${separator}${this.value(this.stdout, description, 160)}`
    this.write(
      this.stdout,
      interactive
        ? `${this.paint(this.stdout, ['cyan', 'bold'], '●')} ${this.paint(this.stdout, 'bold', title)}`
        : this.paint(this.stdout, 'bold', title),
    )
  }

  public promptSelection(label: string, choices: readonly string[]): void {
    this.begin('prompt')
    const gutter = this.gutter(this.stdout)
    this.block('stdout', gutter, gutter.length, this.value(this.stdout, label, Number.POSITIVE_INFINITY), 'bold')
    for (const [index, choice] of choices.entries()) {
      const number = `${index + 1}.`
      const lead = `${gutter}  ${this.paint(this.stdout, 'cyan', number)} `
      this.block(
        'stdout',
        lead,
        gutter.length + 2 + number.length + 1,
        this.value(this.stdout, choice, Number.POSITIVE_INFINITY),
      )
    }
  }

  /**
   * Readline owns question output and redraws. Returning styled text preserves
   * its input handling while sharing the reporter's output state.
   */
  public promptQuestion(label: string, defaultValue?: string, tone: PromptTone = 'input'): string {
    this.begin('prompt')
    const format: Style = tone === 'approval' ? ['yellow', 'bold'] : ['cyan', 'bold']
    const promptLabel = this.value(this.stdout, label, Number.POSITIVE_INFINITY)
    const defaultHint =
      defaultValue === undefined
        ? ''
        : this.paint(this.stdout, 'dim', ` [${this.value(this.stdout, defaultValue, Number.POSITIVE_INFINITY)}]`)
    this.lastLineBlank = false
    return `${this.gutter(this.stdout)}${this.paint(this.stdout, format, promptLabel)}${defaultHint}: `
  }

  public section(name: string): void {
    this.begin('section')
    this.write(this.stdout, `${this.gutter(this.stdout)}${this.paint(this.stdout, 'bold', this.value(this.stdout, name, 80))}`)
  }

  public row(outcome: Outcome, label: string, detail: string): void {
    this.begin('row')
    const style = OUTCOME_STYLES[outcome]
    const gutter = this.gutter(this.stdout)
    const [fancy, plain] = OUTCOME_SYMBOLS[outcome]
    const symbol = this.interactive(this.stdout) ? fancy : plain
    const name = this.value(this.stdout, label, LABEL_WIDTH).padEnd(LABEL_WIDTH)
    const badge = `[${outcome}]`.padEnd(BADGE_WIDTH)
    const lead = `${gutter}${this.paint(this.stdout, style, symbol)} ${this.paint(this.stdout, 'bold', name)} ${this.paint(this.stdout, style, badge)} `
    this.block('stdout', lead, gutter.length + ROW_DETAIL_COLUMN, this.value(this.stdout, detail))
  }

  /**
   * One transient row for an activity that is in progress. On a terminal it is
   * redrawn in place with a spinner and elapsed time. Elsewhere nothing prints
   * until `finish`, except a heartbeat line for activities that last a minute
   * or more. A new live row drops the previous one.
   */
  public live(label: string, detail: string): LiveRow {
    if (this.muted > 0) {
      return { update: () => {}, finish: () => {}, drop: () => {} }
    }
    this.dropLive()
    this.begin('row')
    const interactive = this.interactive(this.stdout)
    const active: ActiveRow = {
      label,
      detail,
      startedAt: Date.now(),
      frame: 0,
      drawn: false,
      timer: setInterval(() => this.tick(active), interactive ? FRAME_INTERVAL_MS : HEARTBEAT_INTERVAL_MS).unref(),
    }
    this.active = active
    if (interactive) {
      this.draw(active)
    }
    return {
      update: next => {
        if (this.active !== active) {
          return
        }
        active.detail = next
        if (active.drawn) {
          this.draw(active)
        }
      },
      finish: (outcome, next) => {
        if (this.active === active) {
          this.dropLive()
        }
        this.row(outcome, label, next)
      },
      drop: () => {
        if (this.active === active) {
          this.dropLive()
        }
      },
    }
  }

  public facts(entries: readonly DiagnosticFact[]): void {
    if (entries.length === 0) {
      return
    }
    this.begin('facts')
    for (const [label, value] of entries) {
      this.fact('stdout', label, value, LABEL_WIDTH)
    }
  }

  public state(label: string, value: string, tone: Tone): void {
    this.begin('state')
    const marker = this.interactive(this.stdout) ? '‣' : '*'
    this.fact('stdout', label, `${marker} ${value}`, LABEL_WIDTH, TONE_STYLES[tone], 'bold')
  }

  /**
   * Only the last column wraps, hanging under its own column, so rows that
   * already fit are unchanged.
   */
  public table(headers: readonly string[], rows: readonly (readonly TableCell[])[]): void {
    this.begin('table')
    const indentation = this.gutter(this.stdout)
    const lastColumn = headers.length - 1
    const text = (cell: TableCell) => this.value(this.stdout, typeof cell === 'string' ? cell : cell.text)
    const styleOf = (cell: TableCell): Style | undefined => (typeof cell === 'string' ? undefined : TONE_STYLES[cell.tone])
    const widths = headers.map((header, column) =>
      Math.max(this.value(this.stdout, header, MAX_LABEL_LENGTH).length, ...rows.map(row => text(row[column]).length)),
    )
    const pad = (value: string, column: number) => (column === lastColumn ? value : value.padEnd(widths[column]))
    const heading = headers.map((header, column) =>
      this.paint(this.stdout, 'bold', pad(this.value(this.stdout, header, MAX_LABEL_LENGTH), column)),
    )
    this.write(this.stdout, `${indentation}${heading.join('  ')}`)
    const hanging = indentation.length + widths.slice(0, lastColumn).reduce((total, width) => total + width + 2, 0)
    for (const row of rows) {
      const lead = row
        .slice(0, lastColumn)
        .map((cell, column) => {
          const content = text(cell).padEnd(widths[column])
          const style = styleOf(cell)
          return `${style === undefined ? content : this.paint(this.stdout, style, content)}  `
        })
        .join('')
      this.block('stdout', `${indentation}${lead}`, hanging, text(row[lastColumn]), styleOf(row[lastColumn]))
    }
  }

  /**
   * A bulleted or numbered list whose continuation lines hang under the text.
   */
  public list(items: readonly string[], numbered = false): void {
    if (items.length === 0) {
      return
    }
    this.begin('list')
    const gutter = this.gutter(this.stdout)
    const bullet = this.interactive(this.stdout) ? '•' : '-'
    for (const [index, item] of items.entries()) {
      const marker = numbered ? `${index + 1}.` : bullet
      this.block(
        'stdout',
        `${gutter}${this.paint(this.stdout, 'cyan', marker)} `,
        gutter.length + marker.length + 1,
        this.value(this.stdout, item),
      )
    }
  }

  public notice(message: string): void {
    this.message('Notice', message, ['yellow', 'bold'])
  }

  public notices(messages: readonly string[]): void {
    for (const message of messages) {
      this.notice(message)
    }
  }

  public info(message: string): void {
    this.message('Info', message, 'cyan')
  }

  public action(message: string): void {
    this.message('Action required', message, ['yellow', 'bold'])
  }

  public summary(message: string): void {
    this.begin('summary')
    const detail = this.value(this.stdout, message)
    this.write(
      this.stdout,
      this.interactive(this.stdout)
        ? `${this.paint(this.stdout, ['cyan', 'bold'], '●')} ${this.paint(this.stdout, 'bold', detail)}`
        : this.paint(this.stdout, 'bold', detail),
    )
  }

  /**
   * Mutes block output for the duration of `run`. Diagnostics go to stderr and
   * are never muted, so a refusal still reaches the operator. Nothing that
   * prompts may run inside it.
   */
  public async silent<T>(run: () => Promise<T>): Promise<T> {
    this.muted += 1
    try {
      return await run()
    } finally {
      this.muted -= 1
    }
  }

  /**
   * Ends the current block with one blank line and clears live state before an
   * external process writes to the terminal.
   */
  public handOff(): void {
    this.dropLive()
    this.ensureBlank()
    this.previous = 'external'
    this.lastLineBlank = false
  }

  /**
   * Commander owns help wrapping and columns. Emit adapter-formatted chunks
   * unchanged so their whitespace, controlled ANSI, and destination survive.
   */
  public help(text: string, destination: OutputStream = 'stdout'): void {
    this.erase()
    this.stream(destination).write(text)
    if (destination === 'stdout' && text.length > 0) {
      this.lastLineBlank = false
    }
  }

  public version(version: string): void {
    this.write(this.stdout, `qiln ${this.value(this.stdout, version, 80)}`)
  }

  public failure(error: unknown): void {
    this.dropLive()
    const diagnostic =
      error instanceof InstallerError
        ? error
        : new InstallerError({
            code: 'INTERNAL_ERROR',
            retry: 'qiln --help',
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
    this.write(this.stderr, '')
    this.fact('stderr', codeLabel, definition.explanation, codeLabelWidth, 'gray', 'red')
    if (diagnostic.facts.length > 0) {
      this.write(this.stderr, '')
      this.heading('Details')
    }
    for (const [label, value] of diagnostic.facts) {
      this.fact('stderr', label, value, factLabelWidth)
    }
    if (definition.steps.length > 0) {
      this.write(this.stderr, '')
      this.heading('Next steps')
      for (const step of definition.steps) {
        this.paragraph(step, interactive ? '  • ' : '  - ', 'grey', 'cyan')
      }
    }
    if (diagnostic.retry !== undefined) {
      this.write(this.stderr, '')
      this.heading('Retry')
      this.paragraph(diagnostic.retry, '  $ ', 'grey', 'cyan')
    }
    this.write(this.stderr, '')
  }

  /**
   * Every block emitter starts here. A section, summary or prompt opens with a
   * blank line, and any other block gets one only when its kind differs from the
   * previous one. Content directly under a section header gets none.
   */
  private begin(kind: BlockKind): void {
    if (this.muted > 0) {
      return
    }
    if (kind === 'prompt') {
      this.dropLive()
    }
    this.erase()
    const previous = this.previous
    const gap =
      previous !== null &&
      (kind === 'section' ||
        kind === 'summary' ||
        (previous !== 'section' && (kind === 'prompt' || kind !== previous)))
    if (gap) {
      this.ensureBlank()
    }
    this.previous = kind
  }

  private ensureBlank(): void {
    if (!this.lastLineBlank) {
      this.write(this.stdout, '')
    }
  }

  private message(label: string, message: string, format: Style): void {
    this.begin('message')
    const prefix = `${this.gutter(this.stdout)}${label}: `
    this.block('stdout', this.paint(this.stdout, format, prefix), prefix.length, this.value(this.stdout, message))
  }

  private fact(
    destination: OutputStream,
    label: string,
    value: string,
    labelWidth: number,
    valueStyle?: Style,
    labelStyle: Style = 'dim',
  ): void {
    const stream = this.stream(destination)
    const name = this.value(stream, label, MAX_LABEL_LENGTH)
    const detail = this.value(stream, value)
    const indent = destination === 'stdout' ? this.gutter(stream) : '  '
    const valueColumn = indent.length + labelWidth + 2
    const stacked = name.length > labelWidth || this.width(destination) - valueColumn < MIN_FACT_VALUE_WIDTH
    const hanging = stacked ? indent.length + 2 : valueColumn
    let lead: string
    if (stacked) {
      this.write(stream, `${indent}${this.paint(stream, labelStyle, name)}`)
      lead = ' '.repeat(hanging)
    } else {
      lead = `${indent}${this.paint(stream, labelStyle, name.padEnd(labelWidth))}  `
    }
    this.block(destination, lead, hanging, detail, valueStyle)
  }

  private heading(value: string): void {
    this.write(this.stderr, `  ${this.paint(this.stderr, 'bold', value)}`)
  }

  private paragraph(value: string, prefix = '  ', prefixStyle?: Style, valueStyle?: Style): void {
    const lead = prefixStyle === undefined ? prefix : this.paint(this.stderr, prefixStyle, prefix)
    this.block('stderr', lead, prefix.length, this.value(this.stderr, value), valueStyle)
  }

  /**
   * Wraps already sanitized text so continuation lines hang under the first
   * line's text. `lead` is the styled first-line prefix, and `hanging` is its
   * visible width.
   */
  private block(destination: OutputStream, lead: string, hanging: number, text: string, style?: Style): void {
    const stream = this.stream(destination)
    const margin = ' '.repeat(hanging)
    for (const [index, line] of wrap(text, Math.max(1, this.width(destination) - hanging)).entries()) {
      this.write(stream, `${index === 0 ? lead : margin}${style === undefined ? line : this.paint(stream, style, line)}`)
    }
  }

  private gutter(stream: Output): string {
    return this.interactive(stream) ? '  ' : ''
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
    if (stream === this.stdout && this.muted > 0) {
      return
    }
    this.erase()
    stream.write(`${value}\n`)
    if (stream === this.stdout) {
      this.lastLineBlank = value === ''
    }
  }

  private tick(active: ActiveRow): void {
    if (this.active !== active) {
      return
    }
    if (this.interactive(this.stdout)) {
      active.frame += 1
      this.draw(active)
    } else {
      this.heartbeat(active)
    }
  }

  private draw(active: ActiveRow): void {
    const stream = this.stdout
    const gutter = this.gutter(stream)
    const seconds = Math.floor((Date.now() - active.startedAt) / 1_000)
    const elapsed = seconds >= ELAPSED_AFTER_SECONDS ? ` · ${seconds}s` : ''
    const room = Math.max(1, this.width('stdout') - gutter.length - ROW_DETAIL_COLUMN - 1)
    const detail = `${this.value(stream, active.detail, Math.max(4, room - elapsed.length))}${elapsed}`
    const spinner = SPINNER_FRAMES[active.frame % SPINNER_FRAMES.length]
    const name = this.value(stream, active.label, LABEL_WIDTH).padEnd(LABEL_WIDTH)
    const badge = '[working]'.padEnd(BADGE_WIDTH)
    clearLine(stream, 0)
    cursorTo(stream, 0)
    stream.write(
      `${gutter}${this.paint(stream, 'dim', spinner)} ${this.paint(stream, 'bold', name)} ${this.paint(stream, 'dim', badge)} ${detail}`,
    )
    active.drawn = true
  }

  /**
   * Without a terminal the row prints nothing until it finishes, so a long
   * activity gets one raw line per interval. It does not end the live row.
   */
  private heartbeat(active: ActiveRow): void {
    const seconds = Math.round((Date.now() - active.startedAt) / 1_000)
    this.stdout.write(
      `still working: ${this.value(this.stdout, `${active.label} · ${active.detail} · ${seconds}s elapsed`)}\n`,
    )
    this.lastLineBlank = false
  }

  /**
   * Removes the transient line while keeping its row active, so other output can
   * appear first and the next frame redraws it below.
   */
  private erase(): void {
    if (this.active?.drawn) {
      clearLine(this.stdout, 0)
      cursorTo(this.stdout, 0)
      this.active.drawn = false
    }
  }

  private dropLive(): void {
    if (this.active === null) {
      return
    }
    this.erase()
    clearInterval(this.active.timer)
    this.active = null
  }
}
