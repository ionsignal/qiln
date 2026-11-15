import { FAILURES, requestSchema, type ServiceFailure } from './protocol'
import { ServiceError } from './client'
import { execute } from './operations'
import { undispatched } from '../child/dispatch'
import { classifier, rejected } from '../child/classify'
import { serveChild } from '../child/serve'

const generic = classifier(FAILURES, {}, ['DOMAIN_NOT_ATTEMPTED'], 'DOMAIN_SERVICE_UNAVAILABLE')

serveChild({
  requestSchema,
  execute,
  classify: (error: unknown): ServiceFailure => {
    const failure = error instanceof ServiceError ? error.failure : generic(error)
    if (failure.certainty === 'rejected' || !undispatched()) {
      return failure
    }
    return error instanceof ServiceError ? { ...failure, certainty: 'rejected' } : rejected('DOMAIN_NOT_ATTEMPTED')
  },
  invalidRequest: 'DOMAIN_NOT_ATTEMPTED',
})
