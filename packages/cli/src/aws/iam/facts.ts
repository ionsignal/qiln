import type { Pending } from './types'

export function pendingFacts(record: Pending) {
  const mutation = record.mutation
  const outcome =
    record.verified !== null
      ? 'IAM verification completed; publication or cleanup may remain outstanding'
      : mutation === null
        ? 'no IAM mutation intent recorded'
        : mutation.verifiedAt !== null
          ? 'outstanding mutation verified; operation not completed'
          : mutation.returned !== null
            ? 'mutation result retained; verification unresolved'
            : 'mutation intent retained; AWS outcome uncertain'
  return [
    ['IAM operation', record.id],
    ['Operation kind', record.kind],
    ['Account', record.accountId ?? 'not verified'],
    ['Operator', record.operator?.arn ?? 'creation not verified'],
    ['Operator user ID', record.operator?.userId ?? 'not recorded'],
    ['Creation identity', record.creationId],
    ['Permission region', record.region],
    ['Approved requirement', String(record.approval?.permission.version ?? 'not approved')],
    ['Outstanding mutation', mutation?.action ?? 'none'],
    ['Observed outcome', outcome],
    ['Foundation policy', record.foundation?.arn ?? 'not recorded'],
    ['Policy ID', record.foundation?.id ?? 'not recorded'],
    ['Policy version', record.foundation?.versionId ?? 'not recorded'],
    [
      'Initial password',
      record.password === null
        ? mutation?.action === 'password'
          ? 'creation or delivery may have occurred; no receipt retained'
          : 'no creation intent recorded'
        : record.password.delivered
          ? 'creation and terminal-write completion retained; human receipt is not proven'
          : 'creation retained; terminal delivery not confirmed',
    ],
    ['Root termination', record.termination],
    ['Root cleanup', record.cleanup],
    ['Recorded failure', record.failureCode ?? 'none'],
    ['IAM recovery', 'No replay, rollback, adoption, policy deletion, version pruning, or password reissuance was attempted.'],
  ] as const
}
