import {
  CapsuleChannelError,
  CapsuleChannelErrorCode,
  CapsuleSshControlCommandName,
  GlobalError,
  GlobalErrorCode,
  TargetType,
} from '@qiln/core/server'
import type {
  CapsuleChannel,
  CapsuleCommandInput,
  CapsuleCommandOutput,
  SshBranchGrantSummary,
  SshOpenSshConfigOutput,
  SshPublicKeyRegistration,
  SshPublicKeySummary,
} from '@qiln/core/server'

function mapChannelErrorCode(code: CapsuleChannelErrorCode): GlobalErrorCode {
  switch (code) {
    case CapsuleChannelErrorCode.BAD_REQUEST:
      return GlobalErrorCode.BAD_REQUEST
    case CapsuleChannelErrorCode.UNAUTHORIZED:
      return GlobalErrorCode.UNAUTHORIZED
    case CapsuleChannelErrorCode.FORBIDDEN:
      return GlobalErrorCode.FORBIDDEN
    case CapsuleChannelErrorCode.NOT_FOUND:
      return GlobalErrorCode.NOT_FOUND
    case CapsuleChannelErrorCode.CONFLICT:
      return GlobalErrorCode.CONFLICT
    case CapsuleChannelErrorCode.TIMEOUT:
      return GlobalErrorCode.TIMEOUT
    case CapsuleChannelErrorCode.TRANSPORT_ERROR:
    case CapsuleChannelErrorCode.INTERNAL_ERROR:
    default:
      return GlobalErrorCode.INTERNAL_ERROR
  }
}

/**
 * Web's management-only SSH boundary.
 *
 * Requester identities come from authenticated tRPC context. The standalone SSH
 * authority independently validates ownership and administrator state. This
 * client owns no database, gateway, key material, or lifecycle authority.
 */
export class SshControlClient {
  constructor(private readonly channel: CapsuleChannel) {}

  public registerPublicKey(userId: string, input: SshPublicKeyRegistration): Promise<SshPublicKeySummary> {
    return this.request(CapsuleSshControlCommandName.SSH_KEY_REGISTER, {
      target: { type: TargetType.OWNER, id: userId },
      publicKey: input.publicKey,
      ...(input.label === undefined ? {} : { label: input.label }),
    })
  }

  public listPublicKeys(userId: string): Promise<SshPublicKeySummary[]> {
    return this.request(CapsuleSshControlCommandName.SSH_KEYS_LIST, {
      target: { type: TargetType.OWNER, id: userId },
    })
  }

  public revokePublicKey(userId: string, publicKeyId: string): Promise<SshPublicKeySummary> {
    return this.request(CapsuleSshControlCommandName.SSH_KEY_REVOKE, {
      target: { type: TargetType.OWNER, id: userId },
      publicKeyId,
    })
  }

  public bindGrant(adminUserId: string, publicKeyId: string, branchId: string): Promise<SshBranchGrantSummary> {
    return this.request(CapsuleSshControlCommandName.SSH_GRANT_BIND, {
      target: { type: TargetType.OWNER, id: adminUserId },
      publicKeyId,
      branchId,
    })
  }

  public revokeGrant(adminUserId: string, grantId: string): Promise<SshBranchGrantSummary> {
    return this.request(CapsuleSshControlCommandName.SSH_GRANT_REVOKE, {
      target: { type: TargetType.OWNER, id: adminUserId },
      grantId,
    })
  }

  public listGrants(adminUserId: string): Promise<SshBranchGrantSummary[]> {
    return this.request(CapsuleSshControlCommandName.SSH_GRANTS_LIST, {
      target: { type: TargetType.OWNER, id: adminUserId },
    })
  }

  public generateOpenSshConfig(userId: string, publicKeyId: string): Promise<SshOpenSshConfigOutput> {
    return this.request(CapsuleSshControlCommandName.SSH_CONFIG, {
      target: { type: TargetType.OWNER, id: userId },
      publicKeyId,
    })
  }

  private async request<TName extends CapsuleSshControlCommandName>(
    name: TName,
    input: CapsuleCommandInput<TName>,
  ): Promise<CapsuleCommandOutput<TName>> {
    try {
      return await this.channel.command(name, input)
    } catch (error: unknown) {
      if (!(error instanceof CapsuleChannelError)) {
        throw new GlobalError('Internal SSH service error.', GlobalErrorCode.INTERNAL_ERROR)
      }
      if (error.code === CapsuleChannelErrorCode.TRANSPORT_ERROR) {
        throw new GlobalError('The SSH service is unavailable.', GlobalErrorCode.INTERNAL_ERROR)
      }
      if (error.code === CapsuleChannelErrorCode.INTERNAL_ERROR) {
        throw new GlobalError('Internal SSH service error.', GlobalErrorCode.INTERNAL_ERROR)
      }
      if (error.code === CapsuleChannelErrorCode.TIMEOUT) {
        // A request timeout does not prove that the authority rejected or
        // rolled back the mutation. Never retry management mutations here.
        throw new GlobalError(
          'The SSH service request timed out. Refresh SSH state before retrying.',
          GlobalErrorCode.TIMEOUT,
        )
      }
      throw new GlobalError(error.message, mapChannelErrorCode(error.code))
    }
  }
}
