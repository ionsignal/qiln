import { redirect } from 'vike/abort'
import type { PageContextServer } from 'vike/types'

export async function guard(pageContext: PageContextServer) {
  const isLoginPage = pageContext.urlPathname === '/login'
  if (!pageContext.user && !isLoginPage) {
    throw redirect('/login')
  }
if (pageContext.user && isLoginPage) {
  throw redirect('/admin/workspace/vessels')
}
if (pageContext.urlPathname === '/' || pageContext.urlPathname === '/admin') {
  throw redirect('/admin/workspace/vessels')
}
}
