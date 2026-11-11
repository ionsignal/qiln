import { InstallerError } from '../../diagnostic/error'
import { AWS_SPEC } from '../spec'

export type TargetId = 'linux-x64' | 'darwin-universal'

export interface Artifact {
  readonly url: string
  readonly format: 'zip' | 'pkg'
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
  readonly roots: readonly string[]
  readonly links: readonly ReviewedLink[]
  readonly effects: readonly string[]
}

export const TOOL_SPEC = Object.freeze({
  version: AWS_SPEC.cliVersion,
  host: 'awscli.amazonaws.com',
  signerTeamId: '94KV3E626L',
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

const FILENAMES = Object.freeze({
  'linux-x64': `awscli-exe-linux-x86_64-${TOOL_SPEC.version}.zip`,
  'darwin-universal': `AWSCLIV2-${TOOL_SPEC.version}.pkg`,
} as const satisfies Record<TargetId, string>)

function artifactUrl(target: TargetId): string {
  return `https://${TOOL_SPEC.host}/${FILENAMES[target]}`
}

/**
 * Both macOS architectures run the one universal package, so they share a release.
 */
const HOSTS: Readonly<Record<string, TargetId>> = Object.freeze({
  'linux-x64': 'linux-x64',
  'darwin-x64': 'darwin-universal',
  'darwin-arm64': 'darwin-universal',
})

export const RELEASES: Readonly<Record<TargetId, Release>> = Object.freeze({
  'linux-x64': Object.freeze({
    target: 'linux-x64',
    artifact: Object.freeze({
      url: artifactUrl('linux-x64'),
      format: 'zip',
      bytes: 74874980,
      sha256: '707a900fde102f486d92e79f979493c747f475b9e2b94f2a42687d5d95129fb7',
    }),
    executable: 'bin/aws',
    roots: Object.freeze(['aws-cli', 'bin']),
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
  }),
  'darwin-universal': Object.freeze({
    target: 'darwin-universal',
    artifact: Object.freeze({
      url: artifactUrl('darwin-universal'),
      format: 'pkg',
      bytes: 61120704,
      sha256: 'a6d419ec5ce460101499246c9ee8a8a6020e43b7cf6355a388274f5127f2e99f',
    }),
    executable: 'aws-cli/aws',
    roots: Object.freeze(['aws-cli']),
    links: Object.freeze([]),
    effects: Object.freeze([
      `Verifies the package signature and notarization against Apple developer team ID ${TOOL_SPEC.signerTeamId}.`,
      'Expands the verified package into a private installation workspace. The macOS installer and its scripts are never run, and no privilege escalation is used.',
      'Moves the AWS CLI payload under aws-cli in the displayed destination.',
    ]),
  }),
})

export function current(): Release {
  const host = `${process.platform}-${process.arch}`
  if (!Object.hasOwn(HOSTS, host)) {
    throw new InstallerError({
      code: 'AWS_TOOL_UNAVAILABLE',
      facts: [
        ['Version', TOOL_SPEC.version],
        ['Target', host],
        ['Supported managed targets', Object.keys(HOSTS).join(', ')],
      ],
      retry: 'qiln aws connect',
    })
  }
  return RELEASES[HOSTS[host]]
}

export function validateArtifact(artifact: Artifact): void {
  const url = new URL(artifact.url)
  const pathnames = Object.values(FILENAMES).map(name => `/${name}`)
  if (
    !Number.isSafeInteger(artifact.bytes) ||
    artifact.bytes <= 0 ||
    artifact.bytes > TOOL_SPEC.maximumArtifactBytes ||
    !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
    /^0{64}$/.test(artifact.sha256) ||
    url.protocol !== 'https:' ||
    url.hostname !== TOOL_SPEC.host ||
    (url.port !== '' && url.port !== '443') ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    url.search !== '' ||
    !pathnames.includes(url.pathname) ||
    !url.pathname.endsWith(`.${artifact.format}`)
  ) {
    throw new InstallerError({
      code: 'AWS_TOOL_STATE_INVALID',
      facts: [['Observed', 'The pinned AWS CLI artifact configuration is inconsistent.']],
    })
  }
}