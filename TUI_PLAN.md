# Hermes Ambit TUI And CLI Surface Plan

## Objective

Define the user-facing command surface for the local Hermes Ambit deployer:
which argument combinations are valid in classic command mode, full-screen TUI
mode, and JSON automation mode, and how those modes map onto the guided flows
needed to deploy and manage a self-hosted Hermes container on GCP or Azure.

This document is intentionally about the application boundary, not internal
provider implementation details. Provider packages may expose an internal
resource preview function so deploy/restart/destroy can show users exactly what
will change before mutation. There is deliberately no public `plan` command.
The CLI/TUI layer should expose the user-facing lifecycle in deployment terms:
setup, models, deploy, status, config, secrets, restart, and destroy.

## Sources Reviewed

- Local `PLAN.md` and `AUTH.md`.
- Local deployer code under `pkg/packages/shared`, `pkg/packages/gcp`, and
  `pkg/packages/azure`.
- Local Home Manager Hermes module under `fs/hermes`.
- Fresh temp checkout of `NousResearch/hermes-agent`, especially:
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
  `hermes model`; provider/model setup should have one authoritative flow. This
  deployer keeps that lesson, but names the cloud catalog surface `models`.
- Upstream Hermes exposes `config show`, `config edit`, `config set`,
  `config path`, `config env-path`, `config check`, and `config migrate`.
  Hermes Ambit should expose only the config operations it can implement
  through the provider-backed runtime path in v1: `config show` and
  `config set` for explicit supported keys.
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
--auth <auto|browser|device> Token acquisition strategy, default: auto
--debug                       Include operation IDs and provider resource refs
--color <auto|always|never>   Human output only, default: auto
```

Profile naming should follow upstream Hermes profile discipline:
lowercase, starts with `[a-z0-9]`, then `[a-z0-9_-]`, length <= 64. The profile
owns local deployment defaults and cached discovery, but not cloud truth.

`--deployment` is the durable cloud identity. Reusing it must converge on the
same resources through deterministic naming. It should default from the active
profile in TUI/CLI mode once a profile has been configured, but JSON mode should
require it unless `--config` supplies it. Deployment names should stay directly
cloud-resource-safe: lowercase, start with `[a-z0-9]`, then `[a-z0-9-]`, length
<= 41 so the `hermes-` resource prefix does not require lossy truncation.

Auth arguments are intentionally token-provider shaped. They should produce the
typed auth contexts consumed by the current provider packages:

- GCP: access token plus optional `--quota-project`.
- Azure: bearer access token plus subscription and tenant identity.

`--auth browser` and `--auth device` are provider-specific credential strategies,
not a promise that every provider supports every mode. Azure currently uses the
Azure Identity browser/device credentials. GCP currently supports only `auto`
through Application Default Credentials, so `--auth browser` and `--auth device`
are invalid for GCP until a standard non-shell Google browser/device adapter is
added deliberately. There is intentionally no auth mode that shells out to
`gcloud` or `az`, and local deployer profiles do not store token material. Do
not add a top-level "access token from env" flag; token sourcing is an adapter
detail and should not become part of the public command grammar.

Automation that needs credentials should use a provider-supported credential
store or a future provider-specific auth adapter, not raw secret-bearing argv.
The public surface should describe stable intent, not raw token plumbing.

## Provider Arguments

Provider selection is product-visible and should not be hidden behind a fake
generic cloud abstraction.

GCP identity arguments:

```text
--project <project-id>
--region <region>
--model <gemini-model-id>
--service-account <email>
--quota-project <project-id>
--state <nfs>
--state-server <host-or-ref>
--state-path <base-path>
```

Azure identity arguments:

```text
--subscription <subscription-id>
--tenant <tenant-id>
--resource-group <name>
--location <azure-location>
--environment-id <managed-environment-resource-id>
--state <azure-files>
--storage-name <container-app-environment-storage-name>
--endpoint <azure-openai-compatible-endpoint>
--model <foundry-deployment-name>
```

Initial implementation can support only the state modes actually implemented.
Unsupported state modes should fail during parsing or validation with a stable
error code, not silently fall back.

Cross-check against the current generated Container Apps surfaces: app volumes
consume `storageType`, `storageName`, and optional mount `subPath`. The deployer
also generates and uses the managed-environment storage GET surface to resolve
the Azure Files account/share behind `--storage-name` when writing the managed
Home Manager module through the persistent user volume. Setup should still ask for the
Container Apps environment storage name, not a raw storage account and file share
tuple. For v1, the managed environment ID must stay inside the selected
subscription and resource group; allowing cross-boundary environment storage
would make the resource-group boundary misleading.

## Commands

Top-level grammar:

```text
hermes-ambit tui [global args]
hermes-ambit setup [global args] [--quick] [--reset] [--reconfigure]
hermes-ambit setup --no-input [global args] [provider args]
hermes-ambit auth check [global args]
hermes-ambit discover [global args]
hermes-ambit models [list] [global args]
hermes-ambit deploy [global args] [provider args] [--yes]
hermes-ambit status [global args] [--watch]
hermes-ambit config [show|set] [global args]
hermes-ambit secrets [list|set|delete] [global args]
hermes-ambit restart [global args] [--yes]
hermes-ambit destroy [global args] [--retain-state|--purge-state] [--yes]
hermes-ambit doctor [global args]
```

`apply` and `plan` should not exist as public aliases; deploy previews are part of
`deploy`, restart, destroy, and the TUI confirmation screens.

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
6. Deploy preview
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
- Lifecycle mutations show a typed preview and ask for confirmation. Explicit
  config and secret edits are already scoped commands and should not grow a
  second generic confirmation layer.
- TUI should use provider-specific forms. GCP deployment requires a
  Google-hosted model selection. Azure deployment requires an Azure-hosted
  endpoint and deployment-name selection. Cross-cloud model routing is not a v1
  normal path.
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
hermes-ambit setup --no-input --provider gcp --deployment personal-agent --project my-project --region us-central1 --model gemini-model-id --state nfs --state-server 10.0.0.8 --state-path /exports/hermes
hermes-ambit setup --no-input --provider azure --deployment work-agent --subscription <id> --tenant <tenant-id> --resource-group hermes --location eastus --environment-id <id> --state azure-files --storage-name <name> --endpoint https://my-resource.openai.azure.com --model my-gpt-deployment
hermes-ambit auth check --provider azure --tenant <tenant-id> --subscription <id>
hermes-ambit discover --provider gcp --project my-project --region us-central1
hermes-ambit models list --provider gcp --region us-central1
hermes-ambit deploy --provider azure --deployment work-agent --subscription <id> --tenant <tenant-id> --resource-group hermes --location eastus --environment-id <id> --storage-name <name> --endpoint https://my-resource.openai.azure.com --model my-gpt-deployment
hermes-ambit status --profile work
hermes-ambit status --provider gcp --deployment personal-agent --watch
hermes-ambit config show --profile work
hermes-ambit config set model.default gemini-model-id --profile work
hermes-ambit secrets set GOOGLE_API_KEY --profile work
hermes-ambit restart --profile work
hermes-ambit destroy --profile work --retain-state
```

CLI prompt policy:

- `setup` may guide interactively, like upstream `hermes setup`.
- `setup --no-input` is valid and must behave as a deterministic profile
  initialization command. It writes/updates the deployer profile from supplied
  args/config/env, validates auth/boundary inputs, and exits without prompts.
- For GCP, `--state-path` is a base NFS path; the profile derives separate
  `/data` and `/nix` backing paths from it. Use `--state-data-path` and
  `--state-nix-path` when the backing directories are not siblings.
- `deploy`, `restart`, and `destroy` may ask for confirmation in a TTY after
  showing a typed preview of what will change.
- `status`, `doctor`, `config show`, and `secrets list` should not prompt.
- `secrets set NAME` may prompt for the value when TTY input is available.

CLI confirmation policy:

- Lifecycle mutating commands require confirmation unless `--yes` is set.
- `--yes` is accepted only on lifecycle mutating CLI commands.
- `--yes` is invalid on TUI mode, read-only commands, and JSON mode. JSON
  mutating commands are already explicit.

CLI invalid examples:

```text
hermes-ambit status --yes
hermes-ambit deploy --watch
hermes-ambit destroy --retain-state --purge-state
hermes-ambit secrets set NAME --json
```

`setup --json` is invalid for now because setup is profile initialization and
may grow human-oriented summaries. Automation that wants machine output should
use `deploy`, `status`, `config set`, and `secrets set --value-stdin`; automation
that wants a readable log should use `setup --no-input`.

## JSON Mode Contract

JSON mode is for scripts, CI, and future web/service embedding. It must produce
only JSON on stdout. Human diagnostics go to stderr only when they do not break
the JSON contract, and should normally be represented in the JSON payload.

Valid:

```text
hermes-ambit auth check --provider gcp --json
hermes-ambit discover --provider azure --tenant <tenant-id> --subscription <id> --resource-group hermes --json
hermes-ambit models list --provider gcp --region us-central1 --json
hermes-ambit deploy --provider gcp --deployment personal-agent --project my-project --region us-central1 --model gemini-model-id --state-server 10.0.0.8 --state-path /exports/hermes --json
hermes-ambit status --provider azure --deployment work-agent --tenant <tenant-id> --subscription <id> --resource-group hermes --json
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
hermes-ambit secrets set NAME --from-env SOURCE_ENV_NAME --profile work
```

`--value <secret>` should not be supported because it leaks through shell
history and process listings.

## JSON Envelope

All JSON output should use a stable envelope:

```json
{
  "ok": true,
  "command": "deploy",
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
    "code": "auth.unavailable",
    "message": "GCP credentials are not available."
  },
  "remediations": [
    {
      "type": "auth",
      "label": "Set up Google Application Default Credentials",
      "url": "https://cloud.google.com/docs/authentication/set-up-adc-local-dev-environment"
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

The shared library models minimal remediation as `type`, `label`, and `url`.
Keep `type` descriptive rather than provider-taxonomic; provider-specific retry
and copy belong in the CLI/TUI layer.

## Command Details

### `setup`

Purpose: guided local profile and deployment setup.

Valid modes: interactive CLI, non-interactive CLI, TUI via `tui`.

Invalid modes: JSON.

Accepted:

```text
setup [--profile <name>] [--provider <gcp|azure>] [--deployment <name>]
setup --no-input --profile <name> --provider <gcp|azure> --deployment <name> [provider args]
setup --quick
setup --reset
setup --reconfigure
```

Behavior:

- New profile: offer quick setup or full setup.
- Existing profile: default to reconfigure with current values as defaults.
- `--quick`: prompt only for missing required values.
- `--reset`: reset local deployer profile, not cloud resources.
- `--no-input`: require a complete provider/deployment/boundary tuple from
  args or `--config`; run read-only auth and provider-boundary validation; write
  the profile only after validation passes; do not deploy unless the command is
  `deploy`.
- Section-specific setup can be added later, but v1 should avoid a large
  section matrix until real user demand appears.

`setup --no-input` is not a synonym for JSON. It should produce concise human
output suitable for logs:

```text
Profile: work
Provider: azure
Deployment: work-agent
Auth: checked
Boundary: subscription <id>, resource group hermes, location eastus
Next: hermes-ambit deploy --profile work
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

Purpose: discover the selected provider boundary before deployment and list
Hermes-owned resources already present there.

Valid modes: CLI, JSON, TUI internal.

Initial GCP output: supplied project/region and Hermes-owned Cloud Run services
inside that boundary.

Initial Azure output: supplied subscription/resource group and Hermes-owned
Container Apps inside that boundary.

Later setup flows can grow broader account enumeration, such as accessible
projects, regions, tenants, subscriptions, resource groups, locations, API
enablement, billing/quota, and Container Apps environments, but that should be
added as provider-specific discovery proves it is needed.

Discovery is read-only and should never create resources.

Model catalog discovery is intentionally a separate `models list` command. The
model surfaces are provider-specific runtime setup inputs, not cloud ownership
boundary discovery.

### `models list`

Purpose: list provider-hosted model choices for the deployment provider.

Valid modes: CLI, JSON, TUI internal.

GCP uses the regional Vertex AI publisher-model surface and should expose only a
small supported Google shared-model set for setup. Azure uses the concrete
Foundry OpenAI-compatible endpoint model list and should keep that route family
visible in the result shape. Azure catalog model IDs are not necessarily Hermes
runtime deployment names, so model summaries should mark whether the runtime
target is the listed model ID or a separate deployment name.

Model listing is read-only and should never create resources.

### `deploy`

Purpose: apply the deployment idempotently.

Valid modes: CLI, JSON, TUI internal.

CLI requires confirmation unless `--yes` is set. TUI confirms in-app. JSON
requires explicit complete inputs and returns operation events in `data`.

`deploy` should internally compute a typed preview first. Do not accept stale
opaque preview files in v1.

The internal preview must clearly group:

- boundary
- resources to create
- resources to reuse
- resources to update
- secrets/config changes
- state retention/destruction implications
- remediations blocking apply

Preview output should avoid low-level provider IDs unless `--debug` is set.

### `status`

Purpose: inspect deployed runtime state.

Valid modes: CLI, JSON, TUI internal.

Accepted:

```text
status [--watch]
```

`--watch` is CLI/TUI only. JSON mode should return one snapshot.
The human CLI polls every 5 seconds and renders repeated status snapshots; it
does not need an alternate screen or spinner.

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
```

Rules:

- `show` supports JSON when the selected provider has a concrete read channel
  for the managed Home Manager module. Azure has that path through Azure Files.
  GCP can mutate the NFS-backed config through a Cloud Run Job, but a read path
  needs a deliberate Cloud Run output channel; do not fake it with a parallel
  local config store.
- `set` supports CLI and JSON only when key/value are supplied, and rolls the
  runtime after the provider-backed managed Home Manager module is written. `restart`
  remains a manual lifecycle command for reloading the current config/secrets.
  Do not expose a separate `config sync` command unless the deployer grows a
  real desired-state source for it to reconcile.
- Do not expose a generic `config edit` command in v1. The deployer applies a
  curated Hermes settings surface to remote Home Manager state; opening an
  arbitrary editor would either be a fake local config path or a broad remote
  Nix editor.
- Azure has a provider user-volume path via managed-environment storage plus
  Azure Files. GCP uses a provider-managed Cloud Run Job that mounts the same
  durable `/data` NFS volume, writes the managed Home Manager module inside that
  mounted filesystem, waits for the Job run, then rolls the service.
- Azure Foundry runtime access follows upstream Hermes' current API-key path:
  write endpoint/model settings to Home Manager and wire `AZURE_FOUNDRY_API_KEY`
  through Container App secrets. Do not expose an Entra ID config toggle until
  the runtime has a real Entra ID inference path.
- Do not assign a Container App managed identity by default for the API-key
  path. Reconciliation may preserve identities already attached to the app, but
  identity creation should appear only when a concrete Azure runtime access path
  requires it.
- The runtime policy rebuilds Home Manager from persistent user config on boot,
  so provider-written config is applied by the restart/revision roll path rather
  than by rebuilding the Docker image.

Config keys should match Hermes config semantics where possible, but this
deployer should expose only settings it can apply cleanly to the cloud runtime.
The upstream Hermes config surface is broad because it owns local chat,
terminal, dashboard, plugins, skills, gateway, sessions, and provider setup.
Most of that is not a deployer responsibility.

Initial settable keys should stay narrow:

```text
model.default
model.api_mode
gateway.host
gateway.port
agent.max_turns
agent.reasoning_effort
```

Provider-specific model forms can render richer selections, then lower them to
these Hermes settings plus provider-backed secrets. Add more keys only when a
deploy/manage flow has a concrete need for them.

`config set model.default` is provider-aware rather than a blind single-key
write: for GCP it writes the Gemini provider/default/base URL together, and for
Azure it requires the concrete OpenAI-compatible `--endpoint` so the Foundry
provider/default/base URL/API mode are coherent. Do not expose
`model.provider` or `model.base_url` as direct config keys in v1; they are
derived from the provider-specific model selection so model discovery, profile
intent, and runtime config do not drift apart.

Azure Foundry currently has that concrete need for its OpenAI-compatible route:
`model.api_mode` is a valid Azure-only config key because the runtime must
distinguish chat-completions versus responses-style calls. Authentication is
not a direct config key in v1; upstream Hermes uses `AZURE_FOUNDRY_API_KEY` for
this route. Anthropic Messages on Azure Foundry is a separate route family and
should not be exposed until the deployer has a concrete provider-native setup
surface for it.

### `secrets`

Purpose: manage provider-backed secret values and make them available to the
Hermes container as runtime environment variables.

Valid:

```text
secrets list
secrets set <NAME>
secrets set <NAME> --value-stdin
secrets set <NAME> --from-env <SOURCE_ENV_NAME>
secrets delete <NAME>
```

Rules:

- `NAME` is the runtime environment variable name, such as `GOOGLE_API_KEY` or
  `AZURE_FOUNDRY_API_KEY`. Provider secret resource names are derived privately.
- `list` never prints secret values.
- `set <name>` prompts in CLI mode when a TTY is available.
- On GCP, if the Cloud Run service has an explicit runtime service account, the
  deployer reconciles `roles/secretmanager.secretAccessor` on each managed
  secret before wiring it into the service environment.
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
- Runtime deployment deletion should also remove provider-owned runtime secrets
  that are wired into that deployment. State retention is a separate choice.
- Azure can purge the configured Azure Files state subpaths after deleting the
  Container App. GCP NFS state purge should remain unavailable until the deployer
  either owns the backing NFS export or has a safe provider-specific purge hook.

### `doctor`

Purpose: diagnose local prerequisites and provider readiness.

Valid modes: CLI, JSON, TUI internal.

Checks:

- Bun/package version if needed.
- Auth provider availability. SDK-managed browser/device credentials and
  provider-supported credential files are sufficient for this project; the TUI
  should not execute `gcloud` or `az` to mint access tokens.
- TTY/browser availability for interactive paths.
- Profile validity.
- Config sanity.
- Universal runtime image readiness.
- Provider setup/state prerequisites when a complete deployment spec is
  available.
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
| `--yes` | no | no | yes | no | no |
| `--watch` | status screen | status only | no | no | no |
| `--retain-state` | destroy screen | no | destroy only | no | destroy only |
| `--purge-state` | destroy screen | no | destroy only | no | destroy only |
| `--debug` | diagnostics toggle | yes | yes | yes | yes |
| `--color` | no | yes | yes | forced never | forced never |

## Invalid Combination Rules

The parser should reject these before side effects:

- `--json` with `tui`, `setup`, `status --watch`, or prompt-only
  secret writes.
- `--no-input` with `tui`.
- `--no-input` without all required command inputs.
- `--auth browser` or `--auth device` with `--no-input` or `--json`.
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
5. If auth is missing, run/offer the selected provider-supported token flow or
   show a typed remediation and retry.
6. Run discovery.
7. Ask for deployment identity and boundary.
8. Show Hermes runtime config form.
9. Show deploy preview.
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

Cross-check against current generated model-list surfaces:

- GCP now has an AI Platform publisher-model list surface. It lists
  `publishers/{publisher}/models` on the regional AI Platform host, with optional
  filter/page/view/language/version query fields and an optional
  `publisherModels` array in the response. The TUI should not expose the full
  Model Garden list. For v1, GCP should support only Google shared models that
  are easy to use through the public API: currently that means a small Gemini
  allowlist/prefix set whose generated `supportedActions.viewRestApi` is present.
  Everything else is discovery/debug data, not a supported setup choice.
- Azure now has a generated surface named after the Azure OpenAI
  `/openai/models` route, scoped to a concrete endpoint and API version. Treat
  that as an OpenAI-compatible route family inside Azure Foundry, not as a claim
  that all supported Foundry models are OpenAI models. Microsoft Foundry also
  documents non-OpenAI model routes, such as Anthropic Claude through an
  `/anthropic` endpoint; those would need their own provider-native surface
  before the TUI exposes them. The generated response has optional `object`,
  `data`, lifecycle, capability, and deprecation fields. The TUI should treat
  that extra metadata as raw discovery/debug data unless a concrete setup flow
  needs it, not as a public model-selection contract.
- These generated surfaces support provider-specific model forms. They do not
  support a cross-cloud model matrix or a single common set of model settings.

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
  | { provider: "gcp"; name: string; deployment: string; user: string; quotaProjectId?: string; gcp: GcpDeployment & { model: string } }
  | { provider: "azure"; name: string; deployment: string; user: string; tenantId: string; azure: AzureDeployment & { openaiCompatibleEndpoint: string; modelDeployment: string } };
```

This is enough for `setup --no-input`, TUI resume, and command defaults. Auth
storage can be separate and opaque. Profile auth metadata should be limited to
stable provider identity needed to construct token-provider contexts, such as a
GCP quota project or Azure tenant, not token material.

Azure's OpenAI-compatible model endpoint and deployment name are profile intent,
not provider credential material and not part of the ARM deployment spec.
Persisting them in the Azure profile lets `deploy`, `models`, `doctor`, and
`config set model.default` work without repeating model-specific fields.

### Provider Modules

Each provider module should expose a few concrete functions around the existing
package API:

```ts
// gcp-app.ts
makeGcpApp(auth: GcpAuthContext): {
  previewDeploy(input: GcpDeployment): Effect.Effect<GcpDeployPreview, CloudError>;
  deploy(input: GcpDeployment): Effect.Effect<GcpStatus, CloudError>;
  status(input: GcpDeployment): Effect.Effect<GcpStatus, CloudError>;
  restart(input: GcpDeployment): Effect.Effect<GcpStatus, CloudError>;
  destroy(input: GcpDeployment): Effect.Effect<GcpStatus, CloudError>;
  putSecret(input: GcpSecretValue): Effect.Effect<SecretVersion, CloudError>;
  listSecrets(...): Effect.Effect<...>;
  deleteSecret(input: GcpSecretRef): Effect.Effect<...>;
  listSupportedModels(region, params?): Effect.Effect<readonly GcpModelSummary[], CloudError>;
}
```

Azure gets the same hand-written shape using `AzureDeployment`,
`AzureDeployPreview`, `AzureStatus`, Container App secrets, and Azure Foundry
model discovery. Keep Azure Foundry model discovery separate from the ARM
deployment app because it has a different auth shape and endpoint scope. If the
implementation delegates to a generated `/openai/models` client, name that as an
OpenAI-compatible route, not as the whole Azure model provider. These wrappers
should mostly delegate to `makeDeployment(makeGcpDriver(auth))`,
`makeDeployment(makeAzureDriver(auth))`, the provider-native secret helpers, and
the provider-specific model-list helpers.

The only extra behavior they should add is:

- Build short preview/status summaries for the TUI.
- Build compact supported-model summaries from generated discovery responses.
  For GCP, filter to shared REST API models instead of presenting every Model
  Garden publisher model.
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
fields. `setup --no-input` calls `draftFromArgs`, `validateDraft`,
`profileFromDraft`, and then read-only provider validation; if anything is
missing or the provider check fails, it fails without writing the profile.

This follows the Hermes CLI pattern without copying its complexity: Hermes has
one provider/model setup path reused by setup and model commands. Here, one
setup draft path should be reused by TUI, CLI prompts, and non-interactive CLI.

### Hermes Config Helpers

Keep this narrow. The TUI needs functions that turn user choices into a
Home Manager module:

```ts
renderHermesModule(input: HermesConfigSelection): HomeManagerModule
```

Home Manager config should be the same kind of operation for both platforms:
take a typed Hermes config selection and render the complete managed Nix module.
Provider differences belong in what can be selected, not in how the module is
written.

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
    readonly service: "gemini";
    readonly routeFamily: "developer-api";
    readonly model: string;
  };
};

type AzureHermesSettable = CommonHermesSettable & {
  readonly model?: {
    readonly provider: "azure";
    readonly endpoint: string;
    readonly deployment: string;
    readonly service: "azure-foundry";
    readonly routeFamily: "openai-compatible";
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
Provider-supported browser/device login, ADC, managed identity, or future
provider-specific adapters can all fit behind these two functions.

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

Define the CLI grammar as positive command shapes: each command/subcommand
declares its supported flags, positional arguments, and exclusive flag groups.
Then parse argv against that shape. This keeps `--yes`, `--watch`, secret source
flags, and config positionals from becoming scattered "things this command does
not support" checks. Zod or a similarly small schema validator may be used to
validate those command-shape declarations themselves.

Do not add a separate public `renderError` path. Failure is one variant of the
same command result, and both renderers should decide how to present that variant.

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
  | { command: "models.list" }
  | { command: "deploy" }
  | { command: "status"; watch: boolean }
  | { command: "config.show" | "config.set" }
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

## Settled V1 Decisions

- Local deployer profiles live under `~/.hermes-ambit/profiles` by default, or
  under `$HERMES_AMBIT_HOME/profiles` when that environment variable is set.
  Keeping cloud deployment profiles separate avoids polluting a local Hermes
  runtime profile tree.
- `setup` is flat in v1. Upstream Hermes has section-specific setup, but this
  deployer has a smaller cloud deployment surface and should add sections only
  after those sections become real product surfaces.
- JSON mutating commands do not accept `--yes`. Complete JSON inputs are already
  explicit, and automation should not need a redundant human prompt bypass.

## Remaining Open Questions

- The exact GCP durable state primitive is not finalized in current code. The
  current NFS path can be mounted into Cloud Run, but the deployer does not own a
  provider API for deleting that backing export.
- Whether Azure setup should later grow storage provisioning arguments. Current
  setup keeps account/share names out of the profile and resolves them through
  the managed-environment storage API when writing managed Home Manager modules.
