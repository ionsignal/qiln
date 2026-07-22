import {
  CapsuleBlueprintCommandName,
  SYSTEM_TARGET_ID,
  TargetType,
  type CapsuleBlueprintManifest,
  type CapsuleChannel,
  type TargetSystem,
} from '@qiln/core/server'

/**
 * Public-engine capsule blueprint service.
 *
 * Blueprint listing is worker-authoritative because the worker owns the runtime
 * registry used for actual branch provisioning. The engine only brokers the
 * system-scoped control-plane request through the Capsule Channel.
 */
export class CapsuleBlueprintService {
  constructor(private readonly channel: CapsuleChannel) {}

  public async list(): Promise<CapsuleBlueprintManifest> {
    return await this.channel.command(CapsuleBlueprintCommandName.BLUEPRINTS_LIST, {
      target: this.systemTarget(),
    })
  }

  private systemTarget(): TargetSystem {
    return {
      type: TargetType.SYSTEM,
      id: SYSTEM_TARGET_ID,
    }
  }
}
