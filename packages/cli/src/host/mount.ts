import { z } from 'zod'
import type { Failure, Section } from './output'

/**
 * The directory that Incus keeps its state in, which the retained layout mounts
 * from the `server-state` dataset.
 */
export const STATE_MOUNTPOINT = '/var/lib/incus'

const text = z.string().min(1).max(2_048)

/**
 * One kernel mount-table entry, as `findmnt --kernel` reports it. It is
 * evidence of what is mounted at the path, not authorization to use it.
 */
export const mountSchema = z.strictObject({
  source: text,
  fstype: text,
  target: text,
  fsroot: text,
  options: text,
})

export type Mount = z.infer<typeof mountSchema>

/**
 * The lenient wrapper strips what findmnt adds in tree mode, such as submount
 * `children`, so the strict observation holds only the entry itself.
 */
const findmntSchema = z.object({ filesystems: z.tuple([z.object(mountSchema.shape)]) })

/**
 * Null means the script reported nothing at the mountpoint. findmnt exits 1 both
 * when nothing is mounted there and on failure, so null is only a missing
 * observation and never proof of absence.
 */
export function mountOf(section: Section, failure: Failure): Mount | null {
  const json = section.lines.join('\n').trim()
  if (json === '') {
    return null
  }
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    throw failure('The state mount was not valid JSON.')
  }
  const parsed = findmntSchema.safeParse(value)
  if (!parsed.success) {
    throw failure('The state mount was not in the expected form.')
  }
  return parsed.data.filesystems[0]
}
