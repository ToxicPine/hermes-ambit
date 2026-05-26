# Hermes Cloud Deployment Plan

## Objective

Build a reliable, embeddable TypeScript foundation for provisioning and managing
the cloud resources needed to run the Hermes container on Google Cloud and
Azure, then build provider-specific CLI/TUI tools on top of it.

The intended user is someone who has a Google or Microsoft account but is not
already fluent in the cloud platform. They should be able to run a local tool,
authenticate, answer guided setup questions, and deploy a self-hosted Hermes 
agent system that bills through their own cloud account.

The implementation should be split into two layers:

1. A lean Effect TS library that owns resource planning, idempotent
   resource provisioning, determining status, and teardown. It should avoid local
   side effects entirely except for controlled network calls through injected
   provider clients/token providers. This keeps the code clear, testable, and
   portable enough that it could be embedded in a web application later, though
   that is out of current scope.
2. Local Bun provider and TUI packages that own the user experience:
   authentication flow orchestration, local profiles, guided configuration,
   secret entry, browser handoffs when manual provider setup is required,
   progress rendering, and calls into the core library.

Keep the first implementation small, readable, and deliberate. Do not build a
generic cloud abstraction layer, a plugin system, or broad smoke-test machinery,
we're focusing on the elegance and clarity of implementation.

## Design Principles

- Provider differences are product-visible. Google and Azure should share
  patterns if useful, but not be flattened into fake generic concepts.
- Deployment provider is also the default model provider. A GCP deployment should
  configure Hermes for Google-hosted model access, and an Azure deployment should
  configure Hermes for Azure-hosted model access. Cross-provider model routing is
  out of the initial scope unless added deliberately later.
- The library should create or select an isolated ownership/resource boundary
  for Hermes wherever the provider account and permissions make that possible.
  The CLI/TUI should explain the chosen boundary to the user.
- Cloud resources should be planned before mutation, applied idempotently, and
  identifiable without a required local state file.
- The library should derive deterministic names and resource shapes from stable
  deployment identity inputs so repeated attempts target the same project,
  resource group, file share, service, secrets, labels/tags, and related
  resources. It should always find/reconcile the expected resources first, create
  them only when they do not exist, and return a typed remediation URL when the
  needed creation step cannot be completed automatically.
- Anything that must be completed in a browser or cloud console should surface
  through a typed remediation value on the error path. Keep that remediation
  minimal: a type/label and a URL. The UI can infer provider-specific text and
  retry behavior.
- The Hermes runtime image should be a fixed universal prebuilt Docker image
  URL. The exact URL is not set yet; once it is, store it in `constants.ts` and
  treat it as the default image used by both deployer tools. The local Bun
  deployer tools are not part of the deployed Docker image.
- Normal Hermes configuration and secrets should be managed through the TUI and
  provider secret/config mechanisms without rebuilding the container image.
- For durable state, prefer the provider's idiomatic mounted file-share option
  that behaves like a normal directory from the container's point of view.
  Avoid making object-store-style mounts the default state backend.
- Favor a small, high-signal set of logs/events, via an Effect TS service,
  over exhaustive telemetry.

## Repository Fit

The repo already builds the Hermes container image with Nix. The new Bun tooling
should live in `pkg/` and remain separate from the runtime image build.

Current shape to respect:

- Root `flake.nix` currently points at `path:./pkg`.
- `pkg/` is a placeholder shell app today; it should become the Bun workspace
  for the local deployer tools.
- `nix/default.nix` accepts an `app` only for packages intentionally included in
  the runtime image. The deployer packages should not be threaded into that
  image path.
- The container image continues to be built by the existing Nix/image code. Once
  published, the deployer tools should use its fixed universal Docker image URL
  from `constants.ts`.
- The entrypoint seeds each user's Home Manager config into
  `/data/homes/<user>/nixcfg`, links it back to `/opt/app/hm-user/<user>`, and
  activates Home Manager from that persistent config. This is the natural place
  for deployed Hermes configuration to live.

Target package shape:

```text
pkg/
  flake.nix
  bun.nix
  package.json
  bun.lock
  tsconfig.json
  packages/
    shared/
    gcp/
    azure/
    tui/
```

Public packages:

- `@cardelli/gcp`
- `@cardelli/azure`
- `@cardelli/tui`

Shared code should start as a private workspace package. The provider packages
and TUI package are public; shared is an internal implementation package.

## Packaging

Use Bun and TypeScript for the local deployer tools. Use bun2nix to make the Bun
workspace build reproducibly from Nix.

The packaging work should:

- Convert `pkg/` into a Bun workspace.
- Generate and commit the bun2nix output from the Bun lockfile.
- Expose local provider binaries from the GCP and Azure packages, and keep the
  OpenTUI app in the public TUI package.
- Keep deployer outputs separate from Docker image contents.
- Keep the root/container flake outputs clear: one path builds the Hermes image,
  another path builds the local deployer tools. The deployer tools should refer
  to the published universal image URL by constant, not by depending on the local
  image build output.

## Core Library Responsibilities

The shared library should provide the reusable cloud control plane. It should be
plain, idiomatic TypeScript using Effect to make dependencies and side effects
explicit.

It owns:

- Account and capability discovery from caller-supplied auth material.
- Provider-specific planning for the resources needed to run Hermes.
- Deterministic resource naming/shape derivation from stable deployment inputs.
- Idempotent apply/update/status/destroy operations.
- Resource identity, labels/tags/annotations, and drift/conflict detection.
- Runtime config and secret propagation through provider mechanisms.
- Provider-specific mechanics for reading and mutating the mounted user volume
  that contains the persistent Home Manager desired state.
- A shared utility layer that can use either provider implementation to inspect,
  reconcile, and update the Home Manager config without the TUI knowing the
  storage mechanics.
- Typed provider errors and minimal web remediation links.
- Polling and interruption behavior for long-running cloud operations.

It does not own:

- Browser/device OAuth UX.
- Local profile or credential persistence.
- Reading Hermes config files from disk.
- Deciding what Hermes options should be changed for a given user flow.
- TUI state or command parsing.
- User-facing defaults and setup copy.
- Generic cloud abstractions that hide provider semantics.

## Provider Client Strategy

Provider SDKs and generated API clients are implementation aids, not the core
architecture. The shared library should define small Effect-native capabilities
for the cloud operations it needs, and the provider packages should supply
implementations for those capabilities.

Guidance:

- Use official JavaScript SDKs where they are clean and well-supported for the
  current Bun/local CLI runtime.
- Study official SDK request/response shapes when they clarify provider models.
- Do not let SDK classes leak through the shared library or TUI interfaces.
- Keep shared types and orchestration browser-compatible. Future web use should
  be possible by swapping the provider implementation for a browser-safe or
  server-backed adapter.
- Prefer Fetch/OpenAPI-shaped clients where practical because they are easier to
  adapt to browser and server runtimes than Node-specific SDK surfaces.
- Wrap all provider calls in Effect layers/services so retry, logging,
  interruption, redaction, and typed errors stay under our control.

OpenAPI generation should be considered where providers expose usable
OpenAPI/Swagger descriptions for the operations we need. Orval is a good
candidate to investigate because it can generate type-safe TypeScript clients
from OpenAPI v3 or Swagger v2 specs, supports fetch-based output, and exposes a
programmatic API that can be wired into build scripts.

Generated clients should still sit behind our provider capability interfaces.
They should not become the domain API consumed by the TUI.

## Provider And TUI Responsibilities

There should be public provider packages and a public TUI package:

- `@cardelli/gcp`
- `@cardelli/azure`
- `@cardelli/tui`

The GCP and Azure packages should expose provider-specific deployment mechanics
and small scriptable CLIs. The TUI package should compose either provider
implementation and be the primary path for uninitiated users.

The TUI should use OpenTUI's SolidJS integration (`@opentui/solid`) and be built
as a normal component-driven app, not a custom terminal framework.

The provider packages own:

- Provider-specific auth orchestration helpers and context discovery wrappers.
- Provider-specific deployment orchestration over the shared library.
- Provider-specific user-volume mutation implementation for the mounted Hermes
  Home Manager state.
- Scriptable commands useful for automation.

The TUI owns:

- Auth flow orchestration and browser/device-code handoffs.
- Local deployment profiles if persistence is useful.
- Guided provider setup and remediation.
- Hermes-facing configuration forms.
- Secret collection and update flows.
- Calling the shared Home Manager reconciliation utility through the selected
  provider implementation.
- Plan previews and confirmation.
- Progress/status rendering with operation IDs and resource refs where useful.
- Destruction flows and retention choices.

The TUI should feel compatible with Hermes concepts such as model, provider,
toolsets, skills, profiles, JSON output, and readable progress. It should not try
to reimplement the Hermes chat interface.

## Cloud Resource Intent

The library should provision the resources needed to run the public Hermes
container in an isolated provider-specific boundary owned by the user. The exact
boundary depends on what the provider account can create or select.

At a high level:

- Google should aim for an isolated Hermes project when possible, otherwise an
  explicit user-selected project.
- Azure should aim for an isolated Hermes resource group, and only go above that
  boundary when discovery shows it is supported and appropriate.
- The selected cloud provider should also supply the model access path: Google
  deployments use Google-hosted model services, and Azure deployments use
  Azure-hosted model services.
- Secrets/config should go through provider-managed secret/config surfaces.
- Durable state should use an idiomatic mounted file share that behaves like a
  disk from the container's perspective.
- The plan output should clearly explain what will be created, reused, updated,
  retained, or destroyed.
- Repeated runs with the same deployment identity should converge on the same
  provider resources. If an expected resource is missing, the library should try
  to create it. If creation is blocked by permissions, billing, provider setup,
  or a manual console step, the error should include the remediation URL rather
  than silently switching to a different resource.

Avoid hardcoding speculative cloud-case taxonomies in the plan. During
implementation, use provider APIs and docs to determine the exact capabilities,
resource shapes, and error variants.

## Hermes Configuration Surface

The TUI should determine the configuration surface provider by provider. Google
Vertex/Gemini and Azure AI/Azure OpenAI do not expose the same model catalog,
parameters, auth shape, or deployment assumptions, so the TUI should render
provider-specific forms backed by provider discovery.

For v1, those provider-specific forms should assume the model provider matches
the deployment provider. The TUI should not present a generic cross-cloud model
matrix as the normal path.

Do not expose low-level cloud secret names, registry plumbing, IAM internals, or
provider resource implementation details as the normal user path. They can appear
in debug/status output where they help diagnose failures.

Because both deployers use one fixed prebuilt Docker image, configuration should
flow through the container's existing Home Manager model rather than through a
second ad hoc config system. The image already seeds a per-user
`~/.nixcfg/home.nix` into persistent `/data/homes/<user>/nixcfg` on first boot,
symlinks that persistent config back into `/opt/app/hm-user/<user>`, and uses
`/opt/app/bin/rebuild` to activate Home Manager from the persistent user config.

The likely desired model is:

- Put stable Hermes defaults in `hm-base`.
- Keep deployment/user-specific overrides in the persistent user Home Manager
  config.
- Let the provider libraries expose a common user-volume capability for reading
  and mutating that persistent config, even though the underlying storage
  mechanics differ by cloud.
- Let a shared Home Manager reconciliation utility use that capability to read
  the current desired Hermes options, apply provider-specific changes, and write
  the updated desired state back, given some implementation of the user-volume 
  capability.
- Let the TUI call the shared reconciliation utility as needed, without knowing
  whether the backing implementation is GCP or Azure.
- Keep actual secret values in provider secret stores and pass only references,
  environment wiring, or mounted secret paths through the Home Manager config.

Config and secret updates should follow this cycle:

1. The TUI validates provider-specific model/runtime inputs.
2. The library updates provider-managed secrets for sensitive values.
3. The shared reconciliation utility updates non-secret Hermes desired state and
   secret references in the persistent Home Manager config through the selected
   provider's user-volume implementation.
4. The runtime is restarted or rolled so boot/activation sees the new persistent
   config. If live in-container reconciliation becomes necessary later, use the
   existing `rebuild` path rather than inventing a separate config mechanism.
5. Status reports the active image, config generation/hash, revision/restart
   result, and any provider operation IDs.

The plan should verify whether reboot/revision-roll is enough for the first
version or whether the cloud runtime needs an explicit management hook to run
`rebuild` before restarting Hermes. Either way, normal user configuration
changes should not rebuild the Docker image.

## Implementation Sequence

1. Clean up `pkg/` into a Bun workspace and keep it separate from the image
   build path.
2. Add bun2nix packaging for the public GCP, Azure, and TUI packages.
3. Build the shared library skeleton around provider discovery, planning,
   idempotent apply, status, update, destroy, typed errors, and remediation
   links.
4. Build provider-specific GCP/Azure package surfaces over the shared library,
   including user-volume implementations for Home Manager state.
5. Implement provider discovery and dry-run planning before mutation.
6. Choose and implement the minimal durable file-store strategy for each
  provider.
7. Add a `constants.ts` placeholder for the universal Docker image URL, then use
   that constant for the first end-to-end deploy/update/status/destroy path.
8. Build the OpenTUI/Solid guided setup and management flow in the public TUI
   package over the same orchestration layer.
9. Add focused tests for planning, idempotency, redaction, rendering, and error
   mapping. Keep real-cloud validation manual and minimal.
10. Update README/deployment docs once the first supported path is real.

## Open Questions

- What fixed universal Docker image URL should be stored in `constants.ts`?
- Which Hermes runtime entrypoint should the deployed container run first?
- What is the minimal Hermes config surface for v1?
- What file-share backing should be the default for `/data` and `/nix` on each
  provider?
- Should the first Google path create a project by default when possible, or ask
  explicitly before creating one?
- Should the first Azure path always create a new resource group inside a
  selected subscription?
- Where should local deployment profiles live?
- Should the TUI import an existing local Hermes profile or create a separate
  cloud deployment profile?
