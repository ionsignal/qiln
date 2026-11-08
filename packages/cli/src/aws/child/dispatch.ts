/**
 * A mutating child serves exactly one request, so module state describes that
 * request. The child arms tracking, and the single effect-bearing send marks
 * dispatch immediately before it. A failure observed while armed and
 * undispatched happened before any mutation could have occurred.
 */
let armed = false
let dispatched = false

export function armDispatch(): void {
  armed = true
}

export function markDispatched(): void {
  dispatched = true
}

export function undispatched(): boolean {
  return armed && !dispatched
}
