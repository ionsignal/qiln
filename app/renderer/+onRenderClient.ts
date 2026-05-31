import { createApp } from '@/renderer/createApp'
import { getPageTitle } from '@/renderer/getPageTitle'
import type { PageContextClient } from 'vike/types'

let app: ReturnType<typeof createApp>
const onRenderClient = async (pageContext: PageContextClient) => {
  console.log('render client')
  if (!app) {
    app = createApp(pageContext)
    app.mount('#app')
  } else {
    app.changePage(pageContext)
  }
  document.title = getPageTitle(pageContext)
}

// https://vike.dev/onRenderClient
export { onRenderClient }
