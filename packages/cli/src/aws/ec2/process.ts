import { classifier, rejected } from '../child/classify'
import { serveChild } from '../child/serve'
import { execute } from './operations'
import { FAILURES, isRequest } from './protocol'

serveChild({
  isRequest,
  execute,
  classify: classifier(
    FAILURES,
    {
      InvalidVpcRange: rejected('AWS_DEPLOYMENT_REFUSED'),
      VpcLimitExceeded: rejected('AWS_DEPLOYMENT_LIMIT'),
      DependencyViolation: rejected('AWS_DEPLOYMENT_BLOCKED'),
    },
    // Raised only before the mutating call, so each is a definite refusal.
    ['AWS_DEPLOYMENT_NOT_ATTEMPTED'],
  ),
  invalidRequest: 'AWS_DEPLOYMENT_NOT_ATTEMPTED',
})
