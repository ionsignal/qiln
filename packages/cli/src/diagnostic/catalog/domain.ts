import { entry } from './define'

export const domainDiagnostics = Object.freeze({
  DOMAIN_STATE_INVALID: entry(
    'Domain evidence is unsafe or incompatible',
    'An installation’s domain.json and tls.key must keep their supported schema, ownership, permissions, and binding to the installation, and a retained certificate must match the retained key and the allocated names, so an unreadable or inconsistent record is never repaired, migrated, or discarded, and it does not show that no service effects occurred.',
    'Inspect domain.json and tls.key in the protected installation directory, and do not edit them while another Qiln process may be active.',
    'A retained certificate whose key is lost is unusable. After review, remove domain.json by hand and run configure again: the service answers registration idempotently for the same operator and installation and issues a new certificate, which may count against its issuance caps.',
    'Qiln never deletes the key or the record itself.',
  ),
  DOMAIN_ACQUISITION_REFUSED: entry(
    'Domain acquisition was refused locally',
    'The installation already holds a domain allocated to a different AWS operator than the one bound to this deployment, and a second allocation would strand the first, so no request was sent and nothing was changed.',
    'Review the displayed principals.',
    'Use the connection of the operator that holds the allocation, which is the one recorded with the installation, for the deployment.',
    'Qiln never transfers an allocation between operators and never deletes one.',
  ),
  DOMAIN_NOT_ATTEMPTED: entry(
    'Domain request was not sent',
    'The request never reached the registration service because the command was cancelled, the retained evidence or the authenticated identity did not match, or a credential step failed first, which does not undo an earlier acquisition.',
    'Inspect the retained deployment and domain evidence and the authenticated operator before repeating the command.',
    'Do not edit or delete protected state to bypass the refusal.',
  ),
  DOMAIN_SERVICE_REFUSED: entry(
    'The registration service refused the request',
    'The service definitively rejected the request, for example an identity proof it could not accept, an unknown allocation, or a malformed request, and no DNS record or certificate was changed by it, and Qiln neither retries nor substitutes another service.',
    'Review the displayed details.',
    'Confirm that the saved operator login is current with qiln aws status, and that the deployment records its host address.',
    'Run configure again once the cause is resolved. A refused request is never replayed automatically.',
  ),
  DOMAIN_SERVICE_LIMIT: entry(
    'The registration service limit was reached',
    'The service refused the request because a cap was reached. For a registration this can follow the creation of the installation’s allocation record, but no DNS record or certificate was changed, and the service counts attempts of every status toward its caps.',
    'Wait for the service’s cap period to pass, then run configure again.',
    'Avoid repeating a failing command in a loop, because every attempt can count against the caps.',
  ),
  DOMAIN_SERVICE_UNAVAILABLE: entry(
    'The registration service did not complete the request',
    'The service was busy or could not verify the identity proof upstream, which rejected the request with no effect, or the request failed in transit, timed out, or failed at the DNS or certificate authority, which leaves the outcome uncertain. A local timeout stops only the local wait and does not cancel work the service may continue.',
    'Read the displayed Outcome. A refused outcome had no effect, while an uncertain one may have created DNS records, issued a certificate, or consumed a cap.',
    'Run configure again for the same target. Registration is idempotent, and the service returns a stored certificate for the same key without a new issuance while it is within its renewal window.',
    'A failed attempt may still have consumed an issuance cap.',
  ),
  DOMAIN_RESPONSE_INVALID: entry(
    'The registration service response was not accepted',
    'The reply did not match the strict response contract, or it failed the local checks: a registration must name the host address that was sent and, when the installation already holds an allocation, that same label and zone, and a certificate chain must match the retained TLS key and exactly the allocated apex and wildcard names, be signed link by link, carry the validity window the service reported, and not already be expired. These checks are not path validation to a trust root. Nothing from the reply was retained, but the service may already have completed the operation.',
    'Inspect the displayed details.',
    'Run configure again. The service returns a stored certificate for the same key when one exists, though repeated failures may count against issuance caps.',
    'If the failure repeats, report the response to the service maintainers. Qiln does not relax validation.',
  ),
})
