# Hermes Ambit TUI And CLI Surface Plan

## Objective

Define the user-facing command surface for the local Hermes Ambit deployer:
which argument combinations are valid in classic command mode, full-screen TUI
mode, and JSON automation mode, and how those modes map onto the guided flows
needed to deploy and manage a self-hosted Hermes container on GCP or Azure.

This document is intentionally about the application boundary, not internal
provider implementation details. The shared library already has the core verbs
we need: plan, apply, status, update config, restart, and destroy. The CLI/TUI
layer should expose those verbs predictably without leaking Cloud Run,
Container Apps, IAM, file-share, or Home Manager plumbing as the normal path.

## Sources Reviewed

- Local `PLAN.md` and `AUTH.md`.
- Local deployer code under `pkg/packages/shared`, `pkg/packages/gcp`, and
  `pkg/packages/azure`.
- Local Home Manager Hermes module under `fs/hermes`.
- Upstream Hermes Agent clone at `/tmp/hermes-agent`, especially:
  - `hermes_cli/_parser.py`
  - `hermes_cli/main.py`
  - `hermes_cli/setup.py`
  - `hermes_cli/auth.py`
  - `hermes_cli/profiles.py`
- Current Hermes docs:
  - https://hermes-agent.nousresearch.com/docs/user-guide/cli/
  - https://hermes-agent.nousresearch.com/docs/user-guide/tui
  - https://hermes-agent.nousresearch.com/docs/integrations/providers
  - https://hermes-agent.nousresearch.com/docs/user-guide/configuration/
  - https://hermes-agent.nousresearch.com/docs/user-guide/profiles/
  - https://hermes-agent.nousresearch.com/docs/developer-guide/adding-providers/

Key upstream lessons:

- `hermes setup` is an interactive wizard and refuses non-TTY execution except
  for explicit non-interactive guidance.
- `hermes setup model` delegates to the same provider/model selector as
  `hermes model`; provider setup should have one authoritative flow.
- `hermes --tui` is the recommended interactive frontend but shares config,
  sessions, profiles, slash commands, and model state with the classic CLI.
- Profiles are first-class isolated homes, not just labels.
- Scriptable modes must avoid spinners, prompts, browser handoffs, and mixed
  human/machine output.

Key local-code lessons:

- The provider packages are fetch/OpenAPI clients over typed auth contexts,
  not wrappers around `gcloud` or `az`.
- GCP takes a `GcpAuthContext` with a token function and optional quota project.
- Azure takes an `AzureAuthContext` with a token function that returns bearer
  token, expiry, subscription ID, and tenant ID.
- Auth acquisition is a local CLI/TUI concern layered above those contexts. The
  provider packages should not require a first-party cloud CLI to be installed.
- The current provider packages also expose provider-native secret helpers:
  GCP Secret Manager helpers and Azure Container App secret helpers. These are
  intentionally not folded into the deployment driver yet.

## Product Shape

The public executable should be a single deployer command. The package names can
remain provider-scoped, but the user should not have to learn separate `gcp` and
`azure` binaries for the common path.

Working name in this plan:

```text
hermes-ambit
```

Provider-specific binaries may exist for advanced scripting, but they should
delegate to the same command grammar and JSON envelope.

## Modes

There are two separate axes:

1. Output surface: TUI, human CLI, or JSON.
2. Input behavior: interactive or non-interactive.

This gives four practical execution styles:

1. TUI mode: full-screen OpenTUI/Solid app; always interactive.
2. Interactive CLI mode: line-oriented human commands that may prompt.
3. Non-interactive CLI mode: line-oriented human output, no prompts, all
   required values supplied by args/config/env/stdin.
4. JSON mode: machine-readable, non-interactive command execution.

Mode selection rules:

```text
hermes-ambit                         TUI mode when stdin/stdout are TTYs
hermes-ambit tui                     TUI mode, explicit
hermes-ambit <command>               CLI mode by default
hermes-ambit <command> --no-input    non-interactive CLI mode
hermes-ambit <command> --json        JSON mode
hermes-ambit --json <command>        JSON mode
```

Non-TTY behavior:

- Bare `hermes-ambit` must fail with guidance, not launch a broken TUI.
- `hermes-ambit tui` must fail with a TTY-required error.
- `--json` must never prompt, open a browser, or render progress animations.
- CLI commands may run in a non-TTY only when all required inputs are supplied.
- `--no-input` is not an output format. It keeps normal human-readable CLI
  output but turns missing input into validation errors.

## Global Arguments

Accepted everywhere except where marked invalid:

```text
--profile <name>              Local deployer profile, default: active/default
--deployment <name>           Stable Hermes deployment identity
--provider <gcp|azure>        Cloud deployment provider
--config <path>               Read deployer input from a YAML/JSON file
--json                        Machine-readable output; implies --no-input
--no-input                    Never ask questions
--no-browser                  Print remediation URLs instead of opening browser
--auth <auto|browser|profile> Token acquisition strategy, default: auto
--debug                       Include operation IDs and provider resource refs
--color <auto|always|never>   Human output only, default: auto
```

Profile naming should follow upstream Hermes profile discipline:
lowercase, starts with `[a-z0-9]`, then `[a-z0-9_-]`, length <= 64. The profile
owns local deployment defaults and cached discovery, but not cloud truth.

`--deployment` is the durable cloud identity. Reusing it must converge on the
same resources through deterministic naming. It should default from the active
profile in TUI/CLI mode once a profile has been configured, but JSON mode should
require it unless `--config` supplies it.

Auth arguments are intentionally token-provider shaped. They should produce the
typed auth contexts consumed by the current provider packages:

- GCP: access token plus optional `--quota-project`.
- Azure: bearer access token plus subscription and tenant identity.

`--auth browser` means the local TUI/CLI package owns whatever provider OAuth or
account flow is chosen. `--auth profile` means use the persisted auth material
for the selected deployer profile. Non-interactive commands should normally use
`--auth profile` after an interactive or browser setup has established that
profile. Do not add a top-level "access token from env" flag; token sourcing is
an adapter detail and should not become part of the public command grammar.

Automation that needs to inject credentials should do it through a profile
auth-provider config file or a future provider-specific auth adapter, not
through raw secret-bearing argv. The public surface should describe stable
intent, not raw token plumbing.

## Provider Arguments

Provider selection is product-visible and should not be hidden behind a fake
generic cloud abstraction.

GCP identity arguments:

```text
--project <project-id>
--region <region>
--quota-project <project-id>
--state <nfs|managed>
--state-server <host-or-ref>
--state-path <path>
```

Azure identity arguments:

```text
--subscription <subscription-id>
--tenant <tenant-id>
--resource-group <name>
--location <azure-location>
--environment-id <managed-environment-resource-id>
--state <azure-files|managed>
--storage-account <name>
--file-share <name>
```

Initial implementation can support only the state modes actually implemented.
Unsupported state modes should fail during parsing or validation with a stable
error code, not silently fall back.

## Commands

Top-level grammar:

```text
hermes-ambit tui [global args]
hermes-ambit setup [global args] [--quick] [--reset] [--reconfigure]
hermes-ambit setup --no-input [global args] [provider args]
hermes-ambit auth check [global args]
hermes-ambit discover [global args]
hermes-ambit plan [global args] [provider args]
hermes-ambit deploy [global args] [provider args] [--yes]
hermes-ambit status [global args] [--watch]
hermes-ambit config [show|set|edit|sync] [global args]
hermes-ambit secrets [list|set|delete] [global args]
hermes-ambit restart [global args] [--yes]
hermes-ambit destroy [global args] [--retain-state|--purge-state] [--yes]
hermes-ambit doctor [global args]
```

`apply` may exist as an alias for `deploy`, but docs should use `deploy`.

## TUI Mode Contract

Valid:

```text
hermes-ambit
hermes-ambit tui
hermes-ambit tui --profile work
hermes-ambit tui --provider gcp
hermes-ambit tui --deployment personal-agent
hermes-ambit tui --profile work --provider azure --deployment work-agent
```

Invalid:

```text
hermes-ambit tui --json
hermes-ambit tui --yes
hermes-ambit tui --no-input
hermes-ambit tui --watch
hermes-ambit tui --retain-state
hermes-ambit tui --purge-state
```

TUI mode may accept provider args as prefilled values, but it should still show
them in editable review screens before mutation. Supplying enough args to deploy
must not cause implicit mutation on launch.

TUI app sections:

1. Profile selector
2. Provider selector
3. Provider auth check
4. Cloud boundary discovery
5. Model/runtime configuration
6. Plan preview
7. Deploy progress
8. Status and diagnostics
9. Config and secrets
10. Restart/update
11. Destroy

TUI flow rules:

- TUI is the primary path for users who have cloud accounts but do not know the
  cloud provider well.
- TUI owns browser/device handoffs for the chosen token-provider strategy and
  provider console remediation.
- TUI should not ask for cloud OAuth refresh tokens, cloud client secrets, or a
  Hermes-owned OAuth client.
- TUI should collect Hermes runtime settings and secrets, then call the shared
  reconciliation/update path. It should not directly write provider resources.
- Every mutating operation shows a typed plan and asks for confirmation.
- TUI should use provider-specific forms. GCP deployment implies Google-hosted
  model access by default. Azure deployment implies Azure-hosted model access by
  default. Cross-cloud model routing is not a v1 normal path.
- Escape/back can leave a flow without applying partial cloud mutations.

TUI screens should mirror Hermes' mental model where relevant:

- profile
- provider
- model
- tools/toolsets
- skills/plugins
- secrets
- readable progress

But this app is not a Hermes chat UI. It is a deploy/manage UI for the cloud
runtime.

## CLI Mode Contract

CLI mode is human-readable and line-oriented. It has interactive and
non-interactive forms. It may prompt only when stdin is a TTY and `--no-input`
is not set. It may open a browser only when stdout/stderr are TTYs, `--no-input`
is not set, and `--no-browser` is not set.

Valid examples:

```text
hermes-ambit setup
hermes-ambit setup --provider gcp --deployment personal-agent
hermes-ambit setup --no-input --provider gcp --deployment personal-agent --project my-project --region us-central1 --state nfs --state-server 10.0.0.8 --state-path /exports/hermes --auth profile
hermes-ambit setup --no-input --provider azure --deployment work-agent --subscription <id> --tenant <tenant-id> --resource-group hermes --location eastus --environment-id <id> --state azure-files --storage-account <name> --file-share <name> --auth profile
hermes-ambit auth check --provider azure
hermes-ambit discover --provider gcp --project my-project --region us-central1
hermes-ambit plan --provider gcp --deployment personal-agent --project my-project --region us-central1
hermes-ambit deploy --provider azure --deployment work-agent --subscription <id> --tenant <tenant-id> --resource-group hermes --location eastus --environment-id <id>
hermes-ambit status --profile work
hermes-ambit status --provider gcp --deployment personal-agent --watch
hermes-ambit config show --profile work
hermes-ambit config set model.default gemini-3-flash-preview --profile work
hermes-ambit secrets set GOOGLE_API_KEY --profile work
hermes-ambit restart --profile work
hermes-ambit destroy --profile work --retain-state
```

CLI prompt policy:

- `setup` may guide interactively, like upstream `hermes setup`.
- `setup --no-input` is valid and must behave as a deterministic profile
  initialization command. It writes/updates the deployer profile from supplied
  args/config/env, validates auth/boundary inputs, and exits without prompts.
- `plan` may ask for missing provider identity in a TTY.
- `deploy`, `restart`, and `destroy` may ask for confirmation in a TTY.
- `status`, `doctor`, `config show`, and `secrets list` should not prompt.
- `secrets set NAME` may prompt for the value when TTY input is available.

CLI confirmation policy:

- Mutating commands require confirmation unless `--yes` is set.
- `--yes` is accepted only on mutating CLI commands.
- `--yes` is invalid on TUI mode, read-only commands, and JSON mode unless a
  specific mutating JSON command needs it for explicit compatibility.

CLI invalid examples:

```text
hermes-ambit status --yes
hermes-ambit plan --yes
hermes-ambit deploy --watch
hermes-ambit destroy --retain-state --purge-state
hermes-ambit secrets set NAME --json
```

`setup --json` is invalid for now because setup is profile initialization and
may grow human-oriented summaries. Automation that wants machine output should
use `plan`, `deploy`, `config set`, and `secrets set --value-stdin`; automation
that wants a readable log should use `setup --no-input`.

## JSON Mode Contract

JSON mode is for scripts, CI, and future web/service embedding. It must produce
only JSON on stdout. Human diagnostics go to stderr only when they do not break
the JSON contract, and should normally be represented in the JSON payload.

Valid:

```text
hermes-ambit auth check --provider gcp --json
hermes-ambit discover --provider azure --json
hermes-ambit plan --provider gcp --deployment personal-agent --project my-project --region us-central1 --json
hermes-ambit deploy --provider gcp --deployment personal-agent --project my-project --region us-central1 --json
hermes-ambit status --provider azure --deployment work-agent --subscription <id> --resource-group hermes --json
hermes-ambit config show --profile work --json
hermes-ambit secrets list --profile work --json
hermes-ambit restart --profile work --json
hermes-ambit destroy --profile work --retain-state --json
hermes-ambit doctor --json
```

Invalid:

```text
hermes-ambit --json
hermes-ambit tui --json
hermes-ambit setup --json
hermes-ambit status --watch --json
hermes-ambit secrets set NAME --json
hermes-ambit config edit --json
```

JSON mode implications:

- Implies `--no-input`.
- Implies `--no-browser`.
- Implies `--color never`.
- Does not use alternate screen, curses, progress spinners, or prompts.
- Missing required input is a validation error.
- Browser/cloud-console requirements are returned as remediation objects.
- Secret values cannot appear in JSON output.

Secret input for JSON-compatible automation must use one of:

```text
hermes-ambit secrets set NAME --value-stdin --profile work
hermes-ambit secrets set NAME --from-env ENV_NAME --profile work
hermes-ambit deploy ... --secret NAME=env:ENV_NAME --json
```

`--value <secret>` should not be supported because it leaks through shell
history and process listings.

## JSON Envelope

All JSON output should use a stable envelope:

```json
{
  "ok": true,
  "command": "plan",
  "profile": "default",
  "provider": "gcp",
  "deployment": "personal-agent",
  "data": {},
  "diagnostics": [],
  "remediations": []
}
```

Errors:

```json
{
  "ok": false,
  "command": "deploy",
  "profile": "default",
  "provider": "gcp",
  "deployment": "personal-agent",
  "error": {
    "code": "provider.auth.missing",
    "message": "GCP credentials are not available.",
    "operation": "gcp.auth.check"
  },
  "remediations": [
    {
      "type": "auth",
      "label": "Authenticate this deployer profile",
      "provider": "gcp"
    }
  ]
}
```

Provider/browser remediation:

```json
{
  "type": "url",
  "label": "Enable Cloud Run API",
  "url": "https://console.cloud.google.com/apis/library/run.googleapis.com"
}
```

The shared library currently models minimal remediation as `label` and `url`.
The CLI/TUI layer can enrich that for display, but the library should remain
minimal unless a real consumer requires more structure.

## Command Details

### `setup`

Purpose: guided local profile and deployment setup.

Valid modes: interactive CLI, non-interactive CLI, TUI via `tui`.

Invalid modes: JSON.

Accepted:

```text
setup [--profile <name>] [--provider <gcp|azure>] [--deployment <name>]
setup --no-input --profile <name> --provider <gcp|azure> --deployment <name> [provider args] [auth args]
setup --quick
setup --reset
setup --reconfigure
```

Behavior:

- New profile: offer quick setup or full setup.
- Existing profile: default to reconfigure with current values as defaults.
- `--quick`: prompt only for missing required values.
- `--reset`: reset local deployer profile, not cloud resources.
- `--no-input`: require a complete provider/deployment/auth/boundary tuple from
  args or `--config`; write the profile; run read-only validation; do not
  deploy unless the command is `deploy`.
- Section-specific setup can be added later, but v1 should avoid a large
  section matrix until real user demand appears.

`setup --no-input` is not a synonym for JSON. It should produce concise human
output suitable for logs:

```text
Profile: work
Provider: azure
Deployment: work-agent
Auth: profile
Boundary: subscription <id>, resource group hermes, location eastus
Next: hermes-ambit plan --profile work
```

### `auth check`

Purpose: verify the selected token provider can construct the typed cloud auth
context needed by the provider package.

Valid modes: CLI, JSON.

GCP checks:

- Access token acquisition through the selected token provider.
- Optional token expiry if the provider exposes it.
- Optional quota project header input.
- Ability to make a low-cost authorized API call when enough boundary context
  is available.

Azure checks:

- Access token acquisition through the selected token provider.
- Token type, expiry, subscription ID, and tenant ID shape.
- Ability to make a low-cost ARM call when enough boundary context is
  available.

No secrets should be printed. JSON may include token expiry and account IDs, but
not token strings.

### `discover`

Purpose: list candidate provider boundaries and capabilities before planning.

Valid modes: CLI, JSON, TUI internal.

GCP output: active account, accessible projects, regions, API/billing/service
usage capability, quota project status.

Azure output: active account, tenants, subscriptions, resource groups,
locations, Container Apps environments.

Discovery is read-only and should never create resources.

### `plan`

Purpose: compute create/reuse/update/destroy intent without mutation.

Valid modes: CLI, JSON, TUI internal.

Required by JSON: provider, deployment, and enough provider boundary inputs to
derive deterministic names.

Human output must clearly group:

- boundary
- resources to create
- resources to reuse
- resources to update
- secrets/config changes
- state retention/destruction implications
- remediations blocking apply

Plan output should avoid low-level provider IDs unless `--debug` is set.

### `deploy`

Purpose: apply the plan idempotently.

Valid modes: CLI, JSON, TUI internal.

CLI requires confirmation unless `--yes` is set. TUI confirms in-app. JSON
requires explicit complete inputs and returns operation events in `data`.

`deploy` should internally run `plan` first unless `--plan-file` is introduced
later. Do not accept stale opaque plan files in v1.

### `status`

Purpose: inspect deployed runtime state.

Valid modes: CLI, JSON, TUI internal.

Accepted:

```text
status [--watch]
```

`--watch` is CLI/TUI only. JSON mode should return one snapshot.

Status should report:

- deployed/not deployed
- image
- URL/endpoint if available
- running/revision state
- config generation/hash if available
- last operation IDs if useful
- provider resource refs only in debug output or JSON `debug`

### `config`

Purpose: manage non-secret Hermes runtime configuration.

Valid:

```text
config show
config set <key> <value>
config edit
config sync
```

Rules:

- `show` supports JSON.
- `set` supports CLI and JSON only when key/value are supplied.
- `edit` is CLI/TUI only.
- `sync` writes non-secret desired state through the provider user-volume
  implementation and restarts/rolls the runtime if needed.

Config keys should match Hermes config semantics where possible:

```text
model.provider
model.default
model.base_url
gateway.host
gateway.port
terminal.backend
agent.max_turns
agent.reasoning_effort
display.*
tools.*
mcp_servers.*
```

For v1, expose provider-specific curated forms in TUI instead of a huge generic
key editor.

### `secrets`

Purpose: manage provider-backed secret values and references.

Valid:

```text
secrets list
secrets set <name>
secrets set <name> --value-stdin
secrets set <name> --from-env <env-name>
secrets delete <name>
```

Rules:

- `list` never prints secret values.
- `set <name>` prompts in CLI mode when a TTY is available.
- JSON-compatible secret writes must use stdin or env indirection, and stdout
  must not echo the secret.
- TUI uses masked input fields and stores through provider secret mechanisms.

### `restart`

Purpose: roll/restart the cloud runtime so new config/secrets take effect.

Valid modes: CLI, JSON, TUI internal.

CLI requires confirmation unless `--yes` is set.

GCP should use a Cloud Run revision roll when possible. Azure should stop/start
or use the provider's supported restart/update path.

### `destroy`

Purpose: delete the deployed runtime and optionally state.

Valid modes: CLI, JSON, TUI internal.

Accepted:

```text
destroy --retain-state
destroy --purge-state
```

Rules:

- Exactly one of `--retain-state` or `--purge-state` is required in JSON mode.
- CLI/TUI may default to `--retain-state` only after a visible confirmation.
- `--purge-state` requires an extra confirmation in human modes.
- Never infer `--purge-state` from `--yes`; it must be explicit.

### `doctor`

Purpose: diagnose local prerequisites and provider readiness.

Valid modes: CLI, JSON, TUI internal.

Checks:

- Bun/package version if needed.
- Auth provider availability. Browser/env token providers are sufficient for
  this project; first-party provider CLIs are optional adapters only.
- TTY/browser availability for interactive paths.
- Profile validity.
- Config sanity.
- Provider API access sufficient for discovery.

## Argument Compatibility Matrix

| Argument | TUI | CLI read-only | CLI mutate | JSON read-only | JSON mutate |
| --- | --- | --- | --- | --- | --- |
| `--profile` | yes | yes | yes | yes | yes |
| `--deployment` | prefill | yes | yes | required unless config | required unless config |
| `--provider` | prefill | yes | yes | required unless config | required unless config |
| provider boundary args | prefill | yes | yes | required unless config | required unless config |
| `--config` | prefill/import | yes | yes | yes | yes |
| `--json` | no | selects JSON | selects JSON | yes | yes |
| `--no-input` | no | yes, disables prompts | yes, disables prompts | implied | implied |
| `--no-browser` | no | yes | yes | implied | implied |
| `--auth` | prefill | yes | yes | yes | yes |
| `--yes` | no | no | yes | no | generally no |
| `--watch` | status screen | status only | no | no | no |
| `--retain-state` | destroy screen | no | destroy only | no | destroy only |
| `--purge-state` | destroy screen | no | destroy only | no | destroy only |
| `--debug` | diagnostics toggle | yes | yes | yes | yes |
| `--color` | no | yes | yes | forced never | forced never |

## Invalid Combination Rules

The parser should reject these before side effects:

- `--json` with `tui`, `setup`, `config edit`, `status --watch`, or prompt-only
  secret writes.
- `--no-input` with `tui`.
- `--no-input` without all required command inputs.
- `--auth browser` with `--no-input` or `--json`.
- `--yes` on read-only commands.
- `--yes` in TUI mode.
- `--retain-state` and `--purge-state` together.
- Provider-specific args that do not match `--provider`.
- `--project` with Azure.
- `--subscription`, `--tenant`, `--resource-group`, or `--environment-id` with
  GCP.
- `--watch` with any command other than `status`.
- Missing `--deployment` in JSON mode unless supplied by `--config`.
- Missing cloud boundary in JSON mode unless supplied by `--config`.
- Secret values passed as direct argv.

## TUI Flow Map

### First Launch

1. If no TTY, fail with guidance.
2. Load active deployer profile.
3. If no profile is configured, show provider choice.
4. Run provider auth check.
5. If auth is missing, run/offer the selected browser token flow or show a
   typed remediation and retry.
6. Run discovery.
7. Ask for deployment identity and boundary.
8. Show Hermes runtime config form.
9. Show plan preview.
10. Confirm deploy.
11. Stream progress.
12. Land on status screen.

### Existing Deployment

1. Load profile and deployment.
2. Fetch status.
3. Show status dashboard.
4. Offer actions: config, secrets, restart, redeploy, destroy, diagnostics.

### Remediation

Provider errors should carry minimal remediation values. TUI renders them as:

- Open URL
- Copy command
- Retry
- Back

The library should not embed long prose; TUI owns the explanation.

### Config Update

1. Validate provider-specific model/runtime inputs.
2. Write secrets through provider secret store.
3. Update Home Manager desired state through user-volume capability.
4. Restart or roll runtime.
5. Report image, revision, config hash, and operation IDs.

### Destroy

1. Show resources that will be deleted.
2. Ask whether state is retained.
3. If purging state, require typed deployment name.
4. Apply destroy.
5. Show retained state refs or deletion summary.

## Hermes Runtime Config Surface

The TUI should understand the Hermes config shape well enough to avoid making
users edit YAML for the common path, but it should not reimplement Hermes chat.

Initial v1 forms:

- Main model provider/model for the deployed cloud provider.
- Gateway host/port, normally fixed to container defaults.
- Agent reasoning effort and max turns.
- Tool gateway/toolset defaults where they map cleanly.
- MCP server list, probably read-only or advanced in v1.
- Documents such as `SOUL.md` and `USER.md`, likely advanced in v1.
- Secrets needed by the selected cloud/model path.

Home Manager remains the desired-state carrier. Do not invent a second config
format. Secret values stay in provider secret stores; Home Manager should carry
only non-secret settings and references.

## TUI Coordination Layer

Keep this small. The provider packages already expose the real operations:
GCP has Cloud Run and Secret Manager helpers; Azure has Container App and
Container App secret helpers; shared has `makeDeployment` and
`updateHomeManager`. The TUI package only needs a thin coordination layer so the
same setup/config logic can drive screens, prompts, and `--no-input` commands.

Suggested files:

```text
pkg/packages/tui/src/
  app-profile.ts
  setup-state.ts
  hermes-config.ts
  gcp-app.ts
  azure-app.ts
```

Do not add a generic `ProviderAdapter` until duplication proves it is needed.
Two explicit provider modules are clearer for v1.

### Profile

Keep one local profile shape that stores intent, not credentials:

```ts
type AppProfile =
  | { provider: "gcp"; name: string; deployment: string; user: string; gcp: GcpDeployment }
  | { provider: "azure"; name: string; deployment: string; user: string; azure: AzureDeployment };
```

This is enough for `setup --no-input`, TUI resume, and command defaults. Auth
storage can be separate and opaque.

### Provider Modules

Each provider module should expose a few concrete functions around the existing
package API:

```ts
// gcp-app.ts
makeGcpApp(auth: GcpAuthContext): {
  plan(input: GcpDeployment): Effect.Effect<GcpPlan, CloudError>;
  deploy(input: GcpDeployment): Effect.Effect<GcpStatus, CloudError>;
  status(input: GcpDeployment): Effect.Effect<GcpStatus, CloudError>;
  restart(input: GcpDeployment): Effect.Effect<GcpStatus, CloudError>;
  destroy(input: GcpDeployment): Effect.Effect<GcpStatus, CloudError>;
  putSecret(input: GcpSecretValue): Effect.Effect<SecretVersion, CloudError>;
}
```

Azure gets the same hand-written shape using `AzureDeployment`, `AzurePlan`,
`AzureStatus`, and Container App secrets. These wrappers should mostly delegate
to `makeDeployment(makeGcpDriver(auth))`, `makeDeployment(makeAzureDriver(auth))`,
and the provider-native secret helpers.

The only extra behavior they should add is:

- Build short plan/status summaries for the TUI.
- Preserve raw provider objects for debug output.
- Centralize ownership of provider-specific secret naming/reference rules.

### Setup State

Model setup as a draft plus validation, not as a framework:

```ts
type SetupDraft = {
  readonly profileName: string;
  readonly provider?: "gcp" | "azure";
  readonly deployment?: string;
  readonly user: string;
  readonly fields: Record<string, string>;
};
```

Shared helpers:

- `draftFromArgs(args)`
- `draftFromProfile(profile)`
- `validateDraft(draft)`
- `profileFromDraft(draft)`

The TUI can edit the draft step by step. Interactive CLI can ask for missing
fields. `setup --no-input` just calls `draftFromArgs`, `validateDraft`, and
`profileFromDraft`; if anything is missing, it fails.

This follows the Hermes CLI pattern without copying its complexity: Hermes has
one provider/model setup path reused by setup and model commands. Here, one
setup draft path should be reused by TUI, CLI prompts, and non-interactive CLI.

### Hermes Config Helpers

Keep this narrow. The TUI needs functions that turn user choices into a
Home Manager patch:

```ts
renderHermesPatch(input: HermesConfigSelection): HomeManagerPatch
mergeManagedPatch(existing: string, patch: HomeManagerPatch): string
```

Home Manager patching should be the same kind of operation for both platforms:
take a typed Hermes config selection and render the managed Nix block. Provider
differences belong in what can be selected, not in how patches are applied.

Use a common settable surface for options both providers support, then let each
provider extend it. ILLUSTRATIVE ONLY: names, enum values, and field shapes must
be verified against the current Hermes config/Home Manager module before
implementation.

```ts
type CommonHermesSettable = {
  readonly gateway?: {
    readonly host?: string;
    readonly port?: number;
  };
  readonly agent?: {
    readonly maxTurns?: number;
    readonly reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  };
  readonly tools?: {
    readonly toolsets?: readonly string[];
  };
};

type GcpHermesSettable = CommonHermesSettable & {
  readonly model?: {
    readonly provider: "gcp";
    readonly projectId: string;
    readonly region: string;
    readonly model: string;
  };
};

type AzureHermesSettable = CommonHermesSettable & {
  readonly model?: {
    readonly provider: "azure";
    readonly endpoint: string;
    readonly deployment: string;
    readonly apiMode: "azure-openai" | "foundry";
  };
};

type HermesConfigSelection = GcpHermesSettable | AzureHermesSettable;
```

The renderer should be shared and pattern-match on provider-specific variants
only where the rendered Hermes settings differ. This keeps the patch path
uniform while still making it obvious that GCP and Azure have different model
catalogs, auth shapes, endpoints, and deployment assumptions.

Applying config should use existing shared code:

```ts
makeDeployment(driver).updateHomeManager({ identity, user, patch })
```

with the selected provider's `UserVolume` implementation once those are added.

### Secrets

Do not make secrets part of `DeploymentDriver`. Keep them as explicit provider
helpers called by the TUI:

- GCP: `putSecretValue`, `listSecrets`, `deleteSecret`.
- Azure: `readContainerAppSecrets`, `putContainerAppSecrets`.

The TUI layer can add small naming helpers such as
`secretNameFor(profile, "model-api-key")`, but the returned references must be
provider-specific. Home Manager should receive references, never values.

### Auth

The TUI auth layer should only promise:

```ts
getGcpAuth(profileName): Effect.Effect<GcpAuthContext, AppError>
getAzureAuth(profileName): Effect.Effect<AzureAuthContext, AppError>
```

How those token functions are backed is deliberately out of the command grammar.
Browser login, cached profile auth, or future provider-specific adapters can all
fit behind these two functions.

### Shared Command Plumbing

Keep command plumbing boring and shared. The non-interactive CLI and JSON mode
should run the same command logic and differ only at the final render step.

Useful small utilities:

- `parseArgs(argv)`: syntax only.
- `validateIntent(parsed)`: mode/argument compatibility and required inputs.
- `runIntent(intent)`: executes the command and returns data, not printed text.
- `renderHuman(result)`: concise terminal output for success or failure.
- `renderJson(result)`: stable JSON envelope for success or failure.

The important rule: command handlers should not print as they work, except for
explicit interactive prompts/progress in TUI or interactive CLI mode. They should
return a typed result that both human CLI and JSON can render.

Illustrative result shape:

```ts
type CommandResult =
  | { ok: true; command: CommandName; summary: string; data?: unknown; debug?: unknown }
  | { ok: false; command: CommandName; error: AppError; remediations?: readonly Remediation[] };
```

This avoids duplicated behavior between `--no-input` and `--json`, while still
letting human CLI output be readable instead of JSON with colors.

## Implementation Notes

- Build the parser as a small independent module so the TUI, provider command
  packages, and tests can share the same validation matrix.
- Treat mode as parsed data:

```ts
type OutputMode = "tui" | "cli" | "json";
type CommandIntent =
  | { command: "tui" }
  | { command: "setup" }
  | { command: "auth.check" }
  | { command: "discover" }
  | { command: "plan" }
  | { command: "deploy" }
  | { command: "status"; watch: boolean }
  | { command: "config.show" | "config.set" | "config.edit" | "config.sync" }
  | { command: "secrets.list" | "secrets.set" | "secrets.delete" }
  | { command: "restart" }
  | { command: "destroy"; state: "retain" | "purge" }
  | { command: "doctor" };
```

- Parse first, validate mode/argument compatibility second, perform discovery
  third, mutate only after an explicit command intent reaches execution.
- Model interaction as a separate parsed flag from output mode:

```ts
type OutputMode = "tui" | "cli" | "json";
type InputMode = "interactive" | "nonInteractive";
```

- Build auth providers that return the existing `GcpAuthContext` and
  `AzureAuthContext` types. Do not couple provider packages to `gcloud` or
  `az`.
- Unit-test every invalid combination listed above.
- Golden-test JSON output envelopes.
- Add a TTY guard test for bare and explicit TUI launch.
- Keep provider-specific validation in provider modules, but keep generic
  compatibility rules in the CLI/TUI package.

## Open Questions

- Whether local deployer profiles should live under `~/.hermes-ambit` or inside
  the user's Hermes profile tree. The safer default is `~/.hermes-ambit` so
  cloud deployment state does not pollute a local Hermes runtime profile.
- Whether `setup` should support section names in v1. Upstream Hermes has
  section-specific setup, but this deployer has a much smaller surface and can
  wait until the sections stabilize.
- Whether `deploy --json` should require a separate `--yes`. Current plan says
  no: complete JSON inputs are already explicit, and automation should not need
  a redundant prompt bypass. If this feels too permissive, require `--yes` only
  for JSON mutating commands and document it consistently.
- The exact GCP durable state primitive is not finalized in current code.
  Argument names above should be reduced to only implemented state backends
  before release.
