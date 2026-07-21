export type AbsolutePosixPathRelationship = 'equal' | 'ancestor' | 'descendant' | 'disjoint'

/**
 * Determines whether a string is a canonical absolute POSIX path.
 *
 * Canonical paths have one leading slash, no trailing slash except for `/`,
 * and no empty, current-directory, parent-directory, or null-containing
 * segments.
 */
export function isCanonicalAbsolutePosixPath(value: string): boolean {
  if (value === '/') {
    return true
  }
  if (!value.startsWith('/') || value.endsWith('/') || value.includes('\0')) {
    return false
  }
  const segments = value.slice(1).split('/')
  return segments.length > 0 && segments.every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

/**
 * Determines whether a string is a canonical relative POSIX path.
 *
 * The optional root representation `.` is used only by contracts that need to
 * refer to the enclosing managed root itself.
 */
export function isCanonicalRelativePosixPath(value: string, allowRoot: boolean): boolean {
  if (allowRoot && value === '.') {
    return true
  }
  if (value === '' || value.startsWith('/') || value.endsWith('/') || value.includes('\0')) {
    return false
  }
  const segments = value.split('/')
  return segments.every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

/**
 * Determines whether a canonical absolute or relative POSIX path contains an
 * exact path segment. The relative root representation `.` and absolute root
 * `/` contain no segments.
 */
export function containsPosixPathSegment(path: string, segment: string): boolean {
  if (path === '.' || path === '/') {
    return false
  }
  const relativePath = path.startsWith('/') ? path.slice(1) : path
  return relativePath.split('/').some(candidate => candidate === segment)
}

export function isAbsolutePosixPathAtOrBelow(candidate: string, parent: string): boolean {
  if (candidate === parent) {
    return true
  }
  if (parent === '/') {
    return candidate.startsWith('/')
  }
  return candidate.startsWith(`${parent}/`)
}

export function isStrictAbsolutePosixPathDescendant(candidate: string, parent: string): boolean {
  return candidate !== parent && isAbsolutePosixPathAtOrBelow(candidate, parent)
}

/**
 * Classifies `left` relative to `right`.
 *
 * For example, `/workspace/models` is a descendant of `/workspace`, while
 * `/workspace` is an ancestor of `/workspace/models`.
 */
export function classifyAbsolutePosixPathRelationship(left: string, right: string): AbsolutePosixPathRelationship {
  if (left === right) {
    return 'equal'
  }
  if (isStrictAbsolutePosixPathDescendant(right, left)) {
    return 'ancestor'
  }
  if (isStrictAbsolutePosixPathDescendant(left, right)) {
    return 'descendant'
  }
  return 'disjoint'
}

export function joinAbsoluteAndRelativePosixPath(rootPath: string, relativePath: string): string {
  if (relativePath === '.') {
    return rootPath
  }
  return rootPath === '/' ? `/${relativePath}` : `${rootPath}/${relativePath}`
}

export function absolutePosixParentPath(value: string): string {
  if (value === '/') {
    return '/'
  }
  const separatorIndex = value.lastIndexOf('/')
  return separatorIndex <= 0 ? '/' : value.slice(0, separatorIndex)
}
