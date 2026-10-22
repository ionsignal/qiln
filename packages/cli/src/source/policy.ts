import { posix } from 'node:path'
import { SOURCE_SPEC, type ExclusionReason } from './spec'

const { directories, files, extensions, environmentTemplates } = SOURCE_SPEC.exclusions

/**
 * Returns why a repository-relative path is left out, or null when it may be
 * admitted. Applies to tracked and untracked paths alike.
 */
export function exclusionOf(path: string): ExclusionReason | null {
  const parts = path.split('/')
  const name = parts.at(-1) ?? ''
  for (const part of parts.slice(0, -1)) {
    if (Object.hasOwn(directories, part)) {
      return directories[part as keyof typeof directories]
    }
  }
  if (Object.hasOwn(files, name)) {
    return files[name as keyof typeof files]
  }
  if (name === '.env' || (name.startsWith('.env.') && !environmentTemplates.includes(name))) {
    return 'environment file'
  }
  const extension = posix.extname(name).toLowerCase()
  if (Object.hasOwn(extensions, extension)) {
    return extensions[extension as keyof typeof extensions]
  }
  return null
}
