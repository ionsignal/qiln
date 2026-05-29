import {
  mdiFileDocumentOutline,
  mdiImage,
  mdiCog,
  mdiZipBox,
  mdiFileHidden,
  mdiFileOutline,
  mdiFolder,
  mdiLanguagePython,
  mdiCodeJson,
} from '@mdi/js'
import type { FileEntry, FileType } from '../types'

/**
 * Browser-safe path joiner. Prevents `node:path` dependency in client code.
 */
export function joinPath(parent: string, child: string): string {
  const p = parent.endsWith('/') ? parent.slice(0, -1) : parent
  const c = child.startsWith('/') ? child.slice(1) : child
  return p === '' ? `/${c}` : `${p}/${c}`
}

/**
 * Browser-safe path splitter.
 */
export function splitPath(path: string): string[] {
  return path.split('/').filter(Boolean)
}

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

export function getFileExtension(name: string): string {
  const parts = name.split('.')
  if (parts.length === 1 || (parts.length === 2 && parts[0] === '')) return ''
  return parts.pop()?.toLowerCase() || ''
}

export function getFileType(name: string): FileType {
  const ext = getFileExtension(name)
  switch (ext) {
    case 'txt':
    case 'md':
    case 'log':
      return 'text'
    case 'json':
    case 'yaml':
    case 'yml':
    case 'properties':
    case 'toml':
    case 'ini':
      return 'config'
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'svg':
      return 'image'
    case 'zip':
    case 'tar':
    case 'gz':
    case 'jar':
      return 'archive'
    case 'bin':
    case 'exe':
    case 'so':
    case 'dll':
    case 'safetensors':
    case 'pt':
      return 'binary'
    default:
      return 'unknown'
  }
}

export function getFileIconPath(entry: FileEntry): string {
  if (entry.type === 'directory') return mdiFolder
  if (entry.name.startsWith('.')) return mdiFileHidden

  const type = getFileType(entry.name)
  switch (type) {
    case 'text':
      return mdiFileDocumentOutline
    case 'config':
      if (entry.extension === 'json') return mdiCodeJson
      return mdiCog
    case 'image':
      return mdiImage
    case 'archive':
      return mdiZipBox
    case 'binary':
      return mdiFileOutline
    default:
      if (entry.extension === 'py') return mdiLanguagePython
      return mdiFileOutline
  }
}

export function getFileLanguage(name: string): string | undefined {
  const ext = getFileExtension(name)
  switch (ext) {
    case 'json':
      return 'json'
    case 'yaml':
    case 'yml':
      return 'yaml'
    case 'py':
      return 'python'
    case 'sh':
    case 'bash':
      return 'bash'
    case 'properties':
    case 'ini':
      return 'ini'
    default:
      return undefined
  }
}
