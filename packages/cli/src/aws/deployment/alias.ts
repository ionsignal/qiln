/** Selects one retained deployment by its immutable ID or its unique local alias. */
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
