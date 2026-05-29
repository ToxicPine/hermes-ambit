import { createHash } from "node:crypto";

import type { TokenCredential } from "@azure/identity";
import type {
  AzureAuthContext,
  AzureDeployment,
  AzureDeploymentRef,
  AzureResourceGroupRef,
} from "@cardelli/azure";
import type {
  GcpAuthContext,
  GcpBoundary,
  GcpDeployment,
  GcpDeploymentRef,
} from "@cardelli/gcp";
import { type CloudError, type HomeManagerModule } from "@cardelli/shared";
import { Effect } from "effect";

import type { AppProfile } from "./app-profile.js";
import { gcpStateDataPath, gcpStateNixPath } from "./setup-state.js";
import {
  makeAzureApp,
  makeAzureFoundryModelApp,
  makeAzureHomeManagerApp,
  summarizeAzureDeployPreview,
  summarizeAzureStatus,
} from "./azure-app.js";
import type { AppError, AuthMode, InputMode } from "./types.js";
import {
  makeAzureDeviceCodeCredential,
  makeAzureFoundryOpenAICompatibleEntraIdAuthContext,
  makeAzureIdentityAuthContext,
  makeAzureInteractiveBrowserCredential,
  makeAzureNonInteractiveCredential,
  AZURE_STORAGE_SCOPE,
  makeGcpApplicationDefaultAuthContext,
} from "./auth.js";
import {
  makeGcpApp,
  makeGcpHomeManagerApp,
  summarizeGcpDeployPreview,
  summarizeGcpStatus,
} from "./gcp-app.js";
import type {
  ProviderDeployPreviewSummary,
  ProviderDiscoverySummary,
  ProviderStatusSummary,
  SupportedModelSummary,
  ProviderConfigRead,
  ProviderAuthSummary,
} from "./provider-summary.js";
import type { ProviderOperationResult } from "./provider-operation.js";
import { mapProviderOperationResult } from "./provider-operation.js";

export type { ProviderOperationResult } from "./provider-operation.js";

export type LocalCredentialRequest = {
  readonly mode?: AuthMode;
  readonly inputMode: InputMode;
  readonly noBrowser: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly deviceCodePrompt?: (message: string) => void;
};

export type GcpProviderAuthTarget = {
  readonly provider: "gcp";
  readonly profile: string;
  readonly quotaProjectId?: string;
};

export type AzureProviderAuthTarget = {
  readonly provider: "azure";
  readonly profile: string;
  readonly tenantId: string;
  readonly subscriptionId: string;
};

export type ProviderAuthTarget =
  | GcpProviderAuthTarget
  | AzureProviderAuthTarget;

export type GcpProviderModelTarget = {
  readonly provider: "gcp";
  readonly profile: string;
  readonly region: string;
  readonly quotaProjectId?: string;
};

export type AzureProviderModelTarget = {
  readonly provider: "azure";
  readonly profile: string;
  readonly tenantId: string;
  readonly endpoint: string;
};

export type ProviderModelTarget =
  | GcpProviderModelTarget
  | AzureProviderModelTarget;

export const missingAzureModelEndpoint = (): AppError => ({
  code: "args.missing",
  message:
    "Azure model discovery requires --endpoint <azure-openai-compatible-endpoint>.",
});

export type GcpProviderDiscoveryTarget = {
  readonly provider: "gcp";
  readonly profile: string;
  readonly boundary: GcpBoundary;
  readonly quotaProjectId?: string;
};

export type AzureProviderDiscoveryTarget = {
  readonly provider: "azure";
  readonly profile: string;
  readonly tenantId: string;
  readonly boundary: AzureResourceGroupRef;
};

export type ProviderDiscoveryTarget =
  | GcpProviderDiscoveryTarget
  | AzureProviderDiscoveryTarget;

export type GcpProviderTarget = {
  readonly provider: "gcp";
  readonly profile: string;
  readonly user: string;
  readonly ref: GcpDeploymentRef;
  readonly deploymentSpec?: GcpDeployment;
  readonly quotaProjectId?: string;
};

export type AzureProviderTarget = {
  readonly provider: "azure";
  readonly profile: string;
  readonly user: string;
  readonly ref: AzureDeploymentRef;
  readonly deploymentSpec?: AzureDeployment;
  readonly tenantId: string;
};

export type ProviderTarget = GcpProviderTarget | AzureProviderTarget;

export type ProviderAuthRunner = {
  readonly authCheck: () => Effect.Effect<ProviderAuthSummary, CloudError>;
};

export type ProviderModelRunner = {
  readonly listModels: () => Effect.Effect<
    ProviderOperationResult<readonly SupportedModelSummary[]>,
    CloudError
  >;
};

export type ProviderDiscoveryRunner = {
  readonly discover: () => Effect.Effect<
    ProviderOperationResult<ProviderDiscoverySummary>,
    CloudError
  >;
};

export type ProviderRunner = {
  readonly authCheck: () => Effect.Effect<ProviderAuthSummary, CloudError>;
  readonly discover: () => Effect.Effect<
    ProviderOperationResult<ProviderDiscoverySummary>,
    CloudError
  >;
  readonly validateSetup?: () => Effect.Effect<void, CloudError>;
  readonly readHomeManagerConfig?: () => Effect.Effect<
    ProviderConfigRead,
    CloudError
  >;
  readonly previewDeploy?: () => Effect.Effect<
    ProviderOperationResult<ProviderDeployPreviewSummary>,
    CloudError
  >;
  readonly deploy?: () => Effect.Effect<
    ProviderOperationResult<ProviderStatusSummary>,
    CloudError
  >;
  readonly status: () => Effect.Effect<
    ProviderOperationResult<ProviderStatusSummary>,
    CloudError
  >;
  readonly listSecrets: () => Effect.Effect<readonly string[], CloudError>;
  readonly putSecret: (
    name: string,
    value: string,
  ) => Effect.Effect<
    ProviderOperationResult<ProviderStatusSummary>,
    CloudError
  >;
  readonly deleteSecret: (
    name: string,
  ) => Effect.Effect<
    ProviderOperationResult<ProviderStatusSummary>,
    CloudError
  >;
  readonly restart: () => Effect.Effect<
    ProviderOperationResult<ProviderStatusSummary>,
    CloudError
  >;
  readonly destroy: () => Effect.Effect<
    ProviderOperationResult<ProviderStatusSummary>,
    CloudError
  >;
  readonly destroyWithStatePurge?: () => Effect.Effect<
    ProviderOperationResult<ProviderStatusSummary>,
    CloudError
  >;
  readonly writeHomeManagerModule?: (
    module: HomeManagerModule,
  ) => Effect.Effect<
    ProviderOperationResult<ProviderStatusSummary>,
    CloudError
  >;
};

export type ProviderRunnerFactory = (
  target: ProviderTarget,
  credentials: LocalCredentialRequest,
) => ProviderRunner | undefined;

export type ProviderAuthRunnerFactory = (
  target: ProviderAuthTarget,
  credentials: LocalCredentialRequest,
) => ProviderAuthRunner | undefined;

export type ProviderModelRunnerFactory = (
  target: ProviderModelTarget,
  credentials: LocalCredentialRequest,
) => ProviderModelRunner | undefined;

export type ProviderDiscoveryRunnerFactory = (
  target: ProviderDiscoveryTarget,
  credentials: LocalCredentialRequest,
) => ProviderDiscoveryRunner | undefined;

const gcpDeploymentFromProfile = (
  profile: Extract<AppProfile, { readonly provider: "gcp" }>,
  fields: Readonly<Record<string, string>> = {},
): GcpDeployment => {
  const boundary = gcpBoundaryFromProfile(profile, fields);
  return {
    name: profile.deployment,
    ...boundary,
    ...(profile.gcp.serviceAccount
      ? { serviceAccount: profile.gcp.serviceAccount }
      : {}),
    ...(fields["service-account"]
      ? { serviceAccount: fields["service-account"] }
      : {}),
    state: {
      server: fields["state-server"] ?? profile.gcp.state.server,
      dataPath: gcpStateDataPath(fields) ?? profile.gcp.state.dataPath,
      nixPath: gcpStateNixPath(fields) ?? profile.gcp.state.nixPath,
    },
  };
};

const gcpBoundaryFromProfile = (
  profile: Extract<AppProfile, { readonly provider: "gcp" }>,
  fields: Readonly<Record<string, string>> = {},
): GcpBoundary => ({
  projectId: fields["project"] ?? profile.gcp.projectId,
  region: fields["region"] ?? profile.gcp.region,
});

const gcpTargetFromProfile = (
  profile: Extract<AppProfile, { readonly provider: "gcp" }>,
  fields: Readonly<Record<string, string>> = {},
): GcpProviderTarget => {
  const quotaProjectId = fields["quota-project"] ?? profile.quotaProjectId;
  const deployment = gcpDeploymentFromProfile(profile, fields);
  return {
    provider: "gcp",
    profile: profile.name,
    user: fields["user"] ?? profile.user,
    ref: {
      name: profile.deployment,
      projectId: deployment.projectId,
      region: deployment.region,
    },
    deploymentSpec: deployment,
    ...(quotaProjectId ? { quotaProjectId } : {}),
  };
};

const azureDeploymentFromProfile = (
  profile: Extract<AppProfile, { readonly provider: "azure" }>,
  fields: Readonly<Record<string, string>> = {},
): AzureDeployment => {
  const boundary = azureResourceGroupFromProfile(profile, fields);
  return {
    name: profile.deployment,
    ...boundary,
    location: fields["location"] ?? profile.azure.location,
    environmentId: fields["environment-id"] ?? profile.azure.environmentId,
    state: {
      storageName: fields["storage-name"] ?? profile.azure.state.storageName,
      dataSubPath: fields["state-data-path"] ?? profile.azure.state.dataSubPath,
      nixSubPath: fields["state-nix-path"] ?? profile.azure.state.nixSubPath,
    },
  };
};

const azureResourceGroupFromProfile = (
  profile: Extract<AppProfile, { readonly provider: "azure" }>,
  fields: Readonly<Record<string, string>> = {},
): AzureResourceGroupRef => ({
  subscriptionId: fields["subscription"] ?? profile.azure.subscriptionId,
  resourceGroupName:
    fields["resource-group"] ?? profile.azure.resourceGroupName,
});

const azureTargetFromProfile = (
  profile: Extract<AppProfile, { readonly provider: "azure" }>,
  fields: Readonly<Record<string, string>> = {},
): AzureProviderTarget => {
  const deployment = azureDeploymentFromProfile(profile, fields);
  return {
    provider: "azure",
    profile: profile.name,
    user: fields["user"] ?? profile.user,
    tenantId: fields["tenant"] ?? profile.tenantId,
    ref: {
      name: profile.deployment,
      subscriptionId: deployment.subscriptionId,
      resourceGroupName: deployment.resourceGroupName,
    },
    deploymentSpec: deployment,
  };
};

export const targetFromProfile = (
  profile: AppProfile,
  fields: Readonly<Record<string, string>> = {},
): ProviderTarget =>
  profile.provider === "gcp"
    ? gcpTargetFromProfile(profile, fields)
    : azureTargetFromProfile(profile, fields);

export const authTargetFromProfile = (
  profile: AppProfile,
  fields: Readonly<Record<string, string>> = {},
): ProviderAuthTarget => {
  if (profile.provider === "gcp") {
    const quotaProjectId = fields["quota-project"] ?? profile.quotaProjectId;
    return {
      provider: "gcp",
      profile: profile.name,
      ...(quotaProjectId ? { quotaProjectId } : {}),
    };
  }

  return {
    provider: "azure",
    profile: profile.name,
    tenantId: fields["tenant"] ?? profile.tenantId,
    subscriptionId: fields["subscription"] ?? profile.azure.subscriptionId,
  };
};

export const discoveryTargetFromProfile = (
  profile: AppProfile,
  fields: Readonly<Record<string, string>> = {},
): ProviderDiscoveryTarget => {
  if (profile.provider === "gcp") {
    const quotaProjectId = fields["quota-project"] ?? profile.quotaProjectId;
    return {
      provider: "gcp",
      profile: profile.name,
      boundary: gcpBoundaryFromProfile(profile, fields),
      ...(quotaProjectId ? { quotaProjectId } : {}),
    };
  }

  return {
    provider: "azure",
    profile: profile.name,
    tenantId: fields["tenant"] ?? profile.tenantId,
    boundary: azureResourceGroupFromProfile(profile, fields),
  };
};

export const modelTargetFromProfile = (
  profile: AppProfile,
  fields: Readonly<Record<string, string>> = {},
): ProviderModelTarget => {
  if (profile.provider === "gcp") {
    const quotaProjectId = fields["quota-project"] ?? profile.quotaProjectId;
    return {
      provider: "gcp",
      profile: profile.name,
      region: fields["region"] ?? profile.gcp.region,
      ...(quotaProjectId ? { quotaProjectId } : {}),
    };
  }

  return {
    provider: "azure",
    profile: profile.name,
    tenantId: fields["tenant"] ?? profile.tenantId,
    endpoint: fields["endpoint"] ?? profile.azure.openaiCompatibleEndpoint,
  };
};

const sha256Hex = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const providerConfigRead = (
  managedModule: string | undefined,
): ProviderConfigRead => ({
  configured: managedModule !== undefined,
  ...(managedModule !== undefined
    ? {
        managedModuleHash: sha256Hex(managedModule),
        managedModule,
      }
    : {}),
});

const gcpAuth = (target: { readonly quotaProjectId?: string }) =>
  makeGcpApplicationDefaultAuthContext({
    ...(target.quotaProjectId ? { quotaProjectId: target.quotaProjectId } : {}),
  });

const gcpAuthForRequest = (
  target: { readonly quotaProjectId?: string },
  credentials: LocalCredentialRequest,
) =>
  credentials.mode && credentials.mode !== "auto" ? undefined : gcpAuth(target);

const gcpAuthSummary = (target: {
  readonly quotaProjectId?: string;
}): ProviderAuthSummary => ({
  ...(target.quotaProjectId ? { quotaProjectId: target.quotaProjectId } : {}),
});

const gcpAuthCheck = (
  auth: GcpAuthContext,
  target: { readonly quotaProjectId?: string },
): Effect.Effect<ProviderAuthSummary, CloudError> =>
  Effect.map(auth.token(), () => gcpAuthSummary(target));

const gcpAuthRunner = (
  target: GcpProviderAuthTarget,
  credentials: LocalCredentialRequest,
): ProviderAuthRunner | undefined => {
  const auth = gcpAuthForRequest(target, credentials);
  return auth
    ? {
        authCheck: () => gcpAuthCheck(auth, target),
      }
    : undefined;
};

const gcpModelRunner = (
  target: GcpProviderModelTarget,
  credentials: LocalCredentialRequest,
): ProviderModelRunner | undefined => {
  const auth = gcpAuthForRequest(target, credentials);
  if (!auth) return undefined;

  const app = makeGcpApp(auth);

  return {
    listModels: () => app.listSupportedModels(target.region),
  };
};

const gcpDiscoveryRunner = (
  target: GcpProviderDiscoveryTarget,
  credentials: LocalCredentialRequest,
): ProviderDiscoveryRunner | undefined => {
  const auth = gcpAuthForRequest(target, credentials);
  if (!auth) return undefined;

  const app = makeGcpApp(auth);

  return {
    discover: () => app.discover(target.boundary),
  };
};

const gcpRunner = (
  target: GcpProviderTarget,
  credentials: LocalCredentialRequest,
): ProviderRunner | undefined => {
  const auth = gcpAuthForRequest(target, credentials);
  if (!auth) return undefined;

  const app = makeGcpApp(auth);
  const homeManagerApp = makeGcpHomeManagerApp(auth);
  const deployment = target.deploymentSpec;

  return {
    authCheck: () => gcpAuthCheck(auth, target),
    discover: () =>
      app.discover({
        projectId: target.ref.projectId,
        region: target.ref.region,
      }),
    ...(deployment
      ? {
          validateSetup: () => app.validateSetup(deployment),
          previewDeploy: () =>
            mapProviderOperationResult(
              app.previewDeploy(deployment),
              summarizeGcpDeployPreview,
            ),
          deploy: () =>
            mapProviderOperationResult(
              app.deploy(deployment),
              summarizeGcpStatus,
            ),
          writeHomeManagerModule: (module: HomeManagerModule) =>
            mapProviderOperationResult(
              homeManagerApp.writeModule(deployment, target.user, module),
              summarizeGcpStatus,
            ),
        }
      : {}),
    status: () =>
      mapProviderOperationResult(app.status(target.ref), summarizeGcpStatus),
    listSecrets: () => app.listRuntimeSecrets(target.ref),
    putSecret: (name, value) =>
      mapProviderOperationResult(
        app.putRuntimeSecret(target.ref, name, value),
        summarizeGcpStatus,
      ),
    deleteSecret: (name) =>
      mapProviderOperationResult(
        app.deleteRuntimeSecret(target.ref, name),
        summarizeGcpStatus,
      ),
    restart: () =>
      mapProviderOperationResult(app.restart(target.ref), summarizeGcpStatus),
    destroy: () =>
      mapProviderOperationResult(app.destroy(target.ref), summarizeGcpStatus),
  };
};

type AzureRunnerAuth = {
  readonly arm: AzureAuthContext;
  readonly files: AzureAuthContext;
};

const azureCredential = (
  target: { readonly tenantId: string },
  request: LocalCredentialRequest,
): TokenCredential | undefined => {
  const autoMode = request.mode === undefined || request.mode === "auto";
  if (
    request.inputMode === "nonInteractive" ||
    (request.noBrowser && autoMode)
  ) {
    return autoMode
      ? makeAzureNonInteractiveCredential({
          tenantId: target.tenantId,
          env: request.env,
        })
      : undefined;
  }

  const deviceCodePrompt = request.deviceCodePrompt;
  return request.mode === "device"
    ? makeAzureDeviceCodeCredential({
        tenantId: target.tenantId,
        ...(deviceCodePrompt
          ? {
              userPromptCallback: (info) => deviceCodePrompt(info.message),
            }
          : {}),
      })
    : makeAzureInteractiveBrowserCredential({
        tenantId: target.tenantId,
      });
};

const azureRunnerAuth = (
  target: {
    readonly tenantId: string;
    readonly subscriptionId: string;
  },
  credentials: LocalCredentialRequest,
): AzureRunnerAuth | undefined => {
  const credential = azureCredential(target, credentials);
  return credential
    ? {
        arm: makeAzureIdentityAuthContext({
          credential,
          tenantId: target.tenantId,
          subscriptionId: target.subscriptionId,
        }),
        files: makeAzureIdentityAuthContext({
          credential,
          tenantId: target.tenantId,
          subscriptionId: target.subscriptionId,
          scope: AZURE_STORAGE_SCOPE,
        }),
      }
    : undefined;
};

const azureAuthSummary = (token: {
  readonly tenantId: string;
  readonly subscriptionId: string;
  readonly expiresAtEpochSeconds: number;
}): ProviderAuthSummary => ({
  tenantId: token.tenantId,
  subscriptionId: token.subscriptionId,
  expiresAtEpochSeconds: token.expiresAtEpochSeconds,
});

const azureAuthCheck = (
  auth: AzureRunnerAuth,
): Effect.Effect<ProviderAuthSummary, CloudError> =>
  Effect.map(auth.arm.token(), azureAuthSummary);

const azureAuthRunner = (
  target: AzureProviderAuthTarget,
  credentials: LocalCredentialRequest,
): ProviderAuthRunner | undefined => {
  const auth = azureRunnerAuth(target, credentials);
  return auth
    ? {
        authCheck: () => azureAuthCheck(auth),
      }
    : undefined;
};

const azureRunner = (
  target: AzureProviderTarget,
  credentials: LocalCredentialRequest,
): ProviderRunner | undefined => {
  const auth = azureRunnerAuth(
    {
      tenantId: target.tenantId,
      subscriptionId: target.ref.subscriptionId,
    },
    credentials,
  );
  if (!auth) return undefined;

  const app = makeAzureApp(auth.arm);
  const homeManagerApp = makeAzureHomeManagerApp(auth.arm, auth.files);
  const deployment = target.deploymentSpec;

  return {
    authCheck: () => azureAuthCheck(auth),
    discover: () =>
      app.discover({
        subscriptionId: target.ref.subscriptionId,
        resourceGroupName: target.ref.resourceGroupName,
      }),
    ...(deployment
      ? {
          validateSetup: () => app.validateSetup(deployment),
          previewDeploy: () =>
            mapProviderOperationResult(
              app.previewDeploy(deployment),
              summarizeAzureDeployPreview,
            ),
          deploy: () =>
            mapProviderOperationResult(
              app.deploy(deployment),
              summarizeAzureStatus,
            ),
          readHomeManagerConfig: () =>
            Effect.map(
              homeManagerApp.readConfig(deployment, target.user),
              providerConfigRead,
            ),
          writeHomeManagerModule: (module: HomeManagerModule) =>
            mapProviderOperationResult(
              homeManagerApp.writeModule(deployment, target.user, module),
              summarizeAzureStatus,
            ),
        }
      : {}),
    status: () =>
      mapProviderOperationResult(app.status(target.ref), summarizeAzureStatus),
    listSecrets: () => app.listRuntimeSecrets(target.ref),
    putSecret: (name, value) =>
      mapProviderOperationResult(
        app.putRuntimeSecret(target.ref, name, value),
        summarizeAzureStatus,
      ),
    deleteSecret: (name) =>
      mapProviderOperationResult(
        app.deleteRuntimeSecret(target.ref, name),
        summarizeAzureStatus,
      ),
    restart: () =>
      mapProviderOperationResult(app.restart(target.ref), summarizeAzureStatus),
    destroy: () =>
      mapProviderOperationResult(app.destroy(target.ref), summarizeAzureStatus),
    ...(deployment
      ? {
          destroyWithStatePurge: () =>
            mapProviderOperationResult(
              app.destroyWithStatePurge(deployment, auth.files),
              summarizeAzureStatus,
            ),
        }
      : {}),
  };
};

const azureDiscoveryRunner = (
  target: AzureProviderDiscoveryTarget,
  credentials: LocalCredentialRequest,
): ProviderDiscoveryRunner | undefined => {
  const auth = azureRunnerAuth(
    {
      tenantId: target.tenantId,
      subscriptionId: target.boundary.subscriptionId,
    },
    credentials,
  );
  if (!auth) return undefined;

  const app = makeAzureApp(auth.arm);
  return {
    discover: () => app.discover(target.boundary),
  };
};

const azureModelRunner = (
  target: AzureProviderModelTarget,
  credentials: LocalCredentialRequest,
): ProviderModelRunner | undefined => {
  const credential = azureCredential(target, credentials);
  if (!credential) return undefined;

  const app = makeAzureFoundryModelApp(
    makeAzureFoundryOpenAICompatibleEntraIdAuthContext({ credential }),
  );
  return {
    listModels: () => app.listSupportedModels(target.endpoint),
  };
};

export const makeDefaultProviderRunner: ProviderRunnerFactory = (
  target,
  request,
) =>
  target.provider === "gcp"
    ? gcpRunner(target, request)
    : azureRunner(target, request);

export const makeDefaultProviderAuthRunner: ProviderAuthRunnerFactory = (
  target,
  request,
) =>
  target.provider === "gcp"
    ? gcpAuthRunner(target, request)
    : azureAuthRunner(target, request);

export const makeDefaultProviderModelRunner: ProviderModelRunnerFactory = (
  target,
  request,
) =>
  target.provider === "gcp"
    ? gcpModelRunner(target, request)
    : azureModelRunner(target, request);

export const makeDefaultProviderDiscoveryRunner: ProviderDiscoveryRunnerFactory =
  (target, request) =>
    target.provider === "gcp"
      ? gcpDiscoveryRunner(target, request)
      : azureDiscoveryRunner(target, request);
