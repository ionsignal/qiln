import { awsConnectionDiagnostics } from './aws/connection'
import { awsDeploymentDiagnostics } from './aws/deployment'
import { awsIamDiagnostics } from './aws/iam'
import { awsToolDiagnostics } from './aws/tools'
import { commandDiagnostics } from './command'
import { hostDiagnostics } from './host'
import { incusDiagnostics } from './incus'
import { installationDiagnostics } from './installation'
import { stateDiagnostics } from './state'

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
].reduce((total, domain) => total + Object.keys(domain).length, 0)

if (Object.keys(catalog).length !== domainCodeCount) {
  throw new Error('Diagnostic codes must be unique across catalog domains.')
}
