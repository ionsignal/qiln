import type { InstallerError } from '../diagnostic/error'

export interface Section {
  status: number
  lines: string[]
}

/**
 * Builds the domain's authored diagnostic. Raw output, device names, and tool
 * messages never enter it.
 */
export type Failure = (reason: string) => InstallerError

const BEGIN = /^#qiln:begin (\w+)$/
const END = /^#qiln:end (\w+) ([0-9]+)$/

/**
 * Lines of the form `tag value`, where the value is the rest of the line.
 */
export function tagged(lines: readonly string[]): [string, string][] {
  return lines
    .filter(line => line !== '')
    .map((line): [string, string] => {
      const space = line.indexOf(' ')
      return space < 0 ? [line, ''] : [line.slice(0, space), line.slice(space + 1)]
    })
}

/**
 * Binds the section readers to one domain's failure, so each inspection keeps
 * its own diagnostic code while the parsing rules stay shared.
 */
export function outputOf(failure: Failure) {
  /**
   * Splits the script output into its named sections. Anything outside a section
   * is ignored, and unbalanced or repeated sections are refused.
   */
  function sections(output: string): Map<string, Section> {
    const found = new Map<string, Section>()
    let open: { name: string; lines: string[] } | null = null
    for (const line of output.split('\n')) {
      const begin = BEGIN.exec(line)
      const end = END.exec(line)
      if (begin !== null) {
        if (open !== null || found.has(begin[1])) {
          throw failure('The inspection output is malformed.')
        }
        open = { name: begin[1], lines: [] }
      } else if (end !== null) {
        if (open === null || open.name !== end[1]) {
          throw failure('The inspection output is malformed.')
        }
        found.set(open.name, { status: Number(end[2]), lines: open.lines })
        open = null
      } else if (open !== null) {
        open.lines.push(line)
      }
    }
    if (open !== null) {
      throw failure('The inspection output ended inside a section.')
    }
    return found
  }

  /**
   * Tagged lines whose tags must be unique.
   */
  function fields(lines: readonly string[]): Map<string, string> {
    const values = new Map<string, string>()
    for (const [tag, value] of tagged(lines)) {
      if (values.has(tag)) {
        throw failure('The inspection output repeats a field.')
      }
      values.set(tag, value)
    }
    return values
  }

  function required(found: ReadonlyMap<string, Section>, name: string): Section {
    const section = found.get(name)
    if (section === undefined) {
      throw failure(`The ${name} section is missing from the inspection output.`)
    }
    return section
  }

  function succeeded(found: ReadonlyMap<string, Section>, name: string): Section {
    const section = required(found, name)
    if (section.status !== 0) {
      throw failure(`The ${name} inspection step failed.`)
    }
    return section
  }

  /**
   * Indicators are exactly `yes` or `no`. Anything else is malformed output and
   * never reads as `no`.
   */
  function yesNo(value: string | undefined, subject: string): boolean {
    if (value !== 'yes' && value !== 'no') {
      throw failure(`The ${subject} indicator is missing or unrecognized.`)
    }
    return value === 'yes'
  }

  return { sections, fields, required, succeeded, yesNo }
}
