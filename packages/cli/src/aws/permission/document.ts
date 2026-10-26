import { InstallerError } from '../../diagnostic/error'
import { canonical } from '../../json'

function invalid(): never {
  throw new InstallerError({
    code: 'AWS_BOOTSTRAP_POLICY_CHANGED',
  })
}

/**
 * Some SDK responses already contain plain JSON. Decode only when direct
 * parsing fails, so literal percent characters are not decoded twice.
 */
export function document(value: string | undefined): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 65_536) {
    return invalid()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(value) as unknown
  } catch {
    try {
      parsed = JSON.parse(decodeURIComponent(value)) as unknown
    } catch {
      return invalid()
    }
  }
  return canonical(parsed)
}
