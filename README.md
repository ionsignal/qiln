<img src="./assets/brand/qiln-readme.png" alt="Qiln — versioned AI workflow capsules" width="900">

[Website](https://qiln.com) | [Installation](#installation) | [Documentation](https://qiln.com/docs) | [Blog](https://qiln.com/blog)

# Qiln

**Durable, versioned capsules for AI workflow systems.**

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)
[![Status: pre-release alpha](https://img.shields.io/badge/status-pre--release%20alpha-orange)](#development-status)
[![Interface: CLI-first](https://img.shields.io/badge/interface-CLI--first-7c3aed)](#interface-status)
[![CLA: none](https://img.shields.io/badge/CLA-none-brightgreen)](#license)

Qiln manages AI workflow systems as durable, branchable, and reviewable capsules.

A capsule can include workflow artifacts, visual node graphs, custom nodes, models, dependencies, shared folders, route configuration, tests, secret references, snapshots, and operational history.

Qiln is not generic GPU hosting, application hosting, a cloud IDE, a backend as a service (BaaS), or a platform as a service (PaaS).

## What Qiln is for

Qiln provides a controlled lifecycle for changes to AI workflow systems.

The intended lifecycle is:

```text
create capsule → capture snapshot → fork branch → edit → test + diff → preview → promote → rollback
```

The current alpha supports:

- Capsule creation.
- Editable branches.
- Experimental snapshot capture.
- Experimental snapshot-based editable forks.
- Live previews for eligible online branches.

Test and diff review, promotion, rollback, and immutable release runtimes are planned.

A capsule can begin with one `main` branch and one live preview. Forking from a committed snapshot creates another editable branch. An eligible online branch can receive its own live preview route.

Capturing a snapshot does not create a release runtime. Release routing remains an explicit concern of planned `promote` and `rollback` operations.

## Core model

- **Capsule** — A durable AI workflow system.
- **Branch** — Editable capsule state for a human or agent.
- **Snapshot** — Immutable captured history used for inspection and forks.
- **Live preview** — A mutable route to an eligible online branch.
- **Route alias** — A stable, release-facing route identity.
- **Revision** — Immutable route history for a route alias.
- **`promote` / `rollback`** — Planned operations that move a route alias only after durable review and verification.

Branches hold editable state for humans and agents. Snapshots provide immutable history for inspection and review. Release and rollback decisions remain separate from editing.

A Blueprint is a versioned reference capsule definition. The initial capsule Blueprint is **n8n + ComfyUI**.

Capture and application capabilities remain intentionally explicit. Snapshot support is experimental. The current contracts do not claim production release readiness.

We chose **n8n + ComfyUI** as Qiln’s proof-of-concept reference applications because they are stateful, dependency-heavy, and difficult to iterate on and develop safely. They can combine multiple Git repositories, custom nodes, workflow exports, databases, large models, generated outputs, many inputs, shared storage, and opaque runtime state.

Qiln is designed to manage that complexity with capsule, branch, snapshot, test, diff, and rollback controls.

## Routing model

Qiln separates mutable review traffic from release routing.

| Route type       | Points to                                                               | Mutability                 | Status                          |
| ---------------- | ----------------------------------------------------------------------- | -------------------------- | ------------------------------- |
| **Live preview** | An eligible online editable branch                                      | Mutable                    | Available in alpha environments |
| **Route alias**  | An explicit snapshot-derived runtime created by `promote` or `rollback` | Immutable revision history | Planned                         |

A snapshot provides durable history and fork input. It does not create a release runtime, change traffic, or move a route alias.

A capsule can begin with one `main` branch and one live preview. Snapshot-based forks can add independently previewable branches.

## Architecture

```text
qiln/
├── app/
│   └── server/                         # Host composition, Fastify lifecycle, database ownership
├── packages/
│   ├── core/
│   │   └── src/
│   │       ├── schemas/                # Capsule, blueprint, snapshot, and route contracts
│   │       ├── digest/                 # Canonical immutable pins and content digests
│   │       ├── db/                     # Composable Drizzle tables and relation fragments
│   │       ├── protocol/               # Typed NATS commands, events, targets, and envelopes
│   │       ├── transport/              # NATS connection and JSON transport mechanics
│   │       └── blueprints/             # Server-side Blueprint registry
│   │
│   ├── engine/                         # User interface and user experience layer (todo)
│   │
│   └── worker/
│       └── src/
│           ├── coordination/           # PostgreSQL Worker authority and supervision
│           ├── incus/                  # Incus and storage capabilities
│           ├── caddy/                  # Caddy admin and managed route boundary
│           ├── channel/                # Capsule command handlers listening on NATS
│           └── services/capsule/
│               ├── operations/         # Durable create, fork, capture, archive, and destroy flows
│               ├── branch/             # Branch runtime observation and reconciliation
│               ├── routing/            # Live previews and committed route reads
│               ├── snapshot/           # Committed snapshot history reads
│               └── resource/           # Durable provider-resource ownership inventory
├── catalog/
│   ├── blueprints/                     # Versioned reference capsule definitions
│   └── images/                         # Orchestrator image definitions
└── drizzle.config.ts                   # Host-owned schema generation
```

## Development status

The table reports implementation status. It does not indicate production readiness or whether a capability is currently exposed. See [Current boundaries](#current-boundaries) for alpha limitations.

| Capability                                                     | Status                                |
| -------------------------------------------------------------- | ------------------------------------- |
| Installation instructions                                      | Planned                               |
| Installation wizard                                            | Planned                               |
| Capsule creation and durable operation ledger                  | Implemented                           |
| Editable branch lifecycle and runtime reconciliation           | Implemented                           |
| Immutable Blueprint, rootfs-image, and capture-policy pins     | Implemented                           |
| Experimental snapshot capture                                  | Implemented with explicit limitations |
| Snapshot-based editable forks                                  | Implemented with explicit limitations |
| Live previews for eligible online branches                     | Implemented for alpha environments    |
| Privileged Caddy route management and verification             | Implemented                           |
| Durable route aliases, revisions, heads, and provider evidence | Implemented                           |
| Golden-test and diff-review execution                          | Planned                               |
| Promote and rollback execution                                 | Planned                               |
| Immutable release runtimes                                     | Planned                               |
| Production route aliases                                       | Planned                               |

## Safety model

- PostgreSQL is authoritative for capsule and operation state.
- Operations are durable mutation-control records. They are not generic jobs.
- Immutable execution input is reloaded from PostgreSQL.
- Provider intent is persisted before Incus or Caddy mutations.
- Provider resources have explicit ownership and mutation outcomes.
- Interrupted provider mutations are classified. They are never resumed automatically.
- Events are best-effort invalidations sourced from committed state.

Only the Worker accesses Caddy. That access is constrained to a Qiln-managed route array. Qiln uses strict route validation, ETag writes, and read-after-write verification.

## Interface status

Qiln currently uses a command-line interface (CLI) as its primary interface.

User interface (UI) and user experience (UX) work is not the current focus. UI work is scheduled for the October 2026 release. The current implementation prioritizes durable capsule behavior, safe infrastructure boundaries, and operational correctness.

## Installation

Installation instructions are planned. This README does not yet provide an installation procedure.

## Current boundaries

Qiln is pre-release software for controlled alpha environments.

- Snapshot capture and snapshot-based forks are experimental.
- Live previews are mutable routes to editable branches. They are not route aliases.
- Promotion, rollback, and immutable release runtimes are not exposed.
- Production routing is not exposed.
- The current Blueprint does not claim complete restoration semantics for secrets, dependencies, Git, or production environments.
- Incus, ZFS, PostgreSQL, NATS, and Caddy are infrastructure details behind the capsule model.

## Code quality and readiness

Qiln is developed with extensive artificial intelligence (AI) and large language model (LLM) assistance. Generated code is never considered finished by default.

Our highest priority is human-readable code that people can understand, review, reason about, and safely evolve.

We iteratively refine implementations toward clear boundaries, explicit state transitions, durable invariants, and fail-closed behavior. We believe readability is foundational to safety and security.

The scores below are our candid assessment of current implementation structure and feature completeness. They are not a security audit, production certification, or guarantee of suitability for a specific environment.

Our goal is to reach **5/5** across every area. Human readability and maintainability lead that work.

| Area                     | Responsibility                                                                  | Code quality | Production readiness |
| ------------------------ | ------------------------------------------------------------------------------- | -----------: | -------------------: |
| Core contracts           | Schemas, pins, digests, protocol, database fragments                            |      3.0/5.0 |              3.2/5.0 |
| Capsule operations       | Durable acceptance, fences, execution, compensation, abandonment classification |      2.5/5.0 |              2.0/5.0 |
| Routing and Caddy        | Live previews, managed Caddy routes, verification, route persistence            |      3.5/5.0 |              2.0/5.0 |
| Infrastructure authority | Worker exclusivity, fail-stop behavior, Incus and storage boundaries            |      3.5/5.0 |              2.0/5.0 |
| Host runtime             | Fastify lifecycle, final Drizzle composition, embedded Worker development mode  |      3.5/5.0 |              2.0/5.0 |
| Blueprint catalog        | Initial n8n + ComfyUI capsule definition and capture policy                     |      3.5/5.0 |              2.0/5.0 |
| **Overall**              | **Pre-release capsule platform**                                                |  **3.3/5.0** |          **2.2/5.0** |

## License

Licensed under the [Apache License 2.0](./LICENSE).
