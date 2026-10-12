<img src="./assets/brand/qiln-readme.png" alt="Qiln — versioned AI workflow capsules" width="900">

[Website](https://qiln.com) | [Installation](#installation) | [Documentation](https://qiln.com/docs) | [Blog](https://qiln.com/blog)

# Qiln

**A versioned runtime for AI workflow capsules.**

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)
[![Status: pre-release alpha](https://img.shields.io/badge/status-pre--release%20alpha-orange)](#development-status)

Qiln manages AI workflow systems as durable capsules. It keeps editable state, committed snapshots, and approved routing separate.

A capsule is meant to keep related artifacts and configuration together: application source, workflow graphs, custom nodes, application state, dependency and model references, environment configuration, tests, routes, secret references, and run history.

Qiln is not primarily a GPU hosting service, hosted ComfyUI, a cloud IDE, a backend as a service (BaaS), or a platform as a service (PaaS).

## What Qiln is for

The intended workflow gives you a controlled way to make changes to an AI workflow system:

```text
create capsule → snapshot a baseline → fork an isolated branch → human/agent edit → diff → golden test → snapshot → promote a route alias → rollback
```

The current alpha supports:

- Capsule creation with durable operation accounting.
- Starting and stopping editable branches, with runtime reconciliation.
- Archiving, unarchiving, and explicitly destroying capsules.
- Experimental snapshots of versioned managed storage.
- Live previews for eligible online branches.

Snapshot-based forks are temporarily unavailable while their provider accounting is reworked. Diff currently reports that it is unavailable. Golden-test execution, promotion, rollback, and immutable target runtimes are not implemented yet.

Creating a capsule gives you one root editable branch, initially offline. Eligible online branches can have live previews for their proxy-exposed Blueprint applications.

Taking a snapshot does not create a release runtime, approve a change, or move traffic.

## Core model

- Capsule: A durable workflow system whose artifacts and configuration evolve together.
- Branch: Isolated, editable capsule state for a human or agent.
- Blueprint: A reference capsule definition pinned into accepted operations.
- Snapshot: Immutable, committed restoration evidence for versioned managed storage and pinned reconstruction configuration.
- Live preview: A mutable route to an eligible online branch.
- Route alias: A stable route identity intended to select an approved immutable target.
- Revision: Immutable route history for a route alias.
- Promote / rollback: Planned operations that select approved targets without rewriting historical revisions.

The root branch represents the capsule's creation lineage. It is not automatically production or the promoted branch.

ComfyUI is the initial reference Blueprint, not the product itself. Qiln remains application-independent.

ComfyUI is a useful reference because its source, Python environment, workflow configuration, models, inputs, and generated outputs have different storage and restoration needs. The supplied Blueprint keeps versioned application and data storage separate from fresh, unversioned outputs.

Qiln snapshots currently cover versioned managed storage, the exact rootfs-image pin, and historical Blueprint configuration. They do not preserve arbitrary rootfs edits, unversioned storage, or external bind-mount contents. A snapshot also does not prove that the application works correctly.

## Routing model

Qiln keeps mutable preview traffic separate from approved immutable targets.

| Route type   | Points to                                      | Mutability                 | Status                                                    |
| ------------ | ---------------------------------------------- | -------------------------- | --------------------------------------------------------- |
| Live preview | An eligible online editable branch application | Mutable                    | Implemented for controlled alpha environments             |
| Route alias  | An approved immutable target                   | Immutable revision history | Persistence and reads exist; mutation execution is planned |

Taking a snapshot leaves traffic unchanged. Promotion will move a route alias to an approved immutable target, and rollback will select a prior approved target. Neither operation reverses external side effects.

Preview verification checks the configured upstream and ingress response. It is not a golden test or an assessment of application correctness, and it does not approve promotion.

## Architecture

```text
qiln/
├── app/                                # Web UI, authentication, Fastify/Vike, persistence composition
├── ssh/                                # Standalone SSH application configuration and lifecycle
├── packages/
│   ├── core/
│   │   └── src/
│   │       ├── schemas/                # Shared capsule, Blueprint, snapshot, route, and SSH contracts
│   │       ├── digest/                 # Canonical pins and digests
│   │       ├── db/                     # Composable capsule tables and relation fragments
│   │       ├── protocol/               # Typed commands, events, subjects, and envelopes
│   │       ├── transport/              # NATS connection and JSON transport mechanics
│   │       └── blueprints/             # Server-side Blueprint registry
│   ├── engine/                         # Reusable capsule UI and authenticated integration
│   ├── ssh/                            # SSH policy, keys, grants, tickets, gateway, and relays
│   ├── cli/                            # Installation, AWS operations, approvals, and diagnostics
│   ├── agent/                          # Upcoming developer/agent tooling
│   ├── mcp/                            # Upcoming MCP integration
│   └── worker/
│       └── src/
│           ├── coordination/           # PostgreSQL Worker authority and operation supervision
│           ├── incus/                  # Privileged instance and storage capabilities
│           ├── caddy/                  # Caddy admin and managed route boundary
│           ├── channel/                # Worker command handlers
│           └── services/capsule/
│               ├── operations/         # Durable acceptance, execution, and classification
│               ├── branch/             # Runtime observation and reconciliation
│               ├── read/               # Client-safe capsule projections
│               ├── routing/            # Previews and committed route reads
│               ├── snapshot/           # Committed restoration history
│               └── resource/           # Provider identities and resource inventory
├── catalog/
│   ├── blueprints/                     # Reference capsule definitions
│   ├── images/                         # Capsule, builder, and development images
│   └── profiles/                       # Explicit Incus profiles
└── drizzle.config.ts                   # Application-composed schema tooling
```

Applications own configuration, database connections, and process lifecycle. Packages receive composed dependencies from applications. Worker handles privileged orchestration. The standalone SSH authority manages SSH authorization independently of Web sessions.

## Development status

An implemented feature is not necessarily ready for production. Contracts, persistence tables, and placeholders alone do not establish a working execution path.

| Capability                                            | Status                                  |
| ----------------------------------------------------- | --------------------------------------- |
| Local development installer (`doctor`, `up`)           | Implemented; leaves orchestrator stopped |
| Guided AWS sign-in and approved IAM onboarding         | Implemented                             |
| Approved AWS network creation, inspection, and removal | Implemented; networking only            |
| Capsule creation and durable operation ledger         | Implemented                             |
| Branch start/stop and runtime reconciliation           | Implemented                             |
| Capsule archive, unarchive, and destruction            | Implemented                             |
| Historical Blueprint and exact rootfs-image pins       | Implemented                             |
| Experimental versioned-storage snapshots              | Implemented with explicit limitations   |
| Snapshot-based editable forks                         | Temporarily unavailable                 |
| Live previews and Caddy verification                   | Implemented for alpha environments      |
| Standalone SSH authority and gateway                   | Implemented for development use         |
| Route aliases, revisions, heads, and provider evidence | Persistence and committed reads         |
| Diff                                                  | Unavailable placeholder                 |
| Golden-test execution                                 | Planned                                 |
| Promote, rollback, and immutable target runtimes       | Not implemented                         |
| Agent and MCP tooling                                 | Upcoming                                |

## Safety model

- PostgreSQL is authoritative for capsule and operation state.
- A receipt confirms durable acceptance or replay. It does not confirm that provider execution has finished.
- Immutable execution input is reloaded from durable evidence.
- Mutation intent is persisted before privileged provider work begins.
- Interrupted mutations are classified and never resumed automatically.
- A timeout or transport failure does not prove that a mutation had no effect.
- Events are best-effort invalidation hints. They are not durable state.

Worker owns Incus and Caddy orchestration. Changes to Caddy use a managed route-array boundary, conditional ETag writes, and read-after-write verification.

The SSH authority owns keys, grants, access fences, tickets, and relays. Branch `authorized_keys` synchronization is not authoritative. Host-managed networking must restrict branch SSH ingress to the gateway.

Humans and agents must edit isolated branches instead of changing production directly. Agents must use scoped credentials and must not receive production secret values. External side effects require explicit controls, and changes need separate authors and promoters. Promotion policy is not implemented yet.

The development orchestrator runs services together and embeds Worker with Web. Shared OS identity and private NATS credentials do not establish production service isolation. Current NATS publishers are trusted; validation and digests do not authenticate them. Production hardening still requires service separation and per-service messaging permissions.

## Interface status

Web handles application authentication, rendering, and capsule integration. The CLI currently focuses on development installation, AWS connections, and approved AWS networking. It does not yet cover the full capsule workflow.

Engine contains the reusable UI. Agent and MCP interfaces are upcoming.

## Installation

The current installer sets up a development environment. It is not a production deployment tool.

Local setup requires the supported Ubuntu 26.04 AMD64 host, Incus 7, preinstalled host tools, an existing compatible ZFS-backed Incus pool, a trusted local image, and the canonical Qiln checkout. The repository manifests and installer specifications define the exact requirements.

Once the CLI is built and available, run:

```sh
qiln doctor
qiln up --source <checkout> --image <local-alias-or-fingerprint> --authorized-keys <roster>
```

`up` attaches the checkout as writable storage, configures the development resources, and delivers retained credentials. It leaves the orchestrator stopped. You still need to install dependencies, run migrations, and start services as separate operator actions.

Qiln treats the selected image as trusted guest code. Its fingerprint does not authenticate the publisher. Qiln does not install host prerequisites or invoke privilege escalation.

AWS commands are separate from local installation. `qiln aws connect` guides operator authentication and supports optional IAM onboarding with approval. Current AWS deployment commands create networking only. They do not launch hosts or deploy Qiln services.

## Current boundaries

Qiln is pre-release software for controlled alpha environments.

- Creating a snapshot requires an offline source branch and withdrawn previews.
- Restoration requires retained provider snapshots and the pinned image to remain available.
- Snapshot history provides restoration summaries, but not artifact contents or detailed change reports.
- Snapshot-based forks are temporarily unavailable.
- Previews are mutable branch routes, not approved production targets.
- Golden tests, usable diffing, promotion, rollback, and immutable target runtimes remain unavailable.
- Rollback cannot undo external side effects.

## Development approach

Qiln is developed with extensive AI and LLM assistance. Generated code is not assumed to be finished.

Development prioritizes human-readable code, explicit authority boundaries, durable invariants, and fail-closed behavior. Implementation status is not a security audit or production certification, and it does not guarantee suitability.

## License

Licensed under the [Apache License 2.0](./LICENSE).
