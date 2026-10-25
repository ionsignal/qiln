import type { Failure, Section } from './output'

export interface Install {
  name: string
  version: string
  architecture: string
}

export interface Transaction {
  installs: Install[]
  configures: string[]
  upgrades: string[]
  removals: string[]
}

/**
 * What a planner needs from a resolved transaction. `label` is authored wording
 * that names the package set in each reason.
 */
export interface TransactionNeeds {
  missing: readonly string[]
  architecture: string
  maximum: number
  label: string
}

/**
 * Package specs are approved evidence, but they become arguments to APT, so
 * only plain `name=version` words are accepted.
 */
export const PACKAGE_SPEC = /^[a-z0-9][a-z0-9+.-]*=[A-Za-z0-9][A-Za-z0-9.+:~-]*$/

/**
 * Handles upgrades, which carry the previous version in brackets, and the
 * trailing `[]` that APT appends to some lines. Unrecognized `Inst` and `Conf`
 * lines are refused rather than guessed.
 */
const INSTALL = /^Inst (\S+) (?:\[([^\]]+)\] )?\((\S+) .*\[([A-Za-z0-9]+)\]\)(?: \[[^\]]*\])?$/
const CONFIGURE = /^Conf (\S+) (?:\[[^\]]+\] )?\(\S+ .*\)(?: \[[^\]]*\])?$/
const REMOVAL = /^(?:Remv|Purg) (\S+)/

/**
 * A failed simulation means APT could not resolve the packages, which the
 * planner reports as a refusal.
 */
export function transactionOf(section: Section, failure: Failure): Transaction | null {
  if (section.status !== 0) {
    return null
  }
  const installs: Install[] = []
  const configures: string[] = []
  const upgrades: string[] = []
  const removals: string[] = []
  for (const line of section.lines) {
    const removal = REMOVAL.exec(line)
    if (line.startsWith('Inst ')) {
      const match = INSTALL.exec(line)
      if (match === null) {
        throw failure('APT reported an installation in an unrecognized format.')
      }
      if (match[2] === undefined) {
        installs.push({ name: match[1], version: match[3], architecture: match[4] })
      } else {
        upgrades.push(match[1])
      }
    } else if (line.startsWith('Conf ')) {
      const match = CONFIGURE.exec(line)
      if (match === null) {
        throw failure('APT reported a configuration in an unrecognized format.')
      }
      configures.push(match[1])
    } else if (removal !== null) {
      removals.push(removal[1])
    }
  }
  return { installs, configures, upgrades, removals }
}

/**
 * Every reason a simulated transaction cannot be offered for approval, in a
 * fixed order. An unresolved transaction yields one reason, because nothing
 * else can be judged. Which packages are missing, and what a clean transaction
 * leads to, stay with each planner.
 */
export function transactionViolations(transaction: Transaction | null, needs: TransactionNeeds): string[] {
  if (transaction === null) {
    return [`APT could not resolve the ${needs.label} packages from its current package lists.`]
  }
  const violations: string[] = []
  const expect = (passed: boolean, reason: string) => {
    if (!passed) {
      violations.push(reason)
    }
  }
  expect(
    transaction.upgrades.length === 0 && transaction.removals.length === 0,
    `Installing the ${needs.label} packages would upgrade or remove other packages.`,
  )
  expect(transaction.installs.length <= needs.maximum, `APT planned more than ${needs.maximum} new packages.`)
  expect(
    transaction.configures.every(name => transaction.installs.some(change => change.name === name)),
    'APT planned to configure a package that is not among the new installations, which indicates a half-configured package state.',
  )
  expect(
    needs.missing.every(name => transaction.installs.some(change => change.name === name)),
    `APT did not plan to install every ${needs.label} package.`,
  )
  expect(
    transaction.installs.every(change => change.architecture === needs.architecture || change.architecture === 'all'),
    'APT planned a package for a different architecture.',
  )
  return violations
}
