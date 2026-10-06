import { InstallerError } from '../../diagnostic/error'
import { AWS_SPEC } from '../spec'

export type TargetId = 'linux-x64'

export interface Artifact {
  readonly url: string
  readonly format: 'zip'
  readonly bytes: number
  readonly sha256: string
}

export interface ReviewedLink {
  readonly path: string
  readonly to: string
}

export interface Release {
  readonly target: TargetId
  readonly artifact: Artifact
  readonly executable: string
  readonly archiveLinks: readonly ReviewedLink[]
  readonly links: readonly ReviewedLink[]
  readonly effects: readonly string[]
}

export const TOOL_SPEC = Object.freeze({
  version: AWS_SPEC.cliVersion,
  host: 'awscli.amazonaws.com',
  redirects: 3,
  downloadTimeoutMs: 10 * 60 * 1_000,
  maximumArtifactBytes: 512 * 1_024 * 1_024,
  setupTimeoutMs: 5 * 60 * 1_000,
  maximumOutputBytes: 64 * 1_024,
  maximumRecordBytes: 65_536,
  maximumPayloadEntries: 100_000,
  state: Object.freeze({
    directory: 'tools',
    lock: 'install.lock',
    record: 'installation.json',
    workspace: 'workspace',
  }),
})

export const RELEASE: Release = Object.freeze({
  target: 'linux-x64',
  artifact: Object.freeze({
    url: `https://${TOOL_SPEC.host}/awscli-exe-linux-x86_64-${TOOL_SPEC.version}.zip`,
    format: 'zip',
    bytes: 74061592,
    sha256: '6b3a6a3d7bb3997928f0bdf7b866914224abf242c2e54e1dcebbe84bee64f356',
  }),
  executable: 'bin/aws',
  archiveLinks: Object.freeze([]),
  // Preserve immediate destinations: resolving these ahead of validation would
  // discard the vendor's current-version indirection.
  links: Object.freeze([
    Object.freeze({
      path: `aws-cli/v2/${TOOL_SPEC.version}/bin/aws`,
      to: `aws-cli/v2/${TOOL_SPEC.version}/dist/aws`,
    }),
    Object.freeze({
      path: `aws-cli/v2/${TOOL_SPEC.version}/bin/aws_completer`,
      to: `aws-cli/v2/${TOOL_SPEC.version}/dist/aws_completer`,
    }),
    Object.freeze({
      path: 'aws-cli/v2/current',
      to: `aws-cli/v2/${TOOL_SPEC.version}`,
    }),
    Object.freeze({
      path: 'bin/aws',
      to: 'aws-cli/v2/current/bin/aws',
    }),
    Object.freeze({
      path: 'bin/aws_completer',
      to: 'aws-cli/v2/current/bin/aws_completer',
    }),
  ]),
  effects: Object.freeze([
    'Extracts the verified ZIP into a private installation workspace.',
    'Runs the bundled AWS installer without privilege escalation.',
    'Creates the AWS CLI payload under aws-cli and command links under bin in the displayed destination.',
  ]),
})

export function current(): Release {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new InstallerError({
      code: 'AWS_TOOL_UNAVAILABLE',
      facts: [
        ['Version', TOOL_SPEC.version],
        ['Target', `${process.platform}-${process.arch}`],
        ['Supported managed target', RELEASE.target],
      ],
      retry: 'qiln aws connect',
    })
  }
  return RELEASE
}

export function validateArtifact(artifact: Artifact): void {
  const url = new URL(artifact.url)
  if (
    !Number.isSafeInteger(artifact.bytes) ||
    artifact.bytes <= 0 ||
    artifact.bytes > TOOL_SPEC.maximumArtifactBytes ||
    !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
    /^0{64}$/.test(artifact.sha256) ||
    artifact.format !== 'zip' ||
    url.protocol !== 'https:' ||
    url.hostname !== TOOL_SPEC.host ||
    (url.port !== '' && url.port !== '443') ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    url.search !== '' ||
    url.pathname !== `/awscli-exe-linux-x86_64-${TOOL_SPEC.version}.zip`
  ) {
    throw new InstallerError({
      code: 'AWS_TOOL_STATE_INVALID',
      facts: [['Observed', 'The pinned AWS CLI artifact configuration is inconsistent.']],
    })
  }
}
