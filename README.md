<!-- README.md -->

<img src="./assets/brand/qiln-readme.png" alt="Qiln — versioned AI workflow capsules" width="900">

# Qiln

**Durable, versioned AI workflow capsules for your AI workflows.**

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)
[![Status: pre-release alpha](https://img.shields.io/badge/status-pre--release%20alpha-orange)](#development-status)
[![Interface: CLI-first](https://img.shields.io/badge/interface-CLI--first-7c3aed)](#interface-status)
[![CLA: none](https://img.shields.io/badge/CLA-none-brightgreen)](#license)

Qiln makes an AI workflow system durable, branchable, and reviewable.

A **capsule** contains workflow artifacts, visual node graphs, custom nodes, models, dependencies, shared folders, route configuration, tests, secret references, snapshots, and operational history.

Qiln is not generic GPU hosting, hosting for apps, a cloud IDE, a BaaS or a PaaS.

## What Qiln is for

Qiln provides a controlled lifecycle for changing AI workflow systems:

```text
create capsule → snapshot → fork branch → edit → test + diff → preview → promote → rollback
```

The current alpha supports capsule creation, editable branches, experimental snapshot capture, snapshot-based forks, and live branch previews.

A capsule can begin with one `main` branch and one live preview. Forking from a committed snapshot creates another editable branch, which can receive its own preview route.

Snapshots do not automatically create release runtimes. Immutable release routes remain explicit `promote` and `rollback` concerns.

## Core model

- **Capsule** — durable AI workflow system.
- **Branch** — editable capsule state for a human or agent.
- **Snapshot** — immutable captured history used for inspection and forks.
- **Live preview** — mutable route to an eligible online branch.
- **Route alias** — stable release-facing route identity.
- **Revision** — immutable route history for a route alias.
- **Promote / rollback** — future operations that move a route alias only after durable review and verification.

Qiln keeps production separate from editing. Branches are where humans and agents make changes; immutable history is where review, release, and rollback decisions belong.

## Development status

| Capability                                                     | Status                                |
| -------------------------------------------------------------- | ------------------------------------- |
| Capsule creation and durable operation ledger                  | Implemented                           |
| Editable branch lifecycle and runtime reconciliation           | Implemented                           |
| Immutable Blueprint, rootfs-image, and capture-policy pins     | Implemented                           |
| Experimental Snapshot Capture                                  | Implemented with explicit limitations |
| Snapshot-based editable forks                                  | Implemented with explicit limitations |
| Live previews for eligible online branches                     | Implemented for alpha environments    |
| Privileged Caddy route management and verification             | Implemented                           |
| Durable route aliases, revisions, heads, and provider evidence | Implemented                           |
| Golden-test and diff-review execution                          | Not exposed                           |
| Promote and rollback execution                                 | Not exposed                           |
| Immutable release runtimes                                     | Not exposed                           |
| Production route aliases                                       | Not exposed                           |

The initial capsule Blueprint is **n8n + ComfyUI**. Their capture and application capabilities remain intentionally explicit: snapshot support is experimental, and the current contracts do not claim production release readiness.

We chose these systems as Qiln’s proof of concept because they reflect the kind of workflow environment we know firsthand: sprawling, stateful, dependency-heavy, and difficult to change safely. They combine multiple Git repositories, custom nodes, workflow exports, databases, large models, generated outputs, shared storage, and opaque runtime state.

Qiln brings that complexity under durable capsule, branch, snapshot, test, diff, and rollback controls—so humans and agents can make changes with clearer boundaries and less guesswork.

## Architecture

```text
qiln-stealth/
├── app/
│   └── server/                         # Host composition, Fastify lifecycle, DB ownership
├── packages/
│   ├── core/
│   │   └── src/
│   │       ├── schemas/                # Capsule, Blueprint, snapshot, route contracts
│   │       ├── digest/                 # Canonical immutable pins and content digests
│   │       ├── db/                     # Composable Drizzle tables and relation fragments
│   │       ├── protocol/               # Typed NATS commands, events, targets, envelopes
│   │       ├── transport/              # NATS connection and JSON transport mechanics
│   │       └── blueprints/             # Server-side Blueprint registry
│   │
│   ├── engine/                         # UI/UX Layer
│   │
│   └── worker/
│       └── src/
│           ├── coordination/           # PostgreSQL Worker authority and supervision
│           ├── incus/                  # Restricted Incus and storage capabilities
│           ├── caddy/                  # Restricted Caddy admin and managed route boundary
│           ├── channel/                # Worker-side capsule command handlers
│           └── services/capsule/
│               ├── operations/         # Durable create, fork, capture, archive, destroy flows
│               ├── branch/             # Branch runtime observation and reconciliation
│               ├── routing/            # Live previews and committed route reads
│               ├── snapshot/           # Committed snapshot history reads
│               └── resource/           # Durable provider-resource ownership inventory
├── catalog/
│   ├── blueprints/                     # Versioned n8n + ComfyUI capsule definitions
│   └── images/                         # Orchestrator image definitions
└── drizzle.config.ts                   # Host-owned schema generation
```

| Area                     | Source                                                                      | Responsibility                                                                  | Code quality | Production readiness |
| ------------------------ | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | -----------: | -------------------: |
| Core contracts           | `packages/core/src`                                                         | Schemas, pins, digests, protocol, database fragments                            |          4/5 |                  3/5 |
| Capsule operations       | `packages/worker/src/services/capsule/operations`                           | Durable acceptance, fences, execution, compensation, abandonment classification |          4/5 |                  2/5 |
| Routing and Caddy        | `packages/worker/src/services/capsule/routing`, `packages/worker/src/caddy` | Live previews, managed Caddy routes, verification, route persistence            |          4/5 |                  2/5 |
| Infrastructure authority | `packages/worker/src/coordination`, `packages/worker/src/incus`             | Worker exclusivity, fail-stop behavior, Incus and storage boundaries            |          4/5 |                  2/5 |
| Host runtime             | `app/server`                                                                | Fastify lifecycle, final Drizzle composition, embedded Worker development mode  |          3/5 |                  2/5 |
| Blueprint catalog        | `catalog/blueprints`                                                        | Initial n8n + ComfyUI capsule definition and capture policy                     |          3/5 |                  2/5 |
| **Overall**              | —                                                                           | Pre-release capsule platform                                                    |      **4/5** |              **2/5** |

Scores reflect implementation structure and feature completeness, not a security audit or production certification.

## Safety model

- PostgreSQL is authoritative for capsule and operation state.
- Operations are durable mutation-control records, not generic jobs.
- Immutable execution input is reloaded from PostgreSQL.
- Provider intent is persisted before Incus or Caddy mutation.
- Provider resources have explicit ownership and mutation outcomes.
- Interrupted provider mutations are classified; they are never resumed automatically.
- Events are best-effort invalidations sourced from committed state.

Caddy access is Worker-only and constrained to a Qiln-managed route array with strict route validation, ETag writes, and read-after-write verification.

## Interface status

Qiln is currently **CLI-first**.

UX/UI is not the current focus. UI work is scheduled for October 2026 release. The present implementation emphasis is durable capsule behavior, safe infrastructure boundaries, and operational correctness.

## Current boundaries

Qiln is pre-release software for controlled alpha environments.

- Snapshot capture and forks are experimental.
- Live previews are mutable branch routes, not release aliases.
- Promotion, rollback, and immutable release runtimes are not exposed.
- Production routing is not exposed.
- Current Blueprint capabilities do not claim complete secret, dependency, Git, or production restoration semantics.
- Incus, ZFS, PostgreSQL, NATS, and Caddy are infrastructure details behind the capsule model.

## License

Licensed under the [Apache License 2.0](./LICENSE).
