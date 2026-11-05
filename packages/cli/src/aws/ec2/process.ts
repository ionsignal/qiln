import { QUOTAS, isQuota, type Quota } from '../deployment/quota'
import { FAILURES, requestSchema, type Code } from './protocol'
import { execute } from './operations'
import { undispatched } from './dispatch'
import { classifier, rejected } from '../child/classify'
import { serveChild } from '../child/serve'
import { isRecord } from '../../guards'
import { DiscoveryError, type Issue } from '../deployment/proposal/failure'
import type { Failure } from '../child/protocol'

interface ContextualFailure extends Failure<Code> {
  context?: Issue
  quota?: Quota
}

type Names = Readonly<Record<string, Failure<(typeof FAILURES)[number]>>>

const NAMES: Names = {
  InvalidVpcRange: rejected('AWS_DEPLOYMENT_REFUSED'),
  'InvalidSubnet.Range': rejected('AWS_DEPLOYMENT_REFUSED'),
  'InvalidSubnet.Conflict': rejected('AWS_DEPLOYMENT_REFUSED'),
  ...Object.fromEntries(Object.keys(QUOTAS).map(name => [name, rejected('AWS_DEPLOYMENT_LIMIT')])),
  InsufficientInstanceCapacity: rejected('AWS_DEPLOYMENT_CAPACITY'),
  DependencyViolation: rejected('AWS_DEPLOYMENT_BLOCKED'),
  'InvalidAMIID.Malformed': rejected('AWS_DEPLOYMENT_IMAGE_UNAVAILABLE'),
  'InvalidAMIID.NotFound': rejected('AWS_DEPLOYMENT_IMAGE_UNAVAILABLE'),
  'InvalidAMIID.Unavailable': rejected('AWS_DEPLOYMENT_IMAGE_UNAVAILABLE'),
}

const classify = classifier(FAILURES, NAMES, ['AWS_DEPLOYMENT_NOT_ATTEMPTED'])

serveChild({
  requestSchema,
  execute,
  classify: (error: unknown): ContextualFailure => {
    const failure = classify(error)
    if (failure.certainty === 'uncertain' && undispatched()) {
      return rejected('AWS_DEPLOYMENT_NOT_ATTEMPTED')
    }
    if (error instanceof DiscoveryError) {
      return { ...failure, context: error.issue }
    }
    const name = isRecord(error) ? error.name : undefined
    return isQuota(name) ? { ...failure, quota: name } : failure
  },
  invalidRequest: 'AWS_DEPLOYMENT_NOT_ATTEMPTED',
})
