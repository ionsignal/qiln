/**
 * An EC2 child serves exactly one request, so module state describes that
 * request. A mutating request arms tracking, and the single mutating send()
 * marks dispatch immediately before it. A failure observed while armed and
 * undispatched happened before any provider mutation could have occurred.
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
