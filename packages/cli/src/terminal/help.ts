import { Help, type Command } from 'commander'
import type { Reporter } from './reporter'

export interface HelpContent {
  examples: readonly string[]
  safety: readonly string[]
}

function commandPath(command: Command): string {
  const names: string[] = []
  for (let current: Command | null = command; current; current = current.parent) {
    names.unshift(current.name())
  }
  return names.join(' ')
}

/**
 * Presentation is resolved when help is rendered, after Commander has parsed
 * the global color option. Subcommands inherit this configuration.
 */
export function configureHelp(
  program: Command,
  presentation: () => Reporter,
): (command: Command, content: HelpContent) => void {
  const contents = new WeakMap<Command, HelpContent>()
  program.configureOutput({
    getOutHelpWidth: () => presentation().width('stdout'),
    getErrHelpWidth: () => presentation().width('stderr'),
    getOutHasColors: () => presentation().colors('stdout'),
    getErrHasColors: () => presentation().colors('stderr'),
  })
  program.configureHelp({
    showGlobalOptions: true,
    commandDescription: () => '',
    prepareContext(this: Help, contextOptions: Parameters<Help['prepareContext']>[0]) {
      Help.prototype.prepareContext.call(this, contextOptions)
      const reporter = presentation()
      const stream = contextOptions.error ? 'stderr' : 'stdout'
      const plain = (value: string) => reporter.fragment(value, stream)
      const bold = (value: string) => reporter.style('bold', value, stream)
      this.styleTitle = value => reporter.style(['bold', 'cyan'], value, stream)
      this.styleCommandText = bold
      this.styleSubcommandText = value => (value.startsWith('[') || value.startsWith('<') ? plain(value) : bold(value))
      this.styleArgumentText = plain
      this.styleDescriptionText = plain
      this.styleOptionText = value =>
        plain(value).replace(
          /(^|[\s,|])(--?[^\s,|]+)/g,
          (_match: string, prefix: string, flag: string) => `${prefix}${bold(flag)}`,
        )
    },
    formatHelp(command, helper) {
      const width = helper.helpWidth ?? 80
      const output = [
        helper.styleCommandText(commandPath(command)),
        helper.boxWrap(helper.styleDescriptionText(command.description()), width),
        '',
        Help.prototype.formatHelp.call(helper, command, helper),
      ]
      const content = contents.get(command)
      if (content) {
        output.push(
          ...helper.formatItemList(
            'Examples:',
            content.examples.map(example => `  ${helper.styleDescriptionText(example)}`),
            helper,
          ),
          ...helper.formatItemList(
            'Safety:',
            content.safety.map(
              paragraph =>
                `  ${helper
                  .boxWrap(helper.styleDescriptionText(paragraph), Math.max(1, width - 2))
                  .replace(/\n/g, '\n  ')}`,
            ),
            helper,
          ),
        )
      }
      return output.join('\n')
    },
  })
  return (command, content) => {
    contents.set(command, content)
  }
}
