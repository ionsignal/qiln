# Qiln

Self-hosted orchestration for people who own their GPUs.

Define a workload as a single YAML blueprint and Qiln handles the rest: Incus containers, NVIDIA passthrough, ZFS copy-on-write storage, and automatic HTTPS through Caddy. No Kubernetes, no rented cloud, no vendor lock-in.

Built for homelabs, small AI/ML teams, and anyone tired of choosing between renting compute they could own or wrestling a control plane they don't need.

## Status

Pre-release and under active development. The core provisioning engine works — GPU passthrough, ZFS vaults, vLLM inference, blueprint-driven container lifecycle. The admin UI and one-command installer are the gating features for a public v0.1.0.

Not ready for outside use yet. Watch the repo or join the waitlist if you want a heads-up when it is.

## Stack

Incus · ZFS · NATS · Caddy · Postgres · Fastify · tRPC · Vue 3

## License

Apache 2.0, no CLA, released alongside the first tagged version.
