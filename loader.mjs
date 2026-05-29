import { promises as fs } from 'fs'
import { pathToFileURL } from 'url'

const ERR_MODULE_NOT_FOUND = 'ERR_MODULE_NOT_FOUND'
const ERR_UNSUPPORTED_DIR_IMPORT = 'ERR_UNSUPPORTED_DIR_IMPORT'
const ENOENT = 'ENOENT'

async function resolveFilePath(filePath) {
  const withJsExtension = filePath.endsWith('.js') ? filePath : `${filePath}.js`
  try {
    await fs.access(withJsExtension)
    return withJsExtension
  } catch (jsError) {
    if (jsError.code === ENOENT) {
      const withIndexJs = filePath.endsWith('/') ? `${filePath}index.js` : `${filePath}/index.js`
      await fs.access(withIndexJs)
      return withIndexJs
    }
    throw jsError
  }
}

export async function resolve(specifier, context, defaultResolve) {
  const { parentURL = null } = context

  // Fall back to original resolution logic
  let resolved
  try {
    resolved = await defaultResolve(specifier, context, defaultResolve)
  } catch (error) {
    if (error?.code === ERR_MODULE_NOT_FOUND || error?.code === ERR_UNSUPPORTED_DIR_IMPORT) {
      let filePath
      console.info(`[loader] rewriting ${specifier}`)
      try {
        filePath = new URL(specifier, parentURL).pathname
      } catch (urlError) {
        console.error('Error parsing URL:', urlError)
        throw urlError
      }
      try {
        const resolvedPath = await resolveFilePath(filePath)
        resolved = { url: pathToFileURL(resolvedPath).href }
      } catch (resolutionError) {
        console.error('Error resolving file path:', resolutionError)
        throw resolutionError
      }
    } else {
      console.error('Unexpected error during module resolution:', error)
      throw error
    }
  }

  return resolved
}
