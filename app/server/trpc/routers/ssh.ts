import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import {
  GlobalError,
  GlobalErrorCode,
  SshBranchGrantBindInputSchema,
  SshBranchGrantRevokeInputSchema,
  SshBranchGrantSummarySchema,
  SshOpenSshConfigInputSchema,
  SshOpenSshConfigOutputSchema,
  SshPublicKeyRegistrationInputSchema,
  SshPublicKeyRegistrationOutputSchema,
  SshPublicKeyRevokeInputSchema,
  SshPublicKeySummarySchema,
} from '@qiln/core/server'
import { adminProcedure, protectedProcedure, router } from '@server/trpc/procedures'

function mapGlobalErrorCode(code: GlobalErrorCode): TRPCError['code'] {
  switch (code) {
    case GlobalErrorCode.BAD_REQUEST:
      return 'BAD_REQUEST'
    case GlobalErrorCode.UNAUTHORIZED:
      return 'UNAUTHORIZED'
    case GlobalErrorCode.FORBIDDEN:
      return 'FORBIDDEN'
    case GlobalErrorCode.NOT_FOUND:
      return 'NOT_FOUND'
    case GlobalErrorCode.CONFLICT:
      return 'CONFLICT'
    case GlobalErrorCode.TIMEOUT:
      return 'TIMEOUT'
    case GlobalErrorCode.INTERNAL_ERROR:
    default:
      return 'INTERNAL_SERVER_ERROR'
  }
}

function rethrowSshPolicyError(error: unknown): never {
  if (error instanceof GlobalError) {
    throw new TRPCError({
      code: mapGlobalErrorCode(error.code),
      message: error.message,
      cause: error,
    })
  }

  throw error
}

/**
 * Authenticated Host SSH administration.
 *
 * Users own key registration and generated configuration. Only administrators
 * may create or revoke branch grants.
 */
export const sshRouter = router({
  keys: router({
    register: protectedProcedure
      .input(SshPublicKeyRegistrationInputSchema)
      .output(SshPublicKeyRegistrationOutputSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          return await ctx.ssh.registerPublicKey(ctx.user.id, input)
        } catch (error: unknown) {
          rethrowSshPolicyError(error)
        }
      }),

    list: protectedProcedure.output(z.array(SshPublicKeySummarySchema)).query(async ({ ctx }) => {
      try {
        return await ctx.ssh.listPublicKeys(ctx.user.id)
      } catch (error: unknown) {
        rethrowSshPolicyError(error)
      }
    }),

    revoke: protectedProcedure
      .input(SshPublicKeyRevokeInputSchema)
      .output(SshPublicKeySummarySchema)
      .mutation(async ({ ctx, input }) => {
        try {
          return await ctx.ssh.revokePublicKey(ctx.user.id, input.publicKeyId)
        } catch (error: unknown) {
          rethrowSshPolicyError(error)
        }
      }),
  }),

  grants: router({
    bind: adminProcedure
      .input(SshBranchGrantBindInputSchema)
      .output(SshBranchGrantSummarySchema)
      .mutation(async ({ ctx, input }) => {
        try {
          return await ctx.ssh.bindGrant(ctx.user.id, input.publicKeyId, input.branchId)
        } catch (error: unknown) {
          rethrowSshPolicyError(error)
        }
      }),

    revoke: adminProcedure
      .input(SshBranchGrantRevokeInputSchema)
      .output(SshBranchGrantSummarySchema)
      .mutation(async ({ ctx, input }) => {
        try {
          return await ctx.ssh.revokeGrant(ctx.user.id, input.grantId)
        } catch (error: unknown) {
          rethrowSshPolicyError(error)
        }
      }),

    list: adminProcedure.output(z.array(SshBranchGrantSummarySchema)).query(async ({ ctx }) => {
      try {
        return await ctx.ssh.listGrants(ctx.user.id)
      } catch (error: unknown) {
        rethrowSshPolicyError(error)
      }
    }),
  }),

  config: protectedProcedure
    .input(SshOpenSshConfigInputSchema)
    .output(SshOpenSshConfigOutputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await ctx.ssh.generateOpenSshConfig(ctx.user.id, input.publicKeyId)
      } catch (error: unknown) {
        rethrowSshPolicyError(error)
      }
    }),
})
