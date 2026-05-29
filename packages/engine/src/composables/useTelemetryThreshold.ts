export type TelemetryToken = 'cool' | 'healthy' | 'elevated' | 'critical'

export interface TelemetryThresholds {
  elevated: number
  critical: number
}

/**
 * Evaluates a numeric value against predefined thresholds to return a semantic telemetry token.
 *
 * @param value The raw telemetry value (e.g. CPU %, Temp °C).
 * @param thresholds The boundaries for elevated and critical states.
 * @param base The baseline token to return if thresholds are not exceeded.
 * @returns A strict TelemetryToken string literal union.
 */
export function resolveTelemetryToken(value: number, thresholds: TelemetryThresholds, base: TelemetryToken = 'healthy'): TelemetryToken {
  if (value >= thresholds.critical) return 'critical'
  if (value >= thresholds.elevated) return 'elevated'
  return base
}

/**
 * Converts a TelemetryToken into its corresponding CSS custom property reference.
 * Designed for direct inline `:style` binding.
 */
export function getTelemetryVar(token: TelemetryToken): string {
  return `var(--qiln-telemetry-${token})`
}
