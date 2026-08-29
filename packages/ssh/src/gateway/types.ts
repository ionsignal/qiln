import type {
  SshCanonicalPublicKey,
  SshGatewayKeyEligibilityOutput,
  SshRelayActivationOutput,
  SshRelayCloseOutput,
  SshRelayOpening,
  SshTicketIssueOutput,
} from '@qiln/core/server'

export interface SshGatewayHostPolicy {
  checkGatewayKeyEligibility(key: SshCanonicalPublicKey): Promise<SshGatewayKeyEligibilityOutput>
  issueGatewayTicket(key: SshCanonicalPublicKey): Promise<SshTicketIssueOutput>
  redeemGatewayTicket(ticket: string, key: SshCanonicalPublicKey, gatewayInstanceId: string): Promise<SshRelayOpening>
  activateRelay(relayId: string, gatewayInstanceId: string): Promise<SshRelayActivationOutput>
  closeRelay(relayId: string, gatewayInstanceId: string, reason: string): Promise<SshRelayCloseOutput>
}

export interface SshGatewayConfig {
  bindHost: string
  bindPort: number
  gatewayInstanceId: string
  hostKeys: readonly Buffer[]
  maxConnections: number
  maxRelays: number
  authenticationTimeoutMs: number
  channelOpenTimeoutMs: number
  branchDialTimeoutMs: number
}

export interface SshGatewayStats {
  listening: boolean
  incomingConnections: number
  authenticatedConnections: number
  activeRelays: number
  relayTombstones: number
  authRejections: number
  dialFailures: number
  eventLoopLagMeanMs: number
  eventLoopLagMaxMs: number
}

export type SshRelayRegistryState = 'registered' | 'dialing' | 'active'
export type SshRelayClosureOrigin = 'host' | 'natural' | 'setup_failure' | 'shutdown'
export type SshRelayRegistrationResult = 'registered' | 'tombstoned' | 'capacity'
