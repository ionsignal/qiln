<img src="./assets/brand/qiln-readme.png" alt="Qiln — self-hosted GPU workspaces on hardware you own" width="900">

**Self-hosted GPU workspaces on hardware you own.**  
One YAML blueprint. Isolated Incus workspaces. ZFS clones. Leased GPUs. HTTPS.

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)
[![Status: pre-release alpha](https://img.shields.io/badge/status-pre--release%20alpha-orange)](#status)
[![Scope: single node first](https://img.shields.io/badge/scope-single--node%20first-7c3aed)](#first-release-scope)
[![CLA: none](https://img.shields.io/badge/CLA-none-brightgreen)](#license)
[![Join the waitlist](https://img.shields.io/badge/join-waitlist-7c3aed)](https://qiln.com)

<p>
  <a href="https://qiln.com"><strong>Join the waitlist</strong></a>
  ·
  <a href="https://discord.gg/eNaxauuyZ6">Discord</a>
  ·
  <a href="#status">Status</a>
  ·
  <a href="#how-it-works">How it works</a>
  ·
  <a href="#first-release-scope">First release scope</a>
  ·
  <a href="#license">License</a>
</p>

Qiln turns a bare-metal GPU server into isolated, per-user AI workspaces. Define a workload with a YAML blueprint — ComfyUI, vLLM, JupyterLab, Ollama, or your own app — and Qiln handles the container, storage, GPU access, and HTTPS routing.

The goal is simple: own the GPUs, keep control of your data, and stop running Kubernetes for a 4–16 GPU deployment.

Qiln is developed by [IonSignal, Inc.](https://ionsignal.com).

## Contents

- [Status](#status)
- [Who Qiln is for](#who-qiln-is-for)
- [What Qiln does](#what-qiln-does)
- [How it works](#how-it-works)
- [What Qiln is not](#what-qiln-is-not)
- [First release scope](#first-release-scope)
- [Planned repository layout](#planned-repository-layout)
- [Documentation](#documentation)
- [Stack](#stack)
- [License](#license)
- [Security](#security)

## Status

Qiln is pre-release infrastructure.

The public source will open here for the first usable alpha, `v0.1.0`. Until then, this repository is intentionally minimal and serves as the future public source home for Qiln.

The private development branch currently includes core primitives for:

- Incus-based per-user workspace provisioning
- YAML blueprint loading and validation
- ZFS-backed storage volume creation and cloning
- GPU lease lifecycle for supported workloads
- automatic HTTPS routing through Caddy
- NATS-based internal eventing
- Fastify/tRPC APIs
- browser-based admin UI for workspaces, vaults, blueprints, and operations

The public `v0.1.0` release is gated on:

- a repeatable one-command installer
- finalized admin and user UI flows
- a usable vault/file browser with image previews and file editing
- model import flows, including Hugging Face integration
- documented Incus, ZFS, NVIDIA, and Caddy setup
- stable blueprint examples for common AI workloads
- preparation of the source tree for external review and contribution

Qiln is not publicly installable yet. If you own GPUs and want to help shape the alpha, [join the waitlist](https://qiln.com).

We are prioritizing:

1. **Design partners** running real GPU hardware with real users.
2. **Discord community members** willing to test, break things, and give feedback.
3. **GitHub stars/watchers** who want to follow the public release.

## Who Qiln is for

Qiln is for small teams that own, or want to own, their GPU hardware.

That includes:

- creative studios running ComfyUI for artists and production workflows
- AI/ML teams serving internal vLLM, Ollama, notebook, or model-testing environments
- research groups sharing a few expensive GPUs
- serious homelabbers who want team-grade isolation without enterprise-grade ceremony

If you are paying for Comfy Cloud, Floyo, or other managed ComfyUI-style services mainly because shared GPU boxes are painful, Qiln is being built for the alternative: managed workspaces on your own metal.

## What Qiln does

Qiln turns one bare-metal machine into a managed GPU workspace host.

A Qiln workspace can include:

- an isolated Incus container
- one or more ZFS-backed storage vaults
- a temporary GPU lease
- HTTPS routing through Caddy
- app-specific configuration from a declarative YAML blueprint
- browser-accessible workspace and file-management UI

The important primitives are:

- **Workspaces** — isolated environments for users and apps.
- **Blueprints** — YAML definitions for repeatable workload provisioning.
- **Vaults** — ZFS-backed storage volumes for models, configs, inputs, outputs, and datasets.
- **GPU leases** — temporary access to expensive GPUs, with release-on-idle support for integrated workloads.
- **Operations** — admin visibility into events, status, and infrastructure health.

## How it works

At a high level:

1. You define or import a YAML blueprint for a workload.
2. A user launches a workspace from that blueprint.
3. Qiln provisions an isolated Incus container.
4. Qiln wires storage vaults, including fast ZFS copy-on-write clones where possible.
5. Qiln attaches a GPU lease when the workload needs acceleration.
6. Qiln routes the workspace through HTTPS using Caddy.
7. Admins manage workspaces, vaults, leases, and events from the browser UI.

For supported apps, Qiln can integrate more deeply. ComfyUI is a major first target: the goal is to make GPU attach/detach, idle GPU release, model management, image previews, and workspace file operations feel native instead of like infrastructure chores.

## What Qiln is not

Qiln is not a rented GPU cloud.

If your workloads are extremely spiky or you do not want to own hardware, Runpod, Vast.ai, Lambda, Modal, and similar platforms are often the right answer.

Qiln is also not Kubernetes.

If you operate a large GPU fleet with a platform team, Kubernetes, Run:ai, Kubeflow, and related systems may make sense. Qiln is for the teams before that point — the teams with one or two serious boxes, a few expensive GPUs, real users, and no desire to build a platform team just to run ComfyUI, vLLM, Ollama, or notebooks.

Qiln is not a chat UI or local model runner.

It can run tools like Open WebUI, Ollama, ComfyUI, JupyterLab, and vLLM. Qiln is the orchestration layer that provisions those apps as isolated workspaces and manages the hardware underneath them.

Qiln is not currently intended for hostile public-cloud-style multi-tenancy.

The alpha is aimed at trusted teams, studios, labs, and homelabs. Do not expose untrusted tenants to Qiln until the public security model has been hardened and documented.

## First release scope

`v0.1.0` is focused on one machine.

The first public alpha is expected to support:

- one bare-metal GPU server
- Incus for container isolation
- ZFS for copy-on-write vaults
- Caddy for HTTPS routing
- NATS for internal eventing and preparation for Incus cluster support
- Postgres for state
- browser-based admin UI
- official blueprints for common AI workloads

The first release is single-node by design. Multi-node Incus clustering comes later, but it is being roadmapped now.

Qiln is not recommended for production or untrusted multi-tenant environments until the public alpha has been hardened.

## Planned repository layout

When the source opens, this repository is expected to contain:

```txt
apps/
  qiln/          # runnable Qiln server and admin UI

packages/
  core/          # shared schemas, events, NATS/RPC utilities
  engine/        # orchestration engine, Incus/ZFS services, UI components

blueprints/
  comfyui/
  vllm/
  jupyterlab/
  ollama/

docs/
  concepts/
  install/
  blueprints/
  guides/
  reference/
```

This may change before `v0.1.0`. The goal is a clean public tree, not a source dump.

## Documentation

Public documentation will live on the Qiln website.

This repository will link to the docs when `v0.1.0` opens. The documentation set is expected to cover:

- concepts
- architecture
- installation
- blueprint authoring
- workload guides
- ComfyUI workspace setup
- GPU leasing behavior
- vault and storage management
- security model and limitations
- reference material

## Stack

Incus · ZFS · NATS · Caddy · Postgres · Fastify · tRPC · Vue 3

## License

Qiln core will be released under Apache 2.0.

The `LICENSE` file is included now to make the intended public-source license explicit before the source lands.

No CLA.

IonSignal may offer commercial modules, integrations, and support separately. The open-source core is intended to remain useful on its own for single-node self-hosted GPU workspaces.

## Security

Qiln is pre-release infrastructure and should be treated accordingly.

Security reporting details are provided in [`SECURITY.md`](./SECURITY.md).
