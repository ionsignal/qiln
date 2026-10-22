import { InstallerError, type DiagnosticFact } from '../diagnostic/error'

/**
 * Selection refusals carry authored reasons only. Callers echo a path only
 * after it passed name validation.
 */
export function refuse(reason: string, path?: string): InstallerError {
  const facts: DiagnosticFact[] = [['Reason', reason]]
  if (path !== undefined) {
    facts.push(['Path', path])
  }
  return new InstallerError({
    code: 'SOURCE_SELECTION_REFUSED',
    facts,
    retry: 'qiln aws deployment push',
  })
}

export function missingTool(name: string): InstallerError {
  return new InstallerError({
    code: 'MISSING_HOST_TOOL',
    facts: [['Tool', name]],
    retry: 'qiln aws deployment push',
  })
}
