export type RelationFragment = Record<string, Record<string, unknown>>

type UnionToIntersection<TValue> = [TValue] extends [never]
  ? {}
  : (TValue extends unknown ? (value: TValue) => void : never) extends (value: infer TIntersection) => void
    ? TIntersection
    : never

type Simplify<TValue> = {
  [TKey in keyof TValue]: TValue[TKey]
} & {}

export type MergedRelationFragments<TFragments extends readonly RelationFragment[]> = Simplify<UnionToIntersection<TFragments[number]>>

function isRelationRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Deep-merges Drizzle relation fragments while preventing silent relation overwrites as capsule
 * snapshots, route aliases, promotions, and rollback metadata add more schema fragments.
 */
export function mergeRelationFragments<const TFragments extends readonly RelationFragment[]>(
  ...fragments: TFragments
): MergedRelationFragments<TFragments> {
  const merged: RelationFragment = {}
  for (const fragment of fragments) {
    for (const [tableName, relations] of Object.entries(fragment)) {
      if (!isRelationRecord(relations)) {
        throw new Error(`[QilnDB] Relation fragment for table '${tableName}' must be an object.`)
      }
      const tableRelations = merged[tableName] ?? {}
      for (const [relationName, relation] of Object.entries(relations)) {
        if (Object.prototype.hasOwnProperty.call(tableRelations, relationName)) {
          throw new Error(`[QilnDB] Duplicate relation '${tableName}.${relationName}' while merging relation fragments.`)
        }
        tableRelations[relationName] = relation
      }
      merged[tableName] = tableRelations
    }
  }
  return merged as MergedRelationFragments<TFragments>
}
