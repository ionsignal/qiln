import { InstallerError, type DiagnosticFact } from '../diagnostic/error'

/**
 * One native pairing of the names that Debian packages, Node, and Incus use for
 * the same CPU architecture. Machine architecture (`uname -m`) uses the Incus name.
 */
export interface Architecture {
  package: 'amd64' | 'arm64'
  node: 'x64' | 'arm64'
  incus: 'x86_64' | 'aarch64'
}

const SUPPORTED: readonly Architecture[] = [
  { package: 'amd64', node: 'x64', incus: 'x86_64' },
  { package: 'arm64', node: 'arm64', incus: 'aarch64' },
]

export interface ObservedArchitecture {
  packageArchitecture: string
  machine: string
  node?: string
}

/**
 * The architecture must be observed on the target, never taken from the
 * operator's `process.arch`. Names that disagree, such as an emulated Node
 * runtime, are refused rather than reconciled.
 */
export function architectureOf(observed: ObservedArchitecture, retry: string): Architecture {
  const found = SUPPORTED.find(item => item.package === observed.packageArchitecture)
  if (
    found !== undefined &&
    found.incus === observed.machine &&
    (observed.node === undefined || found.node === observed.node)
  ) {
    return found
  }
  const facts: DiagnosticFact[] = [
    ['Package architecture', observed.packageArchitecture || 'unknown'],
    ['Machine architecture', observed.machine || 'unknown'],
  ]
  if (observed.node !== undefined) {
    facts.push(['Node architecture', observed.node])
  }
  facts.push(['Supported', SUPPORTED.map(item => `${item.package}/${item.incus}`).join(', ')])
  throw new InstallerError({
    code: 'UNSUPPORTED_HOST_ARCHITECTURE',
    facts,
    retry,
  })
}

export function requireIncusArchitecture(
  architecture: Architecture,
  reported: readonly string[],
  retry: string,
): void {
  if (reported.includes(architecture.incus)) {
    return
  }
  throw new InstallerError({
    code: 'INCUS_ARCHITECTURE_INCOMPATIBLE',
    facts: [
      [
        'Observed',
        `Incus architectures: ${reported.join(', ') || 'none'}; the host requires ${architecture.incus}.`,
      ],
    ],
    retry,
  })
}
