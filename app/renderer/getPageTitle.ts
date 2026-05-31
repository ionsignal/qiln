import type { PageContext } from 'vike/types'

function getPageTitle(pageContext: PageContext): string {
  const titleConfig = pageContext.config.title
  if (typeof (pageContext.data as any)?.title === 'string') {
    return (pageContext.data as any).title
  }
  if (typeof titleConfig === 'string') {
    return titleConfig
  }
  if (typeof titleConfig === 'function') {
    return titleConfig(pageContext)
  }
  return 'Qiln'
}

export { getPageTitle }
