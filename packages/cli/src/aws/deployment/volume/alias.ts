import { InstallerError } from '../../../diagnostic/error'

export interface DeploymentSelector {
  kind: 'id' | 'alias'
  value: string
}

/**
 * The alias is local metadata only. The derived name mirrors `operatorName()`
 * for display; it is never an AWS tag or a resource name.
 */
export function deploymentName(alias: string): string {
  return `qiln-${alias}`
}

export function notFound(selector: DeploymentSelector): InstallerError {
  return new InstallerError({
    code: 'AWS_DEPLOYMENT_NOT_FOUND',
    facts: [[selector.kind === 'id' ? 'Deployment ID' : 'Deployment alias', selector.value]],
    retry: 'qiln aws deployment list',
  })
}
