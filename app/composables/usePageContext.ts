// https://vike.dev/usePageContext
import { inject } from 'vue'
import type { App, InjectionKey, Ref } from 'vue'

const key: InjectionKey<Ref<Vike.PageContext>> = Symbol()

/** https://vike.dev/usePageContext */
function usePageContext(): Ref<Vike.PageContext> {
  const pageContext = inject(key)
  if (!pageContext) throw new Error('setPageContext() not called in parent')
  return pageContext
}

function setPageContext(app: App, pageContext: Ref<Vike.PageContext>): void {
  app.provide(key, pageContext)
}

export { usePageContext, setPageContext }
