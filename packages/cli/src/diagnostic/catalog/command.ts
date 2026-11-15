import { entry } from './define'

export const commandDiagnostics = Object.freeze({
  PREFLIGHT_PROCESS_START_FAILED: entry(
    'Required local command could not be started',
    'Qiln cannot establish or generate required state when a supporting command cannot start.',
    'Verify that the command is installed, executable, and accessible to the developer.',
  ),
  PREFLIGHT_PROCESS_TIMEOUT: entry(
    'Required local command exceeded its deadline',
    'Qiln cannot safely continue after an incomplete local operation.',
    'Inspect the command and the host state it requires, then resolve the delay manually.',
  ),
  PREFLIGHT_PROCESS_OUTPUT_LIMIT_EXCEEDED: entry(
    'Required local command exceeded its output limit',
    'Qiln cannot safely retain or interpret an unbounded command response.',
    'Inspect the command and its configuration manually. Qiln will not suppress or retry the response automatically.',
  ),
  INVALID_ARGUMENT: entry(
    'Command-line arguments are invalid',
    'Qiln requires declared options, explicit usable values, and no unexpected positional arguments.',
    'Review qiln --help or qiln installation --help and correct the invocation.',
  ),
  SOURCE_REQUIRED: entry(
    'Source checkout is required',
    'The local host monorepo remains the canonical development working copy.',
    'Pass the Qiln Git checkout root with --source.',
  ),
  LOCAL_OPTION_REQUIRED: entry(
    'A local-target option is required',
    'A local installation is configured from the operator’s own checkout and public name, which Qiln neither infers nor stores, so nothing was observed or changed.',
    'Supply the named option with --local: --source with the Qiln Git checkout root, and --domain with the public DNS name that the root edge forwards to the orchestrator.',
  ),
  LOCAL_OPTION_NOT_SUPPORTED: entry(
    'Option is not supported for an AWS target',
    'An AWS target manages its own checkout and registers its own public name, so --source and --domain belong only to the local target, and nothing was observed or changed.',
    'Remove the option from the command.',
    'Use --local to configure the installation on this machine.',
  ),
  SPLIT_IMAGE_PAIR_REQUIRED: entry(
    'Both split-image artifacts are required',
    'The image fingerprint and multipart import require the ordered metadata and rootfs pair.',
    'Supply both --image-meta and --image-rootfs, or use --image for an existing local image.',
  ),
  IMAGE_SELECTION_REQUIRED: entry(
    'Select exactly one image input form',
    'One explicit local reference or one explicit split-image replacement must define the installation image pin.',
    'Use --image alone, or supply the paired --image-meta and --image-rootfs options.',
  ),
  DUPLICATE_ARGUMENT: entry(
    'An option was supplied more than once',
    'Qiln does not infer precedence between duplicate installation inputs.',
    'Remove the duplicate option and retry.',
  ),
  INVALID_COLOR_MODE: entry(
    'Color mode is invalid',
    'The supported color modes are auto, always, and never.',
    'Use --color auto, --color always, or --color never.',
  ),
  UNKNOWN_COMMAND: entry(
    'Unknown Qiln command',
    'Qiln fails closed rather than guessing the intended operation.',
    'Review qiln --help and select a declared command.',
  ),
  INTERNAL_ERROR: entry(
    'Unexpected installer failure',
    'Continuing after an unclassified failure could produce an unsafe or misleading installation result, so no successful installation should be inferred.',
    'Review the installed CLI version and run qiln installation inspect --local.',
    'Inspect actual installation state before retrying a mutation.',
  ),
  COMMAND_CANCELLED: entry('Command canceled', 'No successful completion should be inferred.'),
  INTERACTIVE_TERMINAL_REQUIRED: entry(
    'Interactive terminal is required',
    'Guided authentication and approvals require a real input/output terminal.',
    'Run the command in an unprivileged Linux or macOS terminal, or Windows through WSL. Select the remote flow when the browser is on another machine.',
  ),
})
