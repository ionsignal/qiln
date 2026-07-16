import { parseDocument, isMap, isSeq, isScalar, YAMLMap, YAMLSeq } from 'yaml'
import { IncusError } from '../../../../errors'
import type { Node, ParsedNode } from 'yaml'

/**
 * Safely merges commands into cloud-init YAML while preserving the current
 * behavior around comments and existing bootcmd shapes.
 */
export function mergeCloudInit(existingData: string | undefined, commands: string[][]): string {
  if (existingData?.trimStart().startsWith('#!')) {
    throw new IncusError('Cannot merge cloud-init commands into a raw shell script.', 'VALIDATION_ERROR')
  }
  const cleanYaml = existingData ? existingData.replace(/^#cloud-config\s*\n/, '') : ''
  const doc = parseDocument(cleanYaml)
  if (!doc.contents || !isMap(doc.contents)) {
    doc.contents = doc.createNode({}) as unknown as ParsedNode
  }
  const rootMap = doc.contents as YAMLMap<unknown, unknown>
  if (isMap(rootMap)) {
    const rawBootcmd = rootMap.get('bootcmd', true)
    let seqNode: YAMLSeq<Node>
    if (!rawBootcmd) {
      seqNode = doc.createNode([]) as YAMLSeq<Node>
      rootMap.set('bootcmd', seqNode)
    } else if (isScalar(rawBootcmd)) {
      seqNode = doc.createNode([rawBootcmd.value]) as YAMLSeq<Node>
      rootMap.set('bootcmd', seqNode)
    } else if (isSeq(rawBootcmd)) {
      seqNode = rawBootcmd as YAMLSeq<Node>
    } else {
      seqNode = doc.createNode([]) as YAMLSeq<Node>
      rootMap.set('bootcmd', seqNode)
    }
    for (const command of commands) {
      seqNode.items.push(doc.createNode(command) as Node)
    }
  }
  return `#cloud-config\n${String(doc)}`
}
