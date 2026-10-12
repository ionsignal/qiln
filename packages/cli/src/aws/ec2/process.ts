import { classifier, rejected } from '../child/classify'
import type { Failure } from '../child/protocol'
import { serveChild } from '../child/serve'
import { undispatched } from './dispatch'
import { execute } from './operations'
import { FAILURES, isRequest, type Code } from './protocol'

const classify = classifier(
  FAILURES,
  {
    InvalidVpcRange: rejected('AWS_DEPLOYMENT_REFUSED'),
    'InvalidSubnet.Range': rejected('AWS_DEPLOYMENT_REFUSED'),
    'InvalidSubnet.Conflict': rejected('AWS_DEPLOYMENT_REFUSED'),
    VpcLimitExceeded: rejected('AWS_DEPLOYMENT_LIMIT'),
    SubnetLimitExceeded: rejected('AWS_DEPLOYMENT_LIMIT'),
    InternetGatewayLimitExceeded: rejected('AWS_DEPLOYMENT_LIMIT'),
    RouteTableLimitExceeded: rejected('AWS_DEPLOYMENT_LIMIT'),
    SecurityGroupLimitExceeded: rejected('AWS_DEPLOYMENT_LIMIT'),
    RulesPerSecurityGroupLimitExceeded: rejected('AWS_DEPLOYMENT_LIMIT'),
    DependencyViolation: rejected('AWS_DEPLOYMENT_BLOCKED'),
  },
  // Raised only before any mutating call, so each is a definite refusal.
  ['AWS_DEPLOYMENT_NOT_ATTEMPTED', 'AWS_DEPLOYMENT_PLACEMENT_UNSUPPORTED'],
)

serveChild({
  isRequest,
  execute,
  classify: (error: unknown): Failure<Code> => {
    const failure = classify(error)
    // A mutating request that failed before its send() cannot have changed
    // anything. Failures during or after dispatch, and specific provider
    // refusals, keep their own classification.
    return failure.certainty === 'uncertain' && undispatched()
      ? rejected('AWS_DEPLOYMENT_NOT_ATTEMPTED')
      : failure
  },
  invalidRequest: 'AWS_DEPLOYMENT_NOT_ATTEMPTED',
})
