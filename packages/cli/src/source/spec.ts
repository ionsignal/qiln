export const MIB = 1_048_576

/**
 * Why a path was left out of the package. The wording is shown to the
 * developer in the preview.
 */
export type ExclusionReason =
  | 'git metadata'
  | 'dependencies'
  | 'generated output'
  | 'cache'
  | 'protected state'
  | 'environment file'
  | 'credential or key material'
  | 'lockfile'

/**
 * Exclusion names are matched exactly and never by substring. Git ignore rules
 * are not a secret filter, and filename filtering is not proof that the source
 * contains no secrets.
 */
export const SOURCE_SPEC = Object.freeze({
  limits: Object.freeze({
    entries: 100_000,
    files: 10_000,
    fileBytes: 32 * MIB,
    unpackedBytes: 256 * MIB,
    archiveBytes: 128 * MIB,
  }),
  git: Object.freeze({
    timeoutMs: 60_000,
    maxOutputBytes: 32 * MIB,
  }),
  tar: Object.freeze({
    timeoutMs: 120_000,
    maxOutputBytes: 65_536,
  }),
  archive: Object.freeze({
    workPrefix: 'qiln-push-',
    name: 'archive.tar.gz',
    listName: 'files.list',
  }),
  listedExclusions: 20,
  exclusions: Object.freeze({
    directories: Object.freeze({
      '.git': 'git metadata',
      node_modules: 'dependencies',
      dist: 'generated output',
      '.vite': 'cache',
      '.cache': 'cache',
      '.aws': 'credential or key material',
      '.ssh': 'credential or key material',
      credentials: 'credential or key material',
      '.qiln': 'protected state',
    } as const satisfies Record<string, ExclusionReason>),
    files: Object.freeze({
      // Ignored by the project but tracked, so Git alone would still list it.
      'package-lock.json': 'lockfile',
      '.envrc': 'environment file',
      '.npmrc': 'credential or key material',
      '.netrc': 'credential or key material',
      '.pgpass': 'credential or key material',
      credentials: 'credential or key material',
      id_rsa: 'credential or key material',
      id_dsa: 'credential or key material',
      id_ecdsa: 'credential or key material',
      id_ed25519: 'credential or key material',
    } as const satisfies Record<string, ExclusionReason>),
    extensions: Object.freeze({
      '.pem': 'credential or key material',
      '.key': 'credential or key material',
      '.p12': 'credential or key material',
      '.pfx': 'credential or key material',
      '.jks': 'credential or key material',
      '.keystore': 'credential or key material',
      '.tsbuildinfo': 'generated output',
    } as const satisfies Record<string, ExclusionReason>),
    environmentTemplates: Object.freeze(['.env.example', '.env.sample', '.env.template']),
  }),
})
