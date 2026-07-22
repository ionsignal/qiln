import { IncusError } from '../../../../errors'

export interface TimestampConversionContext {
  entity?: string
  entityId?: string
}

/**
 * Converts a durable Date into its client-safe ISO representation.
 *
 * Timestamp policy remains operation-specific. This helper only validates and
 * maps a timestamp that a repository or service has already selected.
 */
export function toIsoTimestamp(value: Date, field: string, context: TimestampConversionContext = {}): string {
  if (!(value instanceof Date)) {
    throw new IncusError('Durable state contains a non-Date timestamp value.', 'API_ERROR', {
      field,
      entity: context.entity,
      entityId: context.entityId,
      valueType: typeof value,
    })
  }
  const timestamp = value.getTime()
  if (!Number.isFinite(timestamp)) {
    throw new IncusError('Durable state contains an invalid timestamp.', 'API_ERROR', {
      field,
      entity: context.entity,
      entityId: context.entityId,
    })
  }
  return value.toISOString()
}

export function toNullableIsoTimestamp(
  value: Date | null,
  field: string,
  context: TimestampConversionContext = {},
): string | null {
  return value === null ? null : toIsoTimestamp(value, field, context)
}
