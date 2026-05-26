# Auth Model

Hermes Ambit should behave like the provider CLIs, not like a third-party SaaS
OAuth app. The user signs in with `gcloud` or `az`, those tools store and refresh
their own local credentials, and this code consumes short-lived access-token
shapes from that provider-controlled login state.

The deployer should not ask for API keys, client secrets, refresh tokens, or a
Hermes-owned OAuth client. If a provider login is missing or stale, the local CLI
package can tell the user which first-party command to run. The core/provider
library only needs typed token providers and request-header construction.

## Research Todos

- [x] Confirm Google REST headers for tokens produced by `gcloud`.
- [x] Confirm Google quota/billing project header requirements for user
  credentials.
- [x] Confirm the distinction between `gcloud auth login` and Application
  Default Credentials.
- [x] Confirm Azure CLI access-token output shape and expiry field.
- [x] Confirm Azure Resource Manager REST authentication header.
- [ ] Decide later whether the CLI package shells out to `gcloud`/`az` directly
  or uses provider SDK credential helpers that read the same local login state.
  The provider library types should support either source.

## Runtime Model Access Research Todos

These tasks are about what the deployed Hermes container needs in order to call
model APIs. Keep them separate from deployer auth: the local deployer can use
CLI-shaped OAuth, while the runtime may need cloud-native identity, an API key
secret, or private network reachability.

- [ ] Confirm Google runtime paths:
  - Vertex AI from Cloud Run using the service account attached to the Cloud Run
    revision.
  - Gemini Developer API using `GEMINI_API_KEY` or `GOOGLE_API_KEY` from Secret
    Manager.
  - Which path Hermes should prefer, and whether both should be modeled as
    provider-specific variants.
- [ ] Confirm Google prerequisites for each path:
  - Required APIs, IAM roles, billing/quota project behavior, and whether any
    model terms or enablement steps are per project.
  - Whether publisher models are just referenced by ID/region or must be added
    to a project before inference.
- [ ] Confirm Cloud Run runtime mechanics:
  - Secret Manager environment variables versus mounted secret volumes.
  - Required permissions for the Cloud Run service account to read secrets and
    call Vertex AI.
  - Direct VPC egress, Serverless VPC Access, and Private Service Connect only
    where the model endpoint or dependency is actually private.
- [ ] Confirm Azure runtime paths:
  - Azure OpenAI API key in a Container App secret referenced by an environment
    variable.
  - Azure OpenAI with Microsoft Entra ID using a managed identity attached to
    the Container App.
  - Whether Hermes should support both as provider-specific variants.
- [ ] Confirm Azure prerequisites:
  - Azure OpenAI resource, endpoint, deployment names, model catalog endpoint,
    and whether model deployments must be created or only selected.
  - Required RBAC roles for managed identity inference.
- [ ] Confirm Azure Container Apps runtime mechanics:
  - Container App secrets and environment variable `secretRef`.
  - Key Vault-backed secrets and identity requirements, if that is materially
    better than app-local secrets.
  - VNet integration, outbound routes, private endpoint, and private DNS
    requirements for private Azure OpenAI or other private dependencies.
- [ ] Translate findings into minimal type implications:
  - Keep model catalog/discovery provider-specific.
  - Keep runtime access provider-specific unless a tiny shared base falls out
    naturally.
  - Do not put env vars, secrets, or network knobs on the initial deploy spec
    unless they are truly required to create the service.
- [ ] Figure out, from first principles, how the GCP and Azure driver/setup
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
  readonly tokenType: "Bearer";
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
  Authorization: `${token.tokenType} ${token.accessToken}`,
  Accept: "application/json",
}
```

### Azure Runtime Model Access

Azure OpenAI also has two distinct runtime auth paths:

- API key. Azure OpenAI REST calls include the key in the `api-key` header. In
  Container Apps, store this as a Container App secret or a Key Vault-backed
  secret, then reference it from the container environment with `secretRef`.
- Microsoft Entra ID. A hosted Azure app can use a managed identity instead of
  a secret. The identity needs the appropriate Azure OpenAI/Cognitive Services
  role assignment on the resource.

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

Type implication: Azure runtime access should be provider-specific and should
keep `endpoint`, `deploymentName`, API version, and either `apiKey` secret
wiring or managed identity/RBAC as distinct variants.

## Design Decisions

- Provider auth stays provider-owned. Shared code may expose small mechanical
  helpers, but it should not introduce a fake `CloudCredential` abstraction that
  erases GCP quota projects or Azure tenants/subscriptions.
- The local CLI/TUI layer owns prompting and running `gcloud auth login`,
  `gcloud auth application-default login`, `az login`, or equivalent helper
  flows. Provider libraries consume typed token providers.
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
- `gcloud auth print-access-token`:
  https://cloud.google.com/sdk/gcloud/reference/auth/print-access-token
- `gcloud auth application-default login`:
  https://docs.cloud.google.com/sdk/gcloud/reference/auth/application-default/login
- Azure CLI interactive login:
  https://learn.microsoft.com/en-us/cli/azure/authenticate-azure-cli-interactively
- `az account get-access-token`:
  https://learn.microsoft.com/en-us/cli/azure/account
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
