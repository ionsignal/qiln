import { classifier, rejected } from '../child/classify'
import type { Failure } from '../child/protocol'
import { serveChild } from '../child/serve'
import { DiscoveryError, type Issue } from '../deployment/proposal/failure'
import { undispatched } from './dispatch'
import { execute } from './operations'
import { FAILURES, requestSchema, type Code } from './protocol'

interface ContextualFailure extends Failure<Code> {
  context?: Issue
}

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
    InstanceLimitExceeded: rejected('AWS_DEPLOYMENT_LIMIT'),
    VcpuLimitExceeded: rejected('AWS_DEPLOYMENT_LIMIT'),
    VolumeLimitExceeded: rejected('AWS_DEPLOYMENT_LIMIT'),
    MaxIOPSLimitExceeded: rejected('AWS_DEPLOYMENT_LIMIT'),
    AddressLimitExceeded: rejected('AWS_DEPLOYMENT_LIMIT'),
    InsufficientInstanceCapacity: rejected('AWS_DEPLOYMENT_CAPACITY'),
    DependencyViolation: rejected('AWS_DEPLOYMENT_BLOCKED'),
    'InvalidAMIID.Malformed': rejected('AWS_DEPLOYMENT_IMAGE_UNAVAILABLE'),
    'InvalidAMIID.NotFound': rejected('AWS_DEPLOYMENT_IMAGE_UNAVAILABLE'),
    'InvalidAMIID.Unavailable': rejected('AWS_DEPLOYMENT_IMAGE_UNAVAILABLE'),
  },
  ['AWS_DEPLOYMENT_NOT_ATTEMPTED'],
)

serveChild({
  requestSchema,
  execute,
  classify: (error: unknown): ContextualFailure => {
    const failure = classify(error)
    if (failure.certainty === 'uncertain' && undispatched()) {
      return rejected('AWS_DEPLOYMENT_NOT_ATTEMPTED')
    }
    return error instanceof DiscoveryError ? { ...failure, context: error.issue } : failure
  },
  invalidRequest: 'AWS_DEPLOYMENT_NOT_ATTEMPTED',
})
