# Hermes Ambit Deployer

The local deployer lives in `pkg/`. It is a Bun workspace packaged with
bun2nix and is separate from the container image build.

Build the deployer:

```sh
nix build .#deployer
```

Run it from the workspace while developing:

```sh
cd pkg
nix develop -c -- bun packages/tui/src/cli.ts tui
```

The packaged binaries are:

```text
hermes-ambit
hermes-ambit-gcp
hermes-ambit-azure
```

## Auth

The deployer does not shell out to `gcloud` or `az` for tokens.

- GCP uses Application Default Credentials through `google-auth-library`.
- Azure uses `@azure/identity`; interactive commands can use browser or device
  auth, and non-interactive `auto` uses environment, workload identity, or
  managed identity credentials.

## Command Surface

There is no public `plan` command. Lifecycle commands show previews before
mutation in human/TUI mode, and JSON commands are already explicit.

Main commands:

```text
setup
auth check
discover
models / models list
deploy
status
restart
destroy
config show|set
secrets list|set|delete
doctor
tui
```

## GCP Profile

GCP deployments target Cloud Run plus Secret Manager and require an NFS state
backend supplied by the user.

```sh
hermes-ambit setup \
  --provider gcp \
  --profile default \
  --deployment personal-agent \
  --project my-gcp-project \
  --region us-central1 \
  --state nfs \
  --state-server 10.0.0.10 \
  --state-path /exports/hermes \
  --no-input
```

Use `--quota-project` when user credentials need an explicit billing/quota
project.

Use `--service-account` when the runtime needs provider-backed secrets such as
`GOOGLE_API_KEY`. The deployer only grants Secret Manager accessor permissions
to an explicit Cloud Run service account; it does not guess broad IAM changes
for the provider default runtime identity.

`--state-path` is a base NFS path. The generated profile mounts
`<state-path>/data` at `/data` and `<state-path>/nix` at `/nix`; use
`--state-data-path` and `--state-nix-path` when those directories live
elsewhere.

## Azure Profile

Azure deployments target Container Apps plus Container App secrets and use
Container Apps environment storage backed by Azure Files.

```sh
hermes-ambit setup \
  --provider azure \
  --profile default \
  --deployment personal-agent \
  --tenant 00000000-0000-0000-0000-000000000000 \
  --subscription 00000000-0000-0000-0000-000000000000 \
  --resource-group hermes \
  --location eastus \
  --environment-id /subscriptions/.../resourceGroups/hermes/providers/Microsoft.App/managedEnvironments/hermes-env \
  --storage-name hermes \
  --endpoint https://my-resource.openai.azure.com \
  --no-input
```

The Azure endpoint is optional for deployment itself, but include it in the
profile when you want model discovery and model config commands to work without
repeating it. You can still pass `--endpoint` per command:

```sh
hermes-ambit models --profile default --endpoint https://my-resource.openai.azure.com
```

`--storage-name` is the managed environment storage name already registered on
the Container Apps environment. The `--environment-id` must point at a managed
environment in the selected subscription and resource group. Deploy planning
validates that storage before creating or updating the Container App.

The profile endpoint can be the Azure resource root or the Hermes runtime
OpenAI base URL. Model discovery uses the resource root, while
`config set model.default` writes Hermes `model.base_url` as
`https://<resource>.openai.azure.com/openai/v1`.

## Runtime Config And Secrets

Secret values stay in provider secret stores and are exposed to the runtime as
environment variables. Updating or deleting a secret also updates the runtime
environment revision.

`destroy` removes the provider deployment and provider-owned runtime secrets
that were wired into it. Durable state follows the explicit retain/purge choice.

`status` reports the active runtime image and revision fields from the provider.
When the provider has a concrete Home Manager read path, it also includes the
managed module hash so config changes can be correlated with runtime rolls.

```sh
hermes-ambit secrets set GOOGLE_API_KEY --profile default
hermes-ambit config set model.default gemini-3-flash-preview --profile default
hermes-ambit config set model.default gpt-5-mini --profile default
hermes-ambit restart --profile default
```

Azure Foundry model access currently uses the Hermes runtime's supported API-key
path. Store that key as `AZURE_FOUNDRY_API_KEY`; the deployer wires it into the
Container App environment as a provider-backed secret.
The Container App is not assigned a managed identity just for model access in
v1; existing identities are preserved if they were already attached outside the
deployer.

Provider-specific model config remains explicit:

- GCP writes Hermes `model.provider = "gemini"` and uses Google-hosted Gemini
  access.
- Azure writes Hermes `model.provider = "azure-foundry"` and keeps endpoint,
  deployment, and API mode as Azure-specific settings.

## Current Image Constant

The deployer uses `UNIVERSAL_HERMES_IMAGE` from
`pkg/packages/shared/src/constants.ts`. That value is still a placeholder until
the universal runtime image is published, so real cloud deploys need that
constant set to the published image URL first. Provider planning fails before
cloud mutation while the placeholder is still present.
