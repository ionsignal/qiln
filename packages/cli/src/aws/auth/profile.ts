import { InstallerError } from '../../diagnostic/error'
import { AWS_SPEC } from '../spec'

export interface LoginProfile {
  region: string
  loginSession: string
}

function invalidProfile(): never {
  throw new InstallerError({
    code: 'AWS_PROFILE_INVALID',
  })
}

/**
 * Qiln owns this small configuration file. Accept only its supported profile
 * rather than importing general AWS profile precedence or role resolution.
 */
export function readProfile(content: string, region: string): LoginProfile {
  if (/^\s*\[sso-session(?:\s|\])/im.test(content) || /^\s*sso_[a-z_]+\s*=/im.test(content)) {
    throw new InstallerError({
      code: 'AWS_SSO_UNSUPPORTED',
    })
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(content)) {
    return invalidProfile()
  }

  let sectionSeen = false
  const fields = new Map<string, string>()
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#') || line.startsWith(';')) {
      continue
    }
    if (line.startsWith('[')) {
      if (sectionSeen || line !== `[profile ${AWS_SPEC.profile}]`) {
        return invalidProfile()
      }
      sectionSeen = true
      continue
    }
    const assignment = /^([a-z_]+)\s*=\s*(.+)$/.exec(line)
    const key = assignment?.[1]
    const value = assignment?.[2]
    if (
      !sectionSeen ||
      key === undefined ||
      value === undefined ||
      !['region', 'output', 'login_session'].includes(key) ||
      fields.has(key)
    ) {
      return invalidProfile()
    }
    fields.set(key, value)
  }
  const loginSession = fields.get('login_session')
  if (
    fields.get('region') !== region ||
    fields.get('output') !== 'json' ||
    loginSession === undefined ||
    !/^[\x21-\x7e]{1,2048}$/.test(loginSession)
  ) {
    return invalidProfile()
  }
  return {
    region,
    loginSession,
  }
}
