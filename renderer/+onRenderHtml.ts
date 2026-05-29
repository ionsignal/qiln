import { renderToString } from '@vue/server-renderer'
import { setup } from '@css-render/vue3-ssr'
import { escapeInject, dangerouslySkipEscape } from 'vike/server'
import { createApp } from '@/renderer/createApp'
import { getPageTitle } from '@/renderer/getPageTitle'
import { adminThemeOverrides } from '@/renderer/layout/adminThemeOverrides'
import type { PageContextServer } from 'vike/types'

const onRenderHtml = async (pageContext: PageContextServer) => {
  const app = createApp(pageContext)
  const { collect } = setup(app)
  const appHtml = await renderToString(app)
  const title = getPageTitle(pageContext)
  const styles = collect()
  const naiveUiBody = `body {
      text-size-adjust: 100%;
      padding: 0px;
      margin: 0px;
      background-color: ${adminThemeOverrides.common?.bodyColor}; 
      font-size: 14px;
      font-family: v-sans, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol';
      line-height: 1.6;
      transition: color 0.3s cubic-bezier(0.4, 0, 0.2, 1),
      color: rgba(255, 255, 255, 0.82);
      -webkit-text-size-adjust: 100%;
      -webkit-tap-highlight-color: transparent;
  }`
  const documentHtml = escapeInject`<!DOCTYPE html>
    <html>
      <head>
        <title>${title}</title>
        <link rel="icon" type="image/x-icon" href="/favicon.ico">
        ${dangerouslySkipEscape(styles)}
        <style>${dangerouslySkipEscape(naiveUiBody)}</style>
      </head>
      <body>
        <div id="app">${dangerouslySkipEscape(appHtml)}</div>
      </body>
    </html>`
  return {
    documentHtml,
    pageContext: {
      // https://vike.dev/streaming
      // Disabled eager streaming to ensure CSS is collected synchronously
      enableEagerStreaming: false,
    },
  }
}

// https://vike.dev/onRenderHtml
export { onRenderHtml }
