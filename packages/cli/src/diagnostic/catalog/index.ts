import { awsConnectionDiagnostics } from './aws/connection'
import { awsDeploymentDiagnostics } from './aws/deployment'
import { awsGuestDiagnostics } from './aws/guest'
import { awsIamDiagnostics } from './aws/iam'
import { awsIncusDiagnostics } from './aws/incus'
import { awsToolDiagnostics } from './aws/tools'
import { commandDiagnostics } from './command'
import { hostDiagnostics } from './host'
import { incusDiagnostics } from './incus'
import { installationDiagnostics } from './installation'
import { sshDiagnostics } from './ssh'
import { stateDiagnostics } from './state'
import { zfsDiagnostics } from './zfs'

export type { DiagnosticDefinition } from './define'

export const catalog = Object.freeze({
  ...hostDiagnostics,
  ...incusDiagnostics,
  ...installationDiagnostics,
  ...stateDiagnostics,
  ...commandDiagnostics,
  ...awsToolDiagnostics,
  ...awsConnectionDiagnostics,
  ...awsIamDiagnostics,
  ...awsDeploymentDiagnostics,
  ...awsGuestDiagnostics,
  ...awsIncusDiagnostics,
  ...sshDiagnostics,
  ...zfsDiagnostics,
})

const domainCodeCount = [
  hostDiagnostics,
  incusDiagnostics,
  installationDiagnostics,
  stateDiagnostics,
  commandDiagnostics,
  awsToolDiagnostics,
  awsConnectionDiagnostics,
  awsIamDiagnostics,
  awsDeploymentDiagnostics,
  awsGuestDiagnostics,
  awsIncusDiagnostics,
  sshDiagnostics,
  zfsDiagnostics,
].reduce((total, domain) => total + Object.keys(domain).length, 0)

if (Object.keys(catalog).length !== domainCodeCount) {
  throw new Error('Diagnostic codes must be unique across catalog domains.')
}
