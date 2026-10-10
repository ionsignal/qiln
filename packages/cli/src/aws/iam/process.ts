import { classifier, rejected, uncertain } from '../child/classify'
import { serveChild } from '../child/serve'
import { execute } from './operations'
import { FAILURES, isRequest } from './protocol'

serveChild({
  isRequest,
  execute,
  classify: classifier(FAILURES, {
    EntityAlreadyExistsException: rejected('AWS_BOOTSTRAP_CONFLICT'),
    PasswordPolicyViolationException: rejected('AWS_BOOTSTRAP_PASSWORD_REJECTED'),
    NoSuchEntityException: uncertain('AWS_BOOTSTRAP_INSPECTION_FAILED'),
  }),
  invalidRequest: 'AWS_PERMISSION_STATE_INVALID',
})
