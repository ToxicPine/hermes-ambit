# Auth Model

Hermes Ambit should behave like the provider CLIs, not like a third-party SaaS
OAuth app. The user signs in through a first-party Google or Microsoft flow,
that provider-controlled flow stores and refreshes its own local credentials,
and this code consumes short-lived access-token shapes from that login state.

The deployer should not ask for API keys, client secrets, refresh tokens, or a
Hermes-owned OAuth client. If a provider login is missing or stale, the local CLI
package should either run an SDK-managed browser/device flow or render a
remediation step for the user. It must not execute `gcloud` or `az` to mint
access tokens. The core/provider library only needs typed token providers and
request-header construction.

## Research Todos

- [x] Confirm Google REST headers for tokens produced by `gcloud`.
- [x] Confirm Google quota/billing project header requirements for user
  credentials.
- [x] Confirm the distinction between `gcloud auth login` and Application
  Default Credentials.
- [x] Confirm Azure CLI access-token output shape and expiry field.
- [x] Confirm Azure Resource Manager REST authentication header.
- [x] Research non-shell local auth acquisition for the TUI package before
  implementing provider auth adapters. Shelling out to `gcloud` or `az` is out
  of scope for credential acquisition.

## Local Auth Acquisition Research Todos

These tasks are about how the local TUI/CLI gets deployer credentials. Keep this
logic out of the provider packages; they should continue to consume typed token
providers.

- [x] Locate the authoritative Google Cloud SDK implementation for
  `gcloud auth login`, `gcloud auth print-access-token`,
  `gcloud auth application-default login`, and
  `gcloud auth application-default print-access-token`. Prefer official SDK
  source packages or installed SDK Python sources over unofficial mirrors.
- [x] Identify which Google credential stores are stable enough to consume
  directly, including the Cloud SDK user account store, ADC files, active
  account/project config, quota project config, and service-account
  impersonation settings.
- [x] Evaluate the standard Google JavaScript auth libraries for the TUI
  runtime, especially whether they can provide the needed REST bearer tokens,
  quota project behavior, browser/device login, refresh handling, and Bun/Nix
  packaging without relying on shell execution.
- [x] Decide whether the TUI should prefer Cloud SDK login state, ADC login
  state, or an SDK-managed browser/device flow for GCP. Preserve the distinction
  in types if more than one path remains supported.
- [x] Locate the Azure CLI source for `az login`, subscription/tenant selection,
  cloud environment selection, and `az account get-access-token`.
- [x] Identify the Azure CLI/MSAL token cache and profile data that are stable
  or supported enough to consume directly, including how tenant, subscription,
  expiry, and token type map into `AzureAuthContext`.
- [x] Evaluate standard Microsoft auth libraries for the TUI runtime, especially
  `@azure/identity` and `@azure/msal-node`, and separate direct/browser/device
  credentials from credentials that merely shell out to `az`.
- [x] Decide whether the Azure TUI adapter should read existing Azure CLI login
  state, run an SDK-managed public-client browser/device flow, or support both
  as explicit provider-specific variants.
- [x] Check Bun and bun2nix compatibility for the selected Google and Microsoft
  auth libraries, including transitive Node API assumptions and native
  dependencies.
- [x] Define the TUI auth adapter interfaces after that research. They should
  return `GcpAuthContext`, `AzureAuthContext`, or
  `AzureFoundryOpenAICompatibleAuthContext` without exposing raw refresh tokens,
  token-cache internals, or secret-bearing argv.
- [x] Document the no-subprocess policy for missing credentials and keep
  remediation separate from credential acquisition.

## Local Auth Acquisition Findings

Temporary source inspection used official sources only:

- Google Cloud CLI archive from Google's versioned archive distribution.
- `google-auth-library` source from `googleapis/google-auth-library-nodejs`.
- Azure CLI source from `Azure/azure-cli`.
- Azure Identity source from `Azure/azure-sdk-for-js`.

The TUI package now owns concrete local auth adapters in
`pkg/packages/tui/src/auth.ts`. Provider packages still consume only typed token
providers.

The public command auth modes are `auto`, `browser`, and `device`. Local
deployer profiles store deployment intent only; they do not store an auth mode,
tokens, refresh tokens, or pointers to provider CLI token caches.

### Google Deployer Auth

Use Application Default Credentials through `google-auth-library` as the
non-shell path.

Reasons:

- Google Cloud SDK's normal `gcloud auth login` credentials are stored in Cloud
  SDK sqlite/cache internals such as `credentials.db` and access-token cache
  files. Those are implementation details, not a stable JavaScript integration
  contract.
- The `gcloud auth application-default login` path writes the documented ADC
  file. `google-auth-library` reads the well-known ADC path
  `~/.config/gcloud/application_default_credentials.json` on Linux/macOS and
  `%APPDATA%\gcloud\application_default_credentials.json` on Windows.
- `google-auth-library` handles `authorized_user` refresh tokens and
  `quota_project_id`. The TUI adapter currently accepts an explicit
  `quotaProjectId` so the provider request context can set
  `x-goog-user-project` without parsing hidden SDK config.

Remediation:

- If ADC is missing or stale, fail with a typed remediation that says a
  supported ADC file is required. The TUI can point the user at Google ADC setup
  documentation, but it should not treat `gcloud` as a credential adapter or run
  Cloud SDK commands on the user's behalf.
- If a quota project is required and not already configured, ask for the quota
  project explicitly and persist only the project id needed for
  `x-goog-user-project`.

Directly reading `gcloud auth login`'s private credential database should stay
out of scope unless Google exposes a stable library contract for it. The TUI
must not invoke `gcloud auth print-access-token`,
`gcloud auth application-default print-access-token`, or any other Cloud SDK
credential command itself.

### Azure Deployer Auth

Use `@azure/identity` credentials as the non-shell path. Interactive local
commands use browser/device credentials; non-interactive `auto` uses an
explicit no-subprocess Azure Identity chain for environment-derived service
principal credentials, workload identity, and managed identity.

Reasons:

- Azure CLI itself uses MSAL and persists token cache/profile data under the
  Azure CLI config directory. That cache is an Azure CLI implementation detail.
- Azure's own `AzureCliCredential` implementation shells out to
  `az account get-access-token`, so it does not satisfy the non-shell target.
- `InteractiveBrowserCredential` and `DeviceCodeCredential` use MSAL directly
  and can use the Azure SDK developer sign-on client ID without asking Hermes
  users for a client secret or a Hermes-owned OAuth app.
- Environment-derived service principal credentials,
  `WorkloadIdentityCredential`, and `ManagedIdentityCredential` cover automation
  and hosted runtimes without invoking `az`, PowerShell, or Azure Developer CLI
  helpers. The TUI accepts an injected environment for tests/automation; when
  that environment is not the ambient `process.env`, the adapter builds the
  equivalent Azure Identity credentials from that object instead of letting
  `EnvironmentCredential` read unrelated process state.
- The TUI setup/profile already has the provider-specific subscription and
  tenant fields needed to fill `AzureAuthContext`; those should not be inferred
  from token-cache internals.

Remediation:

- Prefer SDK-managed browser or device auth.
- For `--json` and `--no-input`, use the no-shell Azure Identity chain rather
  than a prompt or provider CLI token command.
- Do not add `AzureCliCredential` or a subprocess wrapper around
  `az account get-access-token`. If browser/device auth is unavailable in a
  specific runtime, fail with a remediation path and add another supported
  `@azure/identity` or MSAL-backed credential variant deliberately.

Azure scopes used by the TUI adapters:

- ARM/control plane: `https://management.azure.com/.default`
- Azure Files data plane for Home Manager user-volume updates:
  `https://storage.azure.com/.default`
- Azure Foundry/OpenAI-compatible data plane:
  `https://cognitiveservices.azure.com/.default`

The Azure Foundry data-plane scope is used by the local deployer to list model
catalog entries through Azure Identity. It is not the deployed Hermes runtime
auth shape; runtime inference currently follows upstream Hermes and uses the
provider-backed `AZURE_FOUNDRY_API_KEY` secret.

### Compatibility Check

In a temporary Bun project, `google-auth-library@10.6.2` and
`@azure/identity@4.13.1` both installed, imported under Bun, and generated
`bun.nix` successfully with bun2nix. The real workspace dependency graph was
then updated through `bun add --cwd packages/tui ...` and `bun2nix -o bun.nix`.

## Runtime Model Access Research Todos

These tasks are about what the deployed Hermes container needs in order to call
model APIs. Keep them separate from deployer auth: the local deployer can use
CLI-shaped OAuth, while the runtime may need cloud-native identity, an API key
secret, or private network reachability.

- [x] Confirm Google runtime paths:
  - Vertex AI from Cloud Run using the service account attached to the Cloud Run
    revision.
  - Gemini Developer API using `GEMINI_API_KEY` or `GOOGLE_API_KEY` from Secret
    Manager.
  - Which path Hermes should prefer, and whether both should be modeled as
    provider-specific variants.
- [x] Confirm Google prerequisites for each path:
  - Required APIs, IAM roles, billing/quota project behavior, and whether any
    model terms or enablement steps are per project.
  - Whether publisher models are just referenced by ID/region or must be added
    to a project before inference.
- [x] Confirm Cloud Run runtime mechanics:
  - Secret Manager environment variables versus mounted secret volumes.
  - Required permissions for the Cloud Run service account to read secrets and
    call Vertex AI.
  - Direct VPC egress, Serverless VPC Access, and Private Service Connect only
    where the model endpoint or dependency is actually private.
- [x] Confirm Azure runtime paths:
  - Azure OpenAI API key in a Container App secret referenced by an environment
    variable.
  - Azure OpenAI with Microsoft Entra ID using a managed identity attached to
    the Container App.
  - Whether Hermes should support both as provider-specific variants.
- [x] Confirm Azure prerequisites:
  - Azure OpenAI resource, endpoint, deployment names, model catalog endpoint,
    and whether model deployments must be created or only selected.
  - Required RBAC roles for managed identity inference.
- [x] Confirm Azure Container Apps runtime mechanics:
  - Container App secrets and environment variable `secretRef`.
  - Key Vault-backed secrets and identity requirements, if that is materially
    better than app-local secrets.
  - VNet integration, outbound routes, private endpoint, and private DNS
    requirements for private Azure OpenAI or other private dependencies.
- [x] Translate findings into minimal type implications:
  - Keep model catalog/discovery provider-specific.
  - Keep runtime access provider-specific unless a tiny shared base falls out
    naturally.
  - Do not put env vars, secrets, or network knobs on the initial deploy spec
    unless they are truly required to create the service.
- [x] Figure out, from first principles, how the GCP and Azure driver/setup
  surfaces should be extended so each deployment can make its model API
  reachable from Hermes cleanly. This does not imply a shared abstraction; the
  right shape may be different for each provider.

## Google

Official Google REST examples use:

```http
Authorization: Bearer ACCESS_TOKEN
```

where `ACCESS_TOKEN` can come from:

- `gcloud auth print-access-token`, using the active gcloud CLI account.
- `gcloud auth application-default print-access-token`, using ADC.
- service-account impersonation through gcloud, if the user chooses that.
- the metadata server on Google-hosted compute, if the deployer ever runs there.

`gcloud auth login` and `gcloud auth application-default login` are separate
credential stores. The first configures credentials for the gcloud CLI itself;
the second writes local ADC credentials for client libraries. They can use the
same user but do not have to.

For REST calls made with user credentials, Google APIs may require a quota
project. That is sent as:

```http
x-goog-user-project: PROJECT_ID
```

The account must have `serviceusage.services.use` on that project. This should
be modeled explicitly as optional GCP auth context, not hidden inside generic
headers.

Provider shape:

```ts
type GcpAccessToken = {
  readonly accessToken: string;
  readonly expiresAtEpochSeconds?: number;
};

type GcpAuthContext = {
  readonly token: () => Effect.Effect<GcpAccessToken, CloudError>;
  readonly quotaProjectId?: string;
};
```

GCP request headers derived from that context:

```ts
{
  Authorization: `Bearer ${token.accessToken}`,
  "x-goog-user-project": quotaProjectId, // only when known/needed
  Accept: "application/json",
}
```

### Google Runtime Model Access

There are two distinct Google-hosted model access paths to keep separate:

- Vertex AI / Gemini on Vertex AI. A Cloud Run runtime should normally use the
  service account attached to the revision. The project must have billing and
  the Vertex AI API enabled, and the runtime identity needs Vertex AI
  permissions such as `roles/aiplatform.user`. This path is cloud-native and
  should not be modeled as an API-key secret.
- Gemini Developer API. This uses a Google AI Studio / Generative Language API
  key. Google client libraries can read `GEMINI_API_KEY` or `GOOGLE_API_KEY`
  from the process environment. On Cloud Run, that value should come from Secret
  Manager, not from Home Manager text config.

Cloud Run can expose Secret Manager values either as environment variables or
mounted files. Environment variables are resolved when an instance starts, while
mounted secret volumes keep fetching from Secret Manager and are better for
rotation. For a simple API-key path, an environment variable is probably enough,
but the version pinning choice should be explicit.

When a deployment uses an explicit Cloud Run service account, the deployer can
grant that service account `roles/secretmanager.secretAccessor` on the specific
managed secrets it wires into the runtime environment. If the service relies on
the provider default runtime identity, the deployer should not guess broad IAM
bindings; use an explicit service account or a clear remediation.

For private reachability, Cloud Run has two relevant mechanics:

- Direct VPC egress or Serverless VPC Access for outbound access to a VPC.
- Private Service Connect only when the model endpoint/dependency is actually
  private. It should not be part of the default public Vertex/Gemini path.

Type implication: GCP runtime access should be a provider-specific setup concern
with at least a Vertex/IAM path and, if supported, a Gemini API-key path. Do not
put these fields on the initial Cloud Run deploy identity unless the selected
path requires them to create the revision.

## Azure

Azure CLI's interactive path is `az login`. The CLI stores refresh tokens and can
later emit short-lived access tokens with:

```sh
az account get-access-token
```

For Azure Resource Manager, the default token audience/scope is ARM. The command
can also be constrained by subscription or tenant. Official example output has
this shape:

```json
{
  "accessToken": "...",
  "expiresOn": "2023-10-31 21:59:10.000000",
  "expires_on": 1698760750,
  "subscription": "...",
  "tenant": "...",
  "tokenType": "Bearer"
}
```

Use `expires_on` for typed expiry, because it is UTC epoch seconds. Do not parse
`expiresOn`; it is a local datetime string.

Azure REST/ARM calls use:

```http
Authorization: Bearer ACCESS_TOKEN
Content-Type: application/json
```

Provider shape:

```ts
type AzureAccessToken = {
  readonly accessToken: string;
  readonly expiresAtEpochSeconds: number;
  readonly subscriptionId: string;
  readonly tenantId: string;
};

type AzureAuthContext = {
  readonly token: () => Effect.Effect<AzureAccessToken, CloudError>;
};
```

Azure request headers derived from that context:

```ts
{
  Authorization: `Bearer ${token.accessToken}`,
  Accept: "application/json",
}
```

`tokenType` is present in Azure CLI output, but the TUI uses `@azure/identity`
rather than CLI token output. The adapter therefore keeps the stable functional
fields and derives the required bearer header directly.

### Azure Runtime Model Access

Azure OpenAI also has two distinct runtime auth paths:

- API key. Azure OpenAI REST calls include the key in the `api-key` header. In
  Container Apps, store this as a Container App secret or a Key Vault-backed
  secret, then reference it from the container environment with `secretRef`.
- Microsoft Entra ID. A hosted Azure app can use a managed identity instead of
  a secret. The identity needs the appropriate Azure OpenAI/Cognitive Services
  role assignment on the resource.

The upstream Hermes Azure Foundry runtime currently uses the API-key path and
reads `AZURE_FOUNDRY_API_KEY`; it does not consume a `model.auth_mode` setting.
Managed identity remains a plausible future Azure path only after the runtime
has a concrete Entra ID inference adapter.

Azure OpenAI has a deployment concept that should stay visible in the provider
shape. The inference endpoint targets an Azure OpenAI resource endpoint and a
deployment name; the deployment name is what clients use in API calls, even when
it corresponds to an underlying model ID. So "model availability" and "usable
runtime target" are not the same thing on Azure.

Container Apps secrets are app-level values, and revisions reference them from
environment variables. Updating a secret alone does not automatically alter
already-running revisions; the setup/update flow should account for revision
rolls when the runtime needs to see changed values.

Private Azure OpenAI access is a networking decision, not an auth abstraction:
the Container Apps environment may need VNet integration, private endpoint, and
private DNS depending on how the Azure OpenAI resource is exposed. Keep this as
Azure setup shape until the exact supported path is chosen.

Type implication: current Azure runtime access should be provider-specific and
should keep `endpoint`, `deploymentName`, API version, and `apiKey` secret
wiring visible. Managed identity/RBAC should be added only as a separate Azure
variant if the Hermes runtime grows a concrete Entra ID inference path.

Default v1 model access should use public provider endpoints plus provider
identity or provider-managed secrets. Private networking is a separate Azure or
GCP setup choice only when public endpoint access is deliberately disabled or
egress must be constrained.

## Design Decisions

- Provider auth stays provider-owned. Shared code may expose small mechanical
  helpers, but it should not introduce a fake `CloudCredential` abstraction that
  erases GCP quota projects or Azure tenants/subscriptions.
- The local CLI/TUI layer owns prompting, browser/device handoffs, and local
  auth adapters. Prefer official libraries or supported first-party
  credential-store integration. Invoking `gcloud` or `az` as subprocesses is not
  an auth design path.
- Tokens are short-lived request inputs. Persisting refresh tokens, ADC files,
  Azure MSAL cache contents, or provider CLI config is out of scope for the core
  library.
- The generated Orval clients should stay behind provider wrappers that add
  these typed headers before calling the provider REST API.

## Sources

- Google Cloud REST authentication:
  https://docs.cloud.google.com/docs/authentication/rest
- Google gcloud authentication model:
  https://docs.cloud.google.com/docs/authentication/gcloud
- Google Cloud CLI versioned archives:
  https://cloud.google.com/sdk/docs/downloads-versioned-archives
- `gcloud auth print-access-token`:
  https://cloud.google.com/sdk/gcloud/reference/auth/print-access-token
- `gcloud auth application-default login`:
  https://docs.cloud.google.com/sdk/gcloud/reference/auth/application-default/login
- Google Auth Library for Node.js:
  https://github.com/googleapis/google-auth-library-nodejs
- Azure CLI interactive login:
  https://learn.microsoft.com/en-us/cli/azure/authenticate-azure-cli-interactively
- MSAL-based Azure CLI:
  https://learn.microsoft.com/en-us/cli/azure/msal-based-azure-cli
- `az account get-access-token`:
  https://learn.microsoft.com/en-us/cli/azure/account
- Azure CLI source:
  https://github.com/Azure/azure-cli
- Azure Identity for JavaScript:
  https://github.com/Azure/azure-sdk-for-js/tree/main/sdk/identity/identity
- Azure REST authentication:
  https://learn.microsoft.com/en-us/rest/api/gettingstarted/
- Vertex AI authentication:
  https://docs.cloud.google.com/vertex-ai/docs/authentication
- Gemini API keys:
  https://ai.google.dev/gemini-api/docs/api-key
- Gemini API in Vertex AI quickstart:
  https://cloud.google.com/vertex-ai/generative-ai/docs/start/quickstarts/quickstart-multimodal
- Vertex AI publisher model list:
  https://cloud.google.com/vertex-ai/docs/reference/rest/v1beta1/publishers.models/list
- Cloud Run secrets:
  https://cloud.google.com/run/docs/configuring/services/secrets
- Cloud Run VPC egress:
  https://cloud.google.com/run/docs/configuring/connecting-vpc
- Azure OpenAI REST API reference:
  https://learn.microsoft.com/en-us/azure/ai-services/openai/reference
- Azure OpenAI create/deploy resource:
  https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/create-resource
- Azure OpenAI managed identity:
  https://learn.microsoft.com/en-us/azure/ai-services/openai/how-to/managed-identity
- Azure Container Apps secrets:
  https://learn.microsoft.com/en-us/azure/container-apps/manage-secrets
- Azure Container Apps private endpoints:
  https://learn.microsoft.com/en-us/azure/container-apps/how-to-use-private-endpoint
