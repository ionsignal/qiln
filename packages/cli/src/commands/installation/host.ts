import type { HostBinding } from '../../installation/records'

export function describeHost(host: HostBinding): string {
  return host.kind === 'local' ? 'this machine' : `AWS deployment ${host.deployment} · instance ${host.instanceId}`
}
