export function prepareRetry(deploymentId: string): string {
  return `qiln aws deployment prepare --id ${deploymentId}`
}
