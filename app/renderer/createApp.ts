import { createSSRApp, h, shallowRef } from 'vue'
import { setPageContext } from '@/composables/usePageContext'
import { setData } from '@/composables/useData'
import { objectAssign } from '@/renderer/utils/object'
import LayoutQiln from '@/renderer/layout/LayoutQiln.vue'
import type { PageContextServer, PageContextClient } from 'vike/types'

function createApp(pageContext: PageContextServer | PageContextClient) {
  const pageContextRef = shallowRef(pageContext)
  const dataRef = shallowRef(pageContext.data)
  const pageRef = shallowRef(pageContext.Page)
  const layoutRef = shallowRef(pageContext.config.Layout || LayoutQiln)
  const RootComponent = () => {
    const Layout = layoutRef.value
    const content = pageRef.value
    return h(Layout, null, () => h(content))
  }
  // create ssr vue app
  const app = createSSRApp(RootComponent)
  setPageContext(app, pageContextRef)
  setData(app, dataRef)
  // app.changePage() is called upon navigation
  objectAssign(app, {
    changePage: (newPageContext: PageContextClient) => {
      pageContextRef.value = newPageContext
      dataRef.value = newPageContext.data
      pageRef.value = newPageContext.Page
      layoutRef.value = newPageContext.config?.Layout || LayoutQiln
    },
  })
  return app
}

export { createApp }
