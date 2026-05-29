import {
  ChainedTokenCredential,
  ClientSecretCredential,
  DeviceCodeCredential,
  EnvironmentCredential,
  InteractiveBrowserCredential,
  ManagedIdentityCredential,
  WorkloadIdentityCredential,
  type AccessToken,
  type DeviceCodePromptCallback,
  type TokenCredential,
} from "@azure/identity";
import type {
  AzureAccessToken,
  AzureAuthContext,
  AzureFoundryOpenAICompatibleAuthContext,
} from "@cardelli/azure";
import type { GcpAuthContext } from "@cardelli/gcp";
import {
  RemediationRequired,
  type CloudError,
  type Remediation,
} from "@cardelli/shared";
import { Effect } from "effect";
import { GoogleAuth } from "google-auth-library";

const GCP_CLOUD_PLATFORM_SCOPE =
  "https://www.googleapis.com/auth/cloud-platform";
const AZURE_ARM_SCOPE = "https://management.azure.com/.default";
const AZURE_COGNITIVE_SERVICES_SCOPE =
  "https://cognitiveservices.azure.com/.default";
export const AZURE_STORAGE_SCOPE = "https://storage.azure.com/.default";

export const gcpApplicationDefaultCredentialsRemediation: Remediation = {
  type: "auth",
  label: "Set up Google Application Default Credentials",
  url: "https://cloud.google.com/docs/authentication/set-up-adc-local-dev-environment",
};

export const azureIdentityCredentialsRemediation: Remediation = {
  type: "auth",
  label: "Configure Azure Identity credentials",
  url: "https://learn.microsoft.com/en-us/javascript/api/overview/azure/identity-readme?view=azure-node-latest",
};

type GcpApplicationDefaultAuthOptions = {
  readonly scopes?: readonly string[];
  readonly quotaProjectId?: string;
};

type AzureInteractiveBrowserCredentialOptions = {
  readonly tenantId: string;
};

type AzureDeviceCodeCredentialOptions = {
  readonly tenantId: string;
  readonly userPromptCallback?: DeviceCodePromptCallback;
};

type AzureNonInteractiveCredentialOptions = {
  readonly tenantId: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
};

type AzureArmAuthOptions = {
  readonly credential: TokenCredential;
  readonly tenantId: string;
  readonly subscriptionId: string;
  readonly scope?: string;
};

type AzureFoundryEntraIdAuthOptions = {
  readonly credential: TokenCredential;
  readonly scope?: string;
};

const authUnavailable = (
  scope: string,
  message: string,
  remediation: Remediation,
): RemediationRequired =>
  new RemediationRequired({
    scope,
    message,
    remediation,
  });

const googleScopes = (
  scopes: readonly string[] | undefined,
): readonly string[] => scopes ?? [GCP_CLOUD_PLATFORM_SCOPE];

const bearerToken = (
  scope: string,
  authorization: string | null,
): Effect.Effect<string, RemediationRequired> => {
  const prefix = "Bearer ";
  return authorization?.startsWith(prefix)
    ? Effect.succeed(authorization.slice(prefix.length))
    : Effect.fail(
        authUnavailable(
          scope,
          "Credential provider did not return a bearer access token",
          gcpApplicationDefaultCredentialsRemediation,
        ),
      );
};

export const makeGcpApplicationDefaultAuthContext = (
  options: GcpApplicationDefaultAuthOptions = {},
): GcpAuthContext => {
  const auth = new GoogleAuth({
    scopes: [...googleScopes(options.scopes)],
  });

  return {
    token: () =>
      Effect.gen(function* () {
        const scope = "gcp.application-default";
        const headers = yield* Effect.tryPromise({
          try: () => auth.getRequestHeaders(),
          catch: () =>
            authUnavailable(
              scope,
              "Could not get Google Application Default Credentials token",
              gcpApplicationDefaultCredentialsRemediation,
            ),
        });
        const accessToken = yield* bearerToken(
          scope,
          headers.get("authorization"),
        );
        return { accessToken };
      }),
    ...(options.quotaProjectId
      ? { quotaProjectId: options.quotaProjectId }
      : {}),
  };
};

export const makeAzureInteractiveBrowserCredential = (
  options: AzureInteractiveBrowserCredentialOptions,
): TokenCredential =>
  new InteractiveBrowserCredential({
    tenantId: options.tenantId,
  });

export const makeAzureDeviceCodeCredential = (
  options: AzureDeviceCodeCredentialOptions,
): TokenCredential =>
  new DeviceCodeCredential({
    tenantId: options.tenantId,
    ...(options.userPromptCallback
      ? { userPromptCallback: options.userPromptCallback }
      : {}),
  });

const makeAzureWorkloadIdentityCredential = (
  options: AzureNonInteractiveCredentialOptions,
): TokenCredential | undefined => {
  const env = options.env ?? process.env;
  const clientId = env.AZURE_CLIENT_ID;
  const tokenFilePath = env.AZURE_FEDERATED_TOKEN_FILE;
  return clientId && tokenFilePath
    ? new WorkloadIdentityCredential({
        tenantId: options.tenantId,
        clientId,
        tokenFilePath,
      })
    : undefined;
};

const makeAzureClientSecretEnvironmentCredential = (
  options: AzureNonInteractiveCredentialOptions,
): TokenCredential | undefined => {
  const env = options.env ?? process.env;
  const clientId = env.AZURE_CLIENT_ID;
  const clientSecret = env.AZURE_CLIENT_SECRET;
  return clientId && clientSecret
    ? new ClientSecretCredential(options.tenantId, clientId, clientSecret)
    : undefined;
};

const makeAzureManagedIdentityCredential = (
  options: AzureNonInteractiveCredentialOptions,
): TokenCredential => {
  const clientId = (options.env ?? process.env).AZURE_CLIENT_ID;
  return clientId
    ? new ManagedIdentityCredential({ clientId })
    : new ManagedIdentityCredential();
};

const usesAmbientProcessEnvironment = (
  options: AzureNonInteractiveCredentialOptions,
): boolean => options.env === undefined || options.env === process.env;

export const makeAzureNonInteractiveCredential = (
  options: AzureNonInteractiveCredentialOptions,
): TokenCredential => {
  const clientSecret = makeAzureClientSecretEnvironmentCredential(options);
  const workloadIdentity = makeAzureWorkloadIdentityCredential(options);
  return new ChainedTokenCredential(
    ...(clientSecret ? [clientSecret] : []),
    ...(usesAmbientProcessEnvironment(options)
      ? [new EnvironmentCredential()]
      : []),
    ...(workloadIdentity ? [workloadIdentity] : []),
    makeAzureManagedIdentityCredential(options),
  );
};

const getAzureAccessToken = (
  options: AzureArmAuthOptions,
): Effect.Effect<AzureAccessToken, CloudError> =>
  Effect.gen(function* () {
    const authScope = "azure.identity";
    const token = yield* getAzureIdentityToken(
      options.credential,
      options.scope ?? AZURE_ARM_SCOPE,
      authScope,
    );

    return {
      accessToken: token.token,
      expiresAtEpochSeconds: Math.floor(token.expiresOnTimestamp / 1000),
      subscriptionId: options.subscriptionId,
      tenantId: options.tenantId,
    };
  });

const getAzureIdentityToken = (
  credential: TokenCredential,
  scope: string,
  authScope: string,
): Effect.Effect<AccessToken, CloudError> =>
  Effect.gen(function* () {
    const token = yield* Effect.tryPromise({
      try: () => credential.getToken(scope),
      catch: () =>
        authUnavailable(
          authScope,
          "Could not get Microsoft Entra access token",
          azureIdentityCredentialsRemediation,
        ),
    });

    return token
      ? token
      : yield* Effect.fail(
          authUnavailable(
            authScope,
            "Microsoft Entra credential returned no token",
            azureIdentityCredentialsRemediation,
          ),
        );
  });

export const makeAzureIdentityAuthContext = (
  options: AzureArmAuthOptions,
): AzureAuthContext => ({
  token: () => getAzureAccessToken(options),
});

export const makeAzureFoundryOpenAICompatibleEntraIdAuthContext = (
  options: AzureFoundryEntraIdAuthOptions,
): AzureFoundryOpenAICompatibleAuthContext => ({
  kind: "entraId",
  token: () =>
    Effect.gen(function* () {
      const token = yield* getAzureIdentityToken(
        options.credential,
        options.scope ?? AZURE_COGNITIVE_SERVICES_SCOPE,
        "azure.foundry.openai-compatible.identity",
      );
      return {
        accessToken: token.token,
      };
    }),
});
