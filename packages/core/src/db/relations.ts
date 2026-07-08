import type { Many, ManyConfig, One, OneConfig, SchemaEntry } from 'drizzle-orm'

export type RelationFragment = Record<string, Record<string, unknown>>

/**
 * Relation fragments describe FK topology across package boundaries.
 *
 * We intentionally omit relation-level `where` from the helper function contract because package-owned
 * fragments should not constrain host-owned table filter shapes such as the final `users` table.
 */
export type RelationFragmentOneFn<TTableName extends string> = <TOptional extends boolean = true>(
  config?: Omit<OneConfig<SchemaEntry, TOptional>, 'where'>,
) => One<TTableName, TOptional>

export type RelationFragmentManyFn<TTableName extends string> = (config?: Omit<ManyConfig<SchemaEntry>, 'where'>) => Many<TTableName>

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
