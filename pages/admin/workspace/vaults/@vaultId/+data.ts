import { render } from 'vike/abort'
import { getVaultById } from '@qiln/engine/client'
import type { PageContextServer, PageContextClient } from 'vike/types'
import type { MockVaultDetail } from '@qiln/engine/client'

export type Data = {
  vault: MockVaultDetail
  title: string
}

export async function data(pageContext: PageContextServer | PageContextClient): Promise<Data> {
  const vaultId = pageContext.routeParams.vaultId
  if (!vaultId) {
    throw render(404, 'Vault ID is missing in the URL.')
  }
  const vault = getVaultById(vaultId)
  if (!vault) {
    throw render(404, `Vault '${vaultId}' does not exist or you do not have access.`)
  }
  return {
    vault,
    title: `Vault: ${vault.name}`,
  }
}
